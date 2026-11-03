"""Conditional integration selection for full backend validation."""
import contextlib
import io
import types
import unittest
from unittest import mock

from tests.unit.test_validate_script import validate


class ConditionalSelection(unittest.TestCase):
    def test_modes_select_related_modules_and_fall_back_when_changes_unknown(self):
        modules = list(validate.CONDITIONAL) + ["tests.integration.test_other"]
        adapters = modules[:3]
        cases = [
            (" M backend/agent_studio/providers/codex.py\n", adapters + modules[-1:]),
            (" M backend/agent_studio/runner.py\n", adapters + modules[-1:]),
            (" M backend/agent_studio/tmuxctl.py\n", [modules[3], modules[-1]]),
            (" M backend/bin/tool\n", [modules[4], modules[-1]]),
            (" M backend/install.sh\n", [modules[4], modules[-1]]),
            (" M tests/integration/test_s09_claude.py\n", [modules[1], modules[-1]]),
            (" M README.md\n", modules[-1:]),
            (None, modules),
        ]
        for mode in ("--all", "--backend"):
            for changes, expected in cases:
                with self.subTest(mode=mode, changes=changes):
                    status = types.SimpleNamespace(returncode=0 if changes is not None else 1,
                                                   stdout=changes or "")
                    with mock.patch.object(validate, "run_step", return_value=(0, "ok")), \
                         mock.patch.object(validate.subprocess, "run", return_value=status), \
                         mock.patch.object(validate, "branch_changes", return_value=""), \
                         mock.patch.object(validate, "all_integration_modules", return_value=modules), \
                         mock.patch.object(validate, "run_integration", return_value=True) as run, \
                         mock.patch.object(validate, "node_packages", return_value=[]), \
                         contextlib.redirect_stdout(io.StringIO()) as output:
                        self.assertEqual(validate.main([mode]), 0)
                    run.assert_called_once_with(expected)
                    for skipped in set(modules) - set(expected):
                        self.assertIn(f"===== {skipped}: skipped (no related changes)", output.getvalue())

    def test_full_and_unknown_branch_run_every_module(self):
        modules = list(validate.CONDITIONAL)
        for changes, full in ((" M README.md\n", True), (None, False)):
            with self.subTest(changes=changes, full=full), contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(validate.select_integration_modules(modules, changes, full), modules)
                self.assertEqual(output.getvalue(), "")

    def test_each_conditional_module_runs_when_its_own_test_file_changes(self):
        modules = list(validate.CONDITIONAL)
        for module in modules:
            path = module.replace(".", "/") + ".py"
            with self.subTest(module=module):
                self.assertEqual(validate.select_integration_modules(
                    modules, f" M {path}\n"), [module])

    def test_full_flag_runs_conditional_modules_even_with_unrelated_changes(self):
        modules = list(validate.CONDITIONAL)
        for mode in ("--all", "--backend"):
            with self.subTest(mode=mode):
                with mock.patch.object(validate, "run_step", return_value=(0, "ok")), \
                        mock.patch.object(validate.subprocess, "run", return_value=types.SimpleNamespace(
                            returncode=0, stdout=" M README.md\n")), \
                        mock.patch.object(validate, "branch_changes", return_value=""), \
                        mock.patch.object(validate, "all_integration_modules", return_value=modules), \
                        mock.patch.object(validate, "run_integration", return_value=True) as run, \
                        mock.patch.object(validate, "node_packages", return_value=[]):
                    self.assertEqual(validate.main([mode, "--full"]), 0)
                run.assert_called_once_with(modules)

class LegacySelection(unittest.TestCase):
    def test_legacy_classes_skip_by_default_and_are_enabled_by_environment(self):
        import importlib
        import os

        names = ("test_s06_workflow", "test_p01_s09_story_delivery",
                 "test_p04_s05_story_commands", "test_s07_recovery")
        for enabled in (False, True):
            with mock.patch.dict(os.environ, {"AGENT_STUDIO_LEGACY_TESTS": "1"} if enabled else {}, clear=False):
                if not enabled:
                    os.environ.pop("AGENT_STUDIO_LEGACY_TESTS", None)
                for name in names:
                    module = importlib.import_module("tests.integration." + name)
                    module = importlib.reload(module)
                    classes = [obj for obj in vars(module).values()
                               if isinstance(obj, type) and issubclass(obj, unittest.TestCase)
                               and obj.__module__ == module.__name__]
                    self.assertTrue(classes)
                    for cls in classes:
                        with self.subTest(enabled=enabled, cls=cls.__name__):
                            self.assertEqual(cls.__dict__.get("__unittest_skip__", False), not enabled)
