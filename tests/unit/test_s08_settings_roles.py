"""P00-S08: per-agent model/reasoning, workspace roles/skills, and the Codex adapter's mapping and parsing."""
import json
import os
import shutil
import subprocess
import tempfile
import types
import unittest

import tests.helpers  # noqa: F401  (puts backend on sys.path)
from agent_studio import providers, roles
from agent_studio.protocol import AsError
from agent_studio.providers.base import AssignmentInput, ParseState, extract_verdict
from agent_studio.providers.codex import adapter as codex_mod

FIX = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "fixtures", "codex")
CODEX = providers.get("codex")


def inp(policy="read_only", model=None, reasoning=None, verdict=False, ws="/tmp"):
    return AssignmentInput(assignment_id="a" * 8, agent_id="b" * 8, provider_id="codex", attempt=1, workspace=ws,
                           prompt_path="/tmp/p.txt", role_instructions="dev", policy=policy, deadline_s=60,
                           output_budget_bytes=1 << 20, model=model, reasoning=reasoning, expects_verdict=verdict)


def oc(**kw):
    d = {"exitCode": 0, "signal": None, "timedOut": False, "cancelRequested": False, "truncated": False,
         "outputPath": None, "stderrPath": None}
    d.update(kw)
    return d


def feed(lines):
    st = ParseState()
    shown = []
    for line in lines:
        shown += CODEX.parse_line(line if isinstance(line, bytes) else json.dumps(line).encode(), st)
    return st, shown


class Settings(unittest.TestCase):
    def test_codex_declares_model_and_verified_reasoning_levels(self):
        self.assertTrue(CODEX.model_selectable())
        self.assertEqual(CODEX.reasoning_levels(), ("minimal", "low", "medium", "high", "xhigh"))
        CODEX.validate_settings("gpt-5.1-codex", "high")
        CODEX.validate_settings(None, None)

    def test_unverified_or_hostile_settings_are_refused(self):
        for model, reasoning in ((None, "max"), (None, "HIGH"), ("gpt 5", None), ("-c x=1", None),
                                 ("$(id)", None), ("a" * 200, None), (None, "")):
            with self.assertRaises(AsError, msg=(model, reasoning)) as cm:
                CODEX.validate_settings(model, reasoning)
            self.assertEqual(cm.exception.code, "SETTING_UNSUPPORTED")

    def test_placeholders_refuse_any_setting(self):
        a = providers.get("agy")
        a.validate_settings(None, None)
        with self.assertRaises(AsError):
            a.validate_settings("invalid model", None)
        # opencode selects models but refuses reasoning until a variant scheme is verified
        providers.get("opencode").validate_settings("opencode-go/glm-5.3", None)
        with self.assertRaises(AsError):
            providers.get("opencode").validate_settings("opencode-go/glm-5.3", "high")
            with self.assertRaises(AsError):
                a.validate_settings(None, "high")

    def test_describe_reports_settings(self):
        d = CODEX.describe({"PATH": ""})
        self.assertTrue(d["modelSelectable"])
        self.assertIn("xhigh", d["reasoningLevels"])


