"""Version 2 board workflow schema validation."""
import copy
import json
import unittest
from dataclasses import FrozenInstanceError

import tests.helpers  # noqa: F401
from agent_studio import workflowdef
from agent_studio.protocol import AsError


class BoardSpecTests(unittest.TestCase):
    def setUp(self):
        self.obj = {"version": 2, "startsAt": "dev-ready", "whileRunning": "deving",
                    "role": "Developer", "priority": 10, "workspace": "worktree", "syncBase": True,
                    "waitForDependencies": False, "createdTickets": "none",
                    "end": {"pass": {"status": "merged", "releaseCreatedTickets": {"from": "none", "to": "ready"}},
                            "fail": "dev-ready", "blocked": {"status": "blocked", "returnTo": "dev-ready"}},
                    "limits": {"maxRuns": 6, "failuresInARow": {"count": 3, "status": "escalate"},
                               "onFailPriority": 0}}

    def parse(self, obj):
        return workflowdef.parse_obj(obj, "develop.yaml")

    def test_board_values_are_frozen_and_survive_round_trip(self):
        definition = self.parse(self.obj)
        board = definition.board
        self.assertIsInstance(board, workflowdef.BoardSpec)
        self.assertEqual((definition.version, board.starts_at, board.while_running, board.role, board.priority),
                         (2, "dev-ready", "deving", "Developer", 10))
        self.assertEqual((board.workspace, board.sync_base, board.wait_for_dependencies, board.created_tickets),
                         ("worktree", True, False, "none"))
        self.assertEqual(board.end["pass"]["releaseCreatedTickets"]["to"], "ready")
        self.assertEqual(board.limits["failuresInARow"]["count"], 3)
        with self.assertRaises(FrozenInstanceError):
            board.priority = 2
        with self.assertRaises(TypeError):
            board.end["pass"]["status"] = "other"
        self.assertEqual(workflowdef.from_json(json.loads(workflowdef.to_json(definition))), definition)

    def test_defaults_and_non_board_definition(self):
        d = self.parse({"version": 2, "startsAt": "ready", "whileRunning": "running",
                        "end": {"pass": "done", "fail": "ready"}})
        self.assertEqual(d.board.priority, 100)
        self.assertIsNone(d.board.role)
        self.assertIsNone(self.parse({"version": 2}).board)

    def test_blocked_return_to_defaults_to_start_without_mutating_input(self):
        obj = copy.deepcopy(self.obj)
        del obj["end"]["blocked"]["returnTo"]
        definition = self.parse(obj)
        self.assertEqual(definition.board.end["blocked"]["returnTo"], "dev-ready")
        self.assertNotIn("returnTo", obj["end"]["blocked"])
        self.assertEqual(workflowdef.from_json(json.loads(workflowdef.to_json(definition))), definition)
        obj["end"]["blocked"]["returnTo"] = "other-ready"
        self.assertEqual(self.parse(obj).board.end["blocked"]["returnTo"], "other-ready")

    def test_invalid_shapes_report_their_paths(self):
        cases = [
            ("startsAt", "Bad"), ("whileRunning", ""), ("createdTickets", "a_b"),
            ("role", " "), ("priority", True), ("priority", -1), ("workspace", []),
            ("syncBase", 1), ("waitForDependencies", "true"), ("end", []),
            ("end.pass", 1), ("end.pass.status", "BAD"), ("end.pass.releaseCreatedTickets", []),
            ("end.pass.releaseCreatedTickets.from", "BAD"), ("end.pass.releaseCreatedTickets.to", "BAD"),
            ("end.fail", "BAD"), ("end.blocked", "blocked"), ("end.blocked.status", "BAD"),
            ("end.blocked.returnTo", "BAD"), ("limits", []), ("limits.maxRuns", 0),
            ("limits.maxRuns", True), ("limits.onFailPriority", -1),
            ("limits.failuresInARow", []), ("limits.failuresInARow.count", 0),
            ("limits.failuresInARow.status", "BAD"), ("end.extra", 1), ("limits.extra", 1),
        ]
        for path, value in cases:
            with self.subTest(path=path, value=value):
                obj = copy.deepcopy(self.obj)
                parts = path.split(".")
                target = obj
                for part in parts[:-1]:
                    target = target[part]
                target[parts[-1]] = value
                with self.assertRaises(AsError) as error:
                    self.parse(obj)
                self.assertIn(path, [item["path"] for item in error.exception.data["errors"]])

    def test_required_nested_fields_report_paths(self):
        for path in ("whileRunning", "end.pass", "end.fail", "end.pass.status",
                     "end.pass.releaseCreatedTickets.from", "end.pass.releaseCreatedTickets.to",
                     "end.blocked.status", "limits.failuresInARow.count", "limits.failuresInARow.status"):
            with self.subTest(path=path):
                obj = copy.deepcopy(self.obj)
                target = obj
                parts = path.split(".")
                for part in parts[:-1]:
                    target = target[part]
                del target[parts[-1]]
                with self.assertRaises(AsError) as error:
                    self.parse(obj)
                self.assertIn(path, [item["path"] for item in error.exception.data["errors"]])

    def test_board_does_not_require_stages_or_end_when_not_board(self):
        parsed = self.parse({"version": 2})
        self.assertEqual(parsed.stages, ())
        self.assertIsNone(parsed.board)

    def test_missing_end_reports_both_required_outcomes(self):
        obj = copy.deepcopy(self.obj)
        del obj["end"]
        with self.assertRaises(AsError) as error:
            self.parse(obj)
        paths = [item["path"] for item in error.exception.data["errors"]]
        self.assertIn("end.pass", paths)
        self.assertIn("end.fail", paths)

    def test_nested_shape_errors_report_their_exact_paths(self):
        cases = [
            ("role", 4, "role"),
            ("end.pass", {"releaseCreatedTickets": {"from": "none", "to": "ready"}}, "end.pass.status"),
            ("end.pass", {"status": "done", "extra": True}, "end.pass.extra"),
            ("end.fail", {"status": "bad!"}, "end.fail.status"),
            ("end.pass.releaseCreatedTickets", {"from": "none", "to": "ready", "extra": 1},
             "end.pass.releaseCreatedTickets.extra"),
            ("end.blocked", {"status": "blocked", "extra": 1}, "end.blocked.extra"),
            ("limits.failuresInARow", {"count": 2, "status": "escalate", "extra": 1},
             "limits.failuresInARow.extra"),
            ("limits.onFailPriority", "0", "limits.onFailPriority"),
        ]
        for path, value, expected_path in cases:
            with self.subTest(path=path, value=value):
                obj = copy.deepcopy(self.obj)
                parts = path.split(".")
                target = obj
                for part in parts[:-1]:
                    target = target[part]
                target[parts[-1]] = value
                with self.assertRaises(AsError) as error:
                    self.parse(obj)
                self.assertIn(expected_path, [item["path"] for item in error.exception.data["errors"]])

    def test_v1_still_rejects_board_keys(self):
        obj = {"version": 1, "startsAt": "ready", "stages": [{"id": "check", "type": "validation"}]}
        with self.assertRaises(AsError) as error:
            self.parse(obj)
        self.assertIn("startsAt", [item["path"] for item in error.exception.data["errors"]])
