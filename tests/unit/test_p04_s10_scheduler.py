"""P04-S10 unit tick tests: binding, the phase filter, requiresDeps, cap, busy members, and that a current
phase change mid-run lets the running ticket finish."""
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from tests import helpers
from tests.helpers import fresh, make_repo
from agent_studio import boardsched, boardmodel, teams, workflow
from agent_studio.protocol import AsError
from tests.unit.test_p04_s09_rules_and_applier import SOLO

ROLES = {"version": 1, "roles": {"worker": {}}}


def rules_board_json(**rule_extra):
    return {"version": 2, "agentTicketStatus": "build",
            "statuses": [{"id": "backlog", "kind": "initial"}, {"id": "build"}, {"id": "in-progress"},
                         {"id": "done", "kind": "done"}],
            "ticketFields": [],
            "rules": [dict({"when": {"status": "build"}, "role": "worker", "workflow": "solo",
                            "onPass": "done", "onFail": "build", "during": "in-progress"}, **rule_extra)]}


class SchedCase(unittest.TestCase):
    def setUp(self):
        self.ws = make_repo()
        self.addCleanup(helpers.reset_repo, self.ws)
        cfg = os.path.join(self.ws, ".agent-studio")
        os.makedirs(os.path.join(cfg, "workflows"), exist_ok=True)
        with open(os.path.join(cfg, "roles.json"), "w") as f:
            json.dump(ROLES, f)
        with open(os.path.join(cfg, "workflows", "solo.json"), "w") as f:
            json.dump(SOLO, f)
        self.write_board(rules_board_json())  # write_board also commits: a run needs a clean tree
        self.conn, self.store = fresh()
        self.ctx = {"stateDir": tempfile.mkdtemp(), "debug": True}
        with self.store.transaction() as tx:
            self.team = tx.create("team", {"name": "t", "workspace": self.ws})
            tx.transition("team", self.team, "running")
            self.worker = tx.create("agent", {"team_id": self.team, "ordinal": 0, "provider_id": "fake",
                                              "role": "worker", "display_name": "w", "pane_state": "alive"})
            tx.transition("agent", self.worker, "idle")
        self.bind()

    def commit_board(self):
        import subprocess
        for args in (["add", "-A"], ["commit", "-qm", "board config"]):
            subprocess.run(["git", "-C", self.ws] + args, check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def write_board(self, config):
        with open(os.path.join(self.ws, ".agent-studio", "board.json"), "w") as f:
            json.dump(config, f)
        if os.path.isdir(os.path.join(self.ws, ".git")):
            self.commit_board()

    def bind(self, team=None):
        with self.store.transaction() as tx:
            return boardsched.bind_team(tx, self.ws, team or self.team)

    def add_ticket(self, title="a", **extra):
        with self.store.transaction() as tx:
            requested = extra.pop("status", None)
            ticket = boardmodel.ticket_add(tx, self.ws, {"title": title, "priority": 100, **extra})["ticket"]
            config = boardmodel.load_config(self.ws)
            if requested is None:
                requested = config["rules"][0]["when"]["status"]
            target = config.get("upgradedFrom", {}).get(requested, requested)
            column = boardmodel.column_for(config, "backlog", target, False)
            tx.conn.execute("UPDATE tickets SET status = ?, workflow_status = ? WHERE id = ?",
                            (column, target, ticket["id"]))
            return ticket

    def ticket(self, key):
        return dict(self.conn.execute("SELECT * FROM tickets WHERE key = ?", (key,)).fetchone())

    def tick(self):
        return boardsched.tick(self.store, self.ctx)

    def finish(self, run_id, status="succeeded"):
        with self.store.transaction() as tx:
            tx.transition("workflow_run", run_id, status)

    def free_member(self):
        """Settle the claimed run's assignment and free the member (the coordinator loop does this from
        the runner's final report; a unit tick test has no loop)."""
        with self.store.transaction() as tx:
            for row in tx.conn.execute(
                    "SELECT id, status FROM assignments WHERE agent_id = ? AND status IN "
                    "('queued', 'claimed', 'running')", (self.worker,)).fetchall():
                if row["status"] == "queued":
                    tx.transition("assignment", row["id"], "claimed")
                if row["status"] in ("queued", "claimed"):
                    tx.transition("assignment", row["id"], "running")
                tx.transition("assignment", row["id"], "succeeded")
            agent = tx.get("agent", self.worker)
            if agent["availability"] != "idle":
                tx.transition("agent", self.worker, "idle")


class Binding(SchedCase):
    def test_run_board_binds_and_rules_check_gates_it(self):
        got = self.bind()
        self.assertEqual((got["board"]["status"], got["board"]["teamId"]), ("running", self.team))
        bad = rules_board_json()
        bad["rules"][0]["role"] = "nobody"
        self.write_board(bad)
        with self.assertRaises(AsError) as caught:
            self.bind()
        self.assertEqual(caught.exception.code, "BOARD_CONFIG_INVALID")

    def test_second_team_is_refused_until_stopped(self):
        with self.store.transaction() as tx:
            other = tx.create("team", {"name": "o", "workspace": self.ws})
            tx.transition("team", other, "running")
        with self.assertRaises(AsError) as caught:
            self.bind(other)
        self.assertEqual(caught.exception.code, "BOARD_ALREADY_RUNNING")
        with self.store.transaction() as tx:
            boardsched.stop_board(tx, self.ws)
        self.assertEqual(self.bind(other)["board"]["teamId"], other)

    def test_a_stopped_teams_binding_is_taken_over_by_a_new_team(self):
        self.bind()
        with self.store.transaction() as tx:
            tx.transition("team", self.team, "stopping")
            tx.transition("team", self.team, "stopped")
            fresh_team = tx.create("team", {"name": "n", "workspace": self.ws})
            tx.transition("team", fresh_team, "running")
        self.assertEqual(self.bind(fresh_team)["board"]["teamId"], fresh_team)

    def test_stop_board_stops_claims_but_applies_finished_runs(self):
        ticket = self.add_ticket()
        self.tick()
        run = self.ticket("T-001")["active_run_id"]
        self.assertIsNotNone(run)
        with self.store.transaction() as tx:
            boardsched.stop_board(tx, self.ws)
        self.add_ticket("second")
        self.tick()  # stopped: no new claims
        self.assertIsNone(self.ticket("T-002")["active_run_id"])
        self.finish(run)
        self.tick()  # ... but the finished run is still applied
        self.assertEqual(self.ticket("T-001")["workflow_status"], "merged")
        self.assertIsNone(self.ticket("T-001")["assignee"])


class TickRules(SchedCase):
    def test_structured_end_directives_apply_to_finished_runs(self):
        config = {"version": 3, "workflowStatuses": [
            {"id": "none", "kind": "initial"}, {"id": "ready"}, {"id": "working"},
            {"id": "return"}, {"id": "released"},
            {"id": "done", "kind": "done"}], "todoEntry": [],
            "todoDefault": None, "ticketFields": [], "rules": []}
        definition = {"version": 2, "startsAt": "ready", "whileRunning": "working", "role": "worker",
                      "end": {"pass": {"status": "done", "releaseCreatedTickets": {"from": "none", "to": "released"}},
                              "fail": {"status": "return", "releaseCreatedTickets": {"from": "none", "to": "released"}},
                              "blocked": {"status": "blocked", "returnTo": "return"}},
                      "stages": [{"id": "work", "role": "worker", "permission": "read_only",
                                  "prompt": "work", "next": {"done": "$succeed"}}]}
        with open(os.path.join(self.ws, '.agent-studio', 'workflows', 'board-work.json'), 'w') as f:
            json.dump(definition, f)
        self.write_board(config)
        for run_status, expected in [('succeeded', 'done'), ('failed', 'return'), ('cancelled', 'ready')]:
            with self.subTest(run_status=run_status):
                with self.store.transaction() as tx:
                    parent = boardmodel.ticket_add(tx, self.ws, {'title': 'parent', 'priority': 100})['ticket']
                    tx.conn.execute("UPDATE tickets SET status = 'todo', workflow_status = 'ready' WHERE id = ?", (parent['id'],))
                    tx.conn.execute("UPDATE board_state SET run_status = 'running' WHERE workspace = ?", (self.ws,))
                tick = self.tick()
                self.assertEqual(tick['claimed'], 1, tick)
                run = self.ticket(parent['key'])['active_run_id']
                assignment = self.conn.execute('SELECT assignment_id FROM stage_attempts WHERE workflow_run_id = ?', (run,)).fetchone()[0]
                with self.store.transaction() as tx:
                    child = boardmodel.ticket_add(tx, self.ws, {'title': 'child', 'priority': 100})['ticket']
                    tx.conn.execute('UPDATE tickets SET created_by_assignment = ?, parent_ticket_id = ? '
                                    'WHERE id = ?', (assignment, parent['id'], child['id']))
                    tx.conn.execute("UPDATE board_state SET run_status = 'stopped' WHERE workspace = ?", (self.ws,))
                self.finish(run, run_status)
                self.assertEqual(self.tick()['applied'], 1)
                row = self.ticket(parent['key'])
                self.assertEqual(row['workflow_status'], expected)
                self.assertEqual(self.ticket(child['key'])['workflow_status'],
                                 'released' if run_status == 'succeeded' else 'none')
                if run_status == 'cancelled':
                    self.assertIsNone(row['return_status'])  # cancelled releases, nothing is blocked or counted
                    self.assertIsNone(row['rounds_json'])
                self.free_member()

    def action_board(self):
        self.write_board({
            "version": 3,
            "workflowStatuses": [{"id": "none", "kind": "initial"}, {"id": "ready"}, {"id": "merging"},
                                 {"id": "merge-conflict"}, {"id": "done", "kind": "done"}],
            "todoEntry": [], "todoDefault": None, "ticketFields": [],
            "rules": [{"when": {"status": "ready"}, "during": "merging", "action": "merge",
                       "onPass": "done", "onFail": "merge-conflict"}]})

    def test_merge_conflict_uses_during_and_leaves_ticket_in_progress(self):
        self.action_board()
        self.add_ticket(status="ready")
        with self.store.transaction() as tx:
            tx.conn.execute("UPDATE tickets SET branch = ? WHERE key = ?", ("feature", "T-001"))
        with patch.object(boardsched, "_merge_hold", return_value=None), \
             patch.object(boardsched, "merge_ticket", return_value=(False, "MERGE_CONFLICT: shared.txt")):
            tick = self.tick()
        self.assertEqual(tick["errors"], [])
        self.assertEqual(tick["merged"], 1)
        row = self.ticket("T-001")
        self.assertEqual((row["workflow_status"], row["status"]), ("merge-conflict", "in-progress"))
        self.assertIsNone(row["assignee"])
        self.assertIsNone(row["active_run_id"])
        events = self.conn.execute("SELECT from_status, to_status FROM ticket_events "
                                   "WHERE name = 'ticket.workflow_changed' ORDER BY id").fetchall()
        self.assertEqual([tuple(e) for e in events], [("ready", "merging"), ("merging", "merge-conflict")])
        names = [r[0] for r in self.conn.execute(
            "SELECT name FROM ticket_events WHERE ticket_id = ? ORDER BY id", (row["id"],)).fetchall()]
        self.assertIn("ticket.merge_conflict", names)
        self.assertIn("MERGE_CONFLICT: shared.txt", row["body"])

    def test_action_only_workflow_processes_one_ticket_per_tick(self):
        self.action_board()
        self.add_ticket("first", status="ready")
        self.add_ticket("second", status="ready")
        with patch.object(boardsched, "_merge_hold", return_value=None), \
             patch.object(boardsched, "merge_ticket", return_value=(True, None)):
            first = self.tick()
            self.assertEqual((first["merged"], self.ticket("T-001")["workflow_status"],
                              self.ticket("T-002")["workflow_status"]), (1, "done", "ready"))
            second = self.tick()
        self.assertEqual((second["merged"], self.ticket("T-002")["workflow_status"]), (1, "done"))

    def test_file_action_only_workflow_merges_to_end_pass(self):
        with open(os.path.join(self.ws, ".agent-studio", "workflows", "board-merge.json"), "w") as f:
            json.dump({"version": 2, "startsAt": "ready", "whileRunning": "merging",
                       "end": {"pass": "done", "fail": "ready"},
                       "steps": [{"id": "merge", "action": "merge"}]}, f)
        self.write_board({"version": 3,
                          "workflowStatuses": [{"id": "none", "kind": "initial"}, {"id": "ready"},
                                               {"id": "merging"}, {"id": "done", "kind": "done"}],
                          "todoEntry": [], "todoDefault": None, "ticketFields": [], "rules": []})
        self.add_ticket(status="ready")
        with self.store.transaction() as tx:
            tx.conn.execute("UPDATE tickets SET branch = ? WHERE key = ?", ("feature", "T-001"))
        def merge_while_claimed(tx, workspace, ticket, config, ctx):
            row = tx.conn.execute("SELECT assignee, workflow_status FROM tickets WHERE id = ?",
                                  (ticket["id"],)).fetchone()
            self.assertEqual(tuple(row), ("coordinator", "merging"))
            return True, None

        with patch.object(boardsched, "_merge_hold", return_value=None), \
             patch.object(boardsched, "merge_ticket", side_effect=merge_while_claimed) as merge:
            tick = self.tick()
        self.assertEqual((tick["merged"], tick["errors"]), (1, []))
        row = self.ticket("T-001")
        self.assertEqual(row["workflow_status"], "done")
        self.assertEqual(json.loads(row["rounds_json"]), {"board-merge": 1})
        event = self.conn.execute("SELECT payload_json FROM ticket_events WHERE ticket_id = ? AND "
                                  "name = 'ticket.outcome_applied'", (row["id"],)).fetchone()
        self.assertEqual(json.loads(event["payload_json"])["workflow"], "board-merge")
        merge.assert_called_once()

    def test_file_action_only_merge_conflict_uses_end_fail(self):
        with open(os.path.join(self.ws, ".agent-studio", "workflows", "board-merge.json"), "w") as f:
            json.dump({"version": 2, "startsAt": "ready", "whileRunning": "merging",
                       "end": {"pass": "done", "fail": "failed"},
                       "steps": [{"id": "merge", "action": "merge"}]}, f)
        self.write_board({"version": 3,
                          "workflowStatuses": [{"id": "none", "kind": "initial"}, {"id": "ready"},
                                               {"id": "merging"}, {"id": "failed"},
                                               {"id": "done", "kind": "done"}],
                          "todoEntry": [], "todoDefault": None, "ticketFields": [], "rules": []})
        self.add_ticket(status="ready")
        with patch.object(boardsched, "_merge_hold", return_value=None), \
             patch.object(boardsched, "merge_ticket", return_value=(False, "MERGE_CONFLICT: shared.txt")):
            tick = self.tick()
        self.assertEqual((tick["merged"], tick["errors"]), (1, []))
        row = self.ticket("T-001")
        self.assertEqual((row["workflow_status"], row["assignee"], row["active_run_id"]),
                         ("failed", None, None))
        self.assertIn("MERGE_CONFLICT: shared.txt", row["body"])

    def test_action_only_check_step_runs_through_the_command_runner(self):
        with open(os.path.join(self.ws, ".agent-studio", "commands.json"), "w") as f:
            json.dump({"version": 1,
                       "commands": {"tests": {"description": "run tests", "argv": ["true"]}},
                       "checkSets": {"ci": {"run": [{"command": "tests", "when": ["**"]}],
                                            "reuseIfTested": False}}}, f)
        with open(os.path.join(self.ws, ".agent-studio", "workflows", "board-check.json"), "w") as f:
            json.dump({"version": 2, "startsAt": "ready", "whileRunning": "checking",
                       "end": {"pass": "done", "fail": "ready"},
                       "steps": [{"id": "check", "check": {"checks": "ci"}}]}, f)
        self.write_board({"version": 3,
                          "workflowStatuses": [{"id": "none", "kind": "initial"}, {"id": "ready"},
                                               {"id": "checking"}, {"id": "done", "kind": "done"}],
                          "todoEntry": [], "todoDefault": None, "ticketFields": [], "rules": []})
        self.add_ticket(status="ready")
        with patch.object(boardsched.delegation, "spawn", return_value={"pid": 123}), \
             patch.object(boardsched.delegation, "result", return_value={"passed": True, "exitCode": 0}), \
             patch.object(boardsched.delegation, "changed_paths", return_value=["app/main.py"]):
            tick = self.tick()
        self.assertEqual((tick["merged"], tick["errors"]), (1, []))
        self.assertEqual(self.ticket("T-001")["workflow_status"], "done")
        request = self.conn.execute("SELECT command_id, status, reason FROM command_requests").fetchone()
        self.assertEqual(tuple(request), ("tests", "succeeded", "workflow check"))

    def test_routing_claim_and_start_failure_return_workflow(self):
        self.write_board({"version": 3, "workflowStatuses": [
            {"id": "none", "kind": "initial"}, {"id": "dev-ready"}, {"id": "deving"},
            {"id": "merged", "kind": "done"}], "todoEntry": ["dev-ready"],
            "todoDefault": "dev-ready", "ticketFields": [], "rules": [{"when": {"status": "dev-ready"},
            "during": "deving", "role": "worker", "workflow": "solo", "onPass": "merged", "onFail": "dev-ready"}]})
        self.add_ticket("backlog", status="none")
        self.add_ticket("ready")
        with patch("agent_studio.boardsched._start", side_effect=AsError("START_FAILED", "failed")):
            self.tick()
        self.assertEqual((self.ticket("T-001")["status"], self.ticket("T-001")["assignee"]), ("backlog", None))
        failed = self.ticket("T-002")
        self.assertEqual((failed["status"], failed["workflow_status"], failed["assignee"]),
                         ("in-progress", "dev-ready", None))
        self.tick()
        claimed = self.ticket("T-002")
        self.assertEqual((claimed["status"], claimed["workflow_status"], claimed["assignee"]),
                         ("in-progress", "deving", self.worker))
        event = self.conn.execute("SELECT from_status, to_status, payload_json FROM ticket_events "
                                  "WHERE ticket_id = ? AND name = 'ticket.claimed'", (claimed["id"],)).fetchone()
        self.assertEqual((event["from_status"], event["to_status"]), ("dev-ready", "deving"))
        self.assertEqual(json.loads(event["payload_json"])["rule"], "dev-ready")

        payload = json.loads(event["payload_json"])
        self.assertEqual(payload, {"ticketId": claimed["id"], "key": "T-002", "agentId": self.worker,
                                   "run": claimed["active_run_id"], "rule": "dev-ready", "workspace": None})

    def test_picker_keeps_priority_order_and_skips_non_todo_columns(self):
        self.write_board({"version": 3, "workflowStatuses": [
            {"id": "none", "kind": "initial"}, {"id": "dev-ready"}, {"id": "deving"},
            {"id": "merged", "kind": "done"}], "todoEntry": ["dev-ready"],
            "todoDefault": "dev-ready", "ticketFields": [], "rules": [{"when": {"status": "dev-ready"},
            "during": "deving", "role": "worker", "workflow": "solo", "onPass": "merged", "onFail": "dev-ready"}]})
        self.add_ticket("first priority", priority=1)
        self.add_ticket("second priority", priority=20)
        self.add_ticket("backlog", status="none", priority=0)

        result = self.tick()

        self.assertEqual((result["claimed"], result["errors"]), (1, []))
        self.assertEqual(self.ticket("T-001")["workflow_status"], "deving")
        self.assertIsNone(self.ticket("T-002")["active_run_id"])
        self.assertIsNone(self.ticket("T-003")["active_run_id"])

    def test_deps_and_cap_use_columns_and_workflow_status(self):
        dep = self.add_ticket("dep")
        waiting = self.add_ticket("waiting")
        config = boardmodel.load_config(self.ws)
        rule = config["rules"][0]
        with self.store.transaction() as tx:
            boardmodel.ticket_depend(tx, self.ws, {"key": "T-002", "on": ["T-001"], "remove": []})
            tx.conn.execute("UPDATE tickets SET status = 'done', workflow_status = ? WHERE id = ?", (rule["when"]["status"], dep["id"]))
            self.assertEqual(boardsched._deps_open(tx, waiting["id"], config), 0)
            tx.conn.execute("UPDATE tickets SET status = 'closed', workflow_status = ? WHERE id = ?", (rule["during"], dep["id"]))
            self.assertEqual(boardsched._deps_open(tx, waiting["id"], config), 0)
            tx.conn.execute("UPDATE tickets SET status = 'in-progress', workflow_status = ?, assignee = ? WHERE id = ?", (rule["during"], self.worker, dep["id"]))
            self.assertEqual(boardsched._deps_open(tx, waiting["id"], config), 1)
            self.assertEqual(boardsched._claiming_workflow(tx, self.ws, dict(tx.conn.execute("SELECT * FROM tickets WHERE id = ?", (dep["id"],)).fetchone()))["startsAt"], rule["when"]["status"])

    @patch("agent_studio.providers.probe_many", return_value={"fake": {"available": True}})
    def test_quota_failover_reclaims_ticket_with_fallback_agent(self, probe):
        config = os.path.join(self.ws, ".agent-studio")
        os.makedirs(os.path.join(config, "teams"), exist_ok=True)
        with open(os.path.join(config, "agents.json"), "w") as f:
            json.dump({"version": 1, "agents": [
                {"id": "first", "name": "First", "provider": "fake", "model": "fake-1"},
                {"id": "backup", "name": "Backup", "provider": "fake", "model": "fake-2"}]}, f)
        with open(os.path.join(config, "teams", "t.json"), "w") as f:
            json.dump({"id": "t", "name": "Team", "members": [
                {"id": "worker", "name": "Worker", "role": "worker", "agents": ["first", "backup"]}]}, f)
        self.commit_board()
        with self.store.transaction() as tx:
            tx.update("team", self.team, {"def_id": "t"}, "team.definition_set")
            tx.update("agent", self.worker, {"member_id": "worker", "active_catalog_agent": "first",
                                              "model": "fake-1"}, "agent.option_set")
        self.add_ticket()
        self.tick()
        original = self.ticket("T-001")["active_run_id"]
        assignment = self.conn.execute("SELECT assignment_id FROM stage_attempts WHERE workflow_run_id = ?",
                                       (original,)).fetchone()[0]
        with self.store.transaction() as tx:
            tx.transition("assignment", assignment, "failed", set_values={
                "diagnostic_code": "USAGE_LIMIT", "result_json": {"diagnosticCode": "USAGE_LIMIT"}})
            tx.transition("agent", self.worker, "busy")
            tx.transition("agent", self.worker, "limit_reached")
            teams.handle_quota_limit(tx, self.worker, None, self.ctx)
        workflow.advance(self.store, self.ctx)
        tick = self.tick()
        self.assertEqual(tick["errors"], [])
        replacement = self.ticket("T-001")["active_run_id"]
        self.assertNotEqual(original, replacement)
        row = self.conn.execute("SELECT a.request_json FROM assignments a JOIN stage_attempts s ON s.assignment_id = a.id "
                                "WHERE s.workflow_run_id = ?", (replacement,)).fetchone()
        self.assertEqual(json.loads(row["request_json"])["model"], "fake-2")

    def test_paused_quota_failure_is_released_and_claimed_again(self):
        self.add_ticket()
        self.tick()
        original = self.ticket("T-001")["active_run_id"]
        assignment = self.conn.execute("SELECT assignment_id FROM stage_attempts WHERE workflow_run_id = ?",
                                       (original,)).fetchone()[0]
        with self.store.transaction() as tx:
            tx.transition("assignment", assignment, "failed", set_values={
                "diagnostic_code": "USAGE_LIMIT", "result_json": {"diagnosticCode": "USAGE_LIMIT"}})
        workflow.advance(self.store, self.ctx)
        self.assertEqual(self.conn.execute("SELECT status FROM workflow_runs WHERE id = ?", (original,)).fetchone()[0],
                         "paused")
        tick = self.tick()
        self.assertEqual(tick["errors"], [])
        self.assertEqual((tick["applied"], tick["claimed"]), (1, 1))
        self.assertNotEqual(self.ticket("T-001")["active_run_id"], original)
        self.assertEqual(self.conn.execute("SELECT status FROM workflow_runs WHERE id = ?", (original,)).fetchone()[0],
                         "failed")
        self.assertIsNone(self.ticket("T-001")["rounds_json"])
        names = [r[0] for r in self.conn.execute("SELECT name FROM ticket_events ORDER BY id").fetchall()]
        self.assertEqual(names, ["ticket.created", "ticket.workflow_changed", "ticket.claimed", "ticket.workflow_changed", "ticket.run_paused", "ticket.workflow_changed", "ticket.claimed"])

    def test_other_infrastructure_pause_is_released_and_reclaimed(self):
        self.add_ticket()
        self.tick()
        original = self.ticket("T-001")["active_run_id"]
        assignment = self.conn.execute("SELECT assignment_id FROM stage_attempts WHERE workflow_run_id = ?",
                                       (original,)).fetchone()[0]
        with self.store.transaction() as tx:
            tx.transition("assignment", assignment, "failed", set_values={
                "diagnostic_code": "PROVIDER_ERROR", "result_json": {"diagnosticCode": "PROVIDER_ERROR"}})
        workflow.advance(self.store, self.ctx)
        tick = self.tick()
        self.assertEqual(tick["errors"], [])
        ticket = self.ticket("T-001")
        self.assertNotEqual(ticket["active_run_id"], original)  # released, then a free member claimed it again
        self.assertIsNone(ticket["rounds_json"])
        self.assertEqual(self.conn.execute("SELECT status FROM workflow_runs WHERE id = ?", (original,)).fetchone()[0],
                         "failed")
        names = [r[0] for r in self.conn.execute("SELECT name FROM ticket_events ORDER BY id").fetchall()]
        self.assertIn("ticket.run_paused", names)

    def test_paused_quota_failure_after_team_stop_releases_claim(self):
        self.add_ticket()
        self.tick()
        original = self.ticket("T-001")["active_run_id"]
        wf = self.conn.execute("SELECT task_id FROM workflow_runs WHERE id = ?", (original,)).fetchone()
        assignment = self.conn.execute("SELECT assignment_id FROM stage_attempts WHERE workflow_run_id = ?",
                                       (original,)).fetchone()[0]
        with self.store.transaction() as tx:
            tx.transition("assignment", assignment, "failed", set_values={
                "diagnostic_code": "USAGE_LIMIT", "result_json": {"diagnosticCode": "USAGE_LIMIT"}})
        workflow.advance(self.store, self.ctx)
        with self.store.transaction() as tx:
            tx.transition("task", wf["task_id"], "cancelled")
            boardsched.stop_board(tx, self.ws)
        tick = self.tick()
        self.assertEqual(tick["errors"], [])
        self.assertIsNone(self.ticket("T-001")["active_run_id"])
        self.assertEqual(self.conn.execute("SELECT status FROM tasks WHERE id = ?", (wf["task_id"],)).fetchone()[0],
                         "cancelled")

    def test_backfilled_ticket_is_claimed_and_outcome_updates_workflow(self):
        self.add_ticket()
        result = self.tick()
        self.assertEqual((result["claimed"], result["errors"]), (1, []))
        row = self.ticket("T-001")
        config = boardmodel.load_config(self.ws)
        self.assertEqual(row["workflow_status"], config["rules"][0]["during"])
        self.assertEqual(row["status"], "in-progress")
        self.finish(row["active_run_id"])
        self.tick()
        row = self.ticket("T-001")
        self.assertEqual((row["workflow_status"], row["status"]),
                         (config["rules"][0]["onPass"], "done"))

    def test_claims_by_rule_with_lease_during_status_and_event(self):
        self.add_ticket()
        out = self.tick()
        self.assertEqual((out["claimed"], out["errors"]), (1, []))
        row = self.ticket("T-001")
        self.assertEqual((row["status"], row["assignee"]), ("in-progress", self.worker))
        self.assertIsNotNone(row["active_run_id"])
        self.assertIsNone(row["lease_until"])  # the claim lease ends once the workflow has started
        run = self.conn.execute("SELECT id, status FROM workflow_runs WHERE id = ?",
                                (row["active_run_id"],)).fetchone()
        self.assertEqual(run["status"], "running")
        names = [e["name"] for e in self.conn.execute(
            "SELECT name FROM ticket_events ORDER BY id").fetchall()]
        self.assertEqual(names, ["ticket.created", "ticket.workflow_changed", "ticket.claimed"])
        assignment = self.conn.execute("SELECT agent_id FROM assignments ORDER BY created_at DESC").fetchone()
        self.assertEqual(assignment["agent_id"], self.worker)

    def test_worktree_rule_holds_created_tickets_until_its_merge_action_passes(self):
        old_state_home = os.environ.get("XDG_STATE_HOME")
        state_home = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, state_home, True)
        os.environ["XDG_STATE_HOME"] = state_home
        if old_state_home is None:
            self.addCleanup(os.environ.pop, "XDG_STATE_HOME", None)
        else:
            self.addCleanup(os.environ.__setitem__, "XDG_STATE_HOME", old_state_home)
        self.ctx["stateDir"] = os.path.join(state_home, "agent-studio")
        base_branch = subprocess.run(
            ["git", "-C", self.ws, "symbolic-ref", "--short", "HEAD"], check=True,
            stdout=subprocess.PIPE, text=True).stdout.strip()
        self.write_board({
            "version": 2,
            "baseBranch": base_branch,
            "agentTicketStatus": "unpack-ready",
            "statuses": [{"id": "backlog", "kind": "initial"}, {"id": "unpack-ready"},
                         {"id": "plan-merge-ready"}, {"id": "refine-ready"},
                         {"id": "done", "kind": "done"}],
            "ticketFields": [],
            "rules": [
                {"when": {"status": "unpack-ready"}, "role": "worker", "workflow": "solo",
                 "workspace": "worktree", "createdTicketStatus": "backlog",
                 "onPass": "plan-merge-ready", "onFail": "backlog"},
                {"when": {"status": "plan-merge-ready"}, "action": "merge", "onPass": "done",
                 "onFail": "unpack-ready",
                 "onPassCreatedTickets": {"from": "backlog", "to": "refine-ready"}}
            ]})
        with self.store.transaction() as tx:
            tx.conn.execute("UPDATE agents SET can_add_tickets = 1 WHERE id = ?", (self.worker,))
        self.add_ticket("feature", status="unpack-ready")
        started = self.tick()
        self.assertEqual(started["errors"], [])
        events = [dict(r) for r in self.conn.execute(
            "SELECT name, payload_json FROM ticket_events ORDER BY id").fetchall()]
        self.assertEqual(started["claimed"], 1, events)
        parent = self.ticket("T-001")
        assignment = self.conn.execute(
            "SELECT assignment_id FROM stage_attempts WHERE workflow_run_id = ?",
            (parent["active_run_id"],)).fetchone()[0]
        with open(os.path.join(parent["worktree_path"], "plan.md"), "w") as f:
            f.write("planned in isolation\n")
        with self.store.transaction() as tx:
            child = boardmodel.mcp_ticket_add(
                tx, parent["worktree_path"],
                {"assignment": assignment, "title": "first story", "priority": 100})["ticket"]
            unchanged = boardmodel.mcp_ticket_add(
                tx, parent["worktree_path"],
                {"assignment": assignment, "title": "already triaged", "priority": 100})["ticket"]
            boardmodel.set_workflow(tx, boardmodel.get_ticket(tx.conn, self.ws, unchanged["key"]),
                                    "unpack-ready", "operator", None, boardmodel.load_config(self.ws))
        self.assertEqual((child["workspace"], child["workflowStatus"], child["status"]), (self.ws, "none", "backlog"))
        self.assertEqual((unchanged["workflowStatus"], unchanged["status"]), ("none", "backlog"))
        self.assertFalse(os.path.exists(os.path.join(self.ws, "plan.md")))

        self.finish(parent["active_run_id"])
        self.tick()  # apply the run, merge its branch, then release only tickets created by that parent
        self.assertEqual((self.ticket("T-001")["workflow_status"], self.ticket("T-001")["status"]), ("merged", "done"))
        self.assertEqual((self.ticket("T-002")["workflow_status"], self.ticket("T-002")["status"]), ("refine-ready", "todo"))
        self.assertEqual((self.ticket("T-003")["workflow_status"], self.ticket("T-003")["status"]),
                         ("unpack-ready", "todo"))
        self.assertTrue(os.path.exists(os.path.join(self.ws, "plan.md")))
        child_events = [r[0] for r in self.conn.execute(
            "SELECT name FROM ticket_events WHERE ticket_id = ? ORDER BY id", (child["id"],)).fetchall()]
        self.assertEqual(child_events, ["ticket.created", "ticket.workflow_changed"])

    def test_only_the_effective_current_phase_is_claimed(self):
        with self.store.transaction() as tx:
            boardmodel.phase_add(tx, self.ws, {"id": "later", "name": "Later"})
        self.add_ticket("in default")
        self.add_ticket("in later", phase="later")
        self.tick()
        self.assertIsNotNone(self.ticket("T-001")["active_run_id"])  # default is current when no pointer
        self.assertIsNone(self.ticket("T-002")["active_run_id"])
        self.finish(self.ticket("T-001")["active_run_id"])
        self.free_member()
        with self.store.transaction() as tx:
            boardmodel.phase_set_current(tx, self.ws, {"phase": "later"})
        self.tick()  # first ticket finishes; new claims use the new current phase
        self.assertEqual(self.ticket("T-001")["workflow_status"], "merged")
        self.assertIsNotNone(self.ticket("T-002")["active_run_id"])

    def test_current_phase_change_leaves_the_running_ticket_alone(self):
        with self.store.transaction() as tx:
            boardmodel.phase_add(tx, self.ws, {"id": "later", "name": "Later"})
        self.add_ticket()
        self.tick()
        before = self.ticket("T-001")
        with self.store.transaction() as tx:
            boardmodel.phase_set_current(tx, self.ws, {"phase": "later"})
        after = self.ticket("T-001")
        self.assertEqual((before["status"], before["active_run_id"], before["assignee"]),
                         (after["status"], after["active_run_id"], after["assignee"]))
        self.finish(before["active_run_id"])
        self.tick()  # the outcome still applies by the claiming rule (the during status)
        self.assertEqual(self.ticket("T-001")["workflow_status"], "merged")

    def test_requires_deps(self):
        self.write_board(rules_board_json(requiresDeps=True))
        self.add_ticket("dep")
        self.add_ticket("waiting")
        with self.store.transaction() as tx:
            boardmodel.ticket_depend(tx, self.ws, {"key": "T-002", "on": ["T-001"], "remove": []})
        self.tick()  # claims the dependency itself; the dependent waits
        self.assertIsNone(self.ticket("T-002")["active_run_id"])
        self.finish(self.ticket("T-001")["active_run_id"])
        self.free_member()
        self.tick()  # the dependency reaches done and releases its claim; the dependent is claimed
        self.assertEqual(self.ticket("T-001")["workflow_status"], "merged")
        self.assertIsNotNone(self.ticket("T-002")["active_run_id"])

    def test_no_cap_and_no_preferred_agent_reservation(self):
        config = {"version": 3, "workflowStatuses": [
            {"id": "none", "kind": "initial"}, {"id": "ready"}, {"id": "working"},
            {"id": "done", "kind": "done"}], "todoEntry": [],
            "todoDefault": None, "ticketFields": [], "rules": []}
        definition = {"version": 2, "startsAt": "ready", "whileRunning": "working", "role": "worker",
                      "priority": 3, "workspace": "main", "syncBase": False,
                      "waitForDependencies": False, "end": {"pass": "done", "fail": "ready"},
                      "stages": [{"id": "work", "role": "worker", "permission": "read_only",
                                  "prompt": "work", "next": {"done": "$succeed"}}]}
        with open(os.path.join(self.ws, '.agent-studio', 'workflows', 'board-work.json'), 'w') as f:
            json.dump(definition, f)
        self.write_board(config)
        with self.store.transaction() as tx:
            other = tx.create("agent", {"team_id": self.team, "ordinal": 1, "provider_id": "fake",
                                        "role": "worker", "display_name": "other", "pane_state": "alive"})
            tx.transition("agent", other, "idle")
            tickets = [boardmodel.ticket_add(tx, self.ws, {"title": title, "priority": priority})['ticket']
                       for title, priority in (("one", 10), ("two", 20))]
            for ticket in tickets:
                tx.conn.execute("UPDATE tickets SET status = 'todo', workflow_status = 'ready' WHERE id = ?",
                                (ticket['id'],))
        self.conn.execute("UPDATE tickets SET preferred_agent_id = ? WHERE key = 'T-001'", ('unavailable',))
        def fake_start(tx, args, ctx):
            task = tx.create('task', {'team_id': self.team, 'origin': 'workflow', 'workspace': self.ws, 'goal': 'test'})
            run = tx.create('workflow_run', {'team_id': self.team, 'task_id': task, 'workflow': args['definition']})
            return {'workflowRunId': run}
        with patch.object(boardsched.tasks, '_mutating_in_workspace', return_value=False), \
             patch.object(boardsched.worktrees, 'is_clean', return_value=True), \
             patch.object(boardsched, '_start', side_effect=fake_start):
            self.assertEqual(self.tick()['claimed'], 2)
        self.assertEqual({self.ticket(k)['assignee'] for k in ('T-001', 'T-002')}, {self.worker, other})

    def test_board_workflow_waits_for_open_dependencies(self):
        config = {"version": 3, "workflowStatuses": [
            {"id": "none", "kind": "initial"}, {"id": "ready"}, {"id": "working"},
            {"id": "done", "kind": "done"}], "todoEntry": [],
            "todoDefault": None, "ticketFields": [], "rules": []}
        definition = {"version": 2, "startsAt": "ready", "whileRunning": "working", "role": "worker",
                      "priority": 3, "workspace": "main", "syncBase": False,
                      "waitForDependencies": True, "end": {"pass": "done", "fail": "ready"},
                      "stages": [{"id": "work", "role": "worker", "permission": "read_only",
                                  "prompt": "work", "next": {"done": "$succeed"}}]}
        with open(os.path.join(self.ws, '.agent-studio', 'workflows', 'board-work.json'), 'w') as f:
            json.dump(definition, f)
        self.write_board(config)
        with self.store.transaction() as tx:
            dependency = boardmodel.ticket_add(tx, self.ws, {"title": "dependency", "priority": 100})['ticket']
            blocked = boardmodel.ticket_add(tx, self.ws, {"title": "blocked", "priority": 100})['ticket']
            for ticket in (dependency, blocked):
                tx.conn.execute("UPDATE tickets SET status = 'todo', workflow_status = 'ready' WHERE id = ?",
                                (ticket['id'],))
            boardmodel.ticket_depend(tx, self.ws, {"key": blocked['key'], "on": [dependency['key']], "remove": []})

        def fake_start(tx, args, ctx):
            task = tx.create('task', {'team_id': self.team, 'origin': 'workflow', 'workspace': self.ws, 'goal': 'test'})
            run = tx.create('workflow_run', {'team_id': self.team, 'task_id': task, 'workflow': args['definition']})
            return {'workflowRunId': run}

        with patch.object(boardsched.tasks, '_mutating_in_workspace', return_value=False), \
             patch.object(boardsched.worktrees, 'is_clean', return_value=True), \
             patch.object(boardsched, '_start', side_effect=fake_start):
            self.assertEqual(self.tick()['claimed'], 1)
            self.assertIsNone(self.ticket(blocked['key'])['assignee'])
            with self.store.transaction() as tx:
                tx.conn.execute("UPDATE tickets SET status = 'done' WHERE id = ?", (dependency['id'],))
            self.assertEqual(self.tick()['claimed'], 0)  # the only member remains occupied by the dependency
            with self.store.transaction() as tx:
                tx.conn.execute("UPDATE tickets SET assignee = NULL, active_run_id = NULL WHERE id = ?",
                                (dependency['id'],))
            self.assertEqual(self.tick()['claimed'], 1)
        self.assertIsNotNone(self.ticket(blocked['key'])['assignee'])

    def test_workflow_order_problems_and_action_only(self):
        workflows = [dict(name='z', startsAt='z', whileRunning='zr', role='worker', priority=1),
                     dict(name='b', startsAt='b', whileRunning='br', role='worker', priority=1),
                     dict(name='a', startsAt='a', whileRunning='ar', role='worker', priority=0),
                     dict(name='bad', startsAt='bad', whileRunning='bad-run', role='worker', priority=0),
                     dict(name='action', startsAt='action', whileRunning='action-run', role=None, priority=0)]
        index = {'workflows': workflows, 'problems': [{'workflow': 'bad', 'path': 'role', 'message': 'bad role'}]}
        seen = []
        def pick(tx, workspace, wf, config, current):
            seen.append(wf['name'])
            return None
        with self.store.transaction() as tx, patch.object(boardsched.boardworkflows, 'load', return_value=index), \
             patch.object(boardsched, '_pick_ticket', side_effect=pick):
            claimed, errors = boardsched._claim(tx, self.ws, {'id': self.team}, {}, self.ctx)
        self.assertEqual(claimed, 0)
        self.assertEqual(seen, ['a', 'b', 'z'])
        self.assertEqual([(e['workflow'], e['path']) for e in errors], [('bad', 'role')])

    def test_board_workflow_definition_claims_and_starts_by_name(self):
        config = {"version": 3, "workflowStatuses": [
            {"id": "none", "kind": "initial"}, {"id": "ready"}, {"id": "working"},
            {"id": "done", "kind": "done"}], "todoEntry": [],
            "todoDefault": None, "ticketFields": [], "rules": []}
        definition = {"version": 2, "startsAt": "ready", "whileRunning": "working", "role": "worker",
                      "priority": 3, "workspace": "main", "syncBase": False, "waitForDependencies": True,
                      "end": {"pass": "done", "fail": "ready"},
                      "stages": [{"id": "work", "role": "worker", "permission": "read_only",
                                  "prompt": "work", "next": {"done": "$succeed"}}]}
        with open(os.path.join(self.ws, '.agent-studio', 'workflows', 'board-work.json'), 'w') as f:
            json.dump(definition, f)
        self.write_board(config)
        with self.store.transaction() as tx:
            ticket = boardmodel.ticket_add(tx, self.ws, {'title': 'board workflow', 'priority': 100})['ticket']
            tx.conn.execute("UPDATE tickets SET status = 'todo', workflow_status = 'ready' WHERE id = ?", (ticket['id'],))
        with patch.object(boardsched, '_start', return_value={'workflowRunId': 'run'}) as start:
            result = self.tick()
        self.assertEqual((result['claimed'], result['errors']), (1, []))
        self.assertEqual(start.call_args.args[1]['definition'], 'board-work')
        self.assertEqual(self.ticket(ticket['key'])['workflow_status'], 'working')

    def test_main_workflow_waits_when_busy_or_dirty(self):
        self.write_board(rules_board_json(workspace='main'))
        self.add_ticket()
        with patch.object(boardsched.tasks, '_mutating_in_workspace', return_value=True):
            self.assertEqual(self.tick()['claimed'], 0)
        with patch.object(boardsched.tasks, '_mutating_in_workspace', return_value=False), \
             patch.object(boardsched.worktrees, 'is_clean', return_value=False):
            self.assertEqual(self.tick()['claimed'], 0)
        self.assertIsNone(self.ticket('T-001')['assignee'])

    def test_board_workflow_waits_when_main_checkout_is_busy_or_dirty(self):
        config = {"version": 3, "workflowStatuses": [
            {"id": "none", "kind": "initial"}, {"id": "ready"}, {"id": "working"},
            {"id": "done", "kind": "done"}], "todoEntry": [],
            "todoDefault": None, "ticketFields": [], "rules": []}
        definition = {"version": 2, "startsAt": "ready", "whileRunning": "working", "role": "worker",
                      "workspace": "main", "syncBase": False,
                      "end": {"pass": "done", "fail": "ready"},
                      "stages": [{"id": "work", "role": "worker", "permission": "read_only",
                                  "prompt": "work", "next": {"done": "$succeed"}}]}
        with open(os.path.join(self.ws, '.agent-studio', 'workflows', 'board-work.json'), 'w') as f:
            json.dump(definition, f)
        self.write_board(config)
        with self.store.transaction() as tx:
            ticket = boardmodel.ticket_add(tx, self.ws, {"title": "board workflow", "priority": 100})['ticket']
            tx.conn.execute("UPDATE tickets SET status = 'todo', workflow_status = 'ready' WHERE id = ?",
                            (ticket['id'],))

        with patch.object(boardsched.tasks, '_mutating_in_workspace', return_value=True):
            self.assertEqual(self.tick()['claimed'], 0)
        with patch.object(boardsched.tasks, '_mutating_in_workspace', return_value=False), \
             patch.object(boardsched.worktrees, 'is_clean', return_value=False):
            self.assertEqual(self.tick()['claimed'], 0)
        self.assertIsNone(self.ticket(ticket['key'])['assignee'])
        self.assertIsNone(self.ticket(ticket['key'])['active_run_id'])

    def test_busy_member_is_never_claimed(self):
        self.add_ticket()
        with self.store.transaction() as tx:  # the member already runs something else
            task = tx.create("task", {"team_id": self.team, "origin": "direct", "workspace": self.ws,
                                      "goal": "ask"})
            tx.transition("task", task, "assigned")
            tx.create("assignment", {"team_id": self.team, "task_id": task, "agent_id": self.worker,
                                     "attempt": 1, "policy": "read_only", "provider_id": "fake"},
                      state="queued")
        out = self.tick()
        self.assertEqual(out["claimed"], 0)
        self.assertIsNone(self.ticket("T-001")["assignee"])


