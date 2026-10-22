"""P00-S04 contract: report validation, shared outcome rules, prepare safety, registry, reconcile."""
import copy
import glob
import json
import os
import re
import signal
import subprocess
import tempfile
import time
import unittest
from unittest import mock

from tests import helpers
from agent_studio import contract, procid, providers
from agent_studio.protocol import AsError
from agent_studio.providers.base import (MISSING, AssignmentInput, ParseState, Prepared, NotImplementedAdapter,
                                         POLICY_UNSUPPORTED)

FIX = os.path.join(helpers.REPO, "tests", "fixtures", "contract")
PKG = os.path.join(helpers.BACKEND, "agent_studio")


def example(name):
    with open(os.path.join(FIX, "examples", name), encoding="utf-8") as f:
        return json.load(f)


EXPECT = {"assignmentId": "11111111-1111-4111-8111-111111111111", "agentId": "22222222-2222-4222-8222-222222222222",
          "providerId": "fake", "attempt": 1}


def inp(policy="read_only", **kw):
    return AssignmentInput(assignment_id=EXPECT["assignmentId"], agent_id=EXPECT["agentId"], provider_id="fake",
                           attempt=1, workspace="/tmp", prompt_path="/tmp/p", role_instructions="", policy=policy,
                           deadline_s=10, output_budget_bytes=4096, **kw)


def oc(**kw):
    base = {"exitCode": 0, "signal": None, "timedOut": False, "cancelRequested": False, "truncated": False,
            "outputPath": "/x", "stderrPath": "/y"}
    base.update(kw)
    return base


class ReportValidation(unittest.TestCase):
    def test_examples_are_valid(self):
        for path in glob.glob(os.path.join(FIX, "examples", "*.json")):
            r = example(os.path.basename(path))
            contract.validate_report(r, dict(EXPECT, policy=r["policy"]))

    def test_every_required_field(self):
        good = example("succeeded.json")
        for field in contract.REQUIRED:
            bad = copy.deepcopy(good)
            del bad[field]
            with self.assertRaises(AsError, msg=field) as cm:
                contract.validate_report(bad, {})
            self.assertEqual(cm.exception.code, "BAD_REPORT")
        for field in contract.EVIDENCE_REQUIRED:
            bad = copy.deepcopy(good)
            del bad["evidence"][field]
            with self.assertRaises(AsError, msg=field):
                contract.validate_report(bad, {})

    def test_wrong_types_unknown_values(self):
        good = example("succeeded.json")
        for field, value in (("attempt", "1"), ("attempt", True), ("status", "great"), ("protocol", "x/v9"),
                             ("policy", "yolo"), ("artifacts", {}), ("exitCode", "0"), ("evidence", [])):
            bad = dict(copy.deepcopy(good), **{field: value})
            with self.assertRaises(AsError, msg=(field, value)) as cm:
                contract.validate_report(bad, {})
            self.assertEqual(cm.exception.code, "BAD_REPORT")

    def test_mismatched_ids_are_rejected(self):
        good = example("succeeded.json")
        for field, value in (("assignmentId", "33333333-3333-4333-8333-333333333333"),
                             ("agentId", "33333333-3333-4333-8333-333333333333"), ("providerId", "codex"),
                             ("attempt", 2), ("policy", "read_only")):
            with self.assertRaises(AsError, msg=field) as cm:
                contract.validate_report(dict(copy.deepcopy(good), **{field: value}),
                                         dict(EXPECT, policy="workspace_write"))
            self.assertEqual(cm.exception.code, "REPORT_MISMATCH")

    def test_success_needs_all_evidence(self):
        good = example("succeeded.json")
        breaks = [("exitCode", 1), ("attention", {"kind": "x"}), ("diagnosticCode", "X")]
        for field, value in breaks:
            with self.assertRaises(AsError, msg=field) as cm:
                contract.validate_report(dict(copy.deepcopy(good), **{field: value}), {})
            self.assertEqual(cm.exception.code, "CONTRADICTORY_EVIDENCE")
        for ev_field, value in (("providerTerminalEvent", False), ("terminalOk", False), ("timedOut", True),
                                ("cancelRequested", True), ("signal", 9)):
            bad = copy.deepcopy(good)
            bad["evidence"][ev_field] = value
            with self.assertRaises(AsError, msg=ev_field) as cm:
                contract.validate_report(bad, {})
            self.assertEqual(cm.exception.code, "CONTRADICTORY_EVIDENCE")