class CodexArgv(unittest.TestCase):
    def setUp(self):
        self.bin = tempfile.mkdtemp()
        shutil.copy(os.path.join(FIX, "bin", "codex"), os.path.join(self.bin, "codex"))
        self.env = {"PATH": self.bin + ":/usr/bin:/bin"}

    def tearDown(self):
        shutil.rmtree(self.bin)

    def test_read_only_mapping(self):
        p = CODEX.prepare(inp("read_only"), self.env)
        a = p.argv
        self.assertEqual(a[0], os.path.join(self.bin, "codex"))
        self.assertEqual(a[1:3], ["exec", "--json"])
        self.assertEqual(a[a.index("--sandbox") + 1], "workspace-write")   # temp writes; the runner guards the workspace
        self.assertIn("sandbox_workspace_write.network_access=false", a)
        self.assertIn('approval_policy="never"', a)
        self.assertEqual(a[-1], "-")
        self.assertEqual(p.stdin_path, "/tmp/p.txt")
        self.assertNotIn("--model", a)
        self.assertFalse(any("model_reasoning_effort" in x for x in a))

    def test_workspace_write_mapping_keeps_network_off(self):
        a = CODEX.prepare(inp("workspace_write"), self.env).argv
        self.assertEqual(a[a.index("--sandbox") + 1], "workspace-write")
        self.assertIn("sandbox_workspace_write.network_access=false", a)

    def test_model_and_reasoning_reach_argv_as_single_arguments(self):
        a = CODEX.prepare(inp(model="gpt-5.1-codex", reasoning="xhigh"), self.env).argv
        self.assertEqual(a[a.index("--model") + 1], "gpt-5.1-codex")
        self.assertIn('model_reasoning_effort="xhigh"', a)

    def test_never_bypasses_the_sandbox(self):
        for policy in ("read_only", "workspace_write"):
            a = CODEX.prepare(inp(policy), self.env).argv
            for bad in codex_mod.NEVER:
                self.assertNotIn(bad, a)

    def test_env_allowlist_drops_unrelated_secrets(self):
        p = CODEX.prepare(inp(), self.env)
        env = p.environment({"PATH": "/x", "OPENAI_API_KEY": "k", "AWS_SECRET_ACCESS_KEY": "s", "GITHUB_TOKEN": "t"})
        self.assertEqual(env.get("OPENAI_API_KEY"), "k")
        self.assertNotIn("AWS_SECRET_ACCESS_KEY", env)
        self.assertNotIn("GITHUB_TOKEN", env)

    def test_bad_setting_refused_at_prepare(self):
        with self.assertRaises(AsError):
            CODEX.prepare(inp(reasoning="ultra"), self.env)

    def test_probe_with_stand_in(self):
        p = CODEX.probe(self.env)
        self.assertTrue(p["available"], p)
        self.assertEqual(p["version"], "0.163.0")
        self.assertFalse(p["authVerified"])

    def test_probe_reports_missing_login_and_flag_gaps(self):
        ctl = os.path.join(self.bin, "fake-codex.json")
        with open(ctl, "w") as f:
            json.dump({"loggedOut": True, "version": "0.163.1"}, f)
        self.assertEqual(CODEX.probe(self.env)["code"], "AUTH_REQUIRED")
        with open(ctl, "w") as f:
            json.dump({"oldHelp": True, "version": "0.100.0"}, f)
        os.utime(os.path.join(self.bin, "codex"), ns=(1, 1))  # new inspect-cache key
        p = CODEX.probe(self.env)
        self.assertEqual(p["code"], "CAPABILITY_GAP")
        self.assertIn("--ephemeral", p["reason"])

    def test_broken_binary_is_reported_not_misread_as_flag_gap(self):
        with open(os.path.join(self.bin, "codex"), "w") as f:
            f.write("#!/bin/sh\necho 'env: node: No such file or directory' >&2\nexit 127\n")
        p = CODEX.probe(self.env)
        self.assertFalse(p["available"])
        self.assertIn("node", p["reason"])
        self.assertNotEqual(p.get("code"), "CAPABILITY_GAP")

    def test_probe_without_binary(self):
        self.assertEqual(CODEX.probe({"PATH": "/nonexistent"})["code"], "PROVIDER_NOT_FOUND")
        with self.assertRaises(AsError):
            CODEX.prepare(inp(), {"PATH": "/nonexistent"})


