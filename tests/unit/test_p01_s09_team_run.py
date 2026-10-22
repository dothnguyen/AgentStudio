"""P01-S09: team.py run / workflows / check with the agent-studio CLI stubbed."""
import importlib.util
import os
import types
import unittest
from unittest import mock

os.environ["AGENT_STUDIO"] = "/bin/true"
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
spec = importlib.util.spec_from_file_location("team_py", os.path.join(ROOT, "scripts", "team", "team.py"))
team = importlib.util.module_from_spec(spec)
spec.loader.exec_module(team)

TEAM = {"teamId": "T1", "agents": {"Developer": {"agentId": "D1", "name": "dev", "role": "Developer"},
                                   "QA": {"agentId": "Q1", "name": "qa", "role": "QA"},
                                   "TeamLead": {"agentId": "L1", "name": "lead", "role": "TeamLead"}}}
COMMIT = "Do it\n\nBody"


def ns(**kw):
    base = dict(name="story-delivery", prompt=None, story=None, prompt_file=None, bind=[], no_wait=False)
    return types.SimpleNamespace(**dict(base, **kw))


def detail(status="succeeded", outcome="verdict_pass", text="ok\n```commit\n" + COMMIT + "\n```"):
    return {"workflowRun": {"id": "W1", "status": status}, "route": "develop → final (pass) → $succeed",
            "stageAttempts": [{"assignmentId": "A1", "outcome": outcome, "verdict": {"verdict": "pass",
                                                                                  "findings": ["f1"]}}],
            "assignments": [{"id": "A1", "result": {"finalText": text}}]}


class Run(unittest.TestCase):
    def setUp(self):
        self.saved = {}
        for target, new in (("team", lambda: TEAM), ("save", lambda k, v: self.saved.update({k: v})),
                            ("load", lambda k, d=None: d), ("story_key", lambda s: "story-x")):
            p = mock.patch.object(team, target, new)
            p.start()
            self.addCleanup(p.stop)

    def test_args_and_bind_names_map_to_ids(self):
        a = team.run_args(ns(bind=["QA=qa", "Developer=dev"]), "t")
        self.assertEqual(a[:8], ["workflow", "start", "--team", "T1", "--definition", "story-delivery",
                                 "--text-file", "-"])
        self.assertIn("QA=Q1", a)
        self.assertIn("Developer=D1", a)
        self.assertEqual(a[-1], "--wait")
        self.assertNotIn("--wait", team.run_args(ns(no_wait=True), "t"))

    def test_bad_bind_exits(self):
        for bad in (["QA"], ["QA=nobody"]):
            with self.assertRaises(SystemExit):
                team.bindings_for(bad)

    def test_prompt_sources(self):
        self.assertEqual(team.run_prompt(ns(prompt="hi")), "hi")
        self.assertIn("The story to deliver is in S.md", team.run_prompt(ns(story="S.md")))
        with self.assertRaises(SystemExit):
            team.run_prompt(ns())

    def test_dirty_tree_refused(self):
        with mock.patch.object(team, "sh", return_value=types.SimpleNamespace(stdout=" M file\n")), \
                mock.patch.object(team, "cli") as cli:
            with self.assertRaises(SystemExit):
                team.c_run(ns(prompt="x"))
            cli.assert_not_called()

    def test_commit_message_captured_for_story(self):
        out = lambda *a, **k: types.SimpleNamespace(stdout="abc123\n" if a[1] == "rev-parse" else "")
        with mock.patch.object(team, "sh", side_effect=out), mock.patch.object(team, "cli", return_value=detail()), \
                mock.patch.object(team, "show"):
            team.c_run(ns(story="S.md"))
        s = self.saved["story-x"]
        self.assertEqual((s["commitMessage"], s["finalPassed"], s["base"]), (COMMIT, True, "abc123"))

    def test_no_commit_when_failed(self):
        r = team.summarize(detail(status="failed", outcome="verdict_fail"))
        self.assertIsNone(r[4])
        self.assertEqual(r[2], ["f1"])


if __name__ == "__main__":
    unittest.main()
