"""P00-S11: OpenCode adapter - settings, argv, probe states and parsing. Error-event fixtures are real
opencode v2.1.4 output (captured-2.1.4-*.jsonl); success/tool shapes are documented but not captured (see
CONTRACT.md - every model the stored credential can list fails upstream), so the stand-in emits them and the
tests pin them as the shapes to re-verify against a runnable model."""
import json
import os
import shutil
import tempfile
import unittest
from unittest import mock

import tests.helpers  # noqa: F401
from agent_studio import providers
from agent_studio.protocol import AsError
from agent_studio.providers.base import AssignmentInput, ParseState
from agent_studio.providers.opencode import adapter as oc_mod

FIX = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "fixtures", "opencode")
OPENCODE = providers.get("opencode")


def inp(policy="read_only", model=None, reasoning=None, ws="/tmp", prompt="/tmp/p.txt"):
    return AssignmentInput(assignment_id="a" * 8, agent_id="b" * 8, provider_id="opencode", attempt=1,
                           workspace=ws, prompt_path=prompt, role_instructions="dev", policy=policy,
                           deadline_s=60, output_budget_bytes=1 << 20, model=model, reasoning=reasoning)


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
                shown += OPENCODE.parse_line(line.rstrip(b"\n"), st)
    return OPENCODE.finalize(inp(**kw), st, oc()), st, shown


class Settings(unittest.TestCase):
    def test_model_selectable_reasoning_refused(self):
        self.assertTrue(OPENCODE.model_selectable())
        OPENCODE.validate_settings("opencode-go/glm-5.3", None)
        OPENCODE.validate_settings("glm-5.3", None)
        for bad in ((None, "high"), ("a b", None), ("--auto", None)):
            with self.assertRaises(AsError, msg=bad):
                OPENCODE.validate_settings(*bad)

    def test_policies_are_unsupported(self):
        mapping = OPENCODE.policy_mapping()
        self.assertEqual(mapping, {"read_only": None, "workspace_write": None})
        self.assertEqual(OPENCODE.describe({"PATH": ""})["policies"],
                         {"read_only": "unsupported", "workspace_write": "unsupported"})

    def test_capabilities(self):
        caps = OPENCODE.capabilities()
        self.assertEqual((caps["headless"], caps["structuredProgress"], caps["structuredFinal"]), (True, True, True))
        self.assertEqual((caps["resume"], caps["interactiveInput"]), ("unsupported", "unsupported"))
        self.assertFalse(OPENCODE.supports_deep_probe())


class Executable(unittest.TestCase):
    def test_path_then_installer_fallback(self):
        with mock.patch.object(oc_mod, "_install_fallback",
                               return_value=os.path.join(tempfile.mkdtemp(), "opencode")):
            self.addCleanup(shutil.rmtree, os.path.dirname(oc_mod._install_fallback()), True)
            self.assertIsNone(OPENCODE.executable({"PATH": "/nonexistent"}))
            bin_dir = tempfile.mkdtemp()
            self.addCleanup(shutil.rmtree, bin_dir, True)
            self.assertIsNone(OPENCODE.executable({"PATH": bin_dir}))
            fake = os.path.join(bin_dir, "opencode")
            shutil.copy(os.path.join(FIX, "bin", "opencode"), fake)
            os.chmod(fake, 0o755)
            self.assertEqual(OPENCODE.executable({"PATH": bin_dir}), fake)

    def test_installer_fallback_finds_the_real_binary(self):
        real = os.path.expanduser("~/.opencode/bin/opencode")
        if not os.path.isfile(real):
            self.skipTest("opencode is not installed in this environment")
        self.assertEqual(os.path.realpath(OPENCODE.executable({"PATH": "/nonexistent"})),
                         os.path.realpath(real))

    def test_prepare_refuses_unsupported_policy(self):
        with mock.patch.object(oc_mod, "_install_fallback",
                               return_value=os.path.join(tempfile.mkdtemp(), "opencode")):
            with self.assertRaises(AsError) as caught:
                OPENCODE.prepare(inp(), {"PATH": "/nonexistent"})
        self.assertEqual(caught.exception.code, "POLICY_UNSUPPORTED")