class CodexParsing(unittest.TestCase):
    SUCCESS = [
        {"type": "thread.started", "thread_id": "0199a213-81c0-7800-8aa1-bbab2a035a53"},
        {"type": "turn.started"},
        {"type": "item.completed", "item": {"id": "i0", "type": "reasoning", "text": "**Looking**"}},
        {"type": "item.started", "item": {"id": "i1", "type": "command_execution", "command": "bash -lc ls",
                                          "status": "in_progress"}},
        {"type": "item.completed", "item": {"id": "i1", "type": "command_execution", "command": "bash -lc ls",
                                            "exit_code": 0, "status": "completed"}},
        {"type": "item.completed", "item": {"id": "i2", "type": "file_change", "status": "completed",
                                            "changes": [{"path": "a.txt", "kind": "add"}]}},
        {"type": "item.completed", "item": {"id": "i3", "type": "agent_message", "text": "All done."}},
        {"type": "turn.completed", "usage": {"input_tokens": 10, "cached_input_tokens": 0, "output_tokens": 3}},
    ]

    def test_success(self):
        st, shown = feed(self.SUCCESS)
        r = CODEX.finalize(inp(), st, oc())
        self.assertEqual((r["status"], r["summary"]), ("succeeded", "All done."))
        self.assertEqual(r["providerSessionId"], "0199a213-81c0-7800-8aa1-bbab2a035a53")
        self.assertEqual(r["usage"]["output_tokens"], 3)
        self.assertIn(("progress", "$ bash -lc ls"), shown)

    def test_turn_failed(self):
        st, _ = feed(self.SUCCESS[:2] + [{"type": "turn.failed", "error": {"message": "stream disconnected"}}])
        r = CODEX.finalize(inp(), st, oc(exitCode=1))
        self.assertEqual((r["status"], r["diagnosticCode"]), ("failed", "PROVIDER_ERROR"))
        self.assertIn("disconnected", r["summary"])

    def test_turn_failed_usage_limit(self):
        st, _ = feed(self.SUCCESS[:2] + [{"type": "turn.failed", "error": {"message": "quota exceeded"}}])
        r = CODEX.finalize(inp(), st, oc(exitCode=1))
        self.assertEqual((r["status"], r["diagnosticCode"]), ("failed", "USAGE_LIMIT"))
        self.assertIn("quota", r["summary"])

    def test_captured_real_network_failure_is_not_terminal(self):
        with open(os.path.join(FIX, "captured-0.163.0-network-unreachable.jsonl"), "rb") as f:
            lines = [l.rstrip(b"\n") for l in f if l.strip()]
        st, shown = feed(lines)
        self.assertIsNone(st.terminal)
        self.assertEqual(st.malformed, 0)
        self.assertTrue(any(k == "attention" and "Reconnecting" in m for k, m in shown))
        r = CODEX.finalize(inp(), st, oc(exitCode=None, signal=15, timedOut=True))
        self.assertEqual((r["status"], r["diagnosticCode"]), ("failed", "TIMEOUT"))

    def test_exit_zero_without_turn_completed_is_inconclusive(self):
        st, _ = feed(self.SUCCESS[:3])
        self.assertEqual(CODEX.finalize(inp(), st, oc())["diagnosticCode"], "NO_TERMINAL_EVENT")

    def test_turn_completed_but_nonzero_exit_is_contradictory(self):
        st, _ = feed(self.SUCCESS)
        self.assertEqual(CODEX.finalize(inp(), st, oc(exitCode=1))["diagnosticCode"], "CONTRADICTORY_EVIDENCE")

    def test_declined_command_needs_attention(self):
        lines = self.SUCCESS[:2] + [{"type": "item.completed", "item": {
            "id": "x", "type": "command_execution", "command": "rm -rf /", "status": "declined"}}] + self.SUCCESS[-2:]
        st, _ = feed(lines)
        r = CODEX.finalize(inp(), st, oc())
        self.assertEqual((r["status"], r["diagnosticCode"]), ("waiting_input", "PERMISSION_DENIED"))

    def test_malformed_and_plain_lines(self):
        st, shown = feed([b'{"type": "turn.started"', b"plain banner text", b"\xff\xfe{"])
        self.assertEqual(st.malformed, 2)
        self.assertIn(("progress", "plain banner text"), shown)
        self.assertEqual(CODEX.finalize(inp(), st, oc(exitCode=1))["status"], "inconclusive")

    def test_legacy_msg_format(self):
        st, _ = feed([{"id": "0", "msg": {"type": "session_configured", "session_id": "s1"}},
                      {"id": "1", "msg": {"type": "agent_message", "message": "hi"}},
                      {"id": "2", "msg": {"type": "task_complete", "last_agent_message": "hi there"}}])
        r = CODEX.finalize(inp(), st, oc())
        self.assertEqual((r["status"], r["summary"], r["providerSessionId"]), ("succeeded", "hi there", "s1"))

    def test_reviewer_verdict_from_final_message(self):
        lines = self.SUCCESS[:2] + [{"type": "item.completed", "item": {
            "id": "m", "type": "agent_message",
            "text": 'Looks fine.\n{"verdict": "fail", "findings": ["missing test"]}'}},
            self.SUCCESS[-1]]
        st, _ = feed(lines)
        r = CODEX.finalize(inp(verdict=True), st, oc())
        self.assertEqual(r["verdict"], {"verdict": "fail", "findings": ["missing test"]})
        st, _ = feed(lines)
        self.assertIsNone(CODEX.finalize(inp(verdict=False), st, oc())["verdict"])

    def test_extract_verdict_accepts_consistent_label_and_rejects_mismatch(self):
        self.assertEqual(extract_verdict('pass JSON: {"verdict":"pass","findings":[]}'),
                         {"verdict": "pass", "findings": []})
        self.assertEqual(extract_verdict('JSON: {"verdict":"fail","findings":["missing"]}')["verdict"], "fail")
        self.assertIsNone(extract_verdict('pass JSON: {"verdict":"fail","findings":[]}'))
        self.assertIsNone(extract_verdict('example: {"verdict":"pass","findings":[]}'))

    def test_prefixed_verdict_survives_provider_finalization(self):
        st, _ = feed(self.SUCCESS[:2] + [{"type": "item.completed", "item": {
            "id": "m", "type": "agent_message", "text": 'pass JSON: {"verdict":"pass","findings":[]}' }},
            self.SUCCESS[-1]])
        self.assertEqual(CODEX.finalize(inp(verdict=True), st, oc())["verdict"],
                         {"verdict": "pass", "findings": []})
    def test_extract_verdict_takes_last_json_line(self):
        self.assertEqual(extract_verdict('{"verdict":"pass"}\ntext\n{"verdict":"fail","findings":[]}')["verdict"],
                         "fail")
        self.assertIsNone(extract_verdict("no json here"))
        self.assertIsNone(extract_verdict(None))


