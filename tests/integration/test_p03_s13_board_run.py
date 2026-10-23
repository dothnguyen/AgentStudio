"""P03-S13 autonomous-board coverage on the real coordinator fake team."""
import json
import os
import sqlite3
import time

from tests.integration import test_p03_s06_outcomes as outcomes
from tests.integration.test_p03_s06_outcomes import git
from tests.helpers import key, make_repo, req, wait_until


class BoardRunIntegration(outcomes.OutcomeIntegration):
    # These inherited tests deliberately stop at ready_merge.  The scheduler
    # test starts the merge worker, so it has its own end-to-end assertions.
    test_fake_outcome_rows_apply_once = None
    test_full_path_commits_and_test_prompt_contains_develop_diff = None
    # This class installs inputs for scheduler-created runs.  The inherited
    # manual-outcome test supplies its own distinct fake inputs, so it belongs
    # to its source module rather than this fixture.
    test_limits_no_change_invalid_plan_and_paused_retry = None
    # Its three per-visit fixture options would be overwritten by the trigger below.
    test_develop_validation_failure_at_visit_limit_counts_one_failed_round = None

    def setUp(self):
        super().setUp()
        # A scheduler run creates and dispatches its first assignment in one
        # coordinator pass.  Install fixture options with an INSERT trigger so
        # the request is complete before a runner can claim it.  Polling for a
        # queued assignment left a race here under parallel validation.
        conn = sqlite3.connect(self.sb.state_dir + "/state.db")
        try:
            conn.execute("""CREATE TRIGGER board_run_fixture_options
                AFTER INSERT ON assignments
                WHEN NEW.stage_attempt_id IS NOT NULL
                BEGIN
                  UPDATE assignments
                  SET request_json = json_set(request_json, '$.providerOptions', json(
                    CASE (SELECT stage FROM stage_attempts WHERE id = NEW.stage_attempt_id)
                      WHEN 'work' THEN '{"scenario":"success","writeFile":"fixed.txt","durationMs":1000,"progressLines":1}'
                      WHEN 'verdict' THEN CASE NEW.policy
                        WHEN 'workspace_write' THEN '{"scenario":"verdict_pass","writeFile":"phases/phase-03/stories/example.md","durationMs":50,"progressLines":1}'
                        ELSE '{"scenario":"verdict_pass","durationMs":50,"progressLines":1}' END
                    END))
                  WHERE id = NEW.id;
                END""")
            conn.commit()
        finally:
            conn.close()

    def _run(self):
        _, response, _ = self.sb.request(req("board.run", {"workspace": self.workspace}, idempotencyKey=key()))
        self.assertTrue(response["ok"], response)

    def _pause(self):
        _, response, _ = self.sb.request(req("board.pause", {"workspace": self.workspace, "reason": "test"}, idempotencyKey=key()))
        self.assertTrue(response["ok"], response)

    def test_run_claims_dependency_only_after_prerequisite_merge(self):
        first, second, dependent = self.create(), self.create(), self.create()
        # Direct setup is intentional: this test starts at the scheduler queue.
        conn = sqlite3.connect(self.sb.state_dir + "/state.db")
        try:
            conn.execute("UPDATE tickets SET status = 'refine' WHERE key IN (?, ?, ?)",
                         (first["key"], second["key"], dependent["key"]))
            ids = dict(conn.execute("SELECT key, id FROM tickets WHERE key IN (?, ?)", (first["key"], dependent["key"])))
            conn.execute("INSERT INTO ticket_deps (ticket_id, blocked_by_ticket_id) VALUES (?, ?)",
                         (ids[dependent["key"]], ids[first["key"]]))
            conn.commit()
        finally:
            conn.close()
        self._run()
        details = wait_until(
            lambda: (rows := [self.detail(ticket) for ticket in (first, second, dependent)])
            and all(row["ticket"]["status"] == "merged" for row in rows) and rows,
            timeout=int(os.environ.get("TEST_WAIT_SECONDS", "120")), message="all autonomous board tickets merged")
        first_detail, second_detail, dependent_detail = details
        for detail in details:
            self.assertIn("ticket.merged", [event["name"] for event in detail["events"]])

        first_merged = next(event["id"] for event in first_detail["events"] if event["name"] == "ticket.merged")
        dependent_dev = next(event["id"] for event in dependent_detail["events"]
                             if event["name"] == "ticket.claimed" and event["toStatus"] == "in_dev")
        self.assertGreater(dependent_dev, first_merged)

        # Main-checkout stages are serialized across all three tickets.
        conn = sqlite3.connect(self.sb.state_dir + "/state.db")
        try:
            rows = conn.execute(
                "SELECT id, ticket_id, name, to_status FROM ticket_events "
                "WHERE ticket_id IN (?, ?, ?) AND name IN ('ticket.claimed', 'ticket.outcome_applied') ORDER BY id",
                tuple(detail["ticket"]["id"] for detail in details)).fetchall()
            main_statuses = {"unpacking", "triaging", "refining"}
            working = set()
            for event_id, ticket_id, name, to_status in rows:
                if to_status in main_statuses:
                    self.assertFalse(working, f"main checkout overlap at ticket event {event_id}")
                    working.add(ticket_id)
                if name == "ticket.outcome_applied" and ticket_id in working:
                    working.remove(ticket_id)
            self.assertFalse(working)
        finally:
            conn.close()
        self.assertEqual(second_detail["ticket"]["status"], "merged")

    def test_pause_does_not_claim_a_new_ticket(self):
        first, second = self.create(), self.create()
        for ticket in (first, second):
            self.move(ticket, "ready_dev")
        self._run()
        wait_until(lambda: self.detail(first)["ticket"]["status"] == "in_dev" or self.detail(second)["ticket"]["status"] == "in_dev",
                   message="board develop run")
        self._pause()
        running = first if self.detail(first)["ticket"]["status"] == "in_dev" else second
        waiting = second if running is first else first
        wait_until(lambda: self.detail(running)["ticket"]["status"] == "ready_test",
                   message="paused develop outcome")
        before = self.detail(waiting)["ticket"]["status"]
        time.sleep(1.5)
        self.assertEqual(self.detail(waiting)["ticket"]["status"], before)
        self._run()
        wait_until(lambda: all(self.detail(ticket)["ticket"]["status"] == "merged" for ticket in (first, second)),
                   message="resumed board tickets merged")

    def _second_workspace(self):
        """A second board: own repo, own running fake team, same coordinator."""
        workspace = make_repo()
        os.makedirs(os.path.join(workspace, os.path.dirname(self.story)))
        with open(os.path.join(workspace, self.story), "w", encoding="utf-8") as f:
            f.write("# Example\n")
        with open(os.path.join(workspace, ".agent-studio", "board.json"), "w", encoding="utf-8") as f:
            json.dump({"baseBranch": git(workspace, "symbolic-ref", "--short", "HEAD")}, f)
        git(workspace, "add", "-A")
        git(workspace, "commit", "-m", "board fixture")
        roster = [{"providerId": "codex", "role": "TeamLead"}, {"providerId": "claude", "role": "Developer"},
                  {"providerId": "agy", "role": "QA"}]
        _, team, _ = self.sb.request(req("team.start", {"workspace": workspace, "roster": roster}, idempotencyKey=key()))
        self.assertTrue(team["ok"], team)
        return workspace

    def _call(self, name, workspace, **args):
        _, response, _ = self.sb.request(req(name, dict(args, workspace=workspace), idempotencyKey=key()))
        return response

    def _ready(self, workspace):
        created = self._call("ticket.create", workspace, storyPath=self.story)
        self.assertTrue(created["ok"], created)
        ticket = created["data"]["ticket"]
        moved = self._call("ticket.move", workspace, key=ticket["key"], to="ready_dev")
        self.assertTrue(moved["ok"], moved)
        return ticket["key"]

    def _status(self, workspace, ticket_key):
        shown = self._call("ticket.show", workspace, key=ticket_key)
        self.assertTrue(shown["ok"], shown)
        return shown["data"]["ticket"]["status"]

    def test_two_boards_run_pause_and_fail_independently(self):
        other = self._second_workspace()
        a1, a2 = self._ready(self.workspace), self._ready(self.workspace)
        b1, b2 = self._ready(other), self._ready(other)
        self.assertEqual((a1, b1), ("T-001", "T-001"))
        for workspace in (self.workspace, other):
            self.assertTrue(self._call("board.run", workspace)["ok"])
        # Pause A as soon as it has claimed; B keeps claiming until merged.
        wait_until(lambda: "in_dev" in (self._status(self.workspace, a1), self._status(self.workspace, a2)),
                   message="board A claimed")
        self.assertTrue(self._call("board.pause", self.workspace, reason="test")["ok"])
        wait_until(lambda: self._status(other, b1) == "merged" and self._status(other, b2) == "merged",
                   timeout=int(os.environ.get("TEST_WAIT_SECONDS", "120")), message="board B merged while A paused")
        wait_until(lambda: "ready_test" in (self._status(self.workspace, a1), self._status(self.workspace, a2)),
                   message="paused board A run finished")
        time.sleep(1.5)
        statuses = {self._status(self.workspace, k) for k in (a1, a2)}
        self.assertEqual(statuses & {"merged", "in_dev"}, set())
        self.assertIn("ready_dev", statuses)
        # A broken board.json fails board.run on A only; B keeps serving new tickets.
        path = os.path.join(self.workspace, ".agent-studio", "board.json")
        with open(path, "w", encoding="utf-8") as f:
            f.write("{broken")
        failed = self._call("board.run", self.workspace)
        self.assertFalse(failed["ok"])
        self.assertEqual(failed["error"]["code"], "BOARD_CONFIG_INVALID")
        created = self._call("ticket.create", other, storyPath=self.story)
        self.assertTrue(created["ok"], created)
        b3 = created["data"]["ticket"]["key"]
        self.assertEqual(b3, "T-003")
        wait_until(lambda: self._status(other, b3) == "merged",
                   timeout=int(os.environ.get("TEST_WAIT_SECONDS", "120")), message="board B merged after A failure")
        self.assertIn("ready_dev", {self._status(self.workspace, k) for k in (a1, a2)})
        # A recovers and finishes its own tickets.
        git(self.workspace, "checkout", "--", ".agent-studio/board.json")
        self.assertTrue(self._call("board.run", self.workspace)["ok"])
        wait_until(lambda: all(self._status(self.workspace, k) == "merged" for k in (a1, a2)),
                   timeout=int(os.environ.get("TEST_WAIT_SECONDS", "120")), message="board A merged after resume")