class Argv(unittest.TestCase):
    """The argv shape is fully specified (verified flags) even though policies keep it unused today."""

    def setUp(self):
        fallback = os.path.join(tempfile.mkdtemp(), "opencode")  # isolate from a real ~/.opencode install
        patcher = mock.patch.object(oc_mod, "_install_fallback", return_value=fallback)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(shutil.rmtree, os.path.dirname(fallback), True)
        self.bin = tempfile.mkdtemp()
        shutil.copy(os.path.join(FIX, "bin", "opencode"), os.path.join(self.bin, "opencode"))
        os.chmod(os.path.join(self.bin, "opencode"), 0o755)
        self.env = {"PATH": self.bin + ":/usr/bin:/bin"}

    def tearDown(self):
        shutil.rmtree(self.bin)

    def argv(self, **kw):
        return OPENCODE.prepare(inp(**kw), self.env).argv

    def test_shape_once_policies_exist(self):
        # pin the shape against the adapter's own construction, bypassing the policy refusal
        import unittest.mock as mock
        with mock.patch.object(oc_mod.OpenCodeAdapter, "policy_mapping",
                               return_value={"read_only": ["--flag-ro"], "workspace_write": ["--flag-ww"]}):
            a = OPENCODE.prepare(inp(), self.env).argv
            self.assertEqual(a[0], os.path.join(self.bin, "opencode"))
            self.assertEqual(a[1:4], ["run", "--standalone", "--format"])
            self.assertEqual(a[a.index("--format") + 1], "json")
            self.assertEqual(a[a.index("--log-level") + 1], "none")
            self.assertNotIn("/tmp", a)  # the workspace is the working directory, never an argument
            p = OPENCODE.prepare(inp(ws="/work/space"), self.env)
            self.assertEqual((p.cwd, p.stdin_path), ("/work/space", "/tmp/p.txt"))

    def test_model_selection(self):
        import unittest.mock as mock
        with mock.patch.object(oc_mod.OpenCodeAdapter, "policy_mapping",
                               return_value={"read_only": [], "workspace_write": []}):
            a = OPENCODE.prepare(inp(model="opencode-go/glm-5.3"), self.env).argv
            self.assertEqual(a[a.index("--model") + 1], "opencode-go/glm-5.3")
            self.assertNotIn("--model", OPENCODE.prepare(inp(), self.env).argv)

    def test_never_flags(self):
        import unittest.mock as mock
        with mock.patch.object(oc_mod.OpenCodeAdapter, "policy_mapping",
                               return_value={"read_only": ["--auto", "-c"], "workspace_write": []}), \
                self.assertRaises(AsError) as caught:
            OPENCODE.prepare(inp(), self.env)
        self.assertEqual(caught.exception.code, "BAD_ADAPTER")


class Probe(unittest.TestCase):
    def setUp(self):
        fallback = os.path.join(tempfile.mkdtemp(), "opencode")
        patcher = mock.patch.object(oc_mod, "_install_fallback", return_value=fallback)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(shutil.rmtree, os.path.dirname(fallback), True)
        self.bin = tempfile.mkdtemp()
        shutil.copy(os.path.join(FIX, "bin", "opencode"), os.path.join(self.bin, "opencode"))
        os.chmod(os.path.join(self.bin, "opencode"), 0o755)
        self.env = {"PATH": self.bin + ":/usr/bin:/bin", "HOME": tempfile.mkdtemp()}

    def tearDown(self):
        shutil.rmtree(self.bin)

    def ctl(self, **kw):
        with open(os.path.join(self.bin, "fake-opencode.json"), "w") as f:
            json.dump(kw, f)
        oc_mod._inspect_cache.clear()

    def test_gap_is_reported_with_version_and_auth(self):
        p = OPENCODE.probe(self.env)
        self.assertEqual((p["code"], p["version"], p["executable"]),
                         ("CAPABILITY_GAP", "2.1.4", os.path.join(self.bin, "opencode")))
        self.assertIn("no run-scoped permission configuration", p["reason"])
        self.assertIn("providers/opencode/CONTRACT.md", p["reason"])
        self.assertTrue(p["login"]["loggedIn"])  # auth is checked before the gap is reported
        self.assertEqual(p["login"]["method"], "OpenCode")  # the stand-in's stored credential

    def test_not_found_and_auth_required(self):
        empty = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, empty, True)
        self.assertEqual(OPENCODE.probe({"PATH": empty})["code"], "PROVIDER_NOT_FOUND")
        self.ctl(authStored=False)
        p = OPENCODE.probe(self.env)
        self.assertEqual(p["code"], "AUTH_REQUIRED")
        self.assertIn("auth login", p["reason"])

    def test_missing_flags_are_a_gap_too(self):
        self.ctl(dropFlags=["--standalone"])
        p = OPENCODE.probe(self.env)
        self.assertEqual(p["code"], "CAPABILITY_GAP")
        self.assertIn("--standalone", p["reason"])




