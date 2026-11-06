"""P00-S11: OpenCode adapter - settings, permissions mapping, argv, probe states and parsing.

Fixtures `captured-2.1.4-*.jsonl` are the old provider-error events; `captured-2.2.5-*.jsonl` are real,
verbatim `opencode run --standalone --format json --log-level none` streams from the installed v2.2.5
(success, write success, permission denied, usage limit). The stand-in emits the same shapes for the probe
and argv tests and implements `debug --standalone agents`, the adapter's config-injection canary."""
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


def inp(policy="read_only", model=None, reasoning=None, ws="/tmp", prompt="/tmp/p.txt", **kw):
    return AssignmentInput(assignment_id="a" * 8, agent_id="b" * 8, provider_id="opencode", attempt=1,
                           workspace=ws, prompt_path=prompt, role_instructions="dev", policy=policy,
                           deadline_s=60, output_budget_bytes=1 << 20, model=model, reasoning=reasoning, **kw)


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


def parse(lines):
    st = ParseState()
    for line in lines:
        OPENCODE.parse_line(line, st)
    return st


class Settings(unittest.TestCase):
    def test_model_selectable_reasoning_refused(self):
        self.assertTrue(OPENCODE.model_selectable())
        OPENCODE.validate_settings("deepseek/deepseek-flash", None)
        for bad in ((None, "high"), ("a b", None), ("--auto", None)):
            with self.assertRaises(AsError, msg=bad):
                OPENCODE.validate_settings(*bad)

    def test_policies_are_supported(self):
        mapping = OPENCODE.policy_mapping()
        self.assertEqual(set(mapping), {"read_only", "workspace_write"})
        for policy, flags in mapping.items():
            self.assertIsNotNone(flags)
            self.assertEqual(flags[0], "OPENCODE_CONFIG_CONTENT")
            rules = json.loads(flags[1])["permissions"]
            self.assertIn({"action": "edit", "resource": "*", "effect": "deny"
                           if policy == "read_only" else "allow"}, rules)
        self.assertEqual(OPENCODE.describe({"PATH": ""})["policies"]["read_only"][0], "OPENCODE_CONFIG_CONTENT")

    def test_capabilities(self):
        caps = OPENCODE.capabilities()
        self.assertEqual((caps["headless"], caps["structuredProgress"], caps["structuredFinal"]), (True, True, True))
        self.assertEqual((caps["resume"], caps["interactiveInput"]), ("unsupported", "unsupported"))
        self.assertTrue(OPENCODE.supports_deep_probe())

    def test_policy_rules_keep_shell_opt_in(self):
        ro = oc_mod.policy_rules("read_only", False)
        self.assertIn({"action": "shell", "resource": "*", "effect": "deny"}, ro)
        self.assertIn({"action": "websearch", "resource": "*", "effect": "deny"}, ro)
        self.assertIn({"action": "webfetch", "resource": "*", "effect": "deny"}, ro)
        ro_cmd = oc_mod.policy_rules("read_only", True)
        self.assertIn({"action": "shell", "resource": "git status *", "effect": "allow"}, ro_cmd)
        self.assertIn({"action": "shell", "resource": "python3 -m unittest *", "effect": "allow"}, ro_cmd)
        self.assertEqual(ro_cmd[-2:], oc_mod.WEB_RULES)
        ww = oc_mod.policy_rules("workspace_write", False)
        self.assertIn({"action": "edit", "resource": "*", "effect": "allow"}, ww)
        self.assertIn({"action": "external_directory", "resource": "*", "effect": "deny"}, ww)
        self.assertIn({"action": "shell", "resource": "*", "effect": "deny"}, ww)
        ww_cmd = oc_mod.policy_rules("workspace_write", True)
        self.assertEqual(ww_cmd[-3], {"action": "shell", "resource": "*", "effect": "allow"})
        self.assertEqual(ww_cmd[-2:], oc_mod.WEB_RULES)


class Fixture(unittest.TestCase):
    def setUp(self):
        self.fallback = os.path.join(tempfile.mkdtemp(), "opencode")
        patcher = mock.patch.object(oc_mod, "_install_fallback", return_value=self.fallback)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(shutil.rmtree, os.path.dirname(self.fallback), True)
        self.bin = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.bin, True)
        shutil.copy(os.path.join(FIX, "bin", "opencode"), os.path.join(self.bin, "opencode"))
        os.chmod(os.path.join(self.bin, "opencode"), 0o755)
        self.env = {"PATH": self.bin + ":/usr/bin:/bin", "HOME": tempfile.mkdtemp()}
        self.addCleanup(shutil.rmtree, self.env["HOME"], True)

    def ctl(self, **kw):
        with open(os.path.join(self.bin, "fake-opencode.json"), "w") as f:
            json.dump(kw, f)
        oc_mod._inspect_cache.clear()


