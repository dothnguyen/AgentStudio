"""P01-S07: crashes, resolve, cancel and deadlines for definition runs."""
import json
import os
import sqlite3
import subprocess
import unittest

from tests.helpers import key, req, wait_until
from tests.integration.test_p01_s04_start import FINAL, fake
from tests.integration.test_p01_s05_routing import RoutingCase, agent, solo
from tests.integration.test_p01_s06_validation import with_tests

EXPECTED_ROUTES = [("develop", "done", "tests"), ("tests", "pass", "qa"), ("qa", "pass", "$succeed")]


class S07Case(RoutingCase):
    def setUp(self):
        super().setUp()
        self.write_def("withtests", with_tests())
        self.write_def("one", solo("check"))
        self.write_def("one-write", {"version": 1, "stages": [
            agent("dev", "Developer", "workspace_write", {"done": "$succeed"}, 1, "{{task}}")]})
        self.commit("s07 definitions")

    def set_config(self, **extra):
        cfg = {"version": 1, "validation": {"argv": ["python3", "check.py"], "timeoutMs": 20000}}
        cfg.update(extra)
        with open(os.path.join(self.ws, ".agent-studio", "workflow.json"), "w") as f:
            json.dump(cfg, f)
        self.commit("config")

    def resolve(self, asg, action, **extra):
        args = dict({"assignmentId": asg, "action": action}, **extra)
        rc, r, _ = self.sb.request(req("assignment.resolve", args, idempotencyKey=key()))
        return r

    def health_pid(self):
        c = self.sb.run("health")[1]["data"]["coordinator"]
        return c["pid"] if c["running"] else None

    def restart_with_crash(self, point):
        self.sb.run("coordinator", "stop")
        self.sb.env["AGENT_STUDIO_TEST_CRASH_AT"] = point
        rc, r, p = self.sb.run("coordinator", "start", "--enable-debug")
        self.assertTrue(r["ok"], p.stderr)

    def recover(self):
        wait_until(lambda: self.health_pid() is None, timeout=40, message="coordinator to crash")
        self.sb.env.pop("AGENT_STUDIO_TEST_CRASH_AT", None)
        rc, r, p = self.sb.run("coordinator", "start", "--enable-debug")
        self.assertTrue(r["ok"], p.stderr)

    def crash_drill(self, point, definition="withtests", opts=None):
        self.restart_with_crash(point)
        opts = opts or {"develop": fake("success", "fixed.txt"), "qa": fake("verdict_pass")}
        r = self.start(definition, debugStageOptions=opts)["data"]
        self.recover()
        d = self.wait(r["workflowRunId"], FINAL + ("paused",), timeout=80)
        self.assertEqual(d["workflowRun"]["status"], "succeeded", (point, d["workflowRun"]["transitionReason"]))
        self.assertTrue(os.path.exists(os.path.join(self.sb.state_dir, f"crashed-at-{point}")), "the point was hit")
        self.assertEqual(len(d["assignments"]), 2, "no duplicate assignment")
        self.assertEqual([a["status"] for a in d["assignments"]], ["succeeded", "succeeded"])
        self.assertEqual(self.routed(d), EXPECTED_ROUTES, "a routed chain without gaps or repeats")
        self.assertEqual([(s["stage"], s["status"]) for s in d["stageAttempts"]],
                         [("develop", "completed"), ("tests", "completed"), ("qa", "completed")])
        handoffs = [e["data"]["toStage"] for e in d["events"] if e["name"] == "workflow_run.handoff"]
        self.assertEqual(handoffs, ["develop", "qa"])
        self.assertEqual(d["task"]["status"], "succeeded")
        return d


class Recovery(S07Case):
    def test_crash_after_routing_before_the_dispatch_commits(self):
        self.crash_drill("before_route_commit")

    def test_crash_right_after_a_stage_is_committed(self):
        self.crash_drill("after_advance_commit")

    def test_crash_after_a_verdict_is_applied_before_routing(self):
        self.crash_drill("after_verdict_before_route")

    def test_crash_while_the_validator_runs(self):
        # Keep the validator alive long enough for the coordinator to observe it.
        with open(os.path.join(self.ws, "check.py"), "r+", encoding="utf-8") as f:
            source = f.read()
            f.seek(0)
            f.write("import time; time.sleep(3)\n" + source)
        self.commit("slow validation for crash drill")
        d = self.crash_drill("while_validating")
        self.assertEqual(d["stageAttempts"][1]["outcome"], "validation_passed")

    def test_crash_between_spawning_the_validator_and_committing_it(self):
        d = self.crash_drill("after_validator_spawn")
        self.assertEqual(d["stageAttempts"][1]["outcome"], "validation_passed")
        pidfile = os.path.join(os.path.dirname(d["stageAttempts"][1]["promptPath"]), "validator.pid.json")
        self.assertTrue(os.path.exists(pidfile))


