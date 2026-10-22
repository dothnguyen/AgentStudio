"""P01-S11: adapter session contract, fake CLI sessions, resume prompt, usage normalization, report validation."""
import copy
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

from tests import helpers
from agent_studio import contract, providers, runner
from agent_studio.protocol import AsError
from agent_studio.providers import base
from agent_studio.providers.base import (PROVIDER_SESSION_MISSING, SESSION_UNSUPPORTED, Adapter, AssignmentInput,
                                         ParseState)
from agent_studio.providers.fake import adapter as fake_mod

FIX = os.path.join(helpers.REPO, "tests", "fixtures")
FAKE = providers.get("fake", allow_test_only=True)
CLAUDE = providers.get("claude")
CODEX = providers.get("codex")


def inp(policy="read_only", provider="fake", session=None, persist=False, options=None, prompt="/tmp/p.txt"):
    return AssignmentInput(assignment_id="a" * 8, agent_id="b" * 8, provider_id=provider, attempt=1, workspace="/tmp",
                           prompt_path=prompt, role_instructions="dev", policy=policy, deadline_s=60,
                           output_budget_bytes=1 << 20, provider_session_id=session, persist_session=persist,
                           options=options or {})


def oc(**kw):
    d = {"exitCode": 0, "signal": None, "timedOut": False, "cancelRequested": False, "truncated": False,
         "outputPath": None, "stderrPath": None}
    d.update(kw)
    return d


def replay(adapter, path, **kw):
    st = ParseState()
    with open(path, "rb") as f:
        for line in f:
            if line.strip():
                adapter.parse_line(line.rstrip(b"\n"), st)
    return adapter.finalize(inp(provider=adapter.provider_id), st, oc(**kw)), st


class SessionSupport(unittest.TestCase):
    def test_adapter_without_resume_refuses_it_in_prepare(self):
        class Stub(Adapter):
            provider_id = "stub"

            def policy_mapping(self):
                return {"read_only": ["--ro"], "workspace_write": None}

            def _prepare(self, inp, env):
                raise AssertionError("_prepare must not run")

        with self.assertRaises(AsError) as cm:
            Stub().prepare(inp(provider="stub", session="x"), {})
        self.assertEqual(cm.exception.code, SESSION_UNSUPPORTED)

    def test_capabilities_agree_with_session_support_for_every_adapter(self):
        for pid in providers.available_ids():
            with self.subTest(pid):
                a = providers.get(pid, allow_test_only=True)
                self.assertEqual(a.capabilities()["resume"], True if a.session_support()["resume"] else "unsupported")

    def test_only_fake_resumes_for_now(self):
        for pid in ("claude", "codex", "agy", "opencode"):
            a = providers.get(pid)
            self.assertEqual(a.session_support(), {"resume": False, "forkOnResume": False})
            self.assertEqual(a.capabilities()["resume"], "unsupported")
        self.assertEqual(FAKE.session_support(), {"resume": True, "forkOnResume": True})
        self.assertIs(FAKE.capabilities()["resume"], True)


