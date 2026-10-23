import os
import tempfile
import unittest

from agent_studio import manifest
from agent_studio.protocol import AsError, MANIFEST_INVALID


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.out = "plans"
        os.mkdir(os.path.join(self.temp.name, self.out))

    def tearDown(self):
        self.temp.cleanup()

    def write_story(self, name, done=True):
        path = os.path.join(self.temp.name, self.out, name)
        with open(path, "w") as f:
            f.write("# " + name + "\nStatus: To Do\nDepends on: —\n\n## Goal\nx\n\n## Implement in this order\n1. x\n\n## Done when\n")
            if done:
                f.write("- [ ] x\n")
            f.write("\n## Evidence\n")
        return self.out + "/" + name

    def data(self, paths):
        return {"stories": [{"path": p, "title": p, "dependsOn": [], "priority": 3} for p in paths]}

    def invalid_paths(self, data):
        with self.assertRaises(AsError) as raised:
            manifest.validate(self.temp.name, self.out, data)
        self.assertEqual(raised.exception.code, MANIFEST_INVALID)
        return [error["path"] for error in raised.exception.data["errors"]]

    def test_valid_three_story_manifest_is_normalized(self):
        paths = [self.write_story(f"S{i}.md") for i in range(1, 4)]
        data = self.data(paths)
        data["stories"][2]["dependsOn"] = [paths[0]]
        expected = manifest.validate(self.temp.name, self.out, data)
        self.assertEqual(expected["stories"][2], {"path": paths[2], "title": paths[2], "dependsOn": [paths[0]], "priority": 3})
        self.assertEqual(expected["questions"], [])

    def test_invalid_manifest_cases_report_required_paths(self):
        a, b = self.write_story("a.md"), self.write_story("b.md")
        cases = [
            (self.data([a, b]), "stories[0].dependsOn"),
            (self.data([a, a]), "stories[1].path"),
            ({"stories": [{"path": "plans/../escape.md", "title": "x"}]}, "stories[0].path"),
            ({"stories": [{"path": "/plans/a.md", "title": "x"}]}, "stories[0].path"),
            ({"stories": [{"path": "elsewhere/a.md", "title": "x"}]}, "stories[0].path"),
            ({"stories": [{"path": a, "title": "x", "dependsOn": [b]}]}, "stories[0].dependsOn[0]"),
            ({"stories": [{"path": "plans/missing.md", "title": "x"}]}, "stories[0].path"),
            ({"stories": [{"path": a, "title": "x", "unknown": 1}]}, "stories[0].unknown"),
        ]
        cases[0][0]["stories"][0]["dependsOn"] = [b]
        cases[0][0]["stories"][1]["dependsOn"] = [a]
        for data, path in cases:
            with self.subTest(path=path):
                self.assertIn(path, self.invalid_paths(data))

    def test_story_sections_priority_and_size_are_checked(self):
        no_done = os.path.join(self.temp.name, self.out, "no-done.md")
        with open(no_done, "w") as f:
            f.write("# x\nStatus: To Do\nDepends on: —\n## Goal\n## Implement in this order\n## Evidence\n")
        unchecked = self.write_story("unchecked.md", done=False)
        self.assertIn("stories[0].path", self.invalid_paths({"stories": [{"path": self.out + "/no-done.md", "title": "x"}]}))
        self.assertIn("stories[0].path", self.invalid_paths({"stories": [{"path": unchecked, "title": "x"}]}))
        path = self.write_story("priority.md")
        for priority in (0, 6, True):
            with self.subTest(priority=priority):
                self.assertIn("stories[0].priority", self.invalid_paths({"stories": [{"path": path, "title": "x", "priority": priority}]}))
        paths = [self.write_story("n%d.md" % i) for i in range(31)]
        self.assertIn("stories", self.invalid_paths(self.data(paths)))

    def test_questions_allow_empty_stories_only_when_nonempty(self):
        self.assertEqual(manifest.validate(self.temp.name, self.out, {"stories": [], "questions": ["q"]}),
                         {"stories": [], "questions": ["q"]})
        self.assertIn("stories", self.invalid_paths({"stories": []}))

    def test_dense_thirty_story_dag_is_accepted(self):
        paths = [self.write_story(f"S{i}.md") for i in range(30)]
        data = self.data(paths)
        for index, story in enumerate(data["stories"]):
            story["dependsOn"] = paths[:index]

        result = manifest.validate(self.temp.name, self.out, data)

        self.assertEqual(result["stories"][-1]["dependsOn"], paths[:-1])

    def test_cycle_is_reported_on_first_participating_story(self):
        paths = [self.write_story(f"S{i}.md") for i in range(3)]
        data = self.data(paths)
        data["stories"][0]["dependsOn"] = [paths[1]]
        data["stories"][1]["dependsOn"] = [paths[2]]
        data["stories"][2]["dependsOn"] = [paths[1]]

        self.assertIn("stories[1].dependsOn", self.invalid_paths(data))
