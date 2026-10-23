"""scripts/validate.py: which integration modules does a change touch."""
import importlib.util
import os
import unittest

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
spec = importlib.util.spec_from_file_location("validate_py", os.path.join(ROOT, "scripts", "validate.py"))
validate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validate)


class Modules(unittest.TestCase):
    def test_picks_changed_existing_integration_tests_only(self):
        status = (" M tests/integration/test_s04_runner.py\n?? tests/integration/test_p01_s08_cli.py\n"
                  " M tests/unit/test_s09_claude.py\n M backend/agent_studio/runner.py\n"
                  " D tests/integration/test_gone_xyz.py\n?? tests/integration/helpers.txt\n")
        self.assertEqual(validate.integration_modules(status),
                         ["tests.integration.test_p01_s08_cli", "tests.integration.test_s04_runner"])

    def test_nothing_changed(self):
        self.assertEqual(validate.integration_modules(""), [])


if __name__ == "__main__":
    unittest.main()