class FakeSessions(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="as-fake-")
        self.sdir = os.path.join(self.tmp, "sessions")
        self.env = {"AGENT_STUDIO_FAKE_SESSION_DIR": self.sdir}

    def run_fake(self, prompt=b"hello", session=None, persist=False, policy="workspace_write", options=None):
        pf = os.path.join(self.tmp, "prompt.txt")
        with open(pf, "wb") as f:
            f.write(prompt)
        o = dict({"durationMs": 0, "progressLines": 0}, **(options or {}))
        prep = FAKE.prepare(inp(policy=policy, session=session, persist=persist, options=o, prompt=pf), self.env)
        p = subprocess.run(prep.argv, stdin=open(pf, "rb"), capture_output=True, cwd=self.tmp,
                           env=prep.environment(), timeout=30)
        events = [json.loads(l) for l in p.stdout.decode().splitlines() if l.strip()]
        return prep, events, p.returncode

    def read_session(self, sid):
        with open(os.path.join(self.sdir, sid + ".json"), "rb") as f:
            return f.read()

    def test_persisted_fresh_then_resume_forks_and_leaves_parent_untouched(self):
        _, ev, _ = self.run_fake(b"first", persist=True)
        first = ev[0]["session"]
        self.assertEqual((ev[0]["resumedFrom"], ev[0]["priorTurns"]), (None, 0))
        parent_bytes = self.read_session(first)
        mode = stat.S_IMODE(os.stat(os.path.join(self.sdir, first + ".json")).st_mode)
        self.assertEqual(mode, 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(self.sdir).st_mode), 0o700)
        for _ in range(2):
            _, ev2, rc = self.run_fake(b"second!", session=first)
            self.assertEqual(rc, 0)
            self.assertEqual((ev2[0]["resumedFrom"], ev2[0]["priorTurns"]), (first, 1))
            self.assertNotEqual(ev2[0]["session"], first)
            self.assertEqual(ev2[-1]["usage"], {"inputTokens": 7, "cachedInputTokens": 5, "outputTokens": 42})
            self.assertEqual(self.read_session(first), parent_bytes)
        child = json.loads(self.read_session(ev2[0]["session"]))
        self.assertEqual(len(child["turns"]), 2)
        self.assertEqual(child["parent"], first)

    def test_fresh_run_without_persist_writes_nothing_and_cannot_be_resumed(self):
        _, ev, _ = self.run_fake(persist=False)
        self.assertFalse(os.path.exists(self.sdir) and os.listdir(self.sdir))
        _, ev2, rc = self.run_fake(session=ev[0]["session"])
        self.assertEqual(rc, 1)
        self.assertEqual([e["type"] for e in ev2], ["result"])
        st = ParseState()
        for e in ev2:
            FAKE.parse_line(json.dumps(e).encode(), st)
        rep = FAKE.finalize(inp(), st, oc(exitCode=1))
        self.assertEqual((rep["status"], rep["diagnosticCode"]), ("failed", PROVIDER_SESSION_MISSING))

    def test_bad_resume_id_is_refused_in_prepare(self):
        for bad in ("fake-xyz", "../etc/passwd", "fake-0123456789abc", "fake-0123456789AB", "--x"):
            with self.subTest(bad), self.assertRaises(AsError) as cm:
                FAKE.prepare(inp(session=bad), self.env)
            self.assertEqual(cm.exception.code, "BAD_REQUEST")

    def test_session_dir_env_is_not_passed_to_the_cli(self):
        prep = FAKE.prepare(inp(), self.env)
        self.assertNotIn("AGENT_STUDIO_FAKE_SESSION_DIR", prep.environment(dict(self.env, PATH="/bin")))
        self.assertEqual(prep.argv[prep.argv.index("--session-dir") + 1], self.sdir)

    def test_resume_with_a_narrower_policy_keeps_the_new_sandbox_and_denies_writes(self):
        _, ev, _ = self.run_fake(persist=True, policy="workspace_write")
        prep, ev2, _ = self.run_fake(session=ev[0]["session"], policy="read_only", options={"writeFile": "out.txt"})
        self.assertEqual(prep.argv[prep.argv.index("--sandbox") + 1], "read-only")
        self.assertEqual(ev2[0]["sandbox"], "read-only")
        self.assertIn("tool_denied", [e["type"] for e in ev2])
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "out.txt")))
        st = ParseState()
        for e in ev2:
            FAKE.parse_line(json.dumps(e).encode(), st)
        rep = FAKE.finalize(inp(policy="read_only"), st, oc())
        self.assertEqual((rep["status"], rep["diagnosticCode"]), ("waiting_input", "PERMISSION_DENIED"))

    def test_force_session_missing_and_tool_uses(self):
        _, ev, _ = self.run_fake(persist=True)
        _, ev2, rc = self.run_fake(session=ev[0]["session"], options={"forceSessionMissing": True})
        self.assertEqual((rc, ev2[0].get("code")), (1, "session_not_found"))
        _, ev3, _ = self.run_fake(options={"toolUses": {"Read": 3, "Edit": 1}})
        st = ParseState()
        for e in ev3:
            FAKE.parse_line(json.dumps(e).encode(), st)
        rep = FAKE.finalize(inp(), st, oc())
        self.assertEqual(rep["toolUses"], {"Read": 3, "Edit": 1})
        with self.assertRaises(AsError):
            FAKE.prepare(inp(options={"toolUses": {"a b": 1}}), self.env)

    def test_fake_failure_has_no_usage(self):
        _, ev, rc = self.run_fake(options={"scenario": "provider_failure"})
        st = ParseState()
        for e in ev:
            FAKE.parse_line(json.dumps(e).encode(), st)
        rep = FAKE.finalize(inp(), st, oc(exitCode=rc))
        self.assertIsNone(rep["usageNormalized"])
        self.assertIsNone(rep["toolUses"])

    def test_fake_fresh_run_reports_normalized_usage(self):
        _, ev, rc = self.run_fake(b"hello", persist=False)
        self.assertEqual(rc, 0)
        st = ParseState()
        for e in ev:
            FAKE.parse_line(json.dumps(e).encode(), st)
        rep = FAKE.finalize(inp(), st, oc())
        self.assertEqual(rep["usageNormalized"], {"inputTokens": 5, "cachedInputTokens": 0, "outputTokens": 42})

    def test_state_dir_default_for_session_dir(self):
        with mock.patch.object(fake_mod.paths, "ensure_state_dir", return_value="/x/state"):
            prep = FAKE.prepare(inp(), {})
        self.assertEqual(prep.argv[prep.argv.index("--session-dir") + 1], "/x/state/fake-sessions")


