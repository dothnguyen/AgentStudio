"""Board run results: pass, fail, blocked, paused, cancelled (T-200)."""
import json
import unittest

from tests import helpers  # noqa: F401  (puts backend on sys.path)
from agent_studio import boardmodel
from agent_studio.protocol import AsError
from tests.unit.test_board_config_v3 import config as workflow_config
from tests.unit.test_p04_s09_rules_and_applier import ApplierCase
from tests.unit import test_p04_s11_recovery_doc as recovery


class ResultMapping(ApplierCase):
    def setUp(self):
        super().setUp()
        with self.store.transaction() as tx:
            self.worker = tx.create("agent", {"team_id": self.team, "ordinal": 0, "provider_id": "fake",
                                              "role": "worker", "display_name": "w", "pane_state": "alive"})
            tx.transition("agent", self.worker, "idle")

    def run_row(self, run):
        return dict(self.conn.execute("SELECT id, status, transition_reason FROM workflow_runs WHERE id = ?",
                                      (run,)).fetchone())

    def pause(self, run, code=None):
        with self.store.transaction() as tx:
            tx.transition("workflow_run", run, "paused", payload={"diagnosticCode": code})

    def add_assignment(self, run, status="failed", code=None, active_stage=False):
        with self.store.transaction() as tx:
            task = tx.conn.execute("SELECT task_id FROM workflow_runs WHERE id = ?", (run,)).fetchone()[0]
            assignment = tx.create("assignment", {"team_id": self.team, "task_id": task, "agent_id": self.worker,
                                                  "attempt": 1, "policy": "read_only", "provider_id": "fake"})
            path = {"failed": ["failed"], "reconciling": ["claimed", "reconciling"],
                    "waiting_input": ["claimed", "running", "waiting_input"]}[status]
            for step in path:
                tx.transition("assignment", assignment, step,
                              set_values={"diagnostic_code": code} if step == path[-1] else None)
            if active_stage:
                tx.create("stage_attempt", {"team_id": self.team, "workflow_run_id": run, "stage": "developer",
                                            "attempt": 1, "assignment_id": assignment})
        return assignment

    def test_run_outcomes_removed(self):
        self.assertFalse(hasattr(boardmodel, "RUN_" + "OUTCOMES"))
        self.assertEqual(boardmodel.RUN_RESULTS, ("pass", "fail", "blocked", "paused", "cancelled"))

    def test_succeeded_is_pass(self):
        run = self.make_run("succeeded")
        self.assertEqual(boardmodel.run_result(self.conn, self.run_row(run)), "pass")

    def test_failed_is_fail(self):
        run = self.make_run("failed")
        self.assertEqual(boardmodel.run_result(self.conn, self.run_row(run)), "fail")

    def test_failed_usage_limit_is_paused(self):
        run = self.make_run("failed")
        self.add_assignment(run, "failed", "USAGE_LIMIT")
        self.assertEqual(boardmodel.run_result(self.conn, self.run_row(run)), "paused")

    def test_failed_step_or_visit_limit_is_blocked(self):
        run = self.make_run("running")
        with self.store.transaction() as tx:
            tx.note("workflow_run", run, "workflow_run.routed",
                    {"wouldEnter": "work", "reason": "step limit 3 reached"})
            tx.transition("workflow_run", run, "failed")
        self.assertEqual(boardmodel.run_result(self.conn, self.run_row(run)), "blocked")

    def test_paused_infrastructure_codes_are_paused(self):
        for code in sorted(boardmodel.PAUSE_CODES):
            with self.subTest(code=code):
                run = self.make_run("running")
                self.pause(run, code)
                self.assertEqual(boardmodel.run_result(self.conn, self.run_row(run)), "paused")

    def test_paused_runner_gone_from_assignment_is_paused(self):
        run = self.make_run("running")
        self.add_assignment(run, "reconciling", "RUNNER_GONE", active_stage=True)
        self.pause(run)
        self.assertEqual(boardmodel.run_result(self.conn, self.run_row(run)), "paused")

    def test_paused_without_infrastructure_code_is_blocked(self):
        for code in (None, "MALFORMED_VERDICT", "CONTRADICTORY"):
            with self.subTest(code=code):
                run = self.make_run("running")
                self.pause(run, code)
                self.assertEqual(boardmodel.run_result(self.conn, self.run_row(run)), "blocked")

    def test_cancelled_is_cancelled(self):
        run = self.make_run("cancelled")
        self.assertEqual(boardmodel.run_result(self.conn, self.run_row(run)), "cancelled")

    def test_running_run_is_rejected(self):
        run = self.make_run("running")
        with self.assertRaises(AsError) as caught:
            boardmodel.run_result(self.conn, self.run_row(run))
        self.assertEqual(caught.exception.code, "TICKET_BUSY")


