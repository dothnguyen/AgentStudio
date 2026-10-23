import unittest

from agent_studio.board import child_priority, plan_children


class PlanChildrenTests(unittest.TestCase):
    def test_priority_mapping(self):
        self.assertEqual([child_priority({"priority": value}) for value in (1, 5, None)], [60, 100, 100])

    def test_classifies_new_mutable_kept_and_removed_children_deterministically(self):
        children = [{"key": "T-1", "story_path": "p/a.md", "status": "refine"},
                    {"key": "T-2", "story_path": "p/b.md", "status": "backlog"},
                    {"key": "T-3", "story_path": "p/c.md", "status": "in_dev"},
                    {"key": "T-4", "story_path": "p/d.md", "status": "cancelled"},
                    {"key": "T-5", "story_path": "p/old.md", "status": "refine"}]
        stories = [{"path": "p/a.md", "title": "A", "priority": 1, "dependsOn": []},
                   {"path": "p/b.md", "title": "B", "priority": 5, "dependsOn": []},
                   {"path": "p/c.md", "title": "C", "priority": None, "dependsOn": []},
                   {"path": "p/d.md", "title": "D", "priority": None, "dependsOn": []},
                   {"path": "p/new.md", "title": "New", "priority": None, "dependsOn": []}]
        got = plan_children(children, stories)
        self.assertEqual([item["path"] for item in got["create"]], ["p/new.md"])
        self.assertEqual([child["key"] for child, _ in got["update"]], ["T-1", "T-2"])
        self.assertEqual([child["key"] for child in got["kept"]], ["T-3", "T-4"])
        self.assertEqual([child["key"] for child in got["removed"]], ["T-5"])
        self.assertEqual(got, plan_children(children, stories))
