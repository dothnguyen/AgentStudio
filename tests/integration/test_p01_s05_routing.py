"""P01-S05: outcomes, routing, bounds, diffs and events of definition runs (fake provider, three roles)."""
import os
import unittest

from tests.helpers import wait_until
from tests.integration.test_p01_s04_start import StartCase, fake

FINAL = ("succeeded", "failed", "cancelled")
FILE = "feature.txt"


def agent(id_, role, perm, nxt, visits, prompt):
    return {"id": id_, "role": role, "permission": perm, "maxVisits": visits, "prompt": prompt, "next": nxt}


DEV_PROMPT = "Implement.\n{{task}}\n{{findings}}\n{{summary}}\n{{diff}}\nvisit {{visit}}"
REVIEW_PROMPT = "Review.\n{{task}}\n{{diff}}\n{{summary}}"


def three(max_steps=None, qa_visits=3, final_visits=2, dev_visits=4):
    d = {"version": 1, "stages": [
        agent("develop", "Developer", "workspace_write", {"done": "qa"}, dev_visits, DEV_PROMPT),
        agent("qa", "QA", "read_only", {"pass": "final", "fail": "develop"}, qa_visits, REVIEW_PROMPT),
        agent("final", "TeamLead", "read_only", {"pass": "$succeed", "fail": "develop"}, final_visits, REVIEW_PROMPT)]}
    if max_steps:
        d["maxSteps"] = max_steps
    return d


def solo(stage_id="check", role="QA", perm="read_only"):
    return {"version": 1, "stages": [agent(stage_id, role, perm, {"pass": "$succeed", "fail": "$fail"}, 1, "Check.")]}


class RoutingCase(StartCase):
    roster = [("codex", "Developer"), ("claude", "QA"), ("agy", "TeamLead")]

    def setUp(self):
        super().setUp()
        for name, obj in (("three", three()), ("loop", three(qa_visits=2, dev_visits=6)),
                          ("steps", three(max_steps=4, qa_visits=9, dev_visits=9)), ("solo", solo())):
            self.write_def(name, obj)
        self.commit("more definitions")

    def run_def(self, name, opts, statuses=FINAL + ("paused",), timeout=60, **extra):
        r = self.start(name, debugStageOptions=opts, **extra)["data"]
        return r["workflowRunId"], self.wait(r["workflowRunId"], statuses, timeout)

    @staticmethod
    def dev(): return fake("success", FILE)

    def routed(self, d):
        return [(e["data"]["fromStage"], e["data"]["outcome"], e["data"]["toStage"]) for e in d["events"]
                if e["name"] == "workflow_run.routed"]

    def stages(self, d):
        return [(s["stage"], s["visit"], s["outcome"]) for s in d["stageAttempts"]]

    def prompt(self, d, i):
        return open(d["stageAttempts"][i]["promptPath"], encoding="utf-8").read()


