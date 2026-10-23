"""Unit coverage for bug-triage planning file validation."""
import unittest
from unittest import mock

from tests import helpers  # noqa: F401
from agent_studio import board


class TriagePlanningTests(unittest.TestCase):
    def test_commit_planning_accepts_valid_single_bug_file(self):
        ticket = {"key": "T-001", "workspace": "/workspace", "story_path": None}
        path = "bugs/BUG-T-001-login-crash.md"
        with mock.patch.object(board.worktrees, "changed_paths", return_value=[path]), \
             mock.patch.object(board.worktrees, "commit_paths", return_value={"commit": "abc123"}) as committed:
            result = board.commit_planning(None, ticket, "triage", ("bugs/BUG-{key}-*.md",),
                                           {"baseBranch": "main"}, "run")
        self.assertEqual(result, {"ok": True, "commit": "abc123", "paths": [path], "offending": []})
        committed.assert_called_once_with("/workspace", "main", [path], "T-001: triage " + path)
