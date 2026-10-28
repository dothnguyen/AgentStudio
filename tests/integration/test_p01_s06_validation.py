"""P01-S06: validation stages, passRequires, the built-in definition, and the legacy-run drill."""
import json
import os
import sqlite3
import subprocess
import unittest

from tests.helpers import key, req, wait_until
from tests.integration.test_p01_s04_start import FINAL, fake, git
from tests.integration.test_p01_s05_routing import RoutingCase, agent

TESTS_STAGE = {"id": "tests", "type": "validation", "maxVisits": 2, "next": {"pass": "qa", "fail": "qa"}}


def with_tests():
    return {"version": 1, "stages": [
        agent("develop", "Developer", "workspace_write", {"done": "tests"}, 2, "Implement.\n{{task}}\n{{findings}}"),
        TESTS_STAGE,
        dict(agent("qa", "QA", "read_only", {"pass": "$succeed", "fail": "develop"}, 2,
                   "Review.\n{{diff}}\n{{validation}}"), passRequires=["tests"])]}


class Validation(RoutingCase):
    def setUp(self):
        super().setUp()
        self.write_def("withtests", with_tests())
        self.commit("tests definition")

    def test_failing_tests_turn_a_qa_pass_into_fail_with_a_finding(self):
        # check.py passes only when fixed.txt exists, and the developer writes feature.txt
        wf, d = self.run_def("withtests", {"develop": fake("success", "feature.txt"), "qa": fake("verdict_pass")})
        self.assertEqual([(s["stage"], s["outcome"]) for s in d["stageAttempts"]],
                         [("develop", "done"), ("tests", "validation_failed"), ("qa", "verdict_fail"),
                          ("develop", "done"), ("tests", "validation_failed"), ("qa", "verdict_fail")])
        qa = d["stageAttempts"][2]
        self.assertEqual(qa["verdict"]["findings"][0], "tests did not pass")
        self.assertEqual(qa["verdict"]["agentVerdict"], "pass")
        self.assertEqual(d["workflowRun"]["status"], "failed")
        self.assertEqual(d["workflowRun"]["transitionReason"], "develop visit limit 2 reached")
        self.assertEqual(self.routed(d)[:3], [("develop", "done", "tests"), ("tests", "fail", "qa"),
                                              ("qa", "fail", "develop")])
        self.assertEqual(d["workflowRun"]["retryCount"], 1)   # the second fail hit the visit limit instead
        self.assertIn("tests did not pass", self.prompt(d, 3))                 # FINDINGS reach the developer

    def test_passing_tests_let_the_pass_stand(self):
        wf, d = self.run_def("withtests", {"develop": fake("success", "fixed.txt"), "qa": fake("verdict_pass")})
        self.assertEqual(d["workflowRun"]["status"], "succeeded")
        validation = next(s for s in d["stageAttempts"] if s["stage"] == "tests")
        self.assertEqual(validation["outcome"], "validation_passed")
        self.assertEqual(len(d["assignments"]), 2)                            # validation is not an assignment
        qa_prompt = self.prompt(d, 2)
        self.assertIn("===== VALIDATION =====\nValidation PASSED.", qa_prompt)
        self.assertIn("looking for fixed.txt", qa_prompt)
        validated = [e["data"] for e in d["events"] if e["name"] == "stage_attempt.validated"]
        self.assertEqual([(v["stage"], v["passed"]) for v in validated], [("tests", True)])
        self.assertEqual(validated[0]["sourceAssignmentId"], d["assignments"][0]["id"])
        self.assertTrue(os.path.exists(validation["validation"]["outputPath"]))

    def test_pass_requires_with_no_result_counts_as_failed(self):
        # a verdict stage that depends on a validation stage it never passed through
        d = {"version": 1, "stages": [
            dict(agent("qa", "QA", "read_only", {"pass": "tests", "fail": "tests"}, 1, "Review."),
                 passRequires=["tests"]),
            {"id": "tests", "type": "validation", "next": {"pass": "$succeed", "fail": "$fail"}}]}
        self.write_def("early", d)
        self.commit("early")
        wf, run = self.run_def("early", {"qa": fake("verdict_pass")})
        self.assertEqual(run["stageAttempts"][0]["verdict"]["findings"], ["tests did not pass"])

    def test_validation_as_the_first_stage(self):
        d = {"version": 1, "stages": [
            {"id": "tests", "type": "validation", "maxVisits": 2, "next": {"pass": "$succeed", "fail": "dev"}},
            agent("dev", "Developer", "workspace_write", {"done": "tests"}, 2, "{{validation}}")]}
        self.write_def("valfirst", d)
        self.commit("valfirst")
        r = self.start("valfirst", debugStageOptions={"dev": fake("success", "fixed.txt")})["data"]
        self.assertIsNone(r["assignmentId"])
        run = self.wait(r["workflowRunId"], FINAL)
        self.assertEqual([(s["stage"], s["outcome"]) for s in run["stageAttempts"]],
                         [("tests", "validation_failed"), ("dev", "done"), ("tests", "validation_passed")])
        self.assertIn("Validation FAILED", self.prompt(run, 1))
        self.assertEqual(run["workflowRun"]["status"], "succeeded")

    def test_validation_could_not_run_pauses(self):
        bad = {"version": 1, "validation": {"argv": ["python3", "no-such-script-$(touch CANARY_ARGV).py"],
                                            "timeoutMs": 5000}}
        with open(os.path.join(self.ws, ".agent-studio", "workflow.json"), "w") as f:
            json.dump(bad, f)
        self.commit("hostile argv")
        wf, d = self.run_def("withtests", {"develop": fake("success", "feature.txt")})
        # python3 starts and fails on a missing script: a nonzero exit is a plain validation failure, never a shell
        self.assertEqual(d["stageAttempts"][1]["outcome"], "validation_failed")
        self.assertIn("no-such-script-$(touch CANARY_ARGV).py", open(d["stageAttempts"][1]["validation"]["outputPath"]).read())
        self.assertFalse(os.path.exists(os.path.join(self.ws, "CANARY_ARGV")))
        self.assertFalse(os.path.exists(os.path.join(os.getcwd(), "CANARY_ARGV")))
        self.cancel(wf) if self.show(wf)["workflowRun"]["status"] not in FINAL else None

    def test_missing_executable_is_validation_error(self):
        bad = {"version": 1, "validation": {"argv": ["/nonexistent/bin/runner", "$(touch CANARY_ARGV)"], "timeoutMs": 5000}}
        with open(os.path.join(self.ws, ".agent-studio", "workflow.json"), "w") as f:
            json.dump(bad, f)
        self.commit("missing exe")
        wf, d = self.run_def("withtests", {"develop": fake("success", "feature.txt")})
        self.assertEqual(d["workflowRun"]["status"], "paused")
        paused = [e["data"] for e in d["events"] if e["name"] == "workflow_run.paused"][-1]
        self.assertEqual(paused["diagnosticCode"], "VALIDATION_ERROR")
        self.assertFalse(os.path.exists(os.path.join(self.ws, "CANARY_ARGV")))
        self.cancel(wf)
        self.assertEqual(self.show(wf)["workflowRun"]["status"], "cancelled")

    def test_validator_lost_pauses(self):
        slow = {"version": 1, "validation": {"argv": ["python3", "-c", "import time; time.sleep(60)"],
                                             "timeoutMs": 90000}}
        with open(os.path.join(self.ws, ".agent-studio", "workflow.json"), "w") as f:
            json.dump(slow, f)
        self.commit("slow validation")
        r = self.start("withtests", debugStageOptions={"develop": fake("success", "fixed.txt")})["data"]
        wf = r["workflowRunId"]
        d = wait_until(lambda: len(self.show(wf)["stageAttempts"]) > 1 and self.show(wf), timeout=40)
        val = d["stageAttempts"][1]["validation"]
        self.assertEqual(val["state"], "running")
        subprocess.run(["pkill", "-9", "-g", str(val["process"]["pid"])], check=False)
        try:
            os.kill(val["process"]["pid"], 9)
        except ProcessLookupError:
            pass
        d = self.wait(wf, FINAL + ("paused",), timeout=40)
        self.assertEqual(d["workflowRun"]["status"], "paused")
        paused = [e["data"] for e in d["events"] if e["name"] == "workflow_run.paused"][-1]
        self.assertEqual(paused["diagnosticCode"], "VALIDATION_LOST")
        self.cancel(wf)
        self.assertEqual(self.show(wf)["workflowRun"]["status"], "cancelled")


