"""scripts/validate.py."""
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


class NodePackages(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="as-node-")
        self.addCleanup(__import__("shutil").rmtree, self.root, True)
        for name, scripts in (("app", {"test": "x", "typecheck": "y", "start": "z"}), ("tools", {}),
                              ("node_modules", {"test": "x"})):
            os.makedirs(os.path.join(self.root, name))
            with open(os.path.join(self.root, name, "package.json"), "w") as f:
                f.write(__import__("json").dumps({"scripts": scripts}))
        os.makedirs(os.path.join(self.root, "docs"))

    def test_touched_packages_only_and_all(self):
        self.assertEqual(validate.node_packages(None, self.root), ["app", "tools"])
        self.assertEqual(validate.node_packages(" M app/src/a.ts\n?? docs/x.md\n", self.root), ["app"])
        self.assertEqual(validate.node_packages(" M docs/x.md\n R a -> tools/b.js\n", self.root), ["tools"])
        self.assertEqual(validate.node_packages(" M application/x\n", self.root), [])

    def run_pkg(self, name, steps_result=(0, "ok")):
        calls = []
        def fake(argv, cwd=None):
            calls.append((argv[1:], os.path.basename(cwd)))
            return steps_result
        with mock.patch.object(validate.shutil, "which", return_value="/usr/bin/npm"), \
                mock.patch.object(validate, "run_step", side_effect=fake):
            return validate.run_node_package(name, self.root), calls

    def test_installs_when_needed_then_runs_test_and_typecheck(self):
        ok, calls = self.run_pkg("app")
        self.assertTrue(ok)
        self.assertEqual([c[0] for c in calls], [["install", "--no-audit", "--no-fund"], ["test"],
                                                 ["run", "typecheck"]])
        os.makedirs(os.path.join(self.root, "app", "node_modules"))
        with open(os.path.join(self.root, "app", "package-lock.json"), "w") as f:
            f.write("{}")
        ok, calls = self.run_pkg("app")
        self.assertEqual([c[0] for c in calls], [["test"], ["run", "typecheck"]])

    def test_lockfile_means_npm_ci_and_a_failed_install_stops_the_rest(self):
        with open(os.path.join(self.root, "app", "package-lock.json"), "w") as f:
            f.write("{}")
        ok, calls = self.run_pkg("app", (1, "boom"))
        self.assertFalse(ok)
        self.assertEqual([c[0] for c in calls], [["ci", "--no-audit", "--no-fund"]])

    def test_missing_npm_is_a_failure_not_a_skip(self):
        with mock.patch.object(validate.shutil, "which", return_value=None):
            self.assertFalse(validate.run_node_package("app", self.root))

    def test_touched_mode_runs_the_touched_package(self):
        with mock.patch.object(validate, "run_step", return_value=(0, "ok")), \
                mock.patch.object(validate.subprocess, "run", return_value=types.SimpleNamespace(
                    stdout=" M app/src/main.ts\n", returncode=0)), \
                mock.patch.object(validate, "branch_changes", return_value=""), \
                mock.patch.object(validate, "node_packages", return_value=["app"]) as found, \
                mock.patch.object(validate, "run_node_package", return_value=False) as run:
            self.assertEqual(validate.main(["--touched"]), 1)
        run.assert_called_once_with("app")
        self.assertIn(" M app/src/main.ts", found.call_args[0][0])


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


if __name__ == "__main__":
    unittest.main()