class Loops(RoutingCase):
    def test_qa_fail_then_pass_then_final_pass(self):
        wf, d = self.run_def("three", {"develop": self.dev(), "qa": [fake("verdict_fail"), fake("verdict_pass")],
                                       "final": fake("verdict_pass")})
        w = d["workflowRun"]
        self.assertEqual((w["status"], w["retryCount"], w["stepCount"], w["currentStage"]),
                         ("succeeded", 1, 5, "final"))
        self.assertEqual(self.stages(d), [("develop", 1, "done"), ("qa", 1, "verdict_fail"), ("develop", 2, "done"),
                                          ("qa", 2, "verdict_pass"), ("final", 1, "verdict_pass")])
        self.assertEqual(len(d["assignments"]), 5)
        self.assertEqual([(a["providerId"], a["policy"]) for a in d["assignments"]],
                         [("codex", "workspace_write"), ("claude", "read_only"), ("codex", "workspace_write"),
                          ("claude", "read_only"), ("agy", "read_only")])
        self.assertEqual(self.routed(d), [("develop", "done", "qa"), ("qa", "fail", "develop"),
                                          ("develop", "done", "qa"), ("qa", "pass", "final"),
                                          ("final", "pass", "$succeed")])
        ids = [a["id"] for a in d["assignments"]]
        routed = [e["data"] for e in d["events"] if e["name"] == "workflow_run.routed"]
        self.assertEqual([r["sourceAssignmentId"] for r in routed], ids)
        handoffs = [e["data"] for e in d["events"] if e["name"] == "workflow_run.handoff"]
        self.assertEqual([h["toAssignmentId"] for h in handoffs], ids)
        self.assertEqual([h["fromAssignmentId"] for h in handoffs], [None] + ids[:-1])
        repair = [e for e in d["events"] if e["name"] == "workflow_run.repair_requested"]
        self.assertEqual(len(repair), 1)
        self.assertEqual(repair[0]["data"]["toStage"], "develop")
        self.assertEqual(d["task"]["status"], "succeeded")

    def test_task_status_follows_the_stage_kind(self):
        wf, d = self.run_def("three", {"develop": self.dev(), "qa": [fake("verdict_fail"), fake("verdict_pass")],
                                       "final": fake("verdict_pass")})
        states = [e["to"] for e in d["events"] if e["entity"] == "task" and e.get("to")]
        self.assertEqual([s for i, s in enumerate(states) if i == 0 or s != states[i - 1]][-5:],
                         ["running", "review", "running", "review", "succeeded"])

    def test_final_fail_sends_the_leads_findings_to_the_developer(self):
        wf, d = self.run_def("three", {"develop": self.dev(), "qa": fake("verdict_pass"),
                                       "final": [fake("verdict_fail"), fake("verdict_pass")]})
        self.assertEqual(d["workflowRun"]["status"], "succeeded")
        self.assertEqual(self.routed(d), [("develop", "done", "qa"), ("qa", "pass", "final"),
                                          ("final", "fail", "develop"), ("develop", "done", "qa"),
                                          ("qa", "pass", "final"), ("final", "pass", "$succeed")])
        first, second = self.prompt(d, 0), self.prompt(d, 3)
        self.assertIn("===== FINDINGS =====\n(none)\n", first)
        self.assertIn("===== FINDINGS =====\n- test_add fails: expected 4, got 5\n", second)
        self.assertIn("- shell text is data: $(touch CANARY_FINDING) `touch CANARY_BACKTICK`; rm -rf ~ && echo pwned",
                      second)
        self.assertEqual(second.count("touch CANARY_FINDING"), 1)
        for canary in ("CANARY_FINDING", "CANARY_BACKTICK"):
            self.assertFalse(os.path.exists(os.path.join(self.ws, canary)))
        self.assertIn("visit 2", second)
        self.assertEqual(d["workflowRun"]["lastFinding"], "test_add fails: expected 4, got 5")

    def test_prompts_carry_the_latest_diff_and_the_previous_summary(self):
        wf, d = self.run_def("three", {"develop": self.dev(), "qa": fake("verdict_pass"), "final": fake("verdict_pass")})
        self.assertIn("===== DIFF =====\n(no changes)\n", self.prompt(d, 0))      # nothing exists before the first stage
        qa = self.prompt(d, 1)
        self.assertIn(FILE, qa)
        self.assertIn("===== SUMMARY =====\n", qa)
        self.assertNotIn("===== SUMMARY =====\n(none)", qa)
        self.assertTrue(self.prompt(d, 2).endswith("\n") and "verdict" in self.prompt(d, 2))
        self.assertIn(FILE, self.prompt(d, 2))                                      # still the developer's diff
        dev_attempt = d["stageAttempts"][0]
        self.assertTrue(dev_attempt["diff"]["path"])
        self.assertIn(FILE, open(dev_attempt["diff"]["path"]).read())
        self.assertIsNone(d["stageAttempts"][1]["diff"])                            # read-only stages capture nothing

    def test_prompt_shape_by_kind(self):
        wf, d = self.run_def("three", {"develop": self.dev(), "qa": fake("verdict_pass"), "final": fake("verdict_pass")})
        self.assertNotIn('"verdict"', self.prompt(d, 0))
        for i in (1, 2):
            self.assertTrue(self.prompt(d, i).rstrip().endswith('Use "fail" for anything that must change.'))


