"""P00-S06: the built-in Developer -> Reviewer workflow, end to end with tmux workers and the fake provider
running under real peer IDs (codex developer, claude reviewer by default)."""
import json
import os
import subprocess
import tempfile
import time
import unittest

from tests.helpers import SHIM, Sandbox, key, make_repo, req, reset_repo, wait_until

ALIASES = {"AGENT_STUDIO_TEST_FIXTURE_PROVIDERS": "codex=fake,claude=fake,agy=fake,opencode=fake"}
FINAL = ("succeeded", "failed", "cancelled")
HOSTILE = "Implement it; $(touch CANARY_TASK) `touch CANARY_TASK_BT` && rm -rf ~ | tee x\nline two 漢字"


def fake(scenario, write=None, duration=150):
    o = {"scenario": scenario, "durationMs": duration, "progressLines": 1}
    if write:
        o["writeFile"] = write
    return o


class WorkflowCase(unittest.TestCase):
    providers = ("codex", "claude")
    config = None

    def setUp(self):
        self.sb = Sandbox(extra_env=ALIASES)
        rc, r, p = self.sb.run("coordinator", "start", "--enable-debug")
        self.assertTrue(r["ok"], p.stderr)
        self.ws = make_repo(self.config)
        roster = [{"providerId": p, "role": role} for p, role in zip(self.providers, ("developer", "reviewer"))]
        rc, r, _ = self.sb.request(req("team.start", {"workspace": self.ws, "roster": roster}, idempotencyKey=key()))
        self.assertTrue(r["ok"], r)
        self.team = r["data"]
        self.dev, self.rev = (a["agentId"] for a in self.team["agents"])

    def tearDown(self):
        self.sb.cleanup()

    def start(self, stages, text="Add the feature", k=None, **extra):
        args = dict({"teamId": self.team["teamId"], "developerAgentId": self.dev, "reviewerAgentId": self.rev,
                     "text": text, "debugStageOptions": stages}, **extra)
        rc, r, _ = self.sb.request(req("workflow.start", args, idempotencyKey=k or key("wf")))
        return r

    def show(self, wf):
        rc, r, _ = self.sb.run("workflow", "show", "--workflow", wf)
        self.assertTrue(r["ok"], r)
        return r["data"]

    def wait(self, wf, statuses=FINAL + ("paused",), timeout=40):
        return wait_until(lambda: self.show(wf)["workflowRun"]["status"] in statuses and self.show(wf), timeout=timeout,
                          message=f"workflow -> {statuses}")

    def cancel(self, wf):
        rc, r, _ = self.sb.request(req("workflow.cancel", {"workflowRunId": wf}, idempotencyKey=key()))
        self.assertTrue(r["ok"], r)
        return r["data"]

    def stages(self, d):
        return [(s["stage"], s["outcome"]) for s in d["stageAttempts"]]

    def wf_events(self, d, name):
        return [e for e in d["events"] if e["name"] == name]


