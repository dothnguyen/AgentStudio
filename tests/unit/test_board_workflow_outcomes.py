"""Board workflow outcomes (T-201): pass/fail targets, limits and findings.

The applier works from the board workflow that ran, not from a legacy rule: the workflow name keys the
rounds and the limit reasons, and the outcome event carries it.
"""
import json
import os
import unittest

from tests import helpers  # noqa: F401  (puts backend on sys.path)
from agent_studio import boardmodel
from tests.unit.test_p04_s07_board_model import BoardCase

ROLES = {"version": 1, "roles": {"worker": {}}}
BOARD = {"version": 4, "workflowStatuses": [
    {"id": "backlog", "kind": "initial"}, {"id": "ready"}, {"id": "working"}, {"id": "review"},
    {"id": "escalated"}, {"id": "done", "kind": "done"}],
    "ticketFields": [], "todoEntry": [], "todoDefault": None}


def definition(limits=None, end=None):
    return {"version": 2, "startsAt": "ready", "whileRunning": "working", "role": "worker",
            "end": end or {"pass": "review", "fail": "ready",
                           "blocked": {"status": "blocked", "returnTo": "ready"}},
            "limits": limits or {},
            "stages": [{"id": "work", "role": "worker", "permission": "read_only", "prompt": "Do.",
                        "next": {"done": "$succeed"}}]}


class WorkflowOutcomeCase(BoardCase):
    def setUp(self):
        super().setUp()
        self.write_config(BOARD)
        with self.store.transaction() as tx:
            self.team = tx.create("team", {"name": "t", "workspace": self.ws})
            tx.transition("team", self.team, "running")
        os.makedirs(os.path.join(self.ws, ".agent-studio", "workflows"), exist_ok=True)
        with open(os.path.join(self.ws, ".agent-studio", "roles.json"), "w") as f:
            json.dump(ROLES, f)
        self.write_workflow()
        self.ticket = self.add("workflow outcome")

    def write_workflow(self, limits=None, end=None):
        with open(os.path.join(self.ws, ".agent-studio", "workflows", "build.json"), "w") as f:
            json.dump(definition(limits=limits, end=end), f)

    def claim(self, key, status="working"):
        with self.store.transaction() as tx:
            tx.conn.execute("UPDATE tickets SET status = 'in-progress', workflow_status = ?, "
                            "assignee = 'worker', active_run_id = NULL, lease_until = 'later' WHERE key = ?",
                            (status, key))
            row = tx.conn.execute("SELECT id FROM tickets WHERE key = ?", (key,)).fetchone()
            boardmodel._ticket_event(tx.conn, row["id"], "ticket.claimed", "coordinator", status, status,
                                     {"ticketId": row["id"], "key": key})

    def make_run(self, status, key=None):
        with self.store.transaction() as tx:
            task = tx.create("task", {"team_id": self.team, "origin": "workflow", "workspace": self.ws,
                                      "goal": "g"})
            tx.transition("task", task, "assigned")
            tx.transition("task", task, "running")
            run = tx.create("workflow_run", {"team_id": self.team, "task_id": task, "workflow": "definition"})
            tx.transition("workflow_run", run, "running")
            if status != "running":
                tx.transition("workflow_run", run, status)
        return run

    def apply(self, key, run, workflow=None):
        with self.store.transaction() as tx:
            return boardmodel.apply_run_outcome(tx, self.ws, {"key": key, "run": run}, workflow=workflow)

    def ticket_row(self, key=None):
        return boardmodel.get_ticket(self.conn, self.ws, key or self.ticket["key"])

    def event(self, key=None):
        ticket = self.ticket_row(key)
        return self.conn.execute("SELECT * FROM ticket_events WHERE ticket_id = ? AND "
                                 "name = 'ticket.outcome_applied' ORDER BY id DESC LIMIT 1",
                                 (ticket["id"],)).fetchone()


