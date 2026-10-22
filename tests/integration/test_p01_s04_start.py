"""P01-S04: workflow.start with a definition: binding, freezing, first-stage dispatch, rejections, idempotency."""
import hashlib
import json
import os
import subprocess
import unittest

from tests.helpers import Sandbox, key, make_repo, req, wait_until
from agent_studio import prompts

ALIASES = {"AGENT_STUDIO_TEST_FIXTURE_PROVIDERS": "codex=fake,claude=fake,agy=fake,opencode=fake"}
SHIP = {"version": 1, "description": "dev then qa", "stages": [
    {"id": "develop", "role": "Developer", "permission": "workspace_write", "maxVisits": 2,
     "prompt": "Implement.\n{{task}}\nStage {{stage}} visit {{visit}}", "next": {"done": "qa"}},
    {"id": "qa", "role": "QA", "permission": "read_only", "maxVisits": 2, "prompt": "Review.\n{{diff}}",
     "next": {"pass": "$succeed", "fail": "develop"}}]}
QA_FIRST = {"version": 1, "stages": [
    {"id": "check", "role": "QA", "permission": "read_only", "prompt": "Check it.", "next": {"pass": "$succeed",
                                                                                              "fail": "$fail"}}]}
NOBODY = {"version": 1, "stages": [
    {"id": "a", "role": "Nobody", "permission": "read_only", "prompt": "x", "next": {"done": "$succeed"}}]}
SAME = {"version": 1, "stages": [
    {"id": "a", "role": "Developer", "permission": "read_only", "prompt": "x", "next": {"done": "b"}},
    {"id": "b", "role": "QA", "permission": "read_only", "prompt": "x", "next": {"done": "$succeed"}}]}
BAD = {"version": 1, "stages": [
    {"id": "a", "role": "Developer", "permission": "read_only", "prompt": "{{nope}}", "next": {"done": "$succeed"}}]}
FINAL = ("succeeded", "failed", "cancelled")


def fake(scenario="success", write=None, duration=150):
    o = {"scenario": scenario, "durationMs": duration, "progressLines": 1}
    if write:
        o["writeFile"] = write
    return o