class SharedOutcomeRules(unittest.TestCase):
    a = providers.get("fake", allow_test_only=True)

    def outcome(self, st=None, **o):
        r = self.a.finalize(inp(), st or ParseState(), oc(**o))
        contract.validate_report(r, dict(EXPECT, policy="read_only"))
        return r["status"], r["diagnosticCode"]

    def term(self, ok=True, **kw):
        st = ParseState(terminal={"ok": ok, "summary": "s", "code": None if ok else "PROVIDER_ERROR"})
        for k, v in kw.items():
            setattr(st, k, v)
        return st

    def test_table(self):
        self.assertEqual(self.outcome(self.term()), ("succeeded", None))
        self.assertEqual(self.outcome(self.term(), exitCode=1), ("inconclusive", "CONTRADICTORY_EVIDENCE"))
        self.assertEqual(self.outcome(ParseState(), exitCode=0), ("inconclusive", "NO_TERMINAL_EVENT"))
        self.assertEqual(self.outcome(ParseState(), exitCode=2), ("failed", "PROVIDER_EXIT_2"))
        self.assertEqual(self.outcome(ParseState(), exitCode=None, signal=9), ("failed", "PROVIDER_CRASHED"))
        self.assertEqual(self.outcome(self.term(ok=False), exitCode=1), ("failed", "PROVIDER_ERROR"))
        self.assertEqual(self.outcome(self.term(denials=["x"])), ("waiting_input", "PERMISSION_DENIED"))
        self.assertEqual(self.outcome(ParseState(input_requests=["q"])), ("waiting_input", "INPUT_REQUIRED"))
        self.assertEqual(self.outcome(ParseState(malformed=1)), ("inconclusive", "MALFORMED_OUTPUT"))
        self.assertEqual(self.outcome(self.term(verdict={"verdict": "maybe"})), ("inconclusive", "MALFORMED_VERDICT"))

    def test_cancel_timeout_waiting_are_distinct(self):
        got = {self.outcome(self.term(), cancelRequested=True, exitCode=None, signal=15),
               self.outcome(self.term(), timedOut=True, exitCode=None, signal=15),
               self.outcome(ParseState(input_requests=["q"]))}
        self.assertEqual({s for s, _ in got}, {"cancelled", "failed", "waiting_input"})
        self.assertEqual({c for _, c in got}, {"CANCELLED", "TIMEOUT", "INPUT_REQUIRED"})

    def test_zero_exit_without_valid_final_is_never_success(self):
        for st in (ParseState(), ParseState(malformed=2), ParseState(input_requests=["q"]), ParseState(denials=["d"])):
            self.assertNotEqual(self.outcome(st, exitCode=0)[0], "succeeded")