class Roles(unittest.TestCase):
    def setUp(self):
        self.ws = tempfile.mkdtemp()
        self.base = os.path.join(self.ws, ".agent-studio")
        os.makedirs(os.path.join(self.base, "roles"))

    def tearDown(self):
        shutil.rmtree(self.ws)

    def write(self, rel, text):
        path = os.path.join(self.base, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)

    def test_unconfigured_workspace(self):
        rc = roles.context_for(self.ws, "Developer")
        self.assertFalse(rc["configured"])
        self.assertIn("AGENT STUDIO ROLE: Developer", rc["text"])
        self.assertEqual(rc["sources"], [])

    def test_role_markdown_fallback(self):
        self.write("roles/Reviewer.md", "Be strict.\n")
        rc = roles.context_for(self.ws, "Reviewer")
        self.assertTrue(rc["configured"])
        self.assertIn("Be strict.", rc["text"])
        self.assertEqual(rc["sources"][0]["path"], ".agent-studio/roles/Reviewer.md")

    def test_roles_json_with_skills(self):
        self.write("roles/dev.md", "Write tests first.")
        self.write("skills/python-style/SKILL.md", "Use type hints.")
        self.write("roles.json", json.dumps({"version": 1, "roles": {"Developer": {
            "description": "Implements features", "instructions": "roles/dev.md",
            "skills": ["python-style", "missing-skill"]}}}))
        rc = roles.context_for(self.ws, "Developer")
        t = rc["text"]
        self.assertLess(t.index("Description: Implements features"), t.index("Write tests first."))
        self.assertLess(t.index("===== END ROLE ====="), t.index("===== SKILL: python-style ====="))
        self.assertIn("Use type hints.", t)
        self.assertEqual([s["kind"] for s in rc["sources"]], ["role", "skill"])
        self.assertTrue(any("missing-skill" in w for w in rc["warnings"]))
        self.assertEqual(len(rc["sha256"]), 64)

    def test_paths_cannot_escape_the_config_dir(self):
        outside = os.path.join(self.ws, "secret.txt")
        with open(outside, "w") as f:
            f.write("TOP SECRET")
        os.symlink(outside, os.path.join(self.base, "roles", "link.md"))
        for rel in ("../secret.txt", "/etc/passwd", "roles/link.md"):
            self.write("roles.json", json.dumps({"version": 1, "roles": {"R": {"instructions": rel}}}))
            rc = roles.context_for(self.ws, "R")
            self.assertNotIn("TOP SECRET", rc["text"], rel)
            self.assertNotIn("root:", rc["text"], rel)
            self.assertTrue(rc["warnings"], rel)

    def test_bad_skill_names_and_bad_json_are_rejected(self):
        for cfg in ('{"version": 1, "roles": {"R": {"skills": ["../x"]}}}', '{"version": 2, "roles": {}}', "{oops"):
            self.write("roles.json", cfg)
            with self.assertRaises(AsError) as cm:
                roles.context_for(self.ws, "R")
            self.assertEqual(cm.exception.code, "ROLES_CONFIG_INVALID")

    def test_direct_task_worktree_policy_is_validated_and_defaults_to_main(self):
        self.write("roles.json", json.dumps({"version": 1, "roles": {"R": {
            "directTask": {"workspace": "worktree", "mergeOnSuccess": True, "baseBranch": "main",
                           "onMergeConflict": "merge-conflict"}}}}))
        self.assertEqual(roles.direct_task_config(self.ws, "R"),
                         {"workspace": "worktree", "mergeOnSuccess": True, "baseBranch": "main",
                          "onMergeConflict": "merge-conflict"})
        self.assertEqual(roles.direct_task_config(self.ws, "Missing"),
                         {"workspace": "main", "mergeOnSuccess": False, "baseBranch": "main",
                          "onMergeConflict": None})
        for policy in ({"workspace": "somewhere"},
                       {"workspace": "main", "mergeOnSuccess": True},
                       {"workspace": "worktree", "mergeOnSuccess": "yes"},
                       {"workspace": "worktree", "baseBranch": "../bad"},
                       {"workspace": "worktree", "onMergeConflict": "Bad Status"}):
            self.write("roles.json", json.dumps({"version": 1, "roles": {"R": {"directTask": policy}}}))
            with self.assertRaises(AsError) as cm:
                roles.load_config(self.ws)
            self.assertEqual(cm.exception.code, "ROLES_CONFIG_INVALID")

    def test_limits(self):
        self.write("roles/big.md", "x" * (roles.LIMITS["instructions"] + 500))
        for i in range(4):
            self.write(f"skills/s{i}/SKILL.md", "y" * roles.LIMITS["skill"])
        self.write("roles.json", json.dumps({"version": 1, "roles": {"R": {
            "instructions": "roles/big.md", "skills": [f"s{i}" for i in range(4)]}}}))
        rc = roles.context_for(self.ws, "R")
        self.assertLessEqual(len(rc["text"].encode()), roles.LIMITS["total"])
        self.assertIn("[instructions truncated by Agent Studio]", rc["text"])
        self.assertTrue(any("skipped" in w for w in rc["warnings"]))

    def test_team_json(self):
        with self.assertRaises(AsError):
            roles.load_team(self.ws)
        self.write("team.json", json.dumps({"version": 1, "agents": [{"providerId": "codex", "role": "Developer"}]}))
        self.assertEqual(roles.load_team(self.ws)[0]["role"], "Developer")