class HappyAndBoundedRepair(WorkflowCase):
    def test_fail_review_then_repair_then_pass(self):
        base = subprocess.run(["git", "-C", self.ws, "rev-parse", "HEAD"], stdout=subprocess.PIPE).stdout.decode().strip()
        r = self.start({"developer": fake("success", "feature.txt"), "reviewer": fake("verdict_fail"),
                        "developer_repair": fake("success", "fixed.txt"), "reviewer_recheck": fake("verdict_pass")},
                       text=HOSTILE)
        self.assertEqual(r["data"]["baseCommit"], base)
        d = self.wait(r["data"]["workflowRunId"], FINAL)
        w = d["workflowRun"]
        self.assertEqual((w["status"], w["retryCount"], w["baseCommit"]), ("succeeded", 1, base))
        self.assertEqual(d["task"]["status"], "succeeded")
        # S06: validation is its own stage attempt, so the six stages of the built-in definition show up
        self.assertEqual(self.stages(d), [("developer", "done"), ("validation", "validation_failed"),
                                          ("reviewer", "verdict_fail"), ("developer_repair", "done"),
                                          ("validation_recheck", "validation_passed"),
                                          ("reviewer_recheck", "verdict_pass")])
        self.assertEqual(len(d["assignments"]), 4)
        # provider IDs come from agents; policies from stages
        self.assertEqual([(a["providerId"], a["policy"]) for a in d["assignments"]],
                         [("codex", "workspace_write"), ("claude", "read_only")] * 2)
        # handoffs chain source assignment IDs
        hand = self.wf_events(d, "workflow_run.handoff")
        ids = [a["id"] for a in d["assignments"]]
        self.assertEqual([h["data"]["toAssignmentId"] for h in hand], ids)
        self.assertEqual([h["data"]["fromAssignmentId"] for h in hand], [None, ids[0], ids[1], ids[2]])
        verdicts = self.wf_events(d, "stage_attempt.verdict")
        self.assertEqual([(v["data"]["sourceAssignmentId"], v["data"]["verdict"]) for v in verdicts],
                         [(ids[1], "fail"), (ids[3], "pass")])
        validated = self.wf_events(d, "stage_attempt.validated")
        self.assertEqual([(v["data"]["sourceAssignmentId"], v["data"]["passed"]) for v in validated],
                         [(ids[0], False), (ids[2], True)])
        # durable artifacts: diffs, validation output, prompts as data files
        dev1, val1, rev1, dev2, val2, rev2 = d["stageAttempts"]
        self.assertIn("feature.txt", open(dev1["diff"]["path"]).read())
        self.assertIn("fixed.txt", open(dev2["diff"]["path"]).read())
        self.assertIn("looking for fixed.txt", open(val1["validation"]["outputPath"]).read())
        review_prompt = open(rev1["promptPath"]).read()
        for section in ("===== TASK =====", "===== DIFF =====", "===== VALIDATION =====", "feature.txt", "FAILED"):
            self.assertIn(section, review_prompt)
        repair_prompt = open(dev2["promptPath"]).read()
        self.assertIn("$(touch CANARY_FINDING) `touch CANARY_BACKTICK`", repair_prompt)
        self.assertIn(HOSTILE, repair_prompt)
        for where in (self.ws, os.path.expanduser("~"), os.getcwd()):
            self.assertEqual([n for n in os.listdir(where) if n.startswith("CANARY")], [], where)
        wait_until(lambda: {g["availability"] for g in self.sb.snapshot(self.team["teamId"])["agents"]} == {"idle"})

    def test_review_fails_twice_is_terminal_with_no_fifth_attempt(self):
        r = self.start({"developer": fake("success", "fixed.txt"), "reviewer": fake("verdict_fail"),
                        "developer_repair": fake("success", "fixed2.txt"), "reviewer_recheck": fake("verdict_fail")})
        d = self.wait(r["data"]["workflowRunId"], FINAL)
        self.assertEqual((d["workflowRun"]["status"], d["task"]["status"]), ("failed", "failed"))
        self.assertEqual(len(d["stageAttempts"]), 6)   # S06: two of them are validation attempts
        time.sleep(1.5)
        d = self.show(r["data"]["workflowRunId"])
        self.assertEqual(len(d["assignments"]), 4)
        self.assertEqual(d["workflowRun"]["transitionReason"], "reviewer_recheck fail")   # S06: was "repair budget used"
        self.assertIn("test_add fails", d["workflowRun"]["lastFinding"])

    def test_completes_after_the_cli_exits(self):
        # the operator's `workflow start --wait` is killed mid-run; the workflow must still finish on its own
        reset_repo(self.ws)
        p = subprocess.Popen([SHIM, "workflow", "start", "--team", self.team["teamId"], "--developer", self.dev,
                              "--reviewer", self.rev, "--text", "real CLI", "--wait"],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=self.sb.env)
        wf = wait_until(lambda: [w["id"] for w in self.sb.snapshot(self.team["teamId"])["workflowRuns"]],
                        message="workflow accepted")[0]
        p.kill()
        p.communicate(timeout=10)
        d = self.wait(wf, FINAL + ("paused",))
        # no debug stage options: the fake's default run gives no verdict, so the reviewer stage pauses -
        # what matters here is that the run advanced through stages with no CLI attached
        self.assertGreaterEqual(len(d["stageAttempts"]), 3)   # S06: validation counts
        self.assertEqual(d["workflowRun"]["status"], "paused")
        self.cancel(wf)