class Targets(WorkflowOutcomeCase):
    def test_pass_uses_end_pass_and_reports_the_workflow(self):
        self.claim(self.ticket["key"])
        result = self.apply(self.ticket["key"], self.make_run("succeeded"))
        row = self.ticket_row()
        self.assertEqual((row["workflow_status"], row["status"]), ("review", "in-progress"))
        self.assertEqual((result["outcome"], result["workflow"], result["rule"], result["rounds"]),
                         ("pass", "build", "ready", 1))
        payload = json.loads(self.event()["payload_json"])
        self.assertEqual((payload["workflow"], payload["rule"], payload["outcome"], payload["rounds"]),
                         ("build", "ready", "pass", 1))
        self.assertEqual(self.ticket_row()["rounds_json"], '{"build": 1}')

    def test_fail_uses_end_fail(self):
        self.claim(self.ticket["key"])
        result = self.apply(self.ticket["key"], self.make_run("failed"))
        row = self.ticket_row()
        self.assertEqual((row["workflow_status"], row["status"]), ("ready", "in-progress"))
        self.assertEqual((result["outcome"], result["workflow"], result["reason"]),
                         ("fail", "build", None))


class Limits(WorkflowOutcomeCase):
    def test_max_runs_blocks_with_the_workflow_name(self):
        self.write_workflow(limits={"maxRuns": 2})
        self.claim(self.ticket["key"])
        first = self.apply(self.ticket["key"], self.make_run("failed"))
        self.assertEqual((first["ticket"]["workflowStatus"], first["reason"], first["rounds"]),
                         ("ready", None, 1))
        self.claim(self.ticket["key"])
        second = self.apply(self.ticket["key"], self.make_run("failed"))
        row = self.ticket_row()
        self.assertEqual((row["workflow_status"], row["status"], row["blocked_reason"], row["return_status"]),
                         ("blocked", "in-progress", "ROUND_LIMIT:build", "ready"))
        self.assertEqual((second["reason"], second["rounds"]), ("ROUND_LIMIT:build", 2))
        self.assertEqual(json.loads(row["rounds_json"]), {"build": 2})

    def test_max_runs_does_not_block_a_pass_at_the_limit(self):
        self.write_workflow(limits={"maxRuns": 1})
        self.claim(self.ticket["key"])
        result = self.apply(self.ticket["key"], self.make_run("succeeded"))
        row = self.ticket_row()
        self.assertEqual((row["workflow_status"], row["blocked_reason"]), ("review", None))
        self.assertEqual((result["outcome"], result["reason"], result["rounds"]), ("pass", None, 1))

    def test_failures_in_a_row_escalates_and_a_pass_resets_the_count(self):
        self.write_workflow(limits={"failuresInARow": {"count": 2, "status": "escalated"}})
        self.claim(self.ticket["key"])
        self.assertEqual(self.apply(self.ticket["key"], self.make_run("failed"))["ticket"]["workflowStatus"],
                         "ready")
        self.claim(self.ticket["key"])
        escalated = self.apply(self.ticket["key"], self.make_run("failed"))
        self.assertEqual((escalated["ticket"]["workflowStatus"], escalated["reason"]),
                         ("escalated", "FAILURE_LIMIT:build"))
        self.assertNotIn("failures:build", json.loads(self.ticket_row()["rounds_json"]))

    def test_pass_resets_a_nonzero_consecutive_failure_count(self):
        self.write_workflow(limits={"failuresInARow": {"count": 2, "status": "escalated"}})
        self.claim(self.ticket["key"])
        self.apply(self.ticket["key"], self.make_run("failed"))
        self.assertEqual(json.loads(self.ticket_row()["rounds_json"])["failures:build"], 1)
        self.claim(self.ticket["key"])
        self.apply(self.ticket["key"], self.make_run("succeeded"))
        self.assertNotIn("failures:build", json.loads(self.ticket_row()["rounds_json"]))
        self.claim(self.ticket["key"])
        after_pass = self.apply(self.ticket["key"], self.make_run("failed"))
        self.assertEqual((after_pass["ticket"]["workflowStatus"], after_pass["reason"]), ("ready", None))
        self.assertEqual(json.loads(self.ticket_row()["rounds_json"])["failures:build"], 1)

    def test_blocked_outcome_at_max_runs_blocks_with_the_round_limit(self):
        self.write_workflow(limits={"maxRuns": 1})
        self.claim(self.ticket["key"])
        result = self.apply(self.ticket["key"], self.make_run("paused"))
        row = self.ticket_row()
        self.assertEqual((row["workflow_status"], row["blocked_reason"]), ("blocked", "ROUND_LIMIT:build"))
        self.assertEqual((result["outcome"], result["reason"], result["rounds"]),
                         ("blocked", "ROUND_LIMIT:build", 1))
        payload = json.loads(self.event()["payload_json"])
        self.assertEqual((payload["workflow"], payload["reason"]), ("build", "ROUND_LIMIT:build"))

    def test_blocked_outcome_below_max_runs_keeps_the_run_reason(self):
        self.write_workflow(limits={"maxRuns": 2})
        self.claim(self.ticket["key"])
        run = self.make_run("paused")
        result = self.apply(self.ticket["key"], run)
        row = self.ticket_row()
        self.assertEqual((row["workflow_status"], row["blocked_reason"]),
                         ("blocked", f"RUN_BLOCKED:{run}"))
        self.assertEqual(result["reason"], f"RUN_BLOCKED:{run}")

    def test_on_fail_priority_is_applied_after_a_fail(self):
        self.write_workflow(limits={"onFailPriority": 7})
        self.claim(self.ticket["key"])
        result = self.apply(self.ticket["key"], self.make_run("failed"))
        self.assertEqual(result["ticket"]["priority"], 7)

    def test_on_fail_priority_is_applied_when_the_fail_reaches_a_blocking_limit(self):
        self.write_workflow(limits={"onFailPriority": 7, "maxRuns": 1})
        self.claim(self.ticket["key"])
        result = self.apply(self.ticket["key"], self.make_run("failed"))
        row = self.ticket_row()
        self.assertEqual((row["workflow_status"], row["blocked_reason"], row["priority"]),
                         ("blocked", "ROUND_LIMIT:build", 7))
        self.assertEqual((result["reason"], result["ticket"]["priority"]), ("ROUND_LIMIT:build", 7))

    def test_the_failure_limit_also_applies_the_on_fail_priority(self):
        self.write_workflow(limits={"onFailPriority": 7,
                                    "failuresInARow": {"count": 1, "status": "escalated"}})
        self.claim(self.ticket["key"])
        result = self.apply(self.ticket["key"], self.make_run("failed"))
        self.assertEqual((result["ticket"]["workflowStatus"], result["ticket"]["priority"]),
                         ("escalated", 7))