class ApplyResults(ApplierCase):
    def setUp(self):
        super().setUp()
        self.config = workflow_config()
        self.write_config(self.config)
        self.ticket = self.add("workflow outcome")
        self.claim("working")

    def claim(self, status):
        with self.store.transaction() as tx:
            tx.conn.execute("UPDATE tickets SET status = 'in-progress', workflow_status = ?, "
                            "assignee = 'worker', active_run_id = NULL, lease_until = 'later' WHERE id = ?",
                            (status, self.ticket["id"]))
            boardmodel._ticket_event(tx.conn, self.ticket["id"], "ticket.claimed", "coordinator", status, status,
                                     {"ticketId": self.ticket["id"], "key": self.ticket["key"]})

    def ticket_row(self):
        return boardmodel.get_ticket(self.conn, self.ws, self.ticket["key"])

    def pause(self, run, code):
        with self.store.transaction() as tx:
            tx.transition("workflow_run", run, "paused", payload={"diagnosticCode": code})

    def apply_rule(self, run, rule=None):
        with self.store.transaction() as tx:
            return boardmodel.apply_run_outcome(tx, self.ws, {"key": self.ticket["key"], "run": run}, rule=rule)

    def set_rounds(self, rounds):
        with self.store.transaction() as tx:
            tx.conn.execute("UPDATE tickets SET rounds_json = ? WHERE id = ?",
                            (json.dumps(rounds), self.ticket["id"]))

    def test_paused_result_keeps_rounds_failures_and_column(self):
        self.set_rounds({"ready": 1, "failures:ready": 1})
        run = self.make_run("running")
        self.pause(run, "USAGE_LIMIT")
        got = self.apply_rule(run)
        row = self.ticket_row()
        self.assertEqual(got["outcome"], "paused")
        self.assertEqual((row["workflow_status"], row["status"], row["assignee"]), ("ready", "in-progress", None))
        self.assertEqual(row["run_id"], run)
        self.assertEqual(json.loads(row["rounds_json"]), {"ready": 1, "failures:ready": 1})
        event = self.events(self.ticket["key"])[-1]
        self.assertEqual(event["name"], "ticket.run_paused")
        self.assertEqual(json.loads(event["payload_json"])["reason"], "USAGE_LIMIT")
        self.assertFalse(self.apply_rule(run)["applied"])

    def test_cancelled_result_keeps_rounds_and_returns_to_start(self):
        self.set_rounds({"ready": 1, "failures:ready": 1})
        run = self.make_run("cancelled")
        got = self.apply_rule(run)
        row = self.ticket_row()
        self.assertEqual(got["outcome"], "cancelled")
        self.assertEqual(row["workflow_status"], "ready")
        self.assertEqual(json.loads(row["rounds_json"]), {"ready": 1, "failures:ready": 1})
        event = self.events(self.ticket["key"])[-1]
        self.assertEqual(event["name"], "ticket.run_cancelled")
        self.assertFalse(json.loads(event["payload_json"])["operatorMoved"])

    def test_cancelled_after_operator_move_keeps_status(self):
        with self.store.transaction() as tx:
            tx.conn.execute("UPDATE tickets SET workflow_status = 'merge-ready' WHERE id = ?", (self.ticket["id"],))
            boardmodel._ticket_event(tx.conn, self.ticket["id"], "ticket.workflow_changed", "operator",
                                     "working", "merge-ready", {"ticketId": self.ticket["id"]})
        run = self.make_run("cancelled")
        got = self.apply_rule(run, self.config["rules"][0])
        row = self.ticket_row()
        self.assertEqual(got["outcome"], "cancelled")
        self.assertEqual((row["workflow_status"], row["assignee"]), ("merge-ready", None))
        self.assertTrue(json.loads(self.events(self.ticket["key"])[-1]["payload_json"])["operatorMoved"])

    def test_cancelled_operator_move_without_claim_event_keeps_status(self):
        with self.store.transaction() as tx:
            tx.conn.execute("DELETE FROM ticket_events WHERE ticket_id = ? AND name = 'ticket.claimed'",
                            (self.ticket["id"],))
            tx.conn.execute("UPDATE tickets SET workflow_status = 'merge-ready' WHERE id = ?", (self.ticket["id"],))
            boardmodel._ticket_event(tx.conn, self.ticket["id"], "ticket.workflow_changed", "operator",
                                     "working", "merge-ready", {"ticketId": self.ticket["id"]})
        run = self.make_run("cancelled")
        got = self.apply_rule(run, self.config["rules"][0])
        row = self.ticket_row()
        self.assertEqual(got["outcome"], "cancelled")
        self.assertEqual((row["workflow_status"], row["assignee"]), ("merge-ready", None))
        payload = json.loads(self.events(self.ticket["key"])[-1]["payload_json"])
        self.assertTrue(payload["operatorMoved"])

    def test_blocked_uses_end_blocked_return_to_and_status(self):
        rule = {**self.config["rules"][0], "startsAt": "ready",
                "end": {"blocked": {"returnTo": "merge-ready"}}}
        ticket = self.add("legacy blocked")
        run = self.make_run("paused")
        with self.store.transaction() as tx:
            boardmodel.apply_run_outcome(tx, self.ws, {"key": ticket["key"], "run": run}, rule=rule)
        row = boardmodel.get_ticket(self.conn, self.ws, ticket["key"])
        self.assertEqual((row["status"], row["return_status"]), ("blocked", "merge-ready"))

        configured = {**rule, "end": {"blocked": {"status": "merge-ready", "returnTo": "merge-ready"}}}
        ticket = self.add("legacy configured")
        run = self.make_run("paused")
        with self.store.transaction() as tx:
            boardmodel.apply_run_outcome(tx, self.ws, {"key": ticket["key"], "run": run}, rule=configured)
        row = boardmodel.get_ticket(self.conn, self.ws, ticket["key"])
        self.assertEqual((row["status"], row["return_status"]), ("merge-ready", "merge-ready"))

    def test_blocked_return_defaults_to_starts_at(self):
        rule = {**self.config["rules"][0], "startsAt": "merge-ready"}
        ticket = self.add("legacy default")
        run = self.make_run("paused")
        with self.store.transaction() as tx:
            boardmodel.apply_run_outcome(tx, self.ws, {"key": ticket["key"], "run": run}, rule=rule)
        row = boardmodel.get_ticket(self.conn, self.ws, ticket["key"])
        self.assertEqual(row["return_status"], "merge-ready")