class WorktreeRegistration(SchedCase):
    """§F restored: a run workspace is accepted only while it is a claimed ticket's registered worktree."""

    def test_registered_worktree_rules(self):
        from agent_studio import tasks as tasks_mod
        from agent_studio.protocol import AsError

        self.add_ticket()
        state_home = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, state_home, True)
        self.enterContext(patch.dict(os.environ, {"XDG_STATE_HOME": state_home}))
        worktree = os.path.join(tempfile.mkdtemp(), "T-001")
        self.conn.execute("UPDATE tickets SET assignee = ?, worktree_path = ?, branch = 'ticket/T-001-a' "
                          "WHERE key = 'T-001'", (self.worker, worktree))
        team = dict(self.conn.execute("SELECT * FROM teams WHERE id = ?", (self.team,)).fetchone())
        for path, why in ((worktree, "not a worktree git lists"), (worktree + "-other", "another path")):
            with self.store.transaction() as tx:
                with self.assertRaises(AsError) as caught:
                    tasks_mod.run_workspace(tx, team, path)
                self.assertEqual(caught.exception.code, "WORKTREE_NOT_REGISTERED", why)
        self.conn.execute("UPDATE tickets SET assignee = NULL WHERE key = 'T-001'")  # released: not live
        with self.store.transaction() as tx:
            with self.assertRaises(AsError) as caught:
                tasks_mod.run_workspace(tx, team, worktree)
            self.assertEqual(caught.exception.code, "WORKTREE_NOT_REGISTERED")


