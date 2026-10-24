"""P04-S05: team review / dev / qa through the real coordinator and the fake provider.

Fake agents print no verdict line, so verdict-dependent branches (approved, finalPassed, commit message) are proven
by the unit tests; here we prove the plumbing: the real task and workflow reach the agents and the state file is saved.
"""
import json
import os
import re
import subprocess
import unittest

from tests.helpers import SHIM, Sandbox, make_repo
from tests.integration.test_p01_s04_start import git

STORY = "phases/p/stories/P99-S01-x.md"
KEY = "story-P99_S01_x"
CONFIG = {"version": 1, "validation": {"argv": ["python3", "-c", "print('ok')"], "timeoutMs": 20000}}
ROLES = {"version": 1, "roles": {"TeamLead": {}, "Developer": {}, "QA": {}}}


class StoryCommands(unittest.TestCase):
    def setUp(self):
        self.sb = Sandbox()
        rc, r, p = self.sb.run("coordinator", "start", "--enable-debug")
        self.assertTrue(r["ok"], p.stderr)
        self.ws = make_repo(config=CONFIG)
        cfg = os.path.join(self.ws, ".agent-studio")
        os.makedirs(os.path.join(cfg, "teams"))
        os.makedirs(os.path.join(self.ws, "phases", "p", "stories"))
        with open(os.path.join(self.ws, STORY), "w") as f:
            f.write("# P99-S01\n\nStatus: To Do\n")
        with open(os.path.join(cfg, "roles.json"), "w") as f:
            json.dump(ROLES, f)
        with open(os.path.join(cfg, "teams", "alpha.json"), "w") as f:
            json.dump({"id": "alpha", "name": "Alpha", "members": [
                {"id": r.lower(), "name": r, "role": r, "provider": "fake"} for r in ("TeamLead", "Developer", "QA")]}, f)
        git(self.ws, "add", "-A")
        git(self.ws, "commit", "-qm", "team and story")
        rc, r, p = self.sb.run("team", "start", "--workspace", self.ws, "--team", "alpha")
        self.assertTrue(r["ok"], (r, p.stderr))

    def tearDown(self):
        self.sb.cleanup()

    def human(self, *args, stdin="n\n", timeout=180):
        p = subprocess.run([SHIM, "team"] + list(args) + ["--workspace", self.ws, "--team", "alpha"], input=stdin,
                           env=self.sb.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=timeout)
        return p.returncode, p.stdout, p.stderr

    def state(self):
        slug = re.sub(r"[^A-Za-z0-9]+", "_", self.ws).strip("_")
        path = os.path.join(self.sb.env["XDG_STATE_HOME"], "agent-studio", "project-team", slug, KEY + ".json")
        with open(path) as f:
            return json.load(f)

    def test_review_dev_force_and_qa_save_state(self):
        rc, out, err = self.human("review", STORY)
        self.assertEqual(rc, 0, err)
        self.assertIn("===== team lead review (", out)
        s = self.state()
        self.assertEqual(s["story"], STORY)
        self.assertIs(s["approved"], False)       # the fake agent prints no verdict line
        self.assertTrue(s["review"])

        if subprocess.run(["git", "-C", self.ws, "status", "--porcelain"], stdout=subprocess.PIPE,
                          text=True).stdout.strip():
            git(self.ws, "add", "-A")
            git(self.ws, "commit", "-qm", "review changes")
        rc, out, err = self.human("dev", STORY, "--force")
        self.assertEqual(rc, 0, err)
        s = self.state()
        head = subprocess.run(["git", "-C", self.ws, "rev-parse", "HEAD"], stdout=subprocess.PIPE, text=True).stdout.strip()
        self.assertEqual(s["base"], head)
        self.assertTrue(s["workflow"])
        self.assertIn("qaPassed", s)

        # the fake agents print no verdict, so the dev workflow pauses; a paused workflow still holds the workspace
        rc, r, p = self.sb.run("workflow", "cancel", "--workflow", s["workflow"])
        self.assertTrue(r["ok"], (r, p.stderr))

        rc, out, err = self.human("qa", STORY)
        self.assertEqual(rc, 0, err)
        s = self.state()
        self.assertIn("findings", s)
        self.assertIn("qaPassed", s)
        self.assertIn("===== QA (", out)
        self.assertIn("running python3 -c print('ok')", err)

        rc, out, err = self.human("final", STORY, "--force")
        self.assertEqual(rc, 0, err)
        s = self.state()
        self.assertIn("finalPassed", s)
        self.assertIn("finalReview", s)
        self.assertIn("commitMessage", s)
        self.assertIn("===== team lead final review (", out)
        self.assertIn("running python3 -c print('ok')", err)

    def test_dev_without_approval_is_story_not_ready(self):
        rc, out, err = self.human("dev", STORY)
        self.assertEqual(rc, 1)
        self.assertTrue(err.startswith("STORY_NOT_READY:"), err)


if __name__ == "__main__":
    unittest.main()