class TickAppliesResults(unittest.TestCase):
    # Reuse the recovery test's isolated board/team/worker setup without inheriting its tests.
    setUp = recovery.RecoveryCase.setUp
    ticket = recovery.RecoveryCase.ticket
    tick = recovery.RecoveryCase.tick
    make_unavailable = recovery.RecoveryCase.make_unavailable
    make_run = recovery.RecoveryCase.make_run
    claim = recovery.RecoveryCase.claim

    def add_assignment(self, run, status="failed", code=None, active_stage=True):
        with self.store.transaction() as tx:
            task = tx.conn.execute("SELECT task_id FROM workflow_runs WHERE id = ?", (run,)).fetchone()[0]
            assignment = tx.create("assignment", {"team_id": self.team, "task_id": task, "agent_id": self.worker,
                                                  "attempt": 1, "policy": "read_only", "provider_id": "fake"})
            path = {"failed": ["failed"], "reconciling": ["claimed", "reconciling"],
                    "waiting_input": ["claimed", "running", "waiting_input"]}[status]
            for step in path:
                tx.transition("assignment", assignment, step,
                              set_values={"diagnostic_code": code} if step == path[-1] else None)
            if active_stage:
                tx.create("stage_attempt", {"team_id": self.team, "workflow_run_id": run, "stage": "developer",
                                            "attempt": 1, "assignment_id": assignment})
        return assignment

    def test_tick_pauses_and_releases_usage_limited_paused_run(self):
        run = self.make_run("running")
        self.add_assignment(run, "failed", "USAGE_LIMIT")
        with self.store.transaction() as tx:
            tx.transition("workflow_run", run, "paused")
        self.claim(run, lease_in_past=False)
        self.make_unavailable(limit=True)
        out = self.tick()
        self.assertEqual(out["errors"], [])
        row = self.conn.execute("SELECT status, transition_reason FROM workflow_runs WHERE id = ?", (run,)).fetchone()
        self.assertEqual((row["status"], row["transition_reason"]), ("failed", "ended by the board: paused"))
        ticket = self.ticket()
        self.assertEqual((ticket["assignee"], ticket["rounds_json"], ticket["run_id"]), (None, None, run))
        event = self.conn.execute("SELECT name, payload_json FROM ticket_events ORDER BY id DESC LIMIT 1").fetchone()
        self.assertEqual(event["name"], "ticket.run_paused")
        self.assertEqual(json.loads(event["payload_json"])["reason"], "USAGE_LIMIT")

    def test_tick_paused_runner_gone_uses_the_assignment_code_as_its_reason(self):
        run = self.make_run("running")
        self.add_assignment(run, "reconciling", "RUNNER_GONE")
        with self.store.transaction() as tx:
            tx.transition("workflow_run", run, "paused")  # the pause event itself carries no code
        self.claim(run, lease_in_past=False)
        self.make_unavailable()
        self.tick()
        event = self.conn.execute("SELECT name, payload_json FROM ticket_events WHERE name = 'ticket.run_paused' "
                                  "ORDER BY id DESC LIMIT 1").fetchone()
        self.assertEqual(event["name"], "ticket.run_paused")
        self.assertEqual(json.loads(event["payload_json"])["reason"], "RUNNER_GONE")
        self.assertEqual(self.conn.execute("SELECT status FROM workflow_runs WHERE id = ?", (run,)).fetchone()[0],
                         "failed")

    def test_tick_leaves_waiting_for_input_alone(self):
        run = self.make_run("running")
        self.add_assignment(run, "waiting_input")
        with self.store.transaction() as tx:
            tx.transition("workflow_run", run, "paused")
        self.claim(run, lease_in_past=False)
        self.tick()
        ticket = self.ticket()
        self.assertEqual((ticket["assignee"], ticket["active_run_id"]), (self.worker, run))
        self.assertEqual(self.conn.execute("SELECT status FROM workflow_runs WHERE id = ?", (run,)).fetchone()[0],
                         "paused")


if __name__ == "__main__":
    unittest.main()