class TruthTable(WorkflowCase):
    """First review outcome x validation outcome, plus every pausing row."""

    def run_case(self, stages, expect_status, expect_next=None):
        reset_repo(self.ws)
        r = self.start(stages)
        self.assertTrue(r["ok"], r)
        wf = r["data"]["workflowRunId"]
        if expect_next:
            d = wait_until(lambda: len(self.show(wf)["stageAttempts"]) >= 4 and self.show(wf), timeout=40,
                           message="next stage")
            self.assertEqual(d["stageAttempts"][3]["stage"], expect_next)   # S06: index 3 (validation is attempt 2)
        d = self.wait(wf)
        self.assertEqual(d["workflowRun"]["status"], expect_status, (stages, d["workflowRun"]["transitionReason"]))
        if expect_status == "paused":
            self.cancel(wf)  # frees the workspace for the next row
            self.assertEqual(self.show(wf)["workflowRun"]["status"], "cancelled")
        return d

    def test_rows(self):
        # validation pass + reviewer pass -> succeeded after two stages
        d = self.run_case({"developer": fake("success", "fixed.txt"), "reviewer": fake("verdict_pass")}, "succeeded")
        self.assertEqual(len(d["stageAttempts"]), 3)   # S06: developer, validation, reviewer
        # validation pass + reviewer fail -> repair
        self.run_case({"developer": fake("success", "fixed.txt"), "reviewer": fake("verdict_fail"),
                       "developer_repair": fake("success", "fixed.txt"), "reviewer_recheck": fake("verdict_pass")},
                      "succeeded", expect_next="developer_repair")
        # validation fail + reviewer pass -> repair (validation overrides an approving reviewer)
        d = self.run_case({"developer": fake("success", "feature.txt"), "reviewer": fake("verdict_pass"),
                           "developer_repair": fake("success", "fixed.txt"), "reviewer_recheck": fake("verdict_pass")},
                          "succeeded", expect_next="developer_repair")
        repair = [e for e in d["events"] if e["name"] == "workflow_run.repair_requested"][0]
        self.assertEqual(repair["data"]["findings"][0], "validation did not pass")   # S06: was reason "validation failed"
        # validation fail + reviewer fail -> repair; recheck still failing validation -> failed
        d = self.run_case({"developer": fake("success", "feature.txt"), "reviewer": fake("verdict_fail"),
                           "developer_repair": fake("success", "feature2.txt"), "reviewer_recheck": fake("verdict_pass")},
                          "failed", expect_next="developer_repair")
        self.assertEqual(d["workflowRun"]["transitionReason"], "reviewer_recheck fail")   # S06
        self.assertEqual(d["workflowRun"]["lastFinding"], "validation_recheck did not pass")

    def test_pausing_rows(self):
        for dev_scenario, code in (("provider_failure", "PROVIDER_ERROR"), ("no_final", "NO_TERMINAL_EVENT"),
                                   ("permission_denied", "PERMISSION_DENIED")):
            d = self.run_case({"developer": fake(dev_scenario)}, "paused")
            paused = [e for e in d["events"] if e["name"] == "workflow_run.paused"][0]
            self.assertEqual(paused["data"]["diagnosticCode"], code)
            self.assertEqual(len(d["stageAttempts"]), 1)  # never advanced to review
        for rev_scenario, code in (("verdict_malformed", "MALFORMED_VERDICT"), ("success", "MALFORMED_VERDICT")):
            d = self.run_case({"developer": fake("success", "fixed.txt"), "reviewer": fake(rev_scenario)}, "paused")
            paused = [e for e in d["events"] if e["name"] == "workflow_run.paused"][0]
            self.assertEqual(paused["data"]["diagnosticCode"], code)
            self.assertIn("verdict", d["workflowRun"]["transitionReason"])

    def test_reviewer_denied_write_preserves_valid_verdict(self):
        d = self.run_case({"developer": fake("success", "fixed.txt"),
                           "reviewer": fake("verdict_pass", write="reviewer-was-here.txt")}, "succeeded")
        self.assertEqual(d["assignments"][1]["result"]["verdict"]["verdict"], "pass")
        self.assertFalse(os.path.exists(os.path.join(self.ws, "reviewer-was-here.txt")))