class Usage(unittest.TestCase):
    def test_claude_success_and_cached_fixture(self):
        rep, _ = replay(CLAUDE, os.path.join(FIX, "claude", "success.jsonl"))
        self.assertEqual(rep["usageNormalized"], {"inputTokens": 50, "cachedInputTokens": 0, "outputTokens": 5})
        rep, _ = replay(CLAUDE, os.path.join(FIX, "claude", "usage_cached.jsonl"))
        self.assertEqual(rep["usageNormalized"], {"inputTokens": 350, "cachedInputTokens": 4000, "outputTokens": 5})

    def test_claude_without_result_has_no_usage_not_zeros(self):
        rep, _ = replay(CLAUDE, os.path.join(FIX, "claude", "missing_result.jsonl"))
        self.assertIsNone(rep["usageNormalized"])

    def test_codex_subtracts_cached_input(self):
        for usage, want in (({"input_tokens": 1200, "cached_input_tokens": 0, "output_tokens": 12},
                             {"inputTokens": 1200, "cachedInputTokens": 0, "outputTokens": 12}),
                            ({"input_tokens": 1200, "cached_input_tokens": 1000, "output_tokens": 12},
                             {"inputTokens": 200, "cachedInputTokens": 1000, "outputTokens": 12}),
                            ({"input_tokens": 10, "cached_input_tokens": 50, "output_tokens": 1},
                             {"inputTokens": 0, "cachedInputTokens": 50, "outputTokens": 1})):
            st = ParseState()
            CODEX.parse_line(json.dumps({"type": "turn.completed", "usage": usage}).encode(), st)
            self.assertEqual(CODEX.finalize(inp(provider="codex"), st, oc())["usageNormalized"], want)
        self.assertIsNone(CODEX.normalize_usage(None))
        self.assertIsNone(CODEX.normalize_usage({}))

    def test_codex_fixture_binary_turn_completed_is_normalized(self):
        with tempfile.TemporaryDirectory() as cwd, tempfile.TemporaryDirectory() as bindir:
            exe = os.path.join(bindir, "codex")
            shutil.copy(os.path.join(FIX, "codex", "bin", "codex"), exe)
            done = subprocess.run([sys.executable, exe, "exec", "--json", "-"], input="hi", cwd=cwd,
                                  capture_output=True, text=True, timeout=30, check=True)
        lines = [ln for ln in done.stdout.splitlines() if ln.strip()]
        completed = [json.loads(ln) for ln in lines if json.loads(ln)["type"] == "turn.completed"]
        self.assertEqual(len(completed), 1)
        cached = json.loads(json.dumps(completed[0]))
        cached["usage"]["cached_input_tokens"] = 1000
        for events, want in (([completed[0]], {"inputTokens": 1200, "cachedInputTokens": 0, "outputTokens": 12}),
                             ([cached], {"inputTokens": 200, "cachedInputTokens": 1000, "outputTokens": 12})):
            st = ParseState()
            for e in events:
                CODEX.parse_line(json.dumps(e).encode(), st)
            self.assertEqual(CODEX.finalize(inp(provider="codex"), st, oc())["usageNormalized"], want)

    def test_base_adapter_returns_no_usage(self):
        self.assertIsNone(Adapter().normalize_usage({"input_tokens": 1}))

    def test_refusal_report_has_null_usage_fields(self):
        rep = runner.refusal_report(inp(), "X", "y", oc())
        self.assertIsNone(rep["usageNormalized"])
        self.assertIsNone(rep["toolUses"])


