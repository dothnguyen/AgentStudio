import os
import re
import subprocess
import tempfile
import unittest
from unittest import mock

from backend.agent_studio import gitws, worktrees
from backend.agent_studio.protocol import AsError


class WorktreeServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.repo = os.path.join(self.temp.name, "repo")
        self.state = os.path.join(self.temp.name, "state")
        os.mkdir(self.repo)
        self.git("init", "-b", "main")
        self.git("config", "user.name", "Unit Tester")
        self.git("config", "user.email", "unit@example.invalid")
        self.write("tracked.txt", "initial\n")
        self.write("deleted.txt", "delete me\n")
        self.git("add", "-A")
        self.git("commit", "-m", "initial")

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args, cwd=None):
        return subprocess.run(["git", "-C", cwd or self.repo, *args], check=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.decode().strip()

    def write(self, name, content, cwd=None):
        path = os.path.join(cwd or self.repo, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)

    def make_tree(self):
        return worktrees.create(self.repo, "T-001", "sample-ticket", "main", state_dir=self.state)

    def test_slug_sanitizes_hostile_and_long_titles(self):
        value = worktrees.slug("$(rm -rf /) 'quotes' `backticks`;\nMünchen")
        self.assertRegex(value, r"^[a-z0-9-]{1,40}$")
        self.assertEqual(worktrees.slug("!@#$%^&*"), "ticket")
        self.assertLessEqual(len(worktrees.slug("a" * 100)), 40)

    def test_root_for_is_stable_and_rejects_non_native_state(self):
        root = worktrees.root_for(self.repo, state_dir=self.state)
        self.assertEqual(root, worktrees.root_for(self.repo, state_dir=self.state))
        self.assertRegex(root, re.escape(os.path.realpath(self.state)) + r"/worktrees/[0-9a-f]{12}$")
        with self.assertRaisesRegex(AsError, "Windows or network") as caught:
            worktrees.root_for(self.repo, state_dir="/mnt/c/x")
        self.assertEqual(caught.exception.code, "STATE_DIR_UNUSABLE")

    def test_create_and_list_registered(self):
        main_head = self.git("rev-parse", "HEAD")
        created = self.make_tree()
        self.assertEqual(created["baseCommit"], main_head)
        self.assertEqual(created["branch"], "ticket/T-001-sample-ticket")
        self.assertEqual(created["path"], os.path.join(worktrees.root_for(self.repo, state_dir=self.state), "T-001"))
        self.assertTrue(os.path.isdir(created["path"]))
        self.assertEqual(worktrees.list_registered(self.repo, state_dir=self.state), [{
            "path": created["path"], "branch": created["branch"], "head": main_head}])
        with self.assertRaises(AsError) as caught:
            self.make_tree()
        self.assertEqual(caught.exception.code, "WORKTREE_EXISTS")
        with self.assertRaises(AsError) as caught:
            worktrees.create(self.repo, "../x", "sample-ticket", "main", state_dir=self.state)
        self.assertEqual(caught.exception.code, "BAD_REQUEST")
        self.assertFalse(os.path.exists(os.path.join(worktrees.root_for(self.repo, state_dir=self.state), "x")))

    def test_commit_round_commits_only_the_ticket_branch(self):
        created = self.make_tree()
        main_head = self.git("rev-parse", "HEAD")
        self.write("round.txt", "branch change\n", created["path"])
        committed = worktrees.commit_round(created["path"], "T-001: round")
        self.assertEqual(committed["commit"], self.git("rev-parse", "HEAD", cwd=created["path"]))
        self.assertEqual(self.git("rev-parse", "HEAD"), main_head)
        self.assertEqual(worktrees.commit_round(created["path"], "T-001: round"), {"commit": None})

    def test_branch_diff_excludes_new_base_commit_and_truncates(self):
        created = self.make_tree()
        self.write("branch.txt", "on branch\n", created["path"])
        worktrees.commit_round(created["path"], "branch")
        self.write("main-new.txt", "on main\n")
        self.git("add", "main-new.txt")
        self.git("commit", "-m", "main")
        out_dir = os.path.join(self.temp.name, "out")
        diff = worktrees.branch_diff(self.repo, "main", created["branch"], out_dir)
        with open(diff["path"], encoding="utf-8") as f:
            patch = f.read()
        self.assertIn("branch.txt", patch)
        self.assertNotIn("main-new.txt", patch)
        self.assertEqual(set(diff), {"path", "bytes", "truncated", "changedFiles", "empty"})
        self.write("large.txt", "x" * (gitws.MAX_DIFF_BYTES + 100), created["path"])
        worktrees.commit_round(created["path"], "large")
        large = worktrees.branch_diff(self.repo, "main", created["branch"], os.path.join(self.temp.name, "large"))
        self.assertTrue(large["truncated"])

    def test_changed_paths_and_check_paths(self):
        self.write("tracked.txt", "modified\n")
        os.unlink(os.path.join(self.repo, "deleted.txt"))
        self.write("new/folder/untracked.txt", "new\n")
        self.assertEqual(worktrees.changed_paths(self.repo), ["deleted.txt", "new/folder/untracked.txt", "tracked.txt"])
        self.assertEqual(worktrees.check_paths(["phases/phase-03/stories/x.md"], ["phases/phase-03/*"]), (True, []))
        ok, bad = worktrees.check_paths(["phases/phase-03/../../etc/passwd", "/abs", "phases/phase-04/x.md"],
                                         ["phases/phase-03/*"])
        self.assertFalse(ok)
        self.assertEqual(bad, ["/abs", "phases/phase-03/../../etc/passwd", "phases/phase-04/x.md"])
        self.assertEqual(worktrees.check_paths(["bugs/BUG-T-001-a.md"], ["bugs/BUG-T-001-*.md"], max_paths=1),
                         (True, []))
        self.assertEqual(worktrees.check_paths(["bugs/BUG-T-001-a.md", "bugs/BUG-T-001-b.md"],
                                                ["bugs/BUG-T-001-*.md"], max_paths=1),
                         (False, ["bugs/BUG-T-001-a.md", "bugs/BUG-T-001-b.md"]))

    def test_commit_paths_is_exact_and_wrong_head_does_not_touch_index(self):
        self.write("wanted.txt", "wanted\n")
        self.write("staged.txt", "staged\n")
        self.write("untracked.txt", "untracked\n")
        self.git("add", "staged.txt")
        committed = worktrees.commit_paths(self.repo, "main", ["wanted.txt"], "plan")
        self.assertEqual(self.git("show", "--format=", "--name-only", committed["commit"]).splitlines(), ["wanted.txt"])
        self.assertEqual(self.git("diff", "--cached", "--name-only"), "staged.txt")
        self.assertTrue(os.path.exists(os.path.join(self.repo, "untracked.txt")))
        before = self.git("diff", "--cached", "--name-only")
        self.git("checkout", "-b", "other")
        with self.assertRaises(AsError) as caught:
            worktrees.commit_paths(self.repo, "main", ["untracked.txt"], "bad")
        self.assertEqual(caught.exception.code, "MAIN_CHECKOUT_WRONG_BRANCH")
        self.assertEqual(self.git("diff", "--cached", "--name-only"), before)
        self.git("checkout", "--detach")
        with self.assertRaises(AsError) as caught:
            worktrees.commit_paths(self.repo, "main", ["untracked.txt"], "bad")
        self.assertEqual(caught.exception.code, "MAIN_CHECKOUT_WRONG_BRANCH")
        self.assertEqual(self.git("diff", "--cached", "--name-only"), before)
        self.assertEqual(worktrees.commit_paths(self.repo, "main", [], "none"), {"commit": None})

    def test_is_clean_and_remove(self):
        self.assertTrue(worktrees.is_clean(self.repo))
        self.write("untracked.txt", "x")
        self.assertFalse(worktrees.is_clean(self.repo))
        os.unlink(os.path.join(self.repo, "untracked.txt"))
        created = self.make_tree()
        worktrees.remove(self.repo, created["path"], state_dir=self.state)
        self.assertFalse(os.path.exists(created["path"]))
        self.assertEqual(worktrees.list_registered(self.repo, state_dir=self.state), [])
        self.assertEqual(self.git("rev-parse", "--verify", created["branch"]), created["baseCommit"])
        for outside in (self.repo, os.path.join(worktrees.root_for(self.repo, state_dir=self.state), "..", "x")):
            with self.assertRaises(AsError) as caught:
                worktrees.remove(self.repo, outside, state_dir=self.state)
            self.assertEqual(caught.exception.code, "WORKTREE_NOT_REGISTERED")

    def test_git_calls_use_argv_without_shell(self):
        real_run = subprocess.run
        calls = []

        def wrapped(*args, **kwargs):
            calls.append((args, kwargs))
            return real_run(*args, **kwargs)

        with mock.patch("subprocess.run", side_effect=wrapped):
            created = self.make_tree()
            self.write("round.txt", "x", created["path"])
            worktrees.commit_round(created["path"], "round")
            self.write("wanted.txt", "x")
            worktrees.commit_paths(self.repo, "main", ["wanted.txt"], "plan")
            worktrees.remove(self.repo, created["path"], state_dir=self.state)
        self.assertTrue(calls)
        self.assertTrue(all(isinstance(args[0], list) and not kwargs.get("shell", False) for args, kwargs in calls))
        source = os.path.join(os.path.dirname(worktrees.__file__), "worktrees.py")
        with open(source, encoding="utf-8") as f:
            code = f.read()
        self.assertNotIn("shell=True", code)
        self.assertNotIn("os.system", code)
        self.assertNotIn("os.popen", code)


if __name__ == "__main__":
    unittest.main()