class RealCli(unittest.TestCase):
    """Against the real installed CLI: version parsed, auth checked, gap reported."""

    def test_probe_reports_the_recorded_gap(self):
        real = os.path.expanduser("~/.opencode/bin/opencode")
        if not os.path.isfile(real):
            self.skipTest("opencode is not installed in this environment")
        p = OPENCODE.probe({"PATH": "/nonexistent", "HOME": os.path.expanduser("~")})
        self.assertEqual(p["executable"], real)
        self.assertEqual(p["version"], "2.1.4")
        self.assertEqual(p["code"], "CAPABILITY_GAP")  # the recorded gap, not a resolution failure
        self.assertTrue(p["login"]["loggedIn"])  # the stored credential is seen


class CapturedEvents(unittest.TestCase):
    """Real v2.1.4 output: a provider error is terminal even though the CLI exits 0."""

    def test_provider_auth_403(self):
        r, st, shown = replay("captured-2.1.4-provider-auth-403.jsonl")
        self.assertEqual((r["status"], r["diagnosticCode"]), ("failed", "AUTH_REQUIRED"))
        self.assertIn("OpenCode Go subscription", r["summary"])
        self.assertTrue(st.session_id.startswith("ses_"))
        self.assertTrue(any("provider.auth" in m for _, m in shown))

    def test_invalid_request_400(self):
        r, _, _ = replay("captured-2.1.4-invalid-request-400.jsonl")
        self.assertEqual((r["status"], r["diagnosticCode"]), ("failed", "PROVIDER_ERROR"))
        self.assertIn("Privacy settings", r["summary"])

    def test_exit_zero_is_never_success_without_a_terminal_event(self):
        r, _, _ = replay("captured-2.1.4-provider-auth-403.jsonl", )  # exitCode stays 0
        self.assertEqual(r["status"], "failed")

    def test_malformed_lines(self):
        st = ParseState()
        OPENCODE.parse_line(b"not json at all", st)
        OPENCODE.parse_line(b'{"truncated', st)
        OPENCODE.parse_line(b"\xff\xfe", st)
        self.assertEqual(st.malformed, 2)
        self.assertIsNone(st.terminal)


class DocumentedShapes(unittest.TestCase):
    """Success/tool shapes follow opencode's part model but were never captured (CONTRACT.md). The stand-in
    emits them; these tests pin the parsing so a runnable model can re-verify them."""

    def test_success_needs_the_step_finish_part(self):
        st = ParseState()
        for line in (b'{"type":"part","part":{"type":"text","text":"AGENT_STUDIO_OK"}}',
                     b'{"type":"part","part":{"type":"step-finish","tokens":{"input":10,"output":5}}}'):
            OPENCODE.parse_line(line, st)
        r = OPENCODE.finalize(inp(), st, oc())
        self.assertEqual((r["status"], r["summary"]), ("succeeded", "AGENT_STUDIO_OK"))
        self.assertEqual(r["usage"], {"input": 10, "output": 5})

    def test_text_without_step_finish_is_inconclusive(self):
        st = ParseState()
        OPENCODE.parse_line(b'{"type":"part","part":{"type":"text","text":"half a reply"}}', st)
        r = OPENCODE.finalize(inp(), st, oc())
        self.assertEqual(r["status"], "inconclusive")

    def test_tool_error_is_attention_not_denial(self):
        st, shown = ParseState(), []
        for line in (b'{"type":"part","part":{"type":"tool","tool":"bash","state":"error",'
                     b'"error":"permission denied by policy"}}',
                     b'{"type":"part","part":{"type":"text","text":"I could not run the command."}}',
                     b'{"type":"part","part":{"type":"step-finish","tokens":{}}}'):
            shown += OPENCODE.parse_line(line, st)
        r = OPENCODE.finalize(inp(), st, oc())
        self.assertEqual(r["status"], "succeeded")
        self.assertTrue(any(k == "attention" and "permission denied" in m for k, m in shown))
        self.assertEqual(st.denials, [])  # a policy-blocked tool result is not a runner-level denial

    def test_unknown_events_are_ignored(self):
        st = ParseState()
        self.assertEqual(OPENCODE.parse_line(b'{"type":"something.new","x":1}', st), [])
        self.assertIsNone(st.terminal)


if __name__ == "__main__":
    unittest.main()
