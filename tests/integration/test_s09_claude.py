"""P00-S09: the real Claude Code adapter end to end (coordinator, tmux worker, runner) against a stand-in `claude`
on PATH, side by side with the Codex adapter: per-agent settings and workspace roles reach each CLI."""
import json
import os
import shutil
import tempfile
import unittest

from tests.helpers import Sandbox, key, req, wait_until

FIX = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "fixtures")


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


class ClaudeCase(unittest.TestCase):
    ctl = {}

    def setUp(self):
        self.bin = tempfile.mkdtemp(prefix="as-clibin-")
        for p in ("claude", "codex"):
            shutil.copy(os.path.join(FIX, p, "bin", p), os.path.join(self.bin, p))
        write(os.path.join(self.bin, "fake-claude.json"), json.dumps(self.ctl))
        self.sb = Sandbox(extra_env={"PATH": self.bin + os.pathsep + os.environ.get("PATH", "/usr/bin:/bin")})
        self.ws = tempfile.mkdtemp(prefix="as-ws-")
        write(os.path.join(self.ws, ".agent-studio", "roles", "Reviewer.md"), "REVIEWER-MARKER: be strict.\n")

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

    def start(self, roster):
        rc, r, p = self.sb.run("coordinator", "start")
        self.assertTrue(r["ok"], p.stderr)
        rc, r, _ = self.sb.request(req("team.start", {"workspace": self.ws, "roster": roster}, idempotencyKey=key()))
        return r

    def direct(self, team, agent, text, policy="read_only"):
        rc, r, _ = self.sb.request(req("task.direct", {"teamId": team, "agentId": agent, "policy": policy,
                                                       "text": text}, idempotencyKey=key("direct")))
        self.assertTrue(r["ok"], r)
        return r["data"]

    def wait_done(self, team, asg):
        def done():
            a = next(x for x in self.sb.snapshot(team)["assignments"] if x["id"] == asg)
            return a if a["status"] in ("succeeded", "failed", "cancelled", "inconclusive", "waiting_input") else None
        return wait_until(done, timeout=30, message="assignment finished")


class MixedTeam(ClaudeCase):
    def test_codex_developer_and_claude_reviewer(self):
        r = self.start([{"providerId": "codex", "role": "Developer", "reasoning": "high"},
                        {"providerId": "claude", "role": "Reviewer", "model": "opus", "reasoning": "max"}])
        self.assertTrue(r["ok"], r)
        team = r["data"]["teamId"]
        dev, rev = (a["agentId"] for a in r["data"]["agents"])
        d = self.direct(team, rev, "TASK-MARKER Create a file named notes.txt in the current directory whose entire "
                                   "content is the single line hello. Then reply DONE.", policy="workspace_write")
        a = self.wait_done(team, d["assignmentId"])
        self.assertEqual(a["status"], "succeeded", a)
        self.assertTrue(os.path.isfile(os.path.join(self.ws, "notes.txt")))
        call = self.calls()[-1]
        self.assertEqual((call["model"], call["effort"], call["mode"], call["cwd"]),
                         ("opus", "max", "acceptEdits", os.path.realpath(self.ws)))
        p = call["prompt"]
        self.assertLess(p.index("REVIEWER-MARKER"), p.index("TASK-MARKER"))
        d2 = self.direct(team, dev, "Reply with exactly CODEX_OK and nothing else.")
        self.assertEqual(self.wait_done(team, d2["assignmentId"])["result"]["summary"], "CODEX_OK")

    def test_read_only_write_attempt_does_not_write(self):
        r = self.start([{"providerId": "claude", "role": "Reviewer"}])
        team, agent = r["data"]["teamId"], r["data"]["agents"][0]["agentId"]
        a = self.wait_done(team, self.direct(team, agent, "Create a file named nope.txt in the current directory "
                                                          "whose entire content is the single line x.")["assignmentId"])
        self.assertEqual(a["status"], "succeeded")
        self.assertFalse(os.path.exists(os.path.join(self.ws, "nope.txt")))
        self.assertEqual(self.calls()[-1]["tools"], ["Read", "Grep", "Glob"])

    def test_unsupported_effort_refused(self):
        r = self.start([{"providerId": "claude", "role": "R", "reasoning": "minimal"}])
        self.assertEqual(r["error"]["code"], "SETTING_UNSUPPORTED")

    def test_verify(self):
        rc, r, p = self.sb.run("provider", "verify", "--provider", "claude", "--model", "sonnet", "--reasoning", "low",
                               timeout=170)
        self.assertTrue(r["ok"], (r, p.stderr))
        self.assertTrue(all(s["passed"] for s in r["data"]["steps"]), r["data"]["steps"])
        self.assertIn("check 4/4", p.stderr.decode())


class ApiError(ClaudeCase):
    ctl = {"mode": "api_error"}

    def test_failed(self):
        r = self.start([{"providerId": "claude", "role": "R"}])
        team, agent = r["data"]["teamId"], r["data"]["agents"][0]["agentId"]
        a = self.wait_done(team, self.direct(team, agent, "anything")["assignmentId"])
        self.assertEqual((a["status"], a["result"]["diagnosticCode"]), ("failed", "PROVIDER_ERROR"))


class LoggedOut(ClaudeCase):
    ctl = {"loggedOut": True}

    def test_refused_at_team_start(self):
        r = self.start([{"providerId": "claude", "role": "R"}])
        self.assertFalse(r["ok"])
        self.assertIn("claude auth login", json.dumps(r["error"]))


if __name__ == "__main__":
    unittest.main()