class BuiltIn(RoutingCase):
    roster = [("codex", "dev-role-x"), ("claude", "rev-role-y")]

    def p00(self, stages, **extra):
        dev, rev = (a["agentId"] for a in self.team["agents"])
        args = dict({"teamId": self.team["teamId"], "developerAgentId": dev, "reviewerAgentId": rev, "text": "t",
                     "debugStageOptions": stages}, **extra)
        rc, r, _ = self.sb.request(req("workflow.start", args, idempotencyKey=key()))
        return r

    def test_p00_form_binds_any_role_names_and_keeps_its_receipt(self):
        r = self.p00({"developer": fake("success", "fixed.txt"), "reviewer": fake("verdict_pass")})
        self.assertTrue(r["ok"], r)
        for k in ("baseCommit", "developerAgentId", "reviewerAgentId", "assignmentId", "validationArgv"):
            self.assertIn(k, r["data"])
        d = self.wait(r["data"]["workflowRunId"], FINAL)
        w = d["workflowRun"]
        self.assertEqual((w["status"], w["definitionName"], w["bindings"]),
                         ("succeeded", "developer-reviewer", {"Developer": r["data"]["developerAgentId"],
                                                               "Reviewer": r["data"]["reviewerAgentId"]}))
        self.assertEqual([s["stage"] for s in d["stageAttempts"]],
                         ["developer", "validation", "reviewer"])
        self.assertEqual(len(w["definition"]["stages"]), 6)

    def test_built_in_by_name_needs_matching_roles(self):
        r = self.start("developer-reviewer", expect_ok=False)
        self.assertEqual(self.code(r), "ROLE_UNBOUND")

    def test_a_workspace_file_cannot_shadow_the_built_in(self):
        self.write_def("developer-reviewer", {"version": 1, "stages": [
            agent("a", "x", "read_only", {"done": "$succeed"}, 1, "x")]})
        self.commit("shadow")
        self.assertEqual(self.code(self.start("developer-reviewer", expect_ok=False)), "WORKFLOW_DEFINITION_INVALID")