class FindingsAndReplay(WorkflowOutcomeCase):
    def test_failed_run_findings_use_the_workflow_name_and_round(self):
        with self.store.transaction() as tx:
            tx.conn.execute("UPDATE tickets SET body = ? WHERE id = ?",
                            ("original brief", self.ticket["id"]))
        run = self.make_run("failed")
        with self.store.transaction() as tx:
            tx.create("stage_attempt", {"team_id": self.team, "workflow_run_id": run, "stage": "work",
                                         "attempt": 1,
                                         "verdict_json": {"verdict": "fail",
                                                          "findings": ["missing validation"]}})
        self.claim(self.ticket["key"])
        self.apply(self.ticket["key"], run)
        body = self.ticket_row()["body"]
        self.assertIn("original brief", body)
        self.assertIn("## Findings from build, round 1", body)
        self.assertIn("- missing validation", body)

    def test_replaying_the_same_run_is_a_no_op(self):
        self.claim(self.ticket["key"])
        run = self.make_run("succeeded")
        first = self.apply(self.ticket["key"], run)
        events = self.count("ticket_events")
        again = self.apply(self.ticket["key"], run)
        self.assertTrue(first["applied"])
        self.assertFalse(again["applied"])
        self.assertEqual(again["ticket"]["workflowStatus"], first["ticket"]["workflowStatus"])
        self.assertEqual(self.count("ticket_events"), events)


if __name__ == "__main__":
    unittest.main()