class PrepareSafety(unittest.TestCase):
    def test_prepared_rejects_shell_like_commands(self):
        for argv in ([], ["fake_cli.py"], ["/bin/sh", 3], ["/bin/x", "a\x00b"]):
            with self.assertRaises(AsError):
                Prepared(argv=argv, env_allowlist=(), stdin_path=None, cwd="/")

    def test_fake_argv_never_contains_task_text(self):
        a = providers.get("fake", allow_test_only=True)
        p = a.prepare(inp(options={"scenario": "success"}), {})
        self.assertTrue(os.path.isabs(p.argv[0]))
        self.assertEqual(p.stdin_path, "/tmp/p")
        self.assertIn("--sandbox", p.argv)
        for bad in ({"scenario": "rm -rf"}, {"durationMs": "1"}, {"writeFile": "../escape"}, {"writeFile": "/abs"}):
            with self.assertRaises(AsError, msg=bad):
                a.prepare(inp(options=bad), {})

    def test_environment_allowlist(self):
        p = Prepared(argv=["/bin/true"], env_allowlist=("PATH", "HOME"), stdin_path=None, cwd="/")
        env = p.environment({"PATH": "/bin", "HOME": "/h", "OPENAI_API_KEY": "secret", "AGENT_STUDIO_X": "1"})
        self.assertEqual(env, {"PATH": "/bin", "HOME": "/h"})

    def test_unmapped_policy_is_refused(self):
        a = providers.get("fake", allow_test_only=True)
        with mock.patch.dict(os.environ, {"AGENT_STUDIO_FAKE_POLICIES": "read_only"}):
            self.assertEqual(a.describe({})["policies"]["workspace_write"], "unsupported")
            with self.assertRaises(AsError) as cm:
                a.prepare(inp(policy="workspace_write"), {})
            self.assertEqual(cm.exception.code, POLICY_UNSUPPORTED)
            a.prepare(inp(policy="read_only"), {})
        with self.assertRaises(AsError) as cm:
            a.prepare(inp(policy="unrestricted"), {})
        self.assertEqual(cm.exception.code, POLICY_UNSUPPORTED)


class Registry(unittest.TestCase):
    def test_peers_are_honest_placeholders(self):
        implemented = {"codex", "claude"}  # P00-S08, S09; the others land in S10-S11
        for pid in providers.PEERS:
            self.assertTrue(os.path.exists(os.path.join(PKG, "providers", pid, "CONTRACT.md")))
            if pid in implemented:
                continue
            a = providers.get(pid)
            probe = a.probe({})
            self.assertFalse(probe["available"])
            self.assertIn("not implemented", probe["reason"])
            self.assertEqual(set(probe["policies"].values()), {"unsupported"})
            with self.assertRaises(AsError) as cm:
                a.prepare(inp(), {})
            self.assertEqual(cm.exception.code, POLICY_UNSUPPORTED)
            self.assertTrue(os.path.exists(os.path.join(PKG, "providers", pid, "CONTRACT.md")))

    def test_fake_is_test_only(self):
        with self.assertRaises(AsError):
            providers.get("fake")
        self.assertTrue(providers.get("fake", allow_test_only=True).test_only)
        with self.assertRaises(AsError):
            providers.get("gpt-cli")

    def test_no_provider_specific_code_outside_providers(self):
        """Adding a provider must only need its own directory under providers/."""
        names = re.compile(r"""["'](codex|claude|agy|opencode)["']""")
        offenders = []
        for path in glob.glob(os.path.join(PKG, "*.py")):
            if os.path.basename(path) == "schema.py":  # the enum of allowed IDs
                continue
            with open(path, encoding="utf-8") as f:
                for n, line in enumerate(f, 1):
                    if names.search(line):
                        offenders.append(f"{os.path.basename(path)}:{n}")
        self.assertEqual(offenders, [])


class ControlOps(unittest.TestCase):
    a = providers.get("fake", allow_test_only=True)

    def test_reconcile(self):
        d = tempfile.mkdtemp()
        p = subprocess.Popen(["sleep", "30"], start_new_session=True)
        try:
            ident = procid.identity(p.pid)
            self.assertEqual(self.a.reconcile(ident, d)["state"], "running")
            self.assertEqual(self.a.reconcile(dict(ident, startTime=1), d)["state"], "uncertain")
            with open(os.path.join(d, "result.json"), "w") as f:
                json.dump({"status": "succeeded"}, f)
            self.assertEqual(self.a.reconcile(ident, d)["state"], "terminal")
        finally:
            p.kill()
            p.wait()

    def test_cancel_only_matching_identity(self):
        p = subprocess.Popen(["sleep", "30"], start_new_session=True)
        ident = procid.identity(p.pid)
        self.assertFalse(self.a.cancel(dict(ident, startTime=ident["startTime"] + 1)))
        self.assertIsNone(p.poll())
        self.assertTrue(self.a.cancel(ident))
        p.wait(10)
        self.assertEqual(p.returncode, -signal.SIGTERM)


if __name__ == "__main__":
    unittest.main()