REAL = shutil.which("codex", path="/tmp/codexcli/node_modules/.bin:" + os.environ.get("PATH", ""))
if REAL:
    try:
        # WSL may expose a Windows shim whose required Node executable is unavailable.
        available = subprocess.run([REAL, "--version"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, timeout=10).returncode == 0
    except (OSError, subprocess.SubprocessError):
        available = False
    if not available:
        REAL = None


@unittest.skipUnless(REAL, "real codex CLI not installed here")
class RealCodexBinary(unittest.TestCase):
    """The flags and login check against the installed CLI (no network needed)."""

    def test_installed_cli_has_every_flag_we_use(self):
        env = {"PATH": os.path.dirname(REAL) + ":" + os.environ.get("PATH", "/usr/bin:/bin"), "HOME": tempfile.mkdtemp()}
        info = CODEX.inspect(env)
        self.assertEqual(info["missingFlags"], [], info)
        self.assertEqual(sorted(info["sandboxModes"]), ["read-only", "workspace-write"])

    def test_logged_out_is_detected(self):
        home = tempfile.mkdtemp()
        env = {"PATH": os.path.dirname(REAL) + ":" + os.environ.get("PATH", "/usr/bin:/bin"), "HOME": home, "CODEX_HOME": home}
        self.assertFalse(CODEX.login_status(env)["loggedIn"])
        self.assertEqual(CODEX.probe(env)["code"], "AUTH_REQUIRED")


if __name__ == "__main__":
    unittest.main()


class ReadOnlyGuard(unittest.TestCase):
    """Codex read_only stages run in workspace-write; the runner fails them if the workspace changed."""

    def setUp(self):
        import subprocess, tempfile
        from agent_studio import runner
        self.runner = runner
        self.ws = tempfile.mkdtemp()
        g = lambda *a: subprocess.run(["git", "-C", self.ws] + list(a), check=True, stdout=subprocess.DEVNULL)
        g("init", "-q"); g("config", "user.email", "t@e.invalid"); g("config", "user.name", "t")
        with open(os.path.join(self.ws, "a.txt"), "w") as f:
            f.write("one\n")
        with open(os.path.join(self.ws, ".gitignore"), "w") as f:
            f.write("cache/\n")
        g("add", "-A"); g("commit", "-qm", "x")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.ws, ignore_errors=True)

    def check(self, change):
        before = self.runner.workspace_fingerprint(self.ws)
        change()
        i = types.SimpleNamespace(workspace=self.ws)
        return self.runner.guard_violation(None, i, before, {"status": "succeeded", "summary": "ok"})

    def test_unchanged_and_ignored_files_pass(self):
        def noop():
            os.makedirs(os.path.join(self.ws, "cache"))
            with open(os.path.join(self.ws, "cache", "x"), "w") as f:
                f.write("tmp")
        self.assertEqual(self.check(noop)["status"], "succeeded")

    def test_edit_new_file_and_untracked_edit_fail(self):
        def edit():
            with open(os.path.join(self.ws, "a.txt"), "a") as f:
                f.write("two\n")
        r = self.check(edit)
        self.assertEqual((r["status"], r["diagnosticCode"]), ("failed", "READ_ONLY_VIOLATION"))
        def new():
            with open(os.path.join(self.ws, "n.txt"), "w") as f:
                f.write("x")
        self.assertEqual(self.check(new)["diagnosticCode"], "READ_ONLY_VIOLATION")

    def test_non_git_workspace_is_not_guarded(self):
        self.assertIsNone(self.runner.workspace_fingerprint("/nonexistent-dir-xyz"))
