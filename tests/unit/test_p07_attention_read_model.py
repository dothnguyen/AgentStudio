"""P07 attention read model: stuck runs, delegated commands and blocked tickets in `team.overview`."""
import unittest
from unittest.mock import patch

from tests.unit import test_p05_s10_team_overview as fixture
from agent_studio import store as store_mod, teamview


EMPTY = {"runs": [], "commandRequests": [],
         "truncated": {"runs": False, "commandRequests": False}}


class AttentionReadModelTests(unittest.TestCase):
    setUp = fixture.TeamOverviewTests.setUp
    _restore = fixture.TeamOverviewTests._restore
    write = fixture.TeamOverviewTests.write
    put_team = fixture.TeamOverviewTests.put_team
    seed_runtime = fixture.TeamOverviewTests.seed_runtime
    seed_ticket = fixture.TeamOverviewTests.seed_ticket
    ov = fixture.TeamOverviewTests.ov
    team = fixture.TeamOverviewTests.team
    core = fixture.TeamOverviewTests.core

    def seed_run(self, team, agent, *, run_status="running", phase=None, stage="develop",
                 assignment_status=None, diagnostic=None, goal="work", current_agent_id=None):
        with self.store.transaction() as tx:
            task = tx.create("task", {"team_id": team, "origin": "direct", "workspace": self.ws,
                                      "goal": goal})
            assignment = tx.create("assignment", {"team_id": team, "task_id": task, "agent_id": agent,
                                                  "attempt": 1, "policy": "read_only", "provider_id": "fake"})
            run = tx.create("workflow_run", {"team_id": team, "task_id": task, "workflow": "test"})
            tx.create("stage_attempt", {"team_id": team, "workflow_run_id": run, "stage": stage, "attempt": 1,
                                        "agent_id": agent, "assignment_id": assignment, "phase": phase})
        self.conn.execute("UPDATE workflow_runs SET status = ?, current_stage = ?, current_agent_id = ? WHERE id = ?",
                          (run_status, stage, current_agent_id, run))
        if assignment_status is not None:
            self.conn.execute("UPDATE assignments SET status = ?, diagnostic_code = ? WHERE id = ?",
                              (assignment_status, diagnostic, assignment))
        self.conn.commit()
        return run, assignment, task

    def seed_request(self, team, run, *, status="requested", command="app-deps-install",
                     reason="needs the new dependency", created_at=None):
        with self.store.transaction() as tx:
            request = tx.create("command_request", {
                "team_id": team, "workflow_run_id": run, "stage": "develop", "visit": 1, "ordinal": 1,
                "command_id": command, "argv_json": "[]", "reason": reason, "source": "mcp"},
                state="requested")
            if status != "requested":
                tx.transition("command_request", request, "approved")
                if status == "running":
                    tx.transition("command_request", request, "running")
        if created_at is not None:
            self.conn.execute("UPDATE command_requests SET created_at = ?, updated_at = ? WHERE id = ?",
                              (created_at, created_at, request))
            self.conn.commit()
        return request

    def seed_board_ticket(self, key, title, *, status="in_progress", assignee=None, active_run_id=None,
                          run_id=None, blocked_reason=None, return_status=None,
                          updated_at="2026-01-01T00:00:00.000Z", workspace=None):
        ws = workspace or self.ws
        phase, ticket = store_mod.new_id(), store_mod.new_id()
        self.conn.execute("INSERT INTO phases (id, workspace, slug, name, position, status, created_at, updated_at) "
                          "VALUES (?, ?, ?, 'Phase', 0, 'open', ?, ?)",
                          (phase, ws, f"p-{key}", updated_at, updated_at))
        self.conn.execute(
            "INSERT INTO tickets (id, workspace, key, title, body, phase_id, status, priority, assignee, "
            "active_run_id, run_id, return_status, blocked_reason, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, 'b', ?, ?, 100, ?, ?, ?, ?, ?, ?, ?)",
            (ticket, ws, key, title, phase, status, assignee, active_run_id, run_id,
             return_status, blocked_reason, updated_at, updated_at))
        self.conn.commit()
        return ticket

    def test_paused_run_carries_member_assignment_and_diagnostic(self):
        self.core()
        team, ids = self.seed_runtime("core", agents=(("dev", "busy"),))
        run, assignment, _ = self.seed_run(team, ids["dev"], run_status="paused",
                                           assignment_status="failed", diagnostic="PROCESS_EXITED",
                                           phase="assignment")
        self.seed_ticket("T-101", "Build it", ids["dev"], run)
        attention = self.team(self.ov(), "core")["attention"]
        self.assertEqual(attention["truncated"], {"runs": False, "commandRequests": False})
        self.assertEqual(attention["runs"], [{
            "workflowRunId": run, "status": "paused", "stage": "develop", "memberId": "dev",
            "ticketKey": "T-101", "assignmentId": assignment, "assignmentStatus": "failed",
            "diagnosticCode": "PROCESS_EXITED", "delegating": False}])

    def test_delegating_run_links_member_even_when_current_agent_is_cleared(self):
        self.core()
        team, ids = self.seed_runtime("core", agents=(("dev", "busy"),))
        run, _, _ = self.seed_run(team, ids["dev"], run_status="running", phase="delegating",
                                  current_agent_id=None)
        self.seed_request(team, run)
        run_entry = self.team(self.ov(), "core")["attention"]["runs"][0]
        self.assertEqual((run_entry["workflowRunId"], run_entry["memberId"], run_entry["delegating"]),
                         (run, "dev", True))

    def test_blocked_ticket_links_the_member_of_its_last_run(self):
        self.core()
        team, ids = self.seed_runtime("core")
        run, _, _ = self.seed_run(team, ids["dev"], run_status="failed")
        self.seed_board_ticket("T-102", "Blocked work", status="blocked", run_id=run,
                               return_status="qa-ready", blocked_reason="too many rounds",
                               updated_at="2026-02-01T00:00:00.000Z")
        out = self.ov()
        self.assertEqual(out["blockedTickets"], [{
            "key": "T-102", "title": "Blocked work", "reason": "too many rounds",
            "returnStatus": "qa-ready", "memberId": "dev", "updatedAt": "2026-02-01T00:00:00.000Z"}])
        self.assertFalse(out["blockedTicketsTruncated"])

    def test_blocked_ticket_without_run_history_has_no_member(self):
        self.core()
        self.seed_board_ticket("T-103", "Old blocked", status="blocked", run_id=None,
                               return_status="dev-ready", blocked_reason=None)
        out = self.ov()
        self.assertEqual(out["blockedTickets"][0]["memberId"], None)
        self.assertIsNone(out["blockedTickets"][0]["reason"])

    def test_stopped_team_has_empty_attention(self):
        self.core()
        team, ids = self.seed_runtime("core", "stopped")
        run, _, _ = self.seed_run(team, ids["dev"])
        self.seed_request(team, run)
        attention = self.team(self.ov(), "core")["attention"]
        self.assertEqual(attention, EMPTY)

    def test_pending_command_requests_are_listed_with_their_member(self):
        self.core()
        team, ids = self.seed_runtime("core")
        run, _, _ = self.seed_run(team, ids["dev"])
        requested = self.seed_request(team, run, status="requested",
                                      created_at="2026-01-01T00:00:00.000Z")
        approved = self.seed_request(team, run, status="approved", command="test-ui",
                                     created_at="2026-01-02T00:00:00.000Z")
        running = self.seed_request(team, run, status="running", command="test-backend",
                                    created_at="2026-01-03T00:00:00.000Z")
        with self.store.transaction() as tx:
            finished = tx.create("command_request", {
                "team_id": team, "workflow_run_id": run, "stage": "develop", "visit": 1, "ordinal": 4,
                "command_id": "test-all", "argv_json": "[]", "reason": None, "source": "mcp"},
                state="requested")
            tx.transition("command_request", finished, "approved")
            tx.transition("command_request", finished, "running")
            tx.transition("command_request", finished, "succeeded")
        requests = self.team(self.ov(), "core")["attention"]["commandRequests"]
        self.assertEqual([r["id"] for r in requests], [running, approved, requested])
        self.assertEqual([(r["command"], r["status"], r["memberId"], r["workflowRunId"]) for r in requests], [
            ("test-backend", "running", "dev", run),
            ("test-ui", "approved", "dev", run),
            ("app-deps-install", "requested", "dev", run)])
        self.assertEqual(requests[2]["reason"], "needs the new dependency")

    def test_bounds_set_truncated_flags(self):
        self.core()
        team, ids = self.seed_runtime("core")
        with self.store.transaction() as tx:
            runs = []
            for i in range(51):
                task = tx.create("task", {"team_id": team, "origin": "direct", "workspace": self.ws,
                                          "goal": f"work {i}"})
                runs.append(tx.create("workflow_run", {"team_id": team, "task_id": task, "workflow": "test"}))
        run = runs[0]
        for i in range(26):
            self.seed_request(team, run, created_at=f"2026-01-{i + 1:02d}T00:00:00.000Z")
        for i in range(26):
            self.seed_board_ticket(f"T-{200 + i}", f"Blocked {i}", status="blocked", run_id=run,
                                   return_status="dev-ready", updated_at=f"2026-02-{i + 1:02d}T00:00:00.000Z")
        out = self.ov()
        attention = self.team(out, "core")["attention"]
        self.assertEqual((len(attention["runs"]), attention["truncated"]["runs"]), (50, True))
        self.assertEqual((len(attention["commandRequests"]), attention["truncated"]["commandRequests"]),
                         (25, True))
        self.assertEqual((len(out["blockedTickets"]), out["blockedTicketsTruncated"]), (25, True))

    def test_text_fields_are_sanitised_and_bounded(self):
        self.core()
        team, ids = self.seed_runtime("core")
        run, _, _ = self.seed_run(team, ids["dev"])
        self.seed_request(team, run, reason="why\n" + "r" * 300)
        self.seed_board_ticket("T-300", "title\n" + "t" * 300, status="blocked", run_id=run,
                               return_status="dev-ready", blocked_reason="\x1b[31m" + "b" * 300)
        out = self.ov()
        ticket = out["blockedTickets"][0]
        self.assertEqual(len(ticket["title"]), 204)
        self.assertNotIn("\n", ticket["title"])
        self.assertEqual(len(ticket["reason"]), 104)
        self.assertNotIn("\x1b", ticket["reason"])
        reason = self.team(out, "core")["attention"]["commandRequests"][0]["reason"]
        self.assertEqual(len(reason), 104)
        self.assertNotIn("\n", reason)

    def test_overview_without_command_requests_table_is_empty_not_failed(self):
        self.core()
        team, ids = self.seed_runtime("core")
        run, _, _ = self.seed_run(team, ids["dev"])
        self.conn.execute("DROP TABLE command_requests")
        self.conn.commit()
        out = self.ov()
        self.assertTrue(all(t["attention"]["commandRequests"] == [] for t in out["teams"]))
        self.assertEqual(len(self.team(out, "core")["attention"]["runs"]), 1)
        self.assertFalse(out["partial"])

    def test_a_failure_reading_attention_returns_empty_shapes_and_marks_partial(self):
        self.core()
        self.seed_runtime("core")
        with patch.object(teamview, "_RUN_ATTENTION_SQL", "SELECT * FROM no_such_table"):
            out = self.ov()
        self.assertEqual(self.team(out, "core")["attention"], EMPTY)
        self.assertTrue(out["partial"])

    def test_run_links_come_from_the_newest_stage_attempt_and_assignment(self):
        self.core()
        team, ids = self.seed_runtime("core", agents=(("dev", "busy"), ("rev", "idle")))
        run, _old_assignment, task = self.seed_run(team, ids["dev"], run_status="running",
                                                   phase="developer")
        with self.store.transaction() as tx:
            tx.create("stage_attempt", {"team_id": team, "workflow_run_id": run, "stage": "reviewer",
                                        "attempt": 1, "agent_id": ids["rev"], "phase": "delegating"})
            newer_assignment = tx.create("assignment", {
                "team_id": team, "task_id": task, "agent_id": ids["dev"], "attempt": 2,
                "policy": "read_only", "provider_id": "fake"})
        self.conn.execute("UPDATE assignments SET status = 'failed', diagnostic_code = 'TIMEOUT' WHERE id = ?",
                          (newer_assignment,))
        self.conn.commit()
        entry = self.team(self.ov(), "core")["attention"]["runs"][0]
        self.assertEqual(entry["memberId"], "rev")
        self.assertEqual((entry["assignmentId"], entry["assignmentStatus"], entry["diagnosticCode"]),
                         (newer_assignment, "failed", "TIMEOUT"))
        self.assertTrue(entry["delegating"])

    def test_run_without_stage_attempt_or_ticket_has_null_links(self):
        self.core()
        team, _ = self.seed_runtime("core")
        with self.store.transaction() as tx:
            task = tx.create("task", {"team_id": team, "origin": "direct", "workspace": self.ws, "goal": "g"})
            run = tx.create("workflow_run", {"team_id": team, "task_id": task, "workflow": "test"})
        entry = self.team(self.ov(), "core")["attention"]["runs"][0]
        self.assertEqual(entry, {
            "workflowRunId": run, "status": "queued", "stage": None, "memberId": None,
            "ticketKey": None, "assignmentId": None, "assignmentStatus": None,
            "diagnosticCode": None, "delegating": False})

    def test_blocked_tickets_are_newest_first_and_workspace_scoped(self):
        self.core()
        team, ids = self.seed_runtime("core")
        run, _, _ = self.seed_run(team, ids["dev"], run_status="failed")
        self.seed_board_ticket("T-402", "Older", status="blocked", run_id=run,
                               updated_at="2026-03-01T00:00:00.000Z")
        self.seed_board_ticket("T-403", "Newer", status="blocked", run_id=run,
                               updated_at="2026-03-02T00:00:00.000Z")
        self.seed_board_ticket("T-900", "Other workspace", status="blocked", run_id=run,
                               updated_at="2026-03-03T00:00:00.000Z",
                               workspace=self.ws + "-other")
        self.assertEqual([t["key"] for t in self.ov()["blockedTickets"]], ["T-403", "T-402"])

    def test_bounds_are_applied_per_team(self):
        self.put_team("beta", [fixture.DEV])
        core, _ = self.seed_runtime("core")
        beta, _ = self.seed_runtime("beta")
        with self.store.transaction() as tx:
            core_runs = []
            for i in range(51):
                task = tx.create("task", {"team_id": core, "origin": "direct", "workspace": self.ws,
                                          "goal": f"core {i}"})
                core_runs.append(tx.create("workflow_run", {"team_id": core, "task_id": task,
                                                            "workflow": "test"}))
            beta_run = None
            for i in range(5):
                task = tx.create("task", {"team_id": beta, "origin": "direct", "workspace": self.ws,
                                          "goal": f"beta {i}"})
                beta_run = tx.create("workflow_run", {"team_id": beta, "task_id": task, "workflow": "test"})
        for i in range(26):
            self.seed_request(core, core_runs[0], created_at=f"2026-01-{i + 1:02d}T00:00:00.000Z")
        for i in range(3):
            self.seed_request(beta, beta_run, created_at=f"2026-02-{i + 1:02d}T00:00:00.000Z")
        out = self.ov()
        core_attention = self.team(out, "core")["attention"]
        beta_attention = self.team(out, "beta")["attention"]
        self.assertEqual((len(core_attention["runs"]), core_attention["truncated"]["runs"]), (50, True))
        self.assertEqual((len(core_attention["commandRequests"]),
                          core_attention["truncated"]["commandRequests"]), (25, True))
        self.assertEqual((len(beta_attention["runs"]), beta_attention["truncated"]["runs"]), (5, False))
        self.assertEqual((len(beta_attention["commandRequests"]),
                          beta_attention["truncated"]["commandRequests"]), (3, False))

    def test_stopped_and_starting_teams_have_empty_attention(self):
        self.core()
        self.put_team("beta", [fixture.DEV])
        stopped, stopped_ids = self.seed_runtime("core", "stopped")
        _starting, _ = self.seed_runtime("beta", "starting")
        stopped_run, _, _ = self.seed_run(stopped, stopped_ids["dev"])
        self.seed_request(stopped, stopped_run)
        out = self.ov()
        self.assertEqual(self.team(out, "core")["attention"], EMPTY)
        self.assertEqual(self.team(out, "beta")["attention"], EMPTY)

    def test_unreadable_runtime_has_empty_attention_and_blocked_tickets(self):
        self.core()
        self.seed_runtime("core")
        self.seed_board_ticket("T-404", "Blocked", status="blocked")
        out = self.ov(running=False, conn=False,
                      error={"code": "BACKEND_UNAVAILABLE", "message": "m"})
        self.assertEqual(self.team(out, "core")["attention"], EMPTY)
        self.assertEqual(out["blockedTickets"], [])
        self.assertFalse(out["blockedTicketsTruncated"])
        self.assertTrue(out["partial"])

    def test_attention_uses_a_bounded_number_of_queries_per_overview(self):
        class CountingConnection:
            def __init__(self, conn):
                self.conn, self.queries = conn, []

            def execute(self, sql, *args):
                self.queries.append(sql)
                return self.conn.execute(sql, *args)

        self.core()
        team, ids = self.seed_runtime("core")
        run, _, _ = self.seed_run(team, ids["dev"])
        self.seed_request(team, run)
        self.seed_board_ticket("T-405", "Blocked", status="blocked", run_id=run)
        conn = CountingConnection(self.conn)
        teamview.overview(conn, self.ws, True, None)
        attention_queries = [q for q in conn.queries if "ROW_NUMBER() OVER" in q or "FROM tickets t" in q]
        self.assertEqual(len(attention_queries), 3)

    def test_blocked_ticket_query_failure_is_empty_and_partial(self):
        self.core()
        team, ids = self.seed_runtime("core")
        run, _, _ = self.seed_run(team, ids["dev"])
        self.seed_board_ticket("T-406", "Blocked", status="blocked", run_id=run)
        with patch.object(teamview, "_BLOCKED_TICKETS_SQL", "SELECT * FROM no_such_table"):
            out = self.ov()
        self.assertEqual(out["blockedTickets"], [])
        self.assertFalse(out["blockedTicketsTruncated"])
        self.assertEqual(len(self.team(out, "core")["attention"]["runs"]), 1)
        self.assertTrue(out["partial"])

    def test_command_request_query_failure_is_empty_and_partial(self):
        self.core()
        team, ids = self.seed_runtime("core")
        run, _, _ = self.seed_run(team, ids["dev"])
        self.seed_request(team, run)
        with patch.object(teamview, "_COMMAND_ATTENTION_SQL",
                          "SELECT missing_column FROM command_requests"):
            out = self.ov()
        self.assertEqual(self.team(out, "core")["attention"]["commandRequests"], [])
        self.assertEqual(len(self.team(out, "core")["attention"]["runs"]), 1)
        self.assertTrue(out["partial"])

    def test_attention_reads_write_no_events(self):
        self.core()
        team, ids = self.seed_runtime("core")
        run, _, _ = self.seed_run(team, ids["dev"], assignment_status="failed", diagnostic="PROCESS_EXITED")
        self.seed_request(team, run)
        self.seed_board_ticket("T-301", "Blocked", status="blocked", run_id=run,
                               return_status="dev-ready")
        before = self.conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
        out = self.ov()
        after = self.conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
        self.assertEqual(before, after)
        self.assertFalse(out["partial"])


if __name__ == "__main__":
    unittest.main()
