"""P00-S08: the real Codex adapter end to end, through the coordinator, tmux worker and runner, against a stand-in
`codex` executable on PATH (no fixture alias): per-agent model/reasoning and workspace roles/skills reach the CLI."""
import json
import os
import shutil
import tempfile
import unittest

from tests.helpers import Sandbox, key, req, wait_until

FAKE_BIN = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "fixtures", "codex", "bin")


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


class CodexCase(unittest.TestCase):
    ctl = {}

    def setUp(self):
        self.bin = tempfile.mkdtemp(prefix="as-codexbin-")
        shutil.copy(os.path.join(FAKE_BIN, "codex"), os.path.join(self.bin, "codex"))
        write(os.path.join(self.bin, "fake-codex.json"), json.dumps(self.ctl))
        self.sb = Sandbox(extra_env={"PATH": self.bin + os.pathsep + os.environ.get("PATH", "/usr/bin:/bin")})
        self.ws = tempfile.mkdtemp(prefix="as-ws-")
        cfg = os.path.join(self.ws, ".agent-studio")
        write(os.path.join(cfg, "roles", "developer.md"), "ROLE-MARKER: write tests before code.\n")
        write(os.path.join(cfg, "skills", "house-style", "SKILL.md"), "SKILL-MARKER: four-space indents.\n")
        write(os.path.join(cfg, "roles.json"), json.dumps({"version": 1, "roles": {"Developer": {
            "description": "DESC-MARKER implements features", "instructions": "roles/developer.md",
            "skills": ["house-style"]}}}))

    def tearDown(self):
        self.sb.cleanup()
        shutil.rmtree(self.bin, ignore_errors=True)
        shutil.rmtree(self.ws, ignore_errors=True)

    def calls(self):
        try:
            with open(os.path.join(self.bin, "calls.jsonl")) as f:
                return [json.loads(l) for l in f if l.strip()]
        except FileNotFoundError:
            return []

    def start(self, roster=None):
        rc, r, p = self.sb.run("coordinator", "start")
        self.assertTrue(r["ok"], p.stderr)
        args = {"workspace": self.ws}
        if roster is not None:
            args["roster"] = roster
        rc, r, _ = self.sb.request(req("team.start", args, idempotencyKey=key()))
        return r

    def direct(self, team, agent, text="TASK-MARKER add a feature", policy="read_only"):
        rc, r, _ = self.sb.request(req("task.direct", {"teamId": team, "agentId": agent, "policy": policy,
                                                       "text": text}, idempotencyKey=key("direct")))
        self.assertTrue(r["ok"], r)
        return r["data"]

    def wait_done(self, team, asg):
        def done():
            a = next(x for x in self.sb.snapshot(team)["assignments"] if x["id"] == asg)
            return a if a["status"] in ("succeeded", "failed", "cancelled", "inconclusive", "waiting_input") else None
        return wait_until(done, timeout=30, message="assignment finished")