class ReportValidation(unittest.TestCase):
    def report(self, **extra):
        r = {"protocol": base.REPORT_PROTOCOL, "assignmentId": "a", "agentId": "b", "providerId": "fake",
             "attempt": 1, "policy": "read_only", "status": "failed", "summary": "s", "artifacts": [],
             "evidence": {"providerTerminalEvent": False, "timedOut": False, "cancelRequested": False,
                          "truncated": False, "validation": []}}
        r.update(extra)
        return r

    def test_good_fields_are_accepted(self):
        for extra in ({}, {"usageNormalized": None, "toolUses": None},
                      {"usageNormalized": {"inputTokens": 1, "cachedInputTokens": 0, "outputTokens": 2},
                       "toolUses": {"Read": 2}, "session": {"mode": "resume", "resumeFrom": "x"}}):
            contract.validate_report(self.report(**extra), {})

    def test_bad_fields_are_rejected(self):
        good = {"inputTokens": 1, "cachedInputTokens": 0, "outputTokens": 2}
        bad = [{"usageNormalized": dict(good, inputTokens=-1)}, {"usageNormalized": dict(good, inputTokens=True)},
               {"usageNormalized": {"inputTokens": 1}}, {"usageNormalized": dict(good, extra=1)},
               {"usageNormalized": []}, {"toolUses": {"Read": -1}}, {"toolUses": {"x" * 101: 1}},
               {"toolUses": {str(i): 1 for i in range(101)}}, {"toolUses": [1]}, {"toolUses": {"a": 1.5}},
               {"session": {"mode": "bogus"}}, {"session": "resume"}, {"session": {}}]
        for extra in bad:
            with self.subTest(extra), self.assertRaises(AsError) as cm:
                contract.validate_report(self.report(**extra), {})
            self.assertEqual(cm.exception.code, "BAD_REPORT")