class Executable(Fixture):
    def test_path_then_installer_fallback(self):
        self.assertIsNone(OPENCODE.executable({"PATH": "/nonexistent"}))
        self.assertEqual(OPENCODE.executable({"PATH": self.bin}), os.path.join(self.bin, "opencode"))

    def test_installer_fallback_finds_the_real_binary(self):
        real = os.path.expanduser("~/.opencode/bin/opencode")
        if not os.path.isfile(real):
            self.skipTest("opencode is not installed in this environment")
        with mock.patch.object(oc_mod, "_install_fallback", return_value=real):
            self.assertEqual(os.path.realpath(OPENCODE.executable({"PATH": "/nonexistent"})), os.path.realpath(real))

    def test_prepare_refuses_an_unknown_policy(self):
        with self.assertRaises(AsError) as caught:
            OPENCODE.prepare(inp(policy="unrestricted"), self.env)
        self.assertEqual(caught.exception.code, "POLICY_UNSUPPORTED")


class Argv(Fixture):
    def argv(self, **kw):
        return OPENCODE.prepare(inp(**kw), self.env)

    def rules(self, prep):
        return json.loads(prep.extra_env["OPENCODE_CONFIG_CONTENT"])["permissions"]

    def test_no_session_flag_unless_resuming(self):
        self.assertNotIn("--session", self.argv().argv)

    def test_a_resumed_session_adds_session_and_keeps_the_permission_rules(self):
        p = self.argv(provider_session_id="ses_e6b33f345ffeRnd1PiGTozQm3R")
        self.assertEqual(p.argv[p.argv.index("--session") + 1], "ses_e6b33f345ffeRnd1PiGTozQm3R")
        self.assertIn({"action": "shell", "resource": "*", "effect": "deny"}, self.rules(p))
        self.assertTrue(OPENCODE.supports_session_resume)

    def test_a_session_id_of_an_odd_shape_is_refused(self):
        for bad in ("--continue", "a b", "x;y", "", "s" * 101):
            if not bad:
                continue
            with self.assertRaises(AsError):
                self.argv(provider_session_id=bad)

    def test_shape_and_permission_injection(self):
        p = self.argv()
        self.assertEqual(p.argv[0], os.path.join(self.bin, "opencode"))
        self.assertEqual(p.argv[1:4], ["run", "--standalone", "--format"])
        self.assertEqual(p.argv[p.argv.index("--format") + 1], "json")
        self.assertEqual(p.argv[p.argv.index("--log-level") + 1], "none")
        self.assertNotIn("/tmp", p.argv)  # the workspace is the working directory, never an argument
        for flag in oc_mod.NEVER:
            self.assertNotIn(flag, p.argv)
        self.assertEqual((p.cwd, p.stdin_path), ("/tmp", "/tmp/p.txt"))
        self.assertEqual(p.extra_env[oc_mod.PROJECT_CONFIG_ENV], "1")
        self.assertIn({"action": "edit", "resource": "*", "effect": "deny"}, self.rules(p))
        self.assertIn({"action": "shell", "resource": "*", "effect": "deny"}, self.rules(p))

    def test_workspace_write_allows_edits(self):
        p = self.argv(policy="workspace_write", ws="/work/space")
        self.assertEqual(p.cwd, "/work/space")
        rules = self.rules(p)
        self.assertIn({"action": "edit", "resource": "*", "effect": "allow"}, rules)
        self.assertIn({"action": "external_directory", "resource": "*", "effect": "deny"}, rules)
        self.assertIn({"action": "shell", "resource": "*", "effect": "deny"}, rules)

    def test_commands_opt_in(self):
        ws = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, ws, True)
        os.makedirs(os.path.join(ws, ".agent-studio"))
        with open(os.path.join(ws, ".agent-studio", "permissions.json"), "w") as f:
            json.dump({"version": 1, "opencode": {"commands": True}}, f)
        p = self.argv(policy="workspace_write", ws=ws)
        self.assertEqual(self.rules(p)[-3], {"action": "shell", "resource": "*", "effect": "allow"})
        self.assertEqual(self.rules(p)[-2:], oc_mod.WEB_RULES)
        ro = self.argv(policy="read_only", ws=ws)
        self.assertIn({"action": "shell", "resource": "git status *", "effect": "allow"}, self.rules(ro))
        self.assertNotIn({"action": "shell", "resource": "*", "effect": "allow"}, self.rules(ro))
        self.assertEqual(self.rules(ro)[-2:], oc_mod.WEB_RULES)

    def test_model_selection(self):
        p = self.argv(model="deepseek/deepseek-flash")
        self.assertEqual(p.argv[p.argv.index("--model") + 1], "deepseek/deepseek-flash")
        self.assertNotIn("--model", self.argv().argv)

    def test_mcp_config_is_per_assignment(self):
        p = self.argv(mcp_tickets=True)
        config = json.loads(p.extra_env["OPENCODE_CONFIG_CONTENT"])
        server = config["mcp"]["servers"]["agent-studio"]
        self.assertEqual(server["type"], "local")
        self.assertEqual(server["command"][1:3], ["-s", os.path.join(os.path.dirname(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "backend", "launch.py")])
        self.assertEqual(server["environment"]["AGENT_STUDIO_ASSIGNMENT"], "a" * 8)
        self.assertEqual(server["environment"]["AGENT_STUDIO_AGENT"], "b" * 8)
        self.assertFalse(server["codemode"])
        self.assertNotIn("mcp", json.loads(self.argv().extra_env["OPENCODE_CONFIG_CONTENT"]))


class Probe(Fixture):
    def test_available_with_policies_and_auth(self):
        p = OPENCODE.probe(self.env)
        self.assertTrue(p["available"], p)
        self.assertEqual((p["version"], p["executable"]), ("2.2.5", os.path.join(self.bin, "opencode")))
        self.assertEqual(p["login"], {"loggedIn": True, "method": "OpenCode"})
        self.assertNotIn("unsupported", p["policies"].values())
        self.assertFalse(p["authVerified"])  # a shallow probe never claims a deep proof

    def test_not_found_and_auth_required(self):
        empty = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, empty, True)
        self.assertEqual(OPENCODE.probe({"PATH": empty})["code"], "PROVIDER_NOT_FOUND")
        self.ctl(authStored=False)
        p = OPENCODE.probe(self.env)
        self.assertEqual(p["code"], "AUTH_REQUIRED")
        self.assertIn("auth login", p["reason"])

    def test_missing_flags_are_a_gap(self):
        self.ctl(dropFlags=["--standalone"])
        p = OPENCODE.probe(self.env)
        self.assertEqual(p["code"], "CAPABILITY_GAP")
        self.assertIn("--standalone", p["reason"])

    def test_missing_config_injection_is_a_gap(self):
        self.ctl(noConfigInjection=True)
        p = OPENCODE.probe(self.env)
        self.assertEqual(p["code"], "CAPABILITY_GAP")
        self.assertIn("OPENCODE_CONFIG_CONTENT", p["reason"])
        self.assertTrue(p["login"]["loggedIn"])  # auth is checked before the gap is reported