class SettingsAndRoles(CodexCase):
    def test_model_reasoning_and_role_context_reach_codex(self):
        r = self.start([{"providerId": "codex", "role": "Developer", "model": "gpt-5.1-codex", "reasoning": "high"},
                        {"providerId": "codex", "role": "Reviewer"}])
        self.assertTrue(r["ok"], r)
        dev, rev = r["data"]["agents"]
        self.assertTrue(dev["roleConfigured"])
        self.assertEqual([s["kind"] for s in dev["roleSources"]], ["role", "skill"])
        self.assertFalse(rev["roleConfigured"])
        team = r["data"]["teamId"]

        d = self.direct(team, dev["agentId"])
        self.assertEqual((d["model"], d["reasoning"]), ("gpt-5.1-codex", "high"))
        a = self.wait_done(team, d["assignmentId"])
        self.assertEqual(a["status"], "succeeded", a)
        call = self.calls()[-1]
        self.assertEqual(call["model"], "gpt-5.1-codex")
        self.assertIn('model_reasoning_effort="high"', call["config"])
        self.assertEqual(call["sandbox"], "read-only")
        prompt = call["prompt"]
        order = [prompt.index(m) for m in ("DESC-MARKER", "ROLE-MARKER", "SKILL-MARKER", "TASK-MARKER")]
        self.assertEqual(order, sorted(order), prompt)

        d2 = self.direct(team, rev["agentId"], text="TASK-MARKER review", policy="workspace_write")
        self.assertEqual(self.wait_done(team, d2["assignmentId"])["status"], "succeeded")
        call = self.calls()[-1]
        self.assertIsNone(call["model"])
        self.assertFalse(any("model_reasoning_effort" in c for c in call["config"]))
        self.assertEqual(call["sandbox"], "workspace-write")
        self.assertIn("AGENT STUDIO ROLE: Reviewer", call["prompt"])

    def test_role_context_is_frozen_at_assignment_creation(self):
        r = self.start([{"providerId": "codex", "role": "Developer"}])
        team, agent = r["data"]["teamId"], r["data"]["agents"][0]["agentId"]
        d = self.direct(team, agent)
        self.wait_done(team, d["assignmentId"])
        rc, t, _ = self.sb.run("task", "show", "--task", d["taskId"])
        created = [e for e in t["data"]["events"] if e["name"] == "assignment.created"][0]
        self.assertEqual(len(created["data"]["roleContextSha256"]), 64)
        self.assertEqual(created["data"]["model"], None)

    def test_unsupported_settings_are_refused_before_any_pane_exists(self):
        for member, word in (({"providerId": "codex", "role": "D", "reasoning": "ultra"}, "ultra"),
                             ({"providerId": "codex", "role": "D", "model": "bad model"}, "model")):
            r = self.start([member])
            self.assertFalse(r["ok"], r)
            self.assertEqual(r["error"]["code"], "SETTING_UNSUPPORTED")
            self.assertIn(word, r["error"]["message"])
        self.assertEqual(self.sb.tmux("list-sessions", check=False), "")

    def test_team_json_and_cli_agent_settings(self):
        write(os.path.join(self.ws, ".agent-studio", "team.json"), json.dumps({"version": 1, "agents": [
            {"providerId": "codex", "role": "Developer", "name": "dev", "model": "gpt-5.1-codex-mini",
             "reasoning": "low"}]}))
        r = self.start()
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["data"]["agents"][0]["model"], "gpt-5.1-codex-mini")
        self.sb.run("team", "stop", "--team", r["data"]["teamId"])
        rc, r2, p = self.sb.run("team", "start", "--workspace", self.ws, "--agent",
                                "codex:Developer:dev2,model=gpt-5.1-codex,reasoning=minimal")
        self.assertTrue(r2["ok"], (r2, p.stderr))
        ag = r2["data"]["agents"][0]
        self.assertEqual((ag["model"], ag["reasoning"], ag["displayName"]), ("gpt-5.1-codex", "minimal", "dev2"))
        rc, r3, _ = self.sb.run("team", "start", "--workspace", self.ws, "--agent", "codex:Developer,speed=fast")
        self.assertFalse(r3["ok"])

    def test_preflight_reports_roles_and_settings(self):
        rc, r, p = self.sb.run("preflight", "--workspace", self.ws, "--provider", "codex", "--role", "Developer",
                               "--role", "Nobody")
        self.assertTrue(r["data"], (r, p.stderr))
        checks = {c["name"]: c for c in r["data"]["checks"]}
        self.assertTrue(checks["role:Developer"]["configured"])
        self.assertFalse(checks["role:Nobody"]["configured"])
        prov = checks["provider:codex"]
        self.assertTrue(prov["ok"], prov)


class FailedTurn(CodexCase):
    ctl = {"mode": "turn_failed"}

    def test_turn_failed_is_a_failed_assignment(self):
        r = self.start([{"providerId": "codex", "role": "Developer"}])
        team, agent = r["data"]["teamId"], r["data"]["agents"][0]["agentId"]
        a = self.wait_done(team, self.direct(team, agent)["assignmentId"])
        self.assertEqual((a["status"], a["result"]["diagnosticCode"]), ("failed", "PROVIDER_ERROR"))


class LoggedOut(CodexCase):
    ctl = {"loggedOut": True}

    def test_team_start_refuses_unauthenticated_codex(self):
        r = self.start([{"providerId": "codex", "role": "Developer"}])
        self.assertFalse(r["ok"], r)
        self.assertIn("login", json.dumps(r["error"]))

    def test_verify_fails_with_reason(self):
        rc, r, p = self.sb.run("provider", "verify", "--provider", "codex", timeout=120)
        self.assertFalse(r["ok"], p.stderr)
        self.assertEqual(r["error"]["code"], "VERIFY_FAILED")
        self.assertIn("AUTH_REQUIRED", r["error"]["message"])


class Verify(CodexCase):
    def test_verify_passes_and_keeps_evidence(self):
        rc, r, p = self.sb.run("provider", "verify", "--provider", "codex", "--model", "gpt-5.1-codex",
                               "--reasoning", "medium", timeout=170)
        self.assertTrue(r["ok"], (r, p.stderr))
        d = r["data"]
        self.assertTrue(d["probe"]["authVerified"])
        self.assertEqual([s["name"] for s in d["steps"]], ["read_only_reply", "workspace_write_creates_file",
                                                           "read_only_blocks_write", "reviewer_verdict"])
        self.assertTrue(all(s["passed"] for s in d["steps"]), d["steps"])
        ev = d["evidenceDir"]
        self.assertTrue(os.path.isfile(os.path.join(ev, "summary.json")))
        self.assertTrue(os.path.getsize(os.path.join(ev, "read_only_reply", "stdout.jsonl")) > 0)
        runs = [c for c in self.calls() if c["prompt"] and "AGENT_STUDIO" in c["prompt"]]
        self.assertTrue(all(c["model"] == "gpt-5.1-codex" for c in runs[1:]))  # [0] is the settings-free probe

    def test_verify_rejects_unverified_reasoning(self):
        rc, r, _ = self.sb.run("provider", "verify", "--provider", "codex", "--reasoning", "max")
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"]["code"], "SETTING_UNSUPPORTED")


if __name__ == "__main__":
    unittest.main()