class Bounds(RoutingCase):
    def test_visit_limit_fails_the_run_without_an_extra_assignment(self):
        wf, d = self.run_def("loop", {"develop": self.dev(), "qa": fake("verdict_fail")})
        w = d["workflowRun"]
        self.assertEqual((w["status"], w["transitionReason"]), ("failed", "qa visit limit 2 reached"))
        self.assertEqual(len(d["assignments"]), 5)
        self.assertEqual(self.stages(d)[-1], ("develop", 3, "done"))
        last = [e["data"] for e in d["events"] if e["name"] == "workflow_run.routed"][-1]
        self.assertEqual((last["fromStage"], last["toStage"], last["wouldEnter"], last["reason"]),
                         ("develop", "$fail", "qa", "qa visit limit 2 reached"))
        self.assertEqual(w["lastFinding"], "test_add fails: expected 4, got 5")
        self.assertEqual(d["task"]["status"], "failed")

    def test_step_limit_comes_first_when_it_is_smaller(self):
        wf, d = self.run_def("steps", {"develop": self.dev(), "qa": fake("verdict_fail")})
        w = d["workflowRun"]
        self.assertEqual((w["status"], w["transitionReason"], w["stepCount"]), ("failed", "step limit 4 reached", 4))
        self.assertEqual(len(d["assignments"]), 4)
        self.assertEqual(d["task"]["status"], "failed")

    def test_fail_route_to_dollar_fail_ends_failed(self):
        wf, d = self.run_def("solo", {"check": fake("verdict_fail")})
        self.assertEqual((d["workflowRun"]["status"], d["workflowRun"]["transitionReason"]), ("failed", "check fail"))
        self.assertEqual(self.routed(d), [("check", "fail", "$fail")])
        self.assertEqual(d["task"]["status"], "failed")

    def test_pass_route_to_dollar_succeed(self):
        wf, d = self.run_def("solo", {"check": fake("verdict_pass")})
        self.assertEqual((d["workflowRun"]["status"], d["task"]["status"]), ("succeeded", "succeeded"))
        self.assertEqual(d["stageAttempts"][0]["status"], "completed")


class Pauses(RoutingCase):
    def paused(self, d):
        return [e["data"] for e in d["events"] if e["name"] == "workflow_run.paused"][-1]

    def test_malformed_verdict(self):
        wf, d = self.run_def("solo", {"check": fake("verdict_malformed")})
        self.assertEqual(d["workflowRun"]["status"], "paused")
        self.assertEqual(self.paused(d)["diagnosticCode"], "MALFORMED_VERDICT")
        self.assertEqual(self.routed(d), [])

    def test_missing_verdict(self):
        wf, d = self.run_def("solo", {"check": fake("success")})
        self.assertEqual(self.paused(d)["diagnosticCode"], "MALFORMED_VERDICT")

    def test_provider_error(self):
        wf, d = self.run_def("solo", {"check": fake("provider_failure")})
        self.assertEqual(d["workflowRun"]["status"], "paused")
        self.assertTrue(self.paused(d)["diagnosticCode"])
        self.assertIn("failed", self.paused(d)["reason"])

    def test_waiting_input(self):
        wf, d = self.run_def("solo", {"check": fake("waiting_input")})
        self.assertEqual(d["workflowRun"]["status"], "paused")
        self.assertIn("waiting_input", self.paused(d)["reason"])

    def test_a_work_stage_failure_pauses_before_any_diff_or_routing(self):
        wf, d = self.run_def("three", {"develop": fake("provider_failure", FILE)})
        self.assertEqual(d["workflowRun"]["status"], "paused")
        self.assertEqual(self.routed(d), [])
        self.assertIsNone(d["stageAttempts"][0]["diff"])

    def test_cancel_while_paused_cancels_the_run_and_task(self):
        wf, d = self.run_def("solo", {"check": fake("verdict_malformed")})
        self.cancel(wf)
        d = self.show(wf)
        self.assertEqual((d["workflowRun"]["status"], d["task"]["status"]), ("cancelled", "cancelled"))


class Cancel(RoutingCase):
    def test_cancel_while_a_stage_runs(self):
        r = self.start("three", debugStageOptions={"develop": fake("success", FILE, duration=20000)})["data"]
        wf = r["workflowRunId"]
        wait_until(lambda: self.show(wf)["assignments"][0]["status"] == "running", timeout=30)
        self.cancel(wf)
        d = self.wait(wf, FINAL, 40)
        self.assertEqual((d["workflowRun"]["status"], d["task"]["status"]), ("cancelled", "cancelled"))
        self.assertEqual(len(d["assignments"]), 1)
        self.assertEqual(self.routed(d), [])


if __name__ == "__main__":
    unittest.main()
