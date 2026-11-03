"""Validation of the v3 board configuration, independent of board execution."""
import copy
import unittest

from backend.agent_studio import boardmodel
from backend.agent_studio.protocol import AsError


def config():
    return {
        "version": 3,
        "workflowStatuses": [
            {"id": "backlog", "kind": "initial"}, {"id": "ready"}, {"id": "working"},
            {"id": "merge-ready"}, {"id": "merging"}, {"id": "done", "kind": "done"},
            {"id": "closed", "kind": "closed"},
        ],
        "rules": [
            {"when": {"status": "ready"}, "role": "Developer", "workflow": "develop",
             "during": "working", "onPass": "merge-ready", "onFail": "ready"},
            {"when": {"status": "merge-ready"}, "action": "merge", "during": "merging",
             "onPass": "done", "onFail": "ready"},
        ],
        "todoEntry": ["ready"], "todoDefault": "ready",
    }


class BoardConfigV3Tests(unittest.TestCase):
    def assert_path(self, raw, path):
        with self.assertRaises(AsError) as caught:
            boardmodel.parse_config(raw)
        self.assertIn(path, [p["path"] for p in caught.exception.data["problems"]])

    def test_valid_config_exposes_workflow_metadata(self):
        raw = config()
        parsed = boardmodel.parse_config(raw)
        self.assertEqual(boardmodel.CONFIG_VERSION, 3)
        self.assertEqual(boardmodel.KANBAN_COLUMNS, ("backlog", "todo", "in-progress", "done", "closed"))
        self.assertEqual(parsed["version"], 3)
        self.assertEqual(parsed["initialStatus"], "backlog")
        self.assertEqual(parsed["doneStatuses"], ["done"])
        self.assertEqual(parsed["closedStatus"], "closed")
        self.assertEqual(parsed["columns"], boardmodel.KANBAN_COLUMNS)
        self.assertEqual(parsed["duringToRule"], {"working": raw["rules"][0], "merging": raw["rules"][1]})
        self.assertEqual(parsed["todoEntry"], ["ready"])
        self.assertEqual(parsed["todoDefault"], "ready")
        del raw["rules"][1]["during"]
        raw["workflowStatuses"].pop()
        self.assertIsNone(boardmodel.parse_config(raw)["closedStatus"])

    def test_v4_config_uses_workflow_statuses_without_rules(self):
        raw = config()
        raw["version"] = 4
        raw.pop("rules")
        parsed = boardmodel.parse_config(raw)
        self.assertEqual(parsed["version"], 4)
        self.assertEqual([s["id"] for s in parsed["workflowStatuses"]],
                         [s["id"] for s in raw["workflowStatuses"]])
        self.assertEqual(parsed["todoEntry"], raw["todoEntry"])
        self.assertEqual(parsed["duringToRule"], {})
        invalid = dict(raw, rules=[])
        self.assert_path(invalid, "root")

    def test_status_validation_paths(self):
        cases = [
            (lambda c: c.pop("workflowStatuses"), "workflowStatuses"),
            (lambda c: c.update(workflowStatuses=[]), "workflowStatuses"),
            (lambda c: c.update(workflowStatuses="ready"), "workflowStatuses"),
            (lambda c: c["workflowStatuses"].append({"id": "another", "kind": "initial"}), "workflowStatuses"),
            (lambda c: c["workflowStatuses"][0].pop("kind"), "workflowStatuses"),
            (lambda c: c["workflowStatuses"][5].pop("kind"), "workflowStatuses"),
            (lambda c: c["workflowStatuses"].append({"id": "another-closed", "kind": "closed"}), "workflowStatuses"),
            (lambda c: c["workflowStatuses"][1].update(id="blocked"), "workflowStatuses[1].id"),
            (lambda c: c["workflowStatuses"][1].update(id="backlog"), "workflowStatuses[1].id"),
            (lambda c: c["workflowStatuses"][1].update(kind="bad"), "workflowStatuses[1].kind"),
            (lambda c: c.update(statuses=[]), "root"),
        ]
        for mutate, path in cases:
            with self.subTest(path=path, mutate=mutate):
                raw = config()
                mutate(raw)
                self.assert_path(raw, path)

    def test_todo_validation_paths(self):
        for key in ("todoEntry", "todoDefault"):
            with self.subTest(missing=key):
                raw = config()
                raw.pop(key)
                self.assert_path(raw, key)
        for value in (None, [], "ready"):
            with self.subTest(value=value):
                raw = config()
                raw["todoEntry"] = value
                self.assert_path(raw, "todoEntry")
        for value in ("unknown", "merge-ready", None, []):
            with self.subTest(value=value):
                raw = config()
                raw["todoEntry"] = [value]
                self.assert_path(raw, "todoEntry[0]")
        for value in (None, "done", []):
            with self.subTest(value=value):
                raw = config()
                raw["todoDefault"] = value
                self.assert_path(raw, "todoDefault")
        raw = config()
        raw["todoDefault"] = "merge-ready"
        self.assert_path(raw, "todoDefault")
        raw = config()
        raw["todoEntry"] = ["merge-ready"]
        self.assert_path(raw, "todoEntry[0]")
        raw = config()
        raw["todoEntry"] = ["working"]
        self.assert_path(raw, "todoEntry[0]")

    def test_during_validation_paths(self):
        cases = [
            (lambda c: c["rules"][0].pop("during"), "rules[0].during"),
            (lambda c: c["rules"][0].update(during="unknown"), "rules[0].during"),
            (lambda c: c["rules"][0].update(during="done"), "rules[0].during"),
            (lambda c: c["rules"][0].update(during="closed"), "rules[0].during"),
            (lambda c: c["rules"][0].update(during="backlog"), "rules[0].during"),
            (lambda c: c["rules"][0].update(during=42), "rules[0].during"),
            (lambda c: c["rules"][0].update(during="merge-ready"), "rules[0].during"),
            (lambda c: c["rules"][1].update(during="working"), "rules[1].during"),
            (lambda c: c["rules"][1].update(during="done"), "rules[1].during"),
        ]
        for mutate, path in cases:
            with self.subTest(path=path, mutate=mutate):
                raw = config()
                mutate(raw)
                self.assert_path(raw, path)

    def test_during_must_be_unique_even_when_otherwise_valid(self):
        raw = config()
        raw["workflowStatuses"].append({"id": "waiting"})
        raw["rules"][0]["during"] = "waiting"
        raw["rules"][1]["during"] = "waiting"
        self.assert_path(raw, "rules[1].during")

    def test_action_rule_may_omit_during(self):
        raw = config()
        raw["rules"][1].pop("during")
        parsed = boardmodel.parse_config(raw)
        self.assertEqual(parsed["duringToRule"], {"working": raw["rules"][0]})

    def test_v2_retains_legacy_shape_and_permissive_rules(self):
        raw = config()
        raw["version"] = 2
        raw["statuses"] = raw.pop("workflowStatuses")
        raw.pop("todoEntry")
        raw.pop("todoDefault")
        raw["rules"][0].pop("during")
        raw["statuses"].append({"id": "other-closed", "kind": "closed"})
        before = copy.deepcopy(raw)
        parsed = boardmodel.parse_config(raw)
        self.assertEqual(raw, before)
        self.assertEqual(parsed["version"], 2)
        self.assertNotIn("columns", parsed)
        self.assertNotIn("initialStatus", parsed)


if __name__ == "__main__":
    unittest.main()