class RealCli(unittest.TestCase):
    """Against the real installed CLI: version, flag and config-injection checks."""

    def test_probe_reports_injection_and_policies(self):
        real = os.path.expanduser("~/.opencode/bin/opencode")
        if not os.path.isfile(real):
            self.skipTest("opencode is not installed in this environment")
        oc_mod._inspect_cache.clear()
        info = OPENCODE.inspect({"PATH": "/nonexistent", "HOME": os.path.expanduser("~")})
        self.assertEqual(info["path"], real)
        self.assertRegex(info["version"], r"^\d+\.\d+\.\d+")
        self.assertTrue(info["configInjection"])
        self.assertEqual(info["missingFlags"], [])
        p = OPENCODE.probe({"PATH": "/nonexistent", "HOME": os.path.expanduser("~")})
        self.assertEqual(p["executable"], real)
        self.assertTrue(p["login"]["loggedIn"] or p["code"] == "AUTH_REQUIRED")
        self.assertEqual(p["policies"], OPENCODE.describe({})["policies"])


class CapturedErrors(unittest.TestCase):
    """Old v2.1.4 output: a provider error is terminal even though the CLI exits 0."""

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
        r, _, _ = replay("captured-2.1.4-provider-auth-403.jsonl")
        self.assertEqual(r["status"], "failed")

    def test_malformed_lines(self):
        st = ParseState()
        OPENCODE.parse_line(b"not json at all", st)
        OPENCODE.parse_line(b'{"truncated', st)
        OPENCODE.parse_line(b"\xff\xfe", st)
        self.assertEqual(st.malformed, 2)
        self.assertIsNone(st.terminal)