class Preconditions(WorkflowCase):
    def code(self, r):
        self.assertFalse(r["ok"], r)
        return r["error"]["code"]

    def test_rejections(self):
        with open(os.path.join(self.ws, "stray.txt"), "w") as f:
            f.write("uncommitted")
        self.assertEqual(self.code(self.start({})), "WORKSPACE_DIRTY")
        os.unlink(os.path.join(self.ws, "stray.txt"))
        rc, r, _ = self.sb.request(req("workflow.start", {"teamId": self.team["teamId"], "developerAgentId": self.dev,
                                                          "reviewerAgentId": self.dev, "text": "t"}, idempotencyKey=key()))
        self.assertEqual(self.code(r), "SAME_AGENT")
        rc, busy, _ = self.sb.request(req("task.direct", {"teamId": self.team["teamId"], "agentId": self.rev,
                                                          "policy": "workspace_write", "text": "edit",
                                                          "debugProviderOptions": fake("slow", duration=20000)},
                                          idempotencyKey=key()))
        wait_until(lambda: any(a["status"] == "running" for a in self.sb.snapshot()["assignments"]))
        self.assertEqual(self.code(self.start({})), "WORKSPACE_BUSY")
        self.sb.request(req("assignment.cancel", {"assignmentId": busy["data"]["assignmentId"]}, idempotencyKey=key()))
        wait_until(lambda: all(a["status"] != "running" for a in self.sb.snapshot()["assignments"]))
        wait_until(lambda: {g["availability"] for g in self.sb.snapshot()["agents"]} == {"idle"})
        r = self.start({"developer": fake("slow", "fixed.txt", duration=20000)})
        self.assertTrue(r["ok"], r)
        rc, d, _ = self.sb.request(req("task.direct", {"teamId": self.team["teamId"], "agentId": self.rev,
                                                       "policy": "workspace_write", "text": "x"}, idempotencyKey=key()))
        self.assertEqual(d["error"]["code"], "WORKSPACE_BUSY")
        out = self.cancel(r["data"]["workflowRunId"])
        self.assertIn(out["outcome"], ("cancel_requested", "cancelled"))
        d = self.wait(r["data"]["workflowRunId"], FINAL)
        self.assertEqual((d["workflowRun"]["status"], d["task"]["status"]), ("cancelled", "cancelled"))
        wait_until(lambda: {g["availability"] for g in self.sb.snapshot(self.team["teamId"])["agents"]} == {"idle"})

    def test_non_git_and_missing_config(self):
        plain = tempfile.mkdtemp(prefix="as-plain-")
        rc, t, _ = self.sb.request(req("team.start", {"workspace": plain, "roster": [
            {"providerId": "codex", "role": "d"}, {"providerId": "claude", "role": "r"}]}, idempotencyKey=key()))
        a, b = (x["agentId"] for x in t["data"]["agents"])
        rc, r, _ = self.sb.request(req("workflow.start", {"teamId": t["data"]["teamId"], "developerAgentId": a,
                                                          "reviewerAgentId": b, "text": "t"}, idempotencyKey=key()))
        self.assertEqual(self.code(r), "WORKSPACE_NOT_GIT")
        subprocess.run(["git", "-C", self.ws, "rm", "-q", ".agent-studio/workflow.json"], check=True)
        subprocess.run(["git", "-C", self.ws, "commit", "-qm", "no config"], check=True)
        self.assertEqual(self.code(self.start({})), "WORKFLOW_CONFIG_INVALID")


class Limits(WorkflowCase):
    config = {"version": 1, "validation": {"argv": ["python3", "check.py"], "timeoutMs": 20000},
              "workflowDeadlineMs": 3000}

    def test_overall_deadline(self):
        r = self.start({"developer": fake("slow", "fixed.txt", duration=30000)})
        d = self.wait(r["data"]["workflowRunId"], FINAL, timeout=30)
        self.assertEqual(d["workflowRun"]["status"], "failed")
        self.assertIn("deadline", d["workflowRun"]["transitionReason"])
        wait_until(lambda: d["assignments"][0]["id"] and
                   self.show(r["data"]["workflowRunId"])["assignments"][0]["status"] == "cancelled",
                   message="stage cancelled")


class SwappedProviders(WorkflowCase):
    providers = ("opencode", "agy")

    def test_any_provider_any_role(self):
        r = self.start({"developer": fake("success", "fixed.txt"), "reviewer": fake("verdict_pass")})
        d = self.wait(r["data"]["workflowRunId"], FINAL)
        self.assertEqual(d["workflowRun"]["status"], "succeeded")
        self.assertEqual([a["providerId"] for a in d["assignments"]], ["opencode", "agy"])


if __name__ == "__main__":
    unittest.main()
