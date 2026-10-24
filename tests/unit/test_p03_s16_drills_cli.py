"""P03-S16 drill harness: isolation and argument parsing only (no coordinator, no tmux)."""
import contextlib
import importlib.util
import io
import os
import unittest

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
spec = importlib.util.spec_from_file_location("board_drills", os.path.join(ROOT, "scripts", "live", "board_drills.py"))
drills = importlib.util.module_from_spec(spec)
spec.loader.exec_module(drills)

EXPECTED = {"coordinator_killed", "runner_killed", "merge_conflict", "round_limit", "planning_outside",
            "dirty_main", "usage_limit", "stuck_claim"}


class DrillHarnessTests(unittest.TestCase):
    def test_all_eight_drills_are_registered(self):
        self.assertEqual(set(drills.DRILLS), EXPECTED)

    def test_provider_other_than_fake_exits_2_without_starting_anything(self):
        for provider in ("codex", "claude", "agy"):
            with self.assertRaises(SystemExit) as caught, contextlib.redirect_stderr(io.StringIO()):
                drills.main(["--provider", provider])
            self.assertEqual(caught.exception.code, 2)

    def test_unknown_drill_name_exits_2(self):
        with self.assertRaises(SystemExit) as caught, contextlib.redirect_stderr(io.StringIO()):
            drills.main(["--provider", "fake", "--only", "nope"])
        self.assertEqual(caught.exception.code, 2)

    def test_env_state_tmux_and_repo_live_under_one_temp_dir_and_are_removed(self):
        env = drills.Env("probe")
        try:
            root = os.path.realpath(env.root)
            self.assertFalse(root.startswith("/mnt/"))
            for path in (env.env["XDG_STATE_HOME"], env.env["TMUX_TMPDIR"], env.workspace):
                self.assertTrue(os.path.realpath(path).startswith(root + os.sep), path)
            self.assertNotEqual(env.env["XDG_STATE_HOME"], os.environ.get("XDG_STATE_HOME"))
            self.assertEqual(env.env["AGENT_STUDIO_TEST_FIXTURE_PROVIDERS"], "codex=fake,claude=fake,agy=fake")
            self.assertNotIn("AGENT_STUDIO_TEST_CRASH_AT", env.env)
        finally:
            env.cleanup()
        self.assertFalse(os.path.exists(env.root))

    def test_each_env_gets_its_own_state(self):
        a, b = drills.Env("a"), drills.Env("b")
        try:
            self.assertNotEqual(a.env["XDG_STATE_HOME"], b.env["XDG_STATE_HOME"])
            self.assertNotEqual(a.env["TMUX_TMPDIR"], b.env["TMUX_TMPDIR"])
        finally:
            a.cleanup()
            b.cleanup()

    def test_make_repo_writes_board_config_and_story_files(self):
        env = drills.Env("repo")
        try:
            env.make_repo(tickets=2, config={"leaseSeconds": 3600})
            self.assertTrue(os.path.isdir(os.path.join(env.workspace, ".git")))
            for n in (1, 2):
                self.assertTrue(os.path.exists(os.path.join(env.workspace, drills.STORY_DIR, f"story-{n}.md")))
            import json
            with open(os.path.join(env.workspace, ".agent-studio", "board.json")) as f:
                config = json.load(f)
            self.assertTrue(config["baseBranch"])
            self.assertEqual(config["leaseSeconds"], 3600)
            self.assertEqual(env.git("status", "--porcelain"), "")
        finally:
            env.cleanup()


if __name__ == "__main__":
    unittest.main()