def git(ws, *a):
    subprocess.run(["git", "-C", ws] + list(a), check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


class StartCase(unittest.TestCase):
    roster = [("codex", "Developer"), ("claude", "QA")]

    def setUp(self):
        self.sb = Sandbox(extra_env=ALIASES)
        rc, r, p = self.sb.run("coordinator", "start", "--enable-debug")
        self.assertTrue(r["ok"], p.stderr)
        self.ws = make_repo()
        self.defs = {}
        for name, obj in (("ship", SHIP), ("qa-first", QA_FIRST), ("nobody", NOBODY), ("same", SAME), ("bad", BAD)):
            self.write_def(name, obj)
        self.commit("add definitions")
        self.team = self.start_team(self.roster)

    def tearDown(self):
        self.sb.cleanup()

    def write_def(self, name, obj):
        d = os.path.join(self.ws, ".agent-studio", "workflows")
        os.makedirs(d, exist_ok=True)
        data = json.dumps(obj, indent=1).encode()
        with open(os.path.join(d, name + ".json"), "wb") as f:
            f.write(data)
        self.defs[name] = data

    def commit(self, msg):
        git(self.ws, "add", "-A")
        git(self.ws, "commit", "-qm", msg)

    def start_team(self, roster):
        r = [{"providerId": p, "role": role} for p, role in roster]
        rc, resp, _ = self.sb.request(req("team.start", {"workspace": self.ws, "roster": r}, idempotencyKey=key()))
        self.assertTrue(resp["ok"], resp)
        return resp["data"]

    def agent(self, role, team=None):
        return next(a["agentId"] for a in (team or self.team)["agents"] if a["role"] == role)

    def start(self, definition="ship", k=None, expect_ok=True, **extra):
        args = dict({"teamId": self.team["teamId"], "definition": definition, "text": "Add the feature"}, **extra)
        rc, r, _ = self.sb.request(req("workflow.start", args, idempotencyKey=k or key("wf")))
        if expect_ok:
            self.assertTrue(r["ok"], r)
        return r

    def show(self, wf):
        rc, r, _ = self.sb.run("workflow", "show", "--workflow", wf)
        self.assertTrue(r["ok"], r)
        return r["data"]

    def wait(self, wf, statuses=FINAL + ("paused",), timeout=40):
        return wait_until(lambda: self.show(wf)["workflowRun"]["status"] in statuses and self.show(wf),
                          timeout=timeout, message=f"workflow -> {statuses}")

    def cancel(self, wf):
        rc, r, _ = self.sb.request(req("workflow.cancel", {"workflowRunId": wf}, idempotencyKey=key()))
        self.assertTrue(r["ok"], r)

    def code(self, r):
        self.assertFalse(r["ok"], r)
        return r["error"]["code"]

    def assertNothingWritten(self):
        snap = self.sb.snapshot()
        self.assertEqual((snap["workflowRuns"], snap["tasks"]), ([], []))


class Freezing(StartCase):
    def test_definition_sha_bindings_and_first_assignment(self):
        opts = {"develop": fake("success", "feature.txt")}
        r = self.start(debugStageOptions=opts)["data"]
        sha = hashlib.sha256(self.defs["ship"]).hexdigest()
        dev, qa = self.agent("Developer"), self.agent("QA")
        self.assertEqual((r["definition"], r["definitionSha256"], r["bindings"]),
                         ("ship", sha, {"Developer": dev, "QA": qa}))
        d = self.show(r["workflowRunId"])
        w = d["workflowRun"]
        self.assertEqual((w["workflow"], w["definitionName"], w["definitionSha256"], w["stepCount"], w["currentStage"]),
                         ("definition", "ship", sha, 1, "develop"))
        self.assertEqual(w["bindings"], {"Developer": dev, "QA": qa})
        self.assertEqual(w["definition"]["sourceSha256"], sha)
        self.assertEqual([s["id"] for s in w["definition"]["stages"]], ["develop", "qa"])
        self.assertEqual(w["definition"]["stages"][0]["promptSource"], "inline")
        self.assertNotIn("promptFile", w["definition"]["stages"][0])
        sa = d["stageAttempts"][0]
        self.assertEqual((sa["stage"], sa["stageType"], sa["visit"], sa["attempt"], sa["agentId"]),
                         ("develop", "agent", 1, 1, dev))
        asg = d["assignments"][0]
        self.assertEqual((asg["agentId"], asg["policy"], asg["providerId"]), (dev, "workspace_write", "codex"))
        started = [e for e in d["events"] if e["name"] == "workflow_run.started" or
                   (e["name"] == "workflow_run.created" and "definition" in e["data"])]
        self.assertTrue(started and started[0]["data"]["definition"] == "ship"
                        and started[0]["data"]["definitionSha256"] == sha and started[0]["data"]["bindings"] == w["bindings"])
        self.cancel(r["workflowRunId"])

    def test_editing_the_file_afterwards_changes_nothing(self):
        r = self.start(debugStageOptions={"develop": fake("success", "feature.txt", duration=300)})["data"]
        before = self.show(r["workflowRunId"])["workflowRun"]
        self.write_def("ship", dict(SHIP, description="edited", maxSteps=3))
        after = self.show(r["workflowRunId"])["workflowRun"]
        self.assertEqual(before["definition"], after["definition"])
        self.assertEqual(before["definitionSha256"], after["definitionSha256"])
        self.assertEqual(after["definition"]["description"], "dev then qa")
        self.cancel(r["workflowRunId"])

    def test_first_prompt_has_the_task_and_no_footer_on_a_work_stage(self):
        r = self.start(debugStageOptions={"develop": fake("success", "feature.txt")})["data"]
        d = self.show(r["workflowRunId"])
        text = open(d["stageAttempts"][0]["promptPath"], encoding="utf-8").read()
        self.assertIn("===== TASK =====\nAdd the feature\n===== END TASK =====", text)
        self.assertIn("Stage develop visit 1", text)
        self.assertNotIn("verdict", text)
        self.cancel(r["workflowRunId"])

    def test_a_verdict_first_stage_ends_with_the_footer(self):
        r = self.start("qa-first", debugStageOptions={"check": fake("verdict_pass")})["data"]
        d = self.show(r["workflowRunId"])
        text = open(d["stageAttempts"][0]["promptPath"], encoding="utf-8").read()
        self.assertTrue(text.endswith(prompts.VERDICT_FOOTER))
        self.assertIn("===== TASK =====", text)
        asg = d["assignments"][0]
        self.assertEqual((asg["agentId"], asg["policy"], asg["providerId"]),
                         (self.agent("QA"), "read_only", "claude"))
        self.cancel(r["workflowRunId"])

    def test_after_the_first_stage_the_run_routes_to_the_next_stage(self):
        r = self.start(debugStageOptions={"develop": fake("success", "feature.txt"), "qa": fake("success", duration=20000)})["data"]
        d = wait_until(lambda: len(self.show(r["workflowRunId"])["assignments"]) >= 2 and self.show(r["workflowRunId"]),
                       timeout=40, message="qa dispatched")
        self.assertEqual([s["stage"] for s in d["stageAttempts"]], ["develop", "qa"])
        self.assertEqual(d["workflowRun"]["currentStage"], "qa")
        self.cancel(r["workflowRunId"])
        self.assertIn(self.wait(r["workflowRunId"], FINAL)["workflowRun"]["status"], FINAL)


class BindingErrors(StartCase):
    def test_role_unbound(self):
        r = self.start("nobody", expect_ok=False)
        self.assertEqual(self.code(r), "ROLE_UNBOUND")
        self.assertEqual(r["data"]["role"], "Nobody")
        self.assertNothingWritten()

    def test_role_ambiguous_then_resolved_with_bind(self):
        self.sb.request(req("team.stop", {"teamId": self.team["teamId"]}, idempotencyKey=key()))
        self.team = self.start_team([("codex", "Developer"), ("claude", "Developer"), ("agy", "QA")])
        r = self.start(expect_ok=False)
        self.assertEqual(self.code(r), "ROLE_AMBIGUOUS")
        self.assertEqual(len(r["data"]["agentIds"]), 2)
        self.assertNothingWritten()
        second = [a["agentId"] for a in self.team["agents"] if a["role"] == "Developer"][1]
        ok = self.start(bindings={"Developer": second}, debugStageOptions={"develop": fake("success", "f.txt")})
        self.assertEqual(ok["data"]["bindings"]["Developer"], second)
        self.cancel(ok["data"]["workflowRunId"])

    def test_same_agent_for_two_roles(self):
        dev = self.agent("Developer")
        r = self.start("same", bindings={"QA": dev}, expect_ok=False)
        self.assertEqual(self.code(r), "SAME_AGENT")
        self.assertNothingWritten()

    def test_binding_for_a_role_the_definition_does_not_use(self):
        r = self.start(bindings={"Ghost": self.agent("QA")}, expect_ok=False)
        self.assertEqual(self.code(r), "BAD_REQUEST")
        self.assertNothingWritten()

    def test_unknown_agent_in_bindings(self):
        r = self.start(bindings={"QA": "11111111-1111-4111-8111-111111111111"}, expect_ok=False)
        self.assertEqual(self.code(r), "NOT_FOUND")
        self.assertNothingWritten()

    def test_bad_binding_shapes_are_rejected_before_the_coordinator(self):
        for bad in ({"QA": "not-a-uuid"}, ["x"], {"": self.agent("QA")}):
            self.assertEqual(self.code(self.start(bindings=bad, expect_ok=False)), "BAD_REQUEST")
        self.assertNothingWritten()


class DefinitionErrors(StartCase):
    def test_not_found_invalid_and_bad_name(self):
        self.assertEqual(self.code(self.start("missing", expect_ok=False)), "WORKFLOW_DEFINITION_NOT_FOUND")
        r = self.start("bad", expect_ok=False)
        self.assertEqual(self.code(r), "WORKFLOW_DEFINITION_INVALID")
        self.assertEqual(r["data"]["errors"][0]["path"], "stages[0].prompt")
        self.assertEqual(self.code(self.start("../etc", expect_ok=False)), "BAD_REQUEST")
        self.assertNothingWritten()

    def test_p00_ids_cannot_be_mixed_with_a_definition(self):
        r = self.start(developerAgentId=self.agent("Developer"), expect_ok=False)
        self.assertEqual(self.code(r), "BAD_REQUEST")


class Preconditions(StartCase):
    def test_dirty_tree(self):
        with open(os.path.join(self.ws, "stray.txt"), "w") as f:
            f.write("x")
        self.assertEqual(self.code(self.start(expect_ok=False)), "WORKSPACE_DIRTY")
        self.assertNothingWritten()

    def test_team_not_running(self):
        self.sb.request(req("team.stop", {"teamId": self.team["teamId"]}, idempotencyKey=key()))
        self.assertEqual(self.code(self.start(expect_ok=False)), "TEAM_NOT_RUNNING")
        self.assertEqual(self.sb.snapshot()["workflowRuns"], [])

    def test_workspace_busy(self):
        first = self.start(debugStageOptions={"develop": fake("success", "feature.txt", duration=3000)})["data"]
        r = self.start(expect_ok=False)
        self.assertEqual(self.code(r), "WORKSPACE_BUSY")
        self.assertEqual(len(self.sb.snapshot()["workflowRuns"]), 1)
        self.cancel(first["workflowRunId"])

    def test_not_a_git_repository(self):
        import shutil
        shutil.rmtree(os.path.join(self.ws, ".git"))
        self.assertEqual(self.code(self.start(expect_ok=False)), "WORKSPACE_NOT_GIT")
        self.assertNothingWritten()


class Idempotency(StartCase):
    def test_same_key_same_payload_returns_the_original_receipt(self):
        k = key("idem")
        opts = {"develop": fake("success", "feature.txt", duration=1500)}
        a = self.start(k=k, debugStageOptions=opts)["data"]
        b = self.start(k=k, debugStageOptions=opts)["data"]
        self.assertEqual(a, b)
        self.assertEqual(len(self.sb.snapshot()["workflowRuns"]), 1)
        self.cancel(a["workflowRunId"])

    def test_same_key_other_definition_conflicts(self):
        k = key("idem")
        a = self.start(k=k, debugStageOptions={"develop": fake("success", "feature.txt", duration=1500)})["data"]
        r = self.start("qa-first", k=k, expect_ok=False)
        self.assertEqual(self.code(r), "IDEMPOTENCY_CONFLICT")
        self.assertEqual(len(self.sb.snapshot()["workflowRuns"]), 1)
        self.cancel(a["workflowRunId"])


if __name__ == "__main__":
    unittest.main()