class ResumePrompt(unittest.TestCase):
    SESSION = {"mode": "resume", "key": "story:P01-S11", "resumeFrom": "fake-0123456789ab"}

    def test_template_with_description(self):
        text = "===== AGENT STUDIO ROLE: Developer =====\nDescription: Implements one story at a time.\nmore\n"
        got = runner.resume_prompt(self.SESSION, "Developer", "workspace_write", text, b"STAGE\n")
        self.assertEqual(got.decode(), (
            "===== AGENT STUDIO SESSION =====\n"
            "You are continuing your earlier session for story:P01-S11.\n"
            "Files may have changed since you last read them; re-read anything you rely on.\n"
            "Your permission for this task is workspace_write.\n"
            "===== END SESSION =====\n"
            "You are Developer: Implements one story at a time.\n\nSTAGE\n"))
        self.assertNotIn(b"===== AGENT STUDIO ROLE", got)
        self.assertNotIn(b"===== SKILL", got)

    def test_without_description_and_empty_role_and_long_description(self):
        self.assertIn(b"\nYou are Developer.\n\n", runner.resume_prompt(self.SESSION, "Developer", "read_only", "", b"X"))
        self.assertIn(b"\nYou are the assigned agent.\n\n", runner.resume_prompt(self.SESSION, "", "read_only", "", b"X"))
        long = runner.resume_prompt(self.SESSION, "R", "read_only", "Description: " + "d" * 300 + ".", b"X")
        self.assertIn(b"You are R: " + b"d" * 200 + b".\n", long)

    def test_session_block_normalization(self):
        self.assertEqual(runner.session_block({})["mode"], "none")
        self.assertFalse(runner.session_block({})["present"])
        s = runner.session_block({"session": dict(self.SESSION, persist=True)})
        self.assertEqual((s["mode"], s["resumeFrom"], s["persist"]), ("resume", "fake-0123456789ab", True))
        s = runner.session_block({"session": {"mode": "unsupported", "key": "k", "persist": True, "resumeFrom": "x"}})
        self.assertEqual((s["resumeFrom"], s["persist"]), (None, False))


class FallbackStep(unittest.TestCase):
    def setUp(self):
        self.rd = tempfile.mkdtemp(prefix="as-rd-")
        for n in runner.RESUME_ATTEMPT_FILES:
            with open(os.path.join(self.rd, n), "w") as f:
                f.write(n)
        self.session = {"mode": "resume", "key": "k", "resumeFrom": "fake-0123456789ab", "persist": True}
        self.first = {"status": "failed", "diagnosticCode": PROVIDER_SESSION_MISSING, "evidence": {}}

    def call(self, first=None, started=None):
        i = inp(session="fake-0123456789ab", prompt=os.path.join(self.rd, "prompt.txt"))
        with mock.patch.object(runner, "_prepare_and_execute", return_value={"status": "succeeded"}) as m:
            out = runner._resume_fallback(first or self.first, FAKE, i, b"FULL", self.session, self.rd,
                                          time.monotonic() if started is None else started, lambda *a: None, {})
        return out, m

    def test_marker_between_runs_keeps_first_report_and_files(self):
        open(os.path.join(self.rd, runner.CANCEL_MARKER), "w").close()
        out, m = self.call()
        self.assertIs(out, self.first)
        m.assert_not_called()
        self.assertFalse(os.path.exists(os.path.join(self.rd, runner.RESUME_ATTEMPT_DIR)))
        self.assertTrue(os.path.exists(os.path.join(self.rd, "stdout.jsonl")))

    def test_no_time_left_keeps_first_report(self):
        out, m = self.call(started=time.monotonic() - 100)
        self.assertIs(out, self.first)
        m.assert_not_called()

    def test_rerun_moves_files_and_marks_session(self):
        out, m = self.call()
        self.assertEqual(out["session"], {"mode": "fresh", "resumeFrom": None,
                                          "fallbackFrom": "fake-0123456789ab", "warning": PROVIDER_SESSION_MISSING})
        inp2 = m.call_args[0][1]
        self.assertTrue(inp2.persist_session)
        self.assertIsNone(inp2.provider_session_id)
        self.assertLess(inp2.deadline_s, 60)
        for n in runner.RESUME_ATTEMPT_FILES:
            self.assertTrue(os.path.exists(os.path.join(self.rd, runner.RESUME_ATTEMPT_DIR, n)))
        with open(os.path.join(self.rd, "prompt.txt"), "rb") as f:
            self.assertEqual(f.read(), b"FULL")

    def test_other_failures_and_modes_are_untouched(self):
        for first, mode in (({"status": "failed", "diagnosticCode": "TIMEOUT", "evidence": {}}, "resume"),
                            (self.first, "fresh"),
                            (dict(self.first, status="cancelled"), "resume"),
                            (dict(self.first, evidence={"cancelRequested": True}), "resume")):
            self.session = dict(self.session, mode=mode)
            out, m = self.call(first)
            self.assertIs(out, first)
            m.assert_not_called()


if __name__ == "__main__":
    unittest.main()