class LegacyRuns(RoutingCase):
    """Q8: a P00 run (no definition_json) is never killed; it pauses LEGACY_WORKFLOW_RUN, and only cancel works."""

    def test_legacy_run_pauses_after_its_assignment_and_cancels_cleanly(self):
        r = self.start("solo", debugStageOptions={"check": fake("verdict_pass", duration=4000)})["data"]
        wf = r["workflowRunId"]
        wait_until(lambda: self.show(wf)["assignments"][0]["status"] == "running", timeout=30)
        db = os.path.join(self.sb.state_dir, "state.db")
        self.sb.run("coordinator", "stop")
        conn = sqlite3.connect(db)
        conn.execute("UPDATE workflow_runs SET definition_json = NULL, definition_name = NULL, "
                     "definition_sha256 = NULL, bindings_json = NULL")
        conn.commit()
        conn.close()
        rc, resp, p = self.sb.run("coordinator", "start", "--enable-debug")
        self.assertTrue(resp["ok"], p.stderr)
        d = self.wait(wf, ("paused",) + FINAL, timeout=40)
        self.assertEqual(d["workflowRun"]["status"], "paused")
        paused = [e["data"] for e in d["events"] if e["name"] == "workflow_run.paused"][-1]
        self.assertEqual(paused["diagnosticCode"], "LEGACY_WORKFLOW_RUN")
        asg = d["assignments"][0]["id"]
        rc, res, _ = self.sb.request(req("assignment.resolve", {"assignmentId": asg, "action": "retry"},
                                         idempotencyKey=key()))
        self.assertEqual(res["error"]["code"], "RESOLVE_NOT_ALLOWED")
        self.cancel(wf)
        d = self.show(wf)
        self.assertEqual((d["workflowRun"]["status"], d["task"]["status"]), ("cancelled", "cancelled"))


if __name__ == "__main__":
    unittest.main()
