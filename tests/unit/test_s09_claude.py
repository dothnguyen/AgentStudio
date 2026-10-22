"""P00-S09: Claude Code adapter - mapping, settings and parsing of output captured from the real CLI 2.1.307."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

import tests.helpers  # noqa: F401
from agent_studio import providers
from agent_studio.protocol import AsError
from agent_studio.providers.base import AssignmentInput, ParseState
from agent_studio.providers.claude import adapter as claude_mod

FIX = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "fixtures", "claude")
CLAUDE = providers.get("claude")


def inp(policy="read_only", model=None, reasoning=None, verdict=False, ws="/tmp", prompt="/tmp/p.txt"):
    return AssignmentInput(assignment_id="a" * 8, agent_id="b" * 8, provider_id="claude", attempt=1, workspace=ws,
                           prompt_path=prompt, role_instructions="dev", policy=policy, deadline_s=60,
                           output_budget_bytes=1 << 20, model=model, reasoning=reasoning, expects_verdict=verdict)


def oc(**kw):
    d = {"exitCode": 0, "signal": None, "timedOut": False, "cancelRequested": False, "truncated": False,
         "outputPath": None, "stderrPath": None}
    d.update(kw)
    return d


def replay(name, **kw):
    st, shown = ParseState(), []
    with open(os.path.join(FIX, name), "rb") as f:
        for line in f:
            if line.strip():
                shown += CLAUDE.parse_line(line.rstrip(b"\n"), st)
    return CLAUDE.finalize(inp(**kw), st, oc()), st, shown


class FinalText(unittest.TestCase):
    def test_full_last_message_is_kept_beyond_the_summary_limit(self):
        st = ParseState()
        long = "Review.\n" + ("x" * 5000) + '\n{"verdict": "fail", "findings": ["a"]}'
        for obj in ({"type": "system", "subtype": "init", "session_id": "s"},
                    {"type": "result", "subtype": "success", "is_error": False, "result": long,
                     "permission_denials": []}):
            CLAUDE.parse_line(json.dumps(obj).encode(), st)
        r = CLAUDE.finalize(inp(), st, oc())
        self.assertEqual(len(r["summary"]), 2000)
        self.assertEqual(r["finalText"], long)
        self.assertTrue(r["finalText"].endswith('"findings": ["a"]}'))

    def test_huge_or_non_ascii_text_is_bounded_for_the_payload_limit(self):
        from agent_studio.providers.base import bounded_text, FINAL_TEXT_LIMIT
        for text in ("y" * 100000, "\u6f22" * 30000, "\U0001F600" * 20000):
            b = bounded_text(text)
            self.assertLessEqual(len(json.dumps(b)), FINAL_TEXT_LIMIT)
            self.assertIn("cut by Agent Studio", b)
        self.assertIsNone(bounded_text(None))
        self.assertEqual(bounded_text("short"), "short")


class Settings(unittest.TestCase):
    def test_levels_and_models(self):
        self.assertEqual(CLAUDE.reasoning_levels(), ("low", "medium", "high", "xhigh", "max"))
        for model in ("opus", "sonnet", "fable", "claude-opus-5-5", "claude-sonnet-5-5[1m]".replace("[1m]", "")):
            CLAUDE.validate_settings(model, "max")
        for bad in ((None, "minimal"), (None, "ultra"), ("--dangerously-skip-permissions", None), ("a b", None)):
            with self.assertRaises(AsError):
                CLAUDE.validate_settings(*bad)


class Argv(unittest.TestCase):
    def setUp(self):
        self.bin = tempfile.mkdtemp()
        shutil.copy(os.path.join(FIX, "bin", "claude"), os.path.join(self.bin, "claude"))
        self.env = {"PATH": self.bin + ":/usr/bin:/bin"}

    def tearDown(self):
        shutil.rmtree(self.bin)

    def argv(self, **kw):
        return CLAUDE.prepare(inp(**kw), self.env).argv

    def test_common_flags(self):
        a = self.argv()
        self.assertEqual(a[0], os.path.join(self.bin, "claude"))
        for flag in ("--print", "--verbose", "--no-session-persistence", "--strict-mcp-config", "--restricted"):
            self.assertIn(flag, a)
        self.assertEqual(a[a.index("--output-format") + 1], "stream-json")
        self.assertEqual(a[a.index("--permission-prompts") + 1], "none")
        p = CLAUDE.prepare(inp(ws="/work/space"), self.env)
        self.assertEqual((p.cwd, p.stdin_path), ("/work/space", "/tmp/p.txt"))
        self.assertNotIn("/work/space", p.argv)  # the workspace is the working directory, not an --add-dir

    def test_read_only_has_only_read_tools_and_denies_everything_else(self):
        a = self.argv()
        self.assertEqual(a[a.index("--permission-mode") + 1], "dontAsk")
        self.assertEqual(a[a.index("--tools") + 1], "Read,Grep,Glob")
        self.assertEqual(a[a.index("--allowedTools") + 1], "Read,Grep,Glob")

    def test_workspace_write_adds_file_edit_tools_only(self):
        a = self.argv(policy="workspace_write")
        self.assertEqual(a[a.index("--permission-mode") + 1], "acceptEdits")
        tools = a[a.index("--tools") + 1].split(",")
        self.assertEqual(sorted(tools), sorted(["Read", "Grep", "Glob", "Edit", "Write", "NotebookEdit"]))
        self.assertNotIn("Bash", tools)

    def test_commands_opt_in_adds_bash_and_drops_restricted(self):
        import tempfile, json as _j
        ws = tempfile.mkdtemp()
        os.makedirs(os.path.join(ws, ".agent-studio"))
        self.assertNotIn("Bash", self.argv(ws=ws, policy="workspace_write")[self.argv(ws=ws).index("--tools") + 1])
        with open(os.path.join(ws, ".agent-studio", "permissions.json"), "w") as f:
            _j.dump({"version": 1, "claude": {"commands": True}}, f)
        w = self.argv(ws=ws, policy="workspace_write")
        self.assertNotIn("--restricted", w)
        self.assertEqual(w[w.index("--allowedTools") + 1], "Read,Grep,Glob,Bash")
        r = self.argv(ws=ws)
        allowed = r[r.index("--allowedTools") + 1]
        self.assertIn("Bash(git diff:*)", allowed)
        self.assertIn("Bash(python3 -W ignore -m unittest:*)", allowed)
        self.assertIn("Bash(rg:*)", allowed)
        self.assertNotIn("Bash,", allowed + ",")  # no bare Bash for read_only
        for bad in claude_mod.NEVER:
            if bad != "Bash":
                self.assertNotIn(bad, w + r)
        shutil.rmtree(ws)

    def test_bad_permissions_file_means_off(self):
        import tempfile
        ws = tempfile.mkdtemp()
        os.makedirs(os.path.join(ws, ".agent-studio"))
        for text in ("not json", '{"version": 2, "claude": {"commands": true}}', '{"version":1,"claude":{"commands":"yes"}}'):
            with open(os.path.join(ws, ".agent-studio", "permissions.json"), "w") as f:
                f.write(text)
            self.assertFalse(claude_mod.commands_enabled(ws))
        shutil.rmtree(ws)

    def test_never_bypasses(self):
        for policy in ("read_only", "workspace_write"):
            for bad in claude_mod.NEVER:
                self.assertNotIn(bad, self.argv(policy=policy))

    def test_model_and_effort(self):
        a = self.argv(model="opus", reasoning="xhigh")
        self.assertEqual(a[a.index("--model") + 1], "opus")
        self.assertEqual(a[a.index("--effort") + 1], "xhigh")
        self.assertNotIn("--model", self.argv())
        self.assertEqual(self.argv(model="auto")[-1], "auto")  # a model literally named "auto" is just a value

    def test_env_allowlist(self):
        env = CLAUDE.prepare(inp(), self.env).environment(
            {"PATH": "/x", "ANTHROPIC_API_KEY": "k", "CLAUDE_CODE_OAUTH_TOKEN": "t", "OPENAI_API_KEY": "o",
             "AWS_SECRET_ACCESS_KEY": "s", "CLAUDECODE": "1", "CLAUDE_CODE_SESSION_ID": "parent"})
        self.assertEqual((env.get("ANTHROPIC_API_KEY"), env.get("CLAUDE_CODE_OAUTH_TOKEN")), ("k", "t"))
        for k in ("OPENAI_API_KEY", "AWS_SECRET_ACCESS_KEY", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID"):
            self.assertNotIn(k, env)

    def test_probe(self):
        p = CLAUDE.probe(self.env)
        self.assertTrue(p["available"], p)
        self.assertEqual(p["version"], "2.1.307")
        ctl = os.path.join(self.bin, "fake-claude.json")
        with open(ctl, "w") as f:
            json.dump({"loggedOut": True}, f)
        self.assertEqual(CLAUDE.probe(self.env)["code"], "AUTH_REQUIRED")
        with open(ctl, "w") as f:
            json.dump({"dropFlags": ["--restricted", "--permission-prompts"], "version": "1.0.0"}, f)
        os.utime(os.path.join(self.bin, "claude"), ns=(5, 5))
        p = CLAUDE.probe(self.env)
        self.assertEqual(p["code"], "CAPABILITY_GAP")
        self.assertIn("--restricted", p["reason"])
        self.assertEqual(CLAUDE.probe({"PATH": "/nonexistent"})["code"], "PROVIDER_NOT_FOUND")


class CapturedOutput(unittest.TestCase):
    """Every fixture here is real Claude Code 2.1.307 output (see fixtures/claude/README.md)."""

    def test_success(self):
        r, st, shown = replay("success.jsonl")
        self.assertEqual((r["status"], r["summary"]), ("succeeded", "AGENT_STUDIO_OK"))
        self.assertTrue(r["providerSessionId"])
        self.assertEqual(r["usage"]["output_tokens"], 5)
        self.assertEqual(st.malformed, 0)
        self.assertTrue(any("mode dontAsk" in m for _, m in shown))

    def test_workspace_write(self):
        r, _, shown = replay("workspace_write_creates_file.jsonl")
        self.assertEqual((r["status"], r["summary"]), ("succeeded", "DONE"))
        self.assertTrue(any(m.startswith("tool Write") for _, m in shown))

    def test_permission_denied_never_succeeds(self):
        r, _, _ = replay("permission_denied.jsonl")
        self.assertEqual((r["status"], r["diagnosticCode"]), ("waiting_input", "PERMISSION_DENIED"))
        self.assertEqual(len(r["attention"]["items"]), 1)
        self.assertTrue(r["attention"]["items"][0].startswith("Write:"))

    def test_unavailable_tool_is_not_a_denial(self):
        r, _, shown = replay("read_only_write_unavailable.jsonl")
        self.assertEqual(r["status"], "succeeded")
        self.assertTrue(any(k == "attention" and "No such tool" in m for k, m in shown))

    def test_api_error(self):
        st = ParseState()
        with open(os.path.join(FIX, "api_error.jsonl"), "rb") as f:
            for line in f:
                CLAUDE.parse_line(line.rstrip(b"\n"), st)
        r = CLAUDE.finalize(inp(), st, oc(exitCode=1))
        self.assertEqual((r["status"], r["diagnosticCode"]), ("failed", "PROVIDER_ERROR"))
        self.assertIn("400", r["summary"])

    def test_missing_result(self):
        r, _, _ = replay("missing_result.jsonl")
        self.assertEqual((r["status"], r["diagnosticCode"]), ("inconclusive", "NO_TERMINAL_EVENT"))

    def test_reviewer_verdict(self):
        r, _, _ = replay("reviewer_verdict.jsonl", verdict=True)
        self.assertEqual(r["verdict"], {"verdict": "pass", "findings": []})

    def test_nonzero_exit_after_success_is_contradictory(self):
        st = ParseState()
        with open(os.path.join(FIX, "success.jsonl"), "rb") as f:
            for line in f:
                CLAUDE.parse_line(line.rstrip(b"\n"), st)
        self.assertEqual(CLAUDE.finalize(inp(), st, oc(exitCode=1))["diagnosticCode"], "CONTRADICTORY_EVIDENCE")

    def test_auth_failure_and_corrupt_lines(self):
        st = ParseState()
        for obj in ({"type": "system", "subtype": "init", "session_id": "s"},
                    {"type": "result", "subtype": "success", "is_error": True,
                     "result": "Not logged in · Please run /login", "permission_denials": []}):
            CLAUDE.parse_line(json.dumps(obj).encode(), st)
        CLAUDE.parse_line(b'{"type":"assistant","mess', st)
        CLAUDE.parse_line(b"\xff\xfe", st)
        r = CLAUDE.finalize(inp(), st, oc(exitCode=1))
        self.assertEqual((r["status"], r["diagnosticCode"]), ("failed", "AUTH_REQUIRED"))
        self.assertEqual(st.malformed, 2)

    def test_stream_denial_without_result_still_blocks_success(self):
        st = ParseState()
        for obj in ({"type": "system", "subtype": "init", "session_id": "s"},
                    {"type": "system", "subtype": "permission_denied", "tool_name": "Write",
                     "decision_reason": "--restricted: path outside the working directory"}):
            CLAUDE.parse_line(json.dumps(obj).encode(), st)
        r = CLAUDE.finalize(inp(), st, oc(exitCode=0))
        self.assertEqual((r["status"], r["diagnosticCode"]), ("waiting_input", "PERMISSION_DENIED"))


REAL = shutil.which("claude", path="/tmp/claudecli/node_modules/.bin")
API = os.path.join(FIX, "fake_anthropic_api.py")


@unittest.skipUnless(REAL, "real Claude Code CLI not installed here")
class RealClaudeAgainstLocalApi(unittest.TestCase):
    """The real CLI with the adapter's exact argv and environment, against a local scripted Messages API."""

    @classmethod
    def setUpClass(cls):
        cls.port = 18000 + os.getpid() % 1000
        cls.log = tempfile.mktemp()
        cls.srv = subprocess.Popen([sys.executable, API, str(cls.port), cls.log], stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL)
        time.sleep(1)
        cls.home = tempfile.mkdtemp()

    @classmethod
    def tearDownClass(cls):
        cls.srv.terminate()
        cls.srv.wait()

    def run_policy(self, policy, prompt, model=None, reasoning=None):
        ws = tempfile.mkdtemp()
        pf = os.path.join(tempfile.mkdtemp(), "prompt.txt")
        with open(pf, "w") as f:
            f.write(prompt)
        env = {"PATH": os.path.dirname(REAL) + ":" + os.path.dirname(shutil.which("node") or "/usr/bin") + ":/usr/bin:/bin",
               "HOME": self.home, "ANTHROPIC_BASE_URL": f"http://127.0.0.1:{self.port}",
               "ANTHROPIC_API_KEY": "sk-ant-local-test", "CLAUDECODE": "1", "CLAUDE_CODE_SESSION_ID": "parent"}
        prep = CLAUDE.prepare(inp(policy=policy, ws=ws, prompt=pf, model=model, reasoning=reasoning), env)
        with open(pf, "rb") as stdin:
            p = subprocess.run(prep.argv, stdin=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=prep.cwd,
                               env=prep.environment(env), timeout=120)
        st = ParseState()
        for line in p.stdout.splitlines():
            CLAUDE.parse_line(line, st)
        return CLAUDE.finalize(inp(policy=policy, ws=ws), st, oc(exitCode=p.returncode)), ws

    def test_flags_exist_in_installed_help(self):
        info = CLAUDE.inspect({"PATH": os.path.dirname(REAL) + ":" + os.environ["PATH"]})
        self.assertEqual(info["missingFlags"], [], info)

    def test_read_only(self):
        r, ws = self.run_policy("read_only", "Create a file named x.txt in the current directory whose entire content "
                                             "is the single line X. Then reply DONE.", model="sonnet", reasoning="high")
        self.assertEqual(os.listdir(ws), [])
        self.assertEqual(r["status"], "succeeded")
        with open(self.log) as f:
            reqs = [json.loads(l) for l in f if '"tools"' in l]
        self.assertNotIn("Write", reqs[-2]["tools"] if len(reqs) > 1 else reqs[-1]["tools"])

    def test_workspace_write(self):
        r, ws = self.run_policy("workspace_write", "Create a file named y.txt in the current directory whose entire "
                                                   "content is the single line Y. Then reply DONE.")
        self.assertEqual((r["status"], os.listdir(ws)), ("succeeded", ["y.txt"]))


if __name__ == "__main__":
    unittest.main()
