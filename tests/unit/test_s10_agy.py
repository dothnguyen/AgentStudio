"""P00-S10 discovery gate: an unverified provider must remain unavailable."""
import os
import tempfile
import unittest
from unittest.mock import patch

from tests.unit.test_s04_contract import inp
from agent_studio import providers
from agent_studio.protocol import AsError
from agent_studio.providers.base import NotImplementedAdapter, POLICY_UNSUPPORTED


class Discovery(unittest.TestCase):
    def test_both_executable_names_remain_unavailable_without_running_them(self):
        adapter = providers.get("agy")
        for name in ("agy", "antigravity"):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                path = os.path.join(directory, name)
                marker = os.path.join(directory, "executed")
                with open(path, "w", encoding="utf-8") as executable:
                    executable.write("#!/bin/sh\ntouch " + marker + "\n")
                os.chmod(path, 0o755)
                for deep in (False, True):
                    result = adapter.probe({"PATH": directory}, deep=deep)
                    self.assertFalse(result["available"])
                    self.assertEqual(result["code"], "CAPABILITY_GAP")
                self.assertFalse(os.path.exists(marker))

    def test_empty_path_components_do_not_discover_current_directory(self):
        adapter = providers.get("agy")
        with tempfile.TemporaryDirectory() as directory:
            executable = os.path.join(directory, "agy")
            with open(executable, "w", encoding="utf-8") as f:
                f.write("#!/bin/sh\nexit 0\n")
            os.chmod(executable, 0o755)
            previous = os.getcwd()
            try:
                os.chdir(directory)
                for path in ("", ":", ":/nonexistent:"):
                    with self.subTest(path=path):
                        result = adapter.probe({"PATH": path})
                        self.assertFalse(result["available"])
                        self.assertEqual(result["code"], "PROVIDER_NOT_FOUND")
            finally:
                os.chdir(previous)

    def test_placeholder_advertises_no_verified_capabilities_or_settings(self):
        description = providers.get("agy").describe({"PATH": ""})
        self.assertEqual(description["providerId"], "agy")
        self.assertTrue(description["capabilities"])
        self.assertTrue(all(value == "unsupported" for value in description["capabilities"].values()))
        self.assertFalse(description["modelSelectable"])
        self.assertEqual(description["reasoningLevels"], [])
        self.assertEqual(description["policies"], {"read_only": "unsupported", "workspace_write": "unsupported"})

    def test_missing_executable_reports_provider_not_found(self):
        probe = providers.get("agy").probe({"PATH": ""})
        self.assertFalse(probe["available"])
        self.assertEqual(probe.get("code"), "PROVIDER_NOT_FOUND")

    def test_unverified_executable_remains_capability_gap(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "agy")
            with open(path, "w", encoding="utf-8") as executable:
                executable.write("#!/bin/sh\nexit 99\n")
            os.chmod(path, 0o755)
            probe = providers.get("agy").probe({"PATH": directory})
        self.assertFalse(probe["available"])
        self.assertEqual(probe["code"], "CAPABILITY_GAP")

    def test_placeholder_is_unavailable_and_refuses_every_policy(self):
        adapter = providers.get("agy")
        self.assertIsInstance(adapter, NotImplementedAdapter)
        probe = adapter.probe({"PATH": ""})
        self.assertEqual(probe["providerId"], "agy")
        self.assertFalse(probe["available"])
        self.assertIn("not implemented", probe["reason"])
        for policy, mapping in adapter.policy_mapping().items():
            with self.subTest(policy=policy):
                self.assertIsNone(mapping)
                with self.assertRaises(AsError) as error:
                    adapter.prepare(inp(policy=policy), {"PATH": ""})
                self.assertEqual(error.exception.code, POLICY_UNSUPPORTED)

    def test_all_policies_and_unknown_policy_refuse_before_execution(self):
        adapter = providers.get("agy")
        self.assertEqual(set(adapter.policy_mapping()), {"read_only", "workspace_write"})
        with patch.object(adapter, "_prepare", side_effect=AssertionError("process preparation reached")):
            for policy in ("read_only", "workspace_write", "unknown"):
                with self.subTest(policy=policy), self.assertRaises(AsError) as error:
                    adapter.prepare(inp(policy=policy), {"PATH": "/usr/bin:/bin"})
                self.assertEqual(error.exception.code, POLICY_UNSUPPORTED)

    def test_unverified_settings_and_deep_probe_are_refused(self):
        adapter = providers.get("agy")
        self.assertFalse(adapter.supports_deep_probe())
        self.assertFalse(adapter.probe({"PATH": "/usr/bin:/bin"}, deep=True)["available"])
        for model, reasoning in (("some-model", None), (None, "high")):
            with self.subTest(model=model, reasoning=reasoning), self.assertRaises(AsError) as error:
                adapter.validate_settings(model, reasoning)
            self.assertEqual(error.exception.code, "SETTING_UNSUPPORTED")