class WorkflowMergeAction(SchedCase):
    def start_action(self, linked=True):
        path = os.path.join(self.ws, '.agent-studio', 'workflows', 'merge.json')
        with open(path, 'w') as f:
            json.dump({'version': 2, 'steps': [{'id': 'merge', 'action': 'merge'}]}, f)
        if subprocess.run(['git', '-C', self.ws, 'status', '--porcelain'], stdout=subprocess.PIPE).stdout:
            self.commit_board()
        ticket = self.add_ticket()
        with self.store.transaction() as tx:
            run = workflow._start_definition(tx, {'teamId': self.team, 'definition': 'merge', 'text': 'merge'}, self.ctx)
            if linked:
                tx.conn.execute('UPDATE tickets SET active_run_id = ? WHERE id = ?',
                                (run['workflowRunId'], ticket['id']))
        return run['workflowRunId']

    def assert_action_route(self, passed, reason, status):
        run = self.start_action()
        attempt = self.conn.execute('SELECT * FROM stage_attempts WHERE workflow_run_id = ?', (run,)).fetchone()
        self.assertEqual((attempt['stage_type'], attempt['status'], attempt['phase']), ('action', 'active', 'acting'))
        self.assertIsNone(attempt['prompt_path'])
        with patch.object(boardsched, 'merge_ticket', return_value=(passed, reason)) as merge:
            with self.store.transaction() as tx:
                self.assertTrue(workflow._advance_one(tx, run, self.ctx))
                self.assertEqual(tx.get('workflow_run', run)['status'], status)
                attempt = tx.conn.execute('SELECT * FROM stage_attempts WHERE workflow_run_id = ?', (run,)).fetchone()
                self.assertIsNone(attempt['assignment_id'])
                self.assertEqual((attempt['phase'], attempt['status'], attempt['outcome']),
                                 ('done', 'completed', 'validation_passed' if passed else 'validation_failed'))
                self.assertEqual(json.loads(attempt['verdict_json'])['findings'], [reason] if reason else [])
            merge.assert_called_once()

    def test_action_routes_pass_without_assignment(self):
        self.assert_action_route(True, None, 'succeeded')

    def test_action_routes_fail_without_assignment(self):
        self.assert_action_route(False, 'MERGE_CONFLICT: x', 'failed')

    def test_action_without_ticket_pauses_with_error(self):
        run = self.start_action(linked=False)
        with self.store.transaction() as tx:
            workflow._advance_one(tx, run, self.ctx)
            self.assertEqual(tx.get('workflow_run', run)['status'], 'paused')
            event = tx.conn.execute("SELECT payload_json FROM events WHERE entity_id = ? AND name = 'workflow_run.paused' ORDER BY seq DESC", (run,)).fetchone()
            self.assertEqual(json.loads(event[0])['diagnosticCode'], 'ACTION_NO_TICKET')

    def test_merge_ticket_clean_and_conflict(self):
        ticket = self.add_ticket()
        def git(*args, cwd=None):
            return subprocess.run(['git', '-C', cwd or self.ws, *args], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        with open(os.path.join(self.ws, 'shared'), 'w') as f:
            f.write('base\n')
        git('add', 'shared')
        git('commit', '-qm', 'base')
        from agent_studio import worktrees
        created = worktrees.create(self.ws, ticket['key'], 'merge', git('symbolic-ref', '--short', 'HEAD').stdout.decode().strip(), state_dir=self.ctx['stateDir'])
        branch_dir = created['path']
        with open(os.path.join(branch_dir, 'shared'), 'w') as f:
            f.write('branch\n')
        git('commit', '-qam', 'branch', cwd=branch_dir)
        with open(os.path.join(self.ws, 'shared'), 'w') as f:
            f.write('main\n')
        git('commit', '-qam', 'main')
        config = boardmodel.load_config(self.ws)
        config['baseBranch'] = git('symbolic-ref', '--short', 'HEAD').stdout.decode().strip()
        with self.store.transaction() as tx:
            tx.conn.execute('UPDATE tickets SET branch = ?, worktree_path = ? WHERE id = ?', (created['branch'], branch_dir, ticket['id']))
            row = boardmodel.get_ticket(tx.conn, self.ws, ticket['key'])
            passed, reason = boardsched.merge_ticket(tx, self.ws, row, config, self.ctx)
            self.assertFalse(passed)
            self.assertIn('shared', reason)
            self.assertTrue(os.path.isdir(branch_dir))
            self.assertIsNone(tx.conn.execute('SELECT merged_commit FROM tickets WHERE id = ?', (ticket['id'],)).fetchone()[0])
        git('revert', '--no-edit', 'HEAD')
        with self.store.transaction() as tx:
            row = boardmodel.get_ticket(tx.conn, self.ws, ticket['key'])
            self.assertEqual(boardsched.merge_ticket(tx, self.ws, row, config, self.ctx), (True, None))
            updated = tx.conn.execute('SELECT merged_commit, worktree_path FROM tickets WHERE id = ?', (ticket['id'],)).fetchone()
            self.assertEqual(updated['merged_commit'], git('rev-parse', 'HEAD').stdout.decode().strip())
            self.assertIsNone(updated['worktree_path'])

    def test_merge_ticket_without_branch_fails_without_touching_checkout(self):
        ticket = self.add_ticket()
        config = boardmodel.load_config(self.ws)
        config['baseBranch'] = subprocess.run(
            ['git', '-C', self.ws, 'symbolic-ref', '--short', 'HEAD'], check=True,
            stdout=subprocess.PIPE).stdout.decode().strip()
        with self.store.transaction() as tx:
            row = boardmodel.get_ticket(tx.conn, self.ws, ticket['key'])
            self.assertEqual(boardsched.merge_ticket(tx, self.ws, row, config, self.ctx),
                             (False, 'MERGE_NO_BRANCH'))
            self.assertIsNone(tx.conn.execute('SELECT merged_commit FROM tickets WHERE id = ?',
                                              (ticket['id'],)).fetchone()[0])
