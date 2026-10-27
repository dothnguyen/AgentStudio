"""Registry and streaming execution for the agy adapter."""
import json
import os
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from tests.unit.test_s04_contract import inp
from agent_studio import providers
from agent_studio.providers.base import ParseState


class AgyDiscovery(unittest.TestCase):
    def test_registry_advertises_only_write_capability(self):
        adapter = providers.get("agy")
        self.assertIsNone(adapter.policy_mapping()["read_only"])
        self.assertIsNotNone(adapter.policy_mapping()["workspace_write"])
        self.assertFalse(adapter.probe({"PATH": ""})["available"])

    def test_prepared_streaming_process_completes_with_private_prompt(self):
        adapter = providers.get("agy")
        with tempfile.TemporaryDirectory() as directory:
            executable = os.path.join(directory, "agy")
            with open(executable, "w", encoding="utf-8") as f:
                f.write('#!/usr/bin/python3\nimport json,sys\nmsg=json.loads(sys.stdin.readline())\nprint(json.dumps({"event":"result","result":{"status":"SUCCESS","response":msg["message"]["content"]}}))\n')
            os.chmod(executable, 0o755)
            prompt = os.path.join(directory, "prompt.txt")
            with open(prompt, "w", encoding="utf-8") as f:
                f.write("test task")
            assignment = inp(policy="workspace_write")
            assignment.workspace, assignment.prompt_path = directory, prompt
            with patch.object(adapter, "inspect", return_value={"found": True, "path": executable, "missing": []}):
                prepared = adapter.prepare(assignment, {})
            with open(prepared.stdin_path, "rb") as stdin:
                result = subprocess.run(prepared.argv, stdin=stdin, stdout=subprocess.PIPE, cwd=directory, check=True)
            state = ParseState()
            for line in result.stdout.splitlines():
                adapter.parse_line(line, state)
            report = adapter.finalize(assignment, state, {"exitCode": result.returncode})
            self.assertEqual(report["status"], "succeeded")
            self.assertEqual(report["finalText"], "test task")