class CapturedSuccess(unittest.TestCase):
    """Real v2.2.5 streams (see CONTRACT.md and tests/fixtures/opencode/)."""

    def test_success(self):
        r, st, shown = replay("captured-2.2.5-success.jsonl")
        self.assertEqual((r["status"], r["summary"]), ("succeeded", "AGENT_STUDIO_OK"))
        self.assertTrue(st.session_id.startswith("ses_"))
        self.assertEqual(r["usage"]["input"], 2792)
        self.assertEqual(r["usage"]["cache_read"], 3968)
        self.assertIn("total_cost_micro_usd", r["usage"])
        self.assertTrue(any("message: AGENT_STUDIO_OK" in m for _, m in shown))

    def test_write_then_stop(self):
        r, st, shown = replay("captured-2.2.5-write-success.jsonl", policy="workspace_write")
        self.assertEqual((r["status"], r["summary"]), ("succeeded", "DONE"))
        self.assertTrue(any("tool write completed" in m and "made.txt" in m for _, m in shown))
        self.assertEqual(st.denials, [])

    def test_intermediate_step_finish_is_not_terminal(self):
        with open(os.path.join(FIX, "captured-2.2.5-write-success.jsonl"), "rb") as f:
            lines = [l.rstrip(b"\n") for l in f if l.strip()]
        first = next(i for i, l in enumerate(lines) if b'"reason":"tool-calls"' in l)
        st = parse(lines[:first + 1])
        self.assertIsNone(st.terminal)
        st = parse(lines)
        self.assertEqual(st.terminal, {"ok": True, "summary": "DONE"})

    def test_permission_denied_is_waiting_input(self):
        r, st, shown = replay("captured-2.2.5-permission-denied.jsonl", policy="workspace_write")
        self.assertEqual((r["status"], r["diagnosticCode"]), ("waiting_input", "PERMISSION_DENIED"))
        self.assertTrue(st.denials)
        self.assertIn("write: Permission denied: edit", st.denials[0])
        self.assertTrue(any(k == "attention" and "permission denied" in m for k, m in shown))
        self.assertEqual(r["attention"]["kind"], "permission_denied")

    def test_usage_limit(self):
        r, st, _ = replay("captured-2.2.5-free-limit.jsonl")
        self.assertEqual((r["status"], r["diagnosticCode"]), ("failed", "USAGE_LIMIT"))
        self.assertIn("Free usage limit reached", r["summary"])
        self.assertIn("limitResetAt", r)
        self.assertTrue(r["limitResetAt"].endswith("Z"))

    def test_default_model_success_is_not_scenario_specific(self):
        r, _, _ = replay("captured-2.2.5-default-model-success.jsonl")
        self.assertEqual((r["status"], r["summary"]), ("succeeded", "OK"))


class StreamShapes(unittest.TestCase):
    def test_text_without_step_finish_is_inconclusive(self):
        st = parse([b'{"type":"text","part":{"type":"text","text":"half a reply"}}'])
        r = OPENCODE.finalize(inp(), st, oc())
        self.assertEqual(r["status"], "inconclusive")

    def test_legacy_part_and_tool_shapes_still_parse(self):
        st, shown = ParseState(), []
        for line in (b'{"type":"part","part":{"type":"tool","tool":"bash","state":"error",'
                     b'"error":"permission denied by policy"}}',
                     b'{"type":"part","part":{"type":"text","text":"I could not run the command."}}',
                     b'{"type":"part","part":{"type":"step-finish","tokens":{"input":10,"output":5}}}'):
            shown += OPENCODE.parse_line(line, st)
        r = OPENCODE.finalize(inp(policy="workspace_write"), st, oc())
        self.assertEqual(r["status"], "waiting_input")
        self.assertEqual(st.denials, ["bash: permission denied by policy"])
        self.assertEqual(r["usage"], {"input": 10, "output": 5})

    def test_unknown_events_are_ignored(self):
        st = parse([b'{"type":"something.new","x":1}'])
        self.assertIsNone(st.terminal)
        self.assertEqual(st.events, 1)


if __name__ == "__main__":
    unittest.main()
