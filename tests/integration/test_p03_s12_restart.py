"""P03-S12 restart recovery through the real coordinator and fixture workers."""
import os
import signal

from tests import helpers  # noqa: F401
from tests.integration import test_p03_s06_outcomes as outcomes
from tests.helpers import key, req, wait_until


class LeaseRestartIntegration(outcomes.OutcomeIntegration):
    # Reuse the live-coordinator fixture helpers, not the S06 test matrix.  Its
    # ready_merge assertions deliberately predate the merge worker and do not
    # exercise restart recovery.
    test_fake_outcome_rows_apply_once = None
    test_full_path_commits_and_test_prompt_contains_develop_diff = None
    test_two_qa_failures_then_pass_commits_three_rounds_and_seeds_findings = None
    test_limits_no_change_invalid_plan_and_paused_retry = None
    test_develop_validation_failure_at_visit_limit_counts_one_failed_round = None
    test_cancelled_releases_and_second_test_failure_crosses_limit = None
    test_outcome_crashes_recover_without_duplicate_commits_or_events = None

    def test_restart_applies_finished_qa_outcome_once(self):
        ticket = self.create()
        self.prepare_worktree(ticket)
        ticket = self.move(ticket, "ready_test")
        started = self.start(ticket, "QA", "verdict", outcomes.fake("verdict_pass", duration=500))
        self.sb.run("coordinator", "stop")
        _, restarted, proc = self.sb.run("coordinator", "start", "--enable-debug")
        self.assertTrue(restarted["ok"], proc.stderr)
        detail = self.wait_ticket(ticket, "ready_review")
        self.assertEqual(sum(e["name"] == "ticket.outcome_applied" for e in detail["events"]), 1)
        # A completed stage is not re-assigned merely because the coordinator restarted.
        run = self.workflow(started["workflowRunId"])
        self.assertEqual(len(run["assignments"]), 1)

    def test_killed_runner_reconciles_to_paused_run_then_retry_applies_late_outcome(self):
        ticket = self.move(self.create(), "ready_dev")
        started = self.start(ticket, "Developer", "work", outcomes.fake("slow", duration=30000))
        run_id = started["workflowRunId"]
        pid = wait_until(lambda: next((a["processPid"] for a in self.workflow(run_id)["assignments"]
                                       if a["status"] == "running" and a["processPid"]), None),
                         message="develop runner to start")
        os.kill(pid, signal.SIGKILL)
        # P00 reconciliation settles the assignment truthfully, pauses the run, and the board blocks the ticket.
        assignment = wait_until(lambda: next((a for a in self.workflow(run_id)["assignments"]
                                              if a["status"] == "reconciling"), None),
                                message="assignment reconciling")
        self.assertEqual(assignment["diagnosticCode"], "RUNNER_GONE")
        detail = self.wait_ticket(ticket, "blocked")
        self.assertEqual(detail["ticket"]["returnStatus"], "ready_dev")
        self.assertTrue(detail["ticket"]["blockedReason"].startswith("RUN_PAUSED:"), detail["ticket"]["blockedReason"])
        self.assertEqual(self.workflow(run_id)["workflowRun"]["status"], "paused")
        self.configure_next_fake(run_id, "work", outcomes.fake("success", "fixed.txt"))
        _, resolved, _ = self.sb.request(req("assignment.resolve", {"assignmentId": assignment["id"], "action": "retry"},
                                             idempotencyKey=key()))
        self.assertTrue(resolved["ok"], resolved)
        self.wait_ticket(ticket, "ready_test")

    def test_paused_develop_retry_applies_late_outcome_after_restart(self):
        ticket = self.move(self.create(), "ready_dev")
        started = self.start(ticket, "Developer", "work", outcomes.fake("failure"))
        detail = self.wait_ticket(ticket, "blocked")
        self.assertEqual(detail["ticket"]["returnStatus"], "ready_dev")
        self.assertTrue(detail["ticket"]["blockedReason"].startswith("RUN_PAUSED:"))
        self.sb.run("coordinator", "stop")
        _, restarted, proc = self.sb.run("coordinator", "start", "--enable-debug")
        self.assertTrue(restarted["ok"], proc.stderr)
        assignment = self.workflow(started["workflowRunId"])["assignments"][-1]["id"]
        self.configure_next_fake(started["workflowRunId"], "work", outcomes.fake("success", "fixed.txt"))
        _, resolved, _ = self.sb.request(req("assignment.resolve", {"assignmentId": assignment, "action": "retry"},
                                             idempotencyKey=key()))
        self.assertTrue(resolved["ok"], resolved)
        self.wait_ticket(ticket, "ready_test")