class Resolve(S07Case):
    def test_retry_on_a_paused_verdict_stage_spends_no_visit_or_step(self):
        r = self.start("one", debugStageOptions={"check": fake("verdict_malformed")})["data"]
        wf = r["workflowRunId"]
        d = self.wait(wf, ("paused",))
        asg = d["assignments"][0]["id"]
        before = d["workflowRun"]["stepCount"]
        bad = self.resolve(asg, "retry", policy="workspace_write")
        self.assertEqual(bad["error"]["code"], "BAD_REQUEST")
        out = self.resolve(asg, "retry", debugProviderOptions=fake("verdict_pass"))
        self.assertTrue(out["ok"], out)
        d = self.wait(wf, FINAL)
        # the stage's maxVisits is 1: finishing proves the retry did not consume a visit
        self.assertEqual(d["workflowRun"]["status"], "succeeded")
        self.assertEqual([(s["attempt"], s["visit"], s["status"]) for s in d["stageAttempts"]],
                         [(1, 1, "abandoned"), (2, 1, "completed")])
        self.assertEqual((d["workflowRun"]["stepCount"], before), (1, 1))
        self.assertEqual(self.routed(d), [("check", "pass", "$succeed")])
        self.assertEqual(open(d["stageAttempts"][0]["promptPath"]).read(),
                         open(d["stageAttempts"][1]["promptPath"]).read())

    def test_retry_keeps_the_inputs_of_the_original_attempt(self):
        wf, d = self.run_def("three", {"develop": self.dev(), "qa": fake("verdict_pass"),
                                       "final": [fake("verdict_malformed"), fake("verdict_pass")]})
        self.assertEqual(d["workflowRun"]["status"], "paused")
        original = open(d["stageAttempts"][2]["promptPath"]).read()
        self.assertIn("feature.txt", original)
        out = self.resolve(d["assignments"][2]["id"], "retry", debugProviderOptions=fake("verdict_pass"))
        self.assertTrue(out["ok"], out)
        d = self.wait(wf, FINAL)
        self.assertEqual(d["workflowRun"]["status"], "succeeded")
        self.assertEqual(open(d["stageAttempts"][3]["promptPath"]).read(), original)
        self.assertEqual(d["workflowRun"]["stepCount"], 3)

    def test_fail_and_cancel_end_the_run(self):
        for action, status in (("fail", "failed"), ("cancel", "cancelled")):
            r = self.start("one", debugStageOptions={"check": fake("verdict_malformed")})["data"]
            d = self.wait(r["workflowRunId"], ("paused",))
            self.assertTrue(self.resolve(d["assignments"][0]["id"], action)["ok"])
            d = self.show(r["workflowRunId"])
            self.assertEqual((d["workflowRun"]["status"], d["task"]["status"]), (status, status))

    def test_resolving_while_the_runner_is_alive_is_refused(self):
        r = self.start("one", debugStageOptions={"check": fake("verdict_pass", duration=25000)})["data"]
        wf = r["workflowRunId"]
        wait_until(lambda: self.show(wf)["assignments"][0]["status"] == "running", timeout=30)
        asg = self.show(wf)["assignments"][0]["id"]
        conn = sqlite3.connect(os.path.join(self.sb.state_dir, "state.db"), timeout=10)
        conn.execute("UPDATE assignments SET status = 'waiting_input' WHERE id = ?", (asg,))
        conn.commit()
        conn.close()
        self.wait(wf, ("paused",), timeout=30)
        out = self.resolve(asg, "retry")
        self.assertEqual(out["error"]["code"], "PROCESS_STILL_RUNNING")
        self.cancel(wf)


class CancelAndDeadlines(S07Case):
    def test_cancel_while_the_validator_runs_kills_it(self):
        self.set_config(validation={"argv": ["python3", "-c", "import time; time.sleep(60)"], "timeoutMs": 90000})
        r = self.start("withtests", debugStageOptions={"develop": fake("success", "fixed.txt")})["data"]
        wf = r["workflowRunId"]
        d = wait_until(lambda: len(self.show(wf)["stageAttempts"]) > 1 and self.show(wf), timeout=40)
        pid = d["stageAttempts"][1]["validation"]["process"]["pid"]
        self.cancel(wf)
        d = self.wait(wf, FINAL, timeout=40)
        self.assertEqual((d["workflowRun"]["status"], d["task"]["status"]), ("cancelled", "cancelled"))
        wait_until(lambda: not os.path.exists(f"/proc/{pid}") or open(f"/proc/{pid}/stat").read().split()[2] == "Z",
                   timeout=20, message="validator gone")

    def test_overall_deadline_fails_the_run_and_cancels_the_stage(self):
        self.set_config(workflowDeadlineMs=3000)
        r = self.start("one-write", debugStageOptions={"dev": fake("slow", "fixed.txt", duration=30000)})["data"]
        d = self.wait(r["workflowRunId"], FINAL, timeout=30)
        self.assertEqual(d["workflowRun"]["status"], "failed")
        self.assertIn("deadline", d["workflowRun"]["transitionReason"])
        wait_until(lambda: self.show(r["workflowRunId"])["assignments"][0]["status"] == "cancelled",
                   message="stage cancelled")

    def test_stage_deadline_pauses_with_timeout_and_a_retry_finishes(self):
        self.set_config(stageDeadlineMs=1500)
        r = self.start("one", debugStageOptions={"check": fake("timeout")})["data"]
        d = self.wait(r["workflowRunId"], ("paused",), timeout=40)
        paused = [e["data"] for e in d["events"] if e["name"] == "workflow_run.paused"][-1]
        self.assertEqual(paused["diagnosticCode"], "TIMEOUT")
        self.assertTrue(self.resolve(d["assignments"][0]["id"], "retry", debugProviderOptions=fake("verdict_pass"))["ok"])
        self.assertEqual(self.wait(r["workflowRunId"], FINAL, timeout=40)["workflowRun"]["status"], "succeeded")


if __name__ == "__main__":
    unittest.main()
