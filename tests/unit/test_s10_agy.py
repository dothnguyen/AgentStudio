"""Coverage for the operator-approved agy workspace-write exception."""
import json
import os
import tempfile
import unittest
from unittest.mock import patch

from tests.unit.test_s04_contract import inp
from agent_studio import providers
from agent_studio.protocol import AsError
from agent_studio.providers.base import ParseState


class AgyTests(unittest.TestCase):
    def setUp(self):
        self.adapter = providers.get("agy")

    def test_read_only_rejected_before_preparing_or_starting(self):
        with patch.object(self.adapter, "_prepare", side_effect=AssertionError("must not prepare")):
            with self.assertRaises(AsError) as error:
                self.adapter.prepare(inp(policy="read_only"), {"PATH": ""})
        self.assertEqual(error.exception.code, "POLICY_UNSUPPORTED")
        self.assertIsNone(self.adapter.policy_mapping()["read_only"])

    def test_prepare_stream_input_without_prompt_in_argv(self):
        with tempfile.TemporaryDirectory() as directory:
            prompt = os.path.join(directory, "prompt.txt")
            with open(prompt, "w", encoding="utf-8") as f:
                f.write("secret task")
            assignment = inp(policy="workspace_write")
            assignment.workspace = directory
            assignment.prompt_path = prompt
            with patch.object(self.adapter, "inspect", return_value={"found": True, "path": "/bin/agy", "missing": []}):
                prepared = self.adapter.prepare(assignment, {})
            self.assertNotIn("secret task", " ".join(prepared.argv))
            self.assertIn("--sandbox", prepared.argv)
            self.assertEqual(prepared.argv[prepared.argv.index("--mode") + 1], "accept-edits")
            with open(prepared.stdin_path, encoding="utf-8") as f:
                self.assertEqual(json.load(f)["message"]["content"], "secret task")

    def test_success_and_stderr_soft_denial(self):
        assignment = inp(policy="workspace_write")
        state = ParseState()
        self.adapter.parse_line(b'{"event":"result","result":{"status":"SUCCESS","response":"done"}}', state)
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8") as f:
            f.write("permission denied for command\n")
            f.flush()
            report = self.adapter.finalize(assignment, state, {"exitCode": 0, "stderrPath": f.name})
        self.assertEqual(report["status"], "waiting_input")
        self.assertEqual(report["diagnosticCode"], "PERMISSION_DENIED")

    def test_usage_limit_and_invalid_event(self):
        state = ParseState()
        self.adapter.parse_line(b'{"event":"result","result":{"status":"ERROR","error":"You have hit your weekly limit"}}', state)
        self.assertEqual(state.terminal["code"], "USAGE_LIMIT")
        other = ParseState()
        self.adapter.parse_line(b'{"event":"result","result":{"status":"MADE_UP"}}', other)
        self.assertIsNone(other.terminal)
        self.assertEqual(other.malformed, 1)

    def test_missing_cli_and_warning(self):
        result = self.adapter.probe({"PATH": ""})
        self.assertFalse(result["available"])
        self.assertEqual(result["code"], "PROVIDER_NOT_FOUND")
        self.assertIn("not guaranteed", result["warning"])
        self.assertEqual(result["policies"]["read_only"], "unsupported")

class AgyHelpTests(unittest.TestCase):
    def test_help_on_stderr_is_supported(self):
        adapter = providers.get("agy")
        help_text = b"--input-format --output-format --mode --sandbox --model --effort accept-edits stream-json"
        result = lambda stdout, stderr: __import__("subprocess").CompletedProcess([], 0, stdout, stderr)
        with patch.object(adapter, "executable", return_value="/bin/agy"), patch("agent_studio.providers.agy.adapter.cli_support.run_quiet", side_effect=[result(b"1.4.8", b""), result(b"", help_text)]):
            info = adapter.inspect({})
        self.assertEqual(info["missing"], [])
