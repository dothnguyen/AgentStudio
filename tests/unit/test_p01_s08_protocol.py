"""P01-S08: route text, per-stage visits, command table, CLI --bind parsing."""
import unittest

from tests import helpers  # noqa: F401  (sets up the import path)
from agent_studio import cli, dispatch, queries
from agent_studio.protocol import AsError


def ev(frm, outcome, to):
    return {"name": "workflow_run.routed", "data": {"fromStage": frm, "outcome": outcome, "toStage": to}}


class Route(unittest.TestCase):
    def test_route_text(self):
        events = [ev("a", "done", "b"), ev("b", "fail", "a"), ev("a", "done", "b"), ev("b", "pass", "$succeed")]
        self.assertEqual(queries.route_text(events), "a → b (fail) → a → b (pass) → $succeed")

    def test_no_routes_shows_current_stage(self):
        self.assertEqual(queries.route_text([], "a"), "a")

    def test_visits(self):
        att = [{"stage": "a", "visit": 1}, {"stage": "b", "visit": 1}, {"stage": "a", "visit": 2}]
        self.assertEqual(queries.visits_per_stage(att), {"a": 2, "b": 1})


class Table(unittest.TestCase):
    def test_commands_registered(self):
        self.assertIn("workflow.list", dispatch.COMMANDS)
        self.assertIn("workflow.validate", dispatch.COMMANDS)

    def test_bindings_parse(self):
        self.assertEqual(cli._bindings(["A=x", "B = y"]), {"A": "x", "B": "y"})
        for bad in (["A"], ["=x"], ["A=x", "A=y"]):
            with self.assertRaises(AsError):
                cli._bindings(bad)


if __name__ == "__main__":
    unittest.main()
