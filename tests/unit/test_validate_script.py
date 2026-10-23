"""scripts/validate.py and the team.py commit gate."""
import importlib.util
import os
import subprocess
import tempfile
import types
import unittest
from unittest import mock

os.environ["AGENT_STUDIO"] = "/bin/true"
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")


def load(name, rel):
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, rel))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


validate = load("validate_py", "scripts/validate.py")
team = load("team_py2", "scripts/team/team.py")


class Modules(unittest.TestCase):
    def test_picks_changed_existing_integration_tests_only(self):
        status = (" M tests/integration/test_s04_runner.py\n?? tests/integration/test_p01_s08_cli.py\n"
                  " M tests/unit/test_s09_claude.py\n M backend/agent_studio/runner.py\n"
                  " D tests/integration/test_gone_xyz.py\n?? tests/integration/helpers.txt\n")
        self.assertEqual(validate.integration_modules(status),
                         ["tests.integration.test_p01_s08_cli", "tests.integration.test_s04_runner"])

    def test_nothing_changed(self):
        self.assertEqual(validate.integration_modules(""), [])

    def test_all_lists_every_integration_module(self):
        mods = validate.all_integration_modules()
        self.assertIn("tests.integration.test_s04_runner", mods)
        self.assertTrue(all(m.startswith("tests.integration.test_") for m in mods))


class Modes(unittest.TestCase):
    def test_exactly_one_mode(self):
        self.assertEqual(validate.parse_mode(["--unit"]), "--unit")
        self.assertEqual(validate.parse_mode(["--touched"]), "--touched")
        for bad in ([], ["--unit", "--all"], ["--fast"], ["--all", "x"]):
            with self.assertRaises(SystemExit):
                validate.parse_mode(bad)

    def test_a_step_that_leaves_a_background_process_does_not_hang(self):
        code, text = validate.run_step(["bash", "-c", "(sleep 30 &) ; echo done"])
        self.assertEqual((code, text), (0, "done"))

    def test_failing_step_reports_output(self):
        code, text = validate.run_step(["bash", "-c", "echo boom; exit 3"])
        self.assertEqual((code, text), (3, "boom"))

    def test_unit_mode_runs_only_the_unit_suite(self):
        calls = []
        with mock.patch.object(validate, "run_step", side_effect=lambda a: calls.append(a) or (0, "ok")), \
                mock.patch.object(validate, "run_integration") as integ:
            self.assertEqual(validate.main(["--unit"]), 0)
        self.assertEqual(calls, [validate.UNIT])
        integ.assert_not_called()

    def test_touched_mode_runs_modules_and_fails_when_one_fails(self):
        with mock.patch.object(validate, "run_step", return_value=(0, "ok")), \
                mock.patch.object(validate.subprocess, "run", return_value=types.SimpleNamespace(
                    stdout=" M tests/integration/test_s04_runner.py\n", returncode=1)), \
                mock.patch.object(validate, "run_integration", return_value=False) as integ:
            self.assertEqual(validate.main(["--touched"]), 1)
        integ.assert_called_once_with(["tests.integration.test_s04_runner"])


class ManualLoopTier(unittest.TestCase):
    def test_manual_commands_use_the_unit_tier_unless_asked(self):
        argv = ["python3", "scripts/validate.py", "--touched"]
        self.assertEqual(team.validation_argv(argv), ["python3", "scripts/validate.py", "--unit"])
        self.assertEqual(team.validation_argv(argv, integration=True), argv)
        self.assertEqual(team.validation_argv(["pytest", "-q"]), ["pytest", "-q"])


class BranchChanges(unittest.TestCase):
    def test_committed_rounds_on_a_branch_still_count(self):
        repo = tempfile.mkdtemp()
        git = lambda *a: subprocess.run(["git", "-C", repo, *a], check=True, stdout=subprocess.DEVNULL,
                                        stderr=subprocess.DEVNULL)
        git("init", "-q", "-b", "main")
        git("config", "user.email", "t@example.invalid")
        git("config", "user.name", "t")
        os.makedirs(os.path.join(repo, "tests", "integration"))
        for name in ("test_old.py", "test_new.py"):
            with open(os.path.join(repo, "tests", "integration", name), "w") as f:
                f.write("x = 1\n")
        git("add", "-A")
        git("commit", "-qm", "base")
        git("checkout", "-qb", "ticket/T-001")
        with open(os.path.join(repo, "tests", "integration", "test_new.py"), "a") as f:
            f.write("x = 2\n")
        git("commit", "-qam", "round 1")
        with mock.patch.object(validate, "ROOT", repo):
            changes = validate.branch_changes()
            self.assertEqual(validate.integration_modules(changes), ["tests.integration.test_new"])

    def test_no_base_branch_means_no_extra_changes(self):
        repo = tempfile.mkdtemp()
        subprocess.run(["git", "-C", repo, "init", "-q", "-b", "other"], check=True)
        with mock.patch.object(validate, "ROOT", repo):
            self.assertEqual(validate.branch_changes(), "")


class CommitGate(unittest.TestCase):
    def test_gate_runs_touched_and_blocks_on_failure(self):
        with mock.patch.object(team.subprocess, "run", return_value=types.SimpleNamespace(returncode=1)) as run:
            with self.assertRaises(SystemExit):
                team.integration_gate(False)
        self.assertIn("--touched", run.call_args[0][0])

    def test_gate_passes_and_can_be_skipped(self):
        with mock.patch.object(team.subprocess, "run", return_value=types.SimpleNamespace(returncode=0)):
            team.integration_gate(False)
        with mock.patch.object(team.subprocess, "run") as run:
            team.integration_gate(True)
        run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
