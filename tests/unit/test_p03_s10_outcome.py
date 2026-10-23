import unittest
from unittest import mock

from agent_studio import board, schema


class UnpackOutcomeTests(unittest.TestCase):
    def test_outcome_shape_glob_and_commit_subject(self):
        self.assertEqual(schema.BOARD_OUTCOMES["unpack"], {"kind": "verdict", "pass": "unpacked", "fail": "blocked", "counter": None,
                                                              "limit": None, "commit": "planning", "globs": ("{out}/*",), "check": "manifest"})
        ticket = {"key": "T-001", "workspace": "/workspace", "story_path": None, "out_dir": "phases/phase-04"}
        self.assertEqual(board._globs(ticket, ("{out}/*",)), ("phases/phase-04/*",))
        with mock.patch.object(board.worktrees, "changed_paths", return_value=["outside.md"]):
            result = board.commit_planning(None, ticket, "unpack", ("{out}/*",), {"baseBranch": "main"}, "run")
        self.assertFalse(result["ok"])
        self.assertEqual(result["offending"], ["outside.md"])
        with mock.patch.object(board.worktrees, "changed_paths", return_value=["phases/phase-04/tickets.json"]), \
             mock.patch.object(board.worktrees, "commit_paths", return_value={"commit": "abc"}) as committed:
            board.commit_planning(None, ticket, "unpack", ("{out}/*",), {"baseBranch": "main"}, "run")
        self.assertEqual(committed.call_args.args[-1], "T-001: unpack phases/phase-04")

    def test_invalid_manifest_blocks_passing_unpack_before_planning_commit(self):
        ticket = {"id": "ticket", "key": "T-001", "status": "unpacking", "workspace": "/workspace",
                  "out_dir": "phases/phase-04", "dev_rounds": 0, "test_rounds": 0, "review_rounds": 0}
        run = {"id": "run", "team_id": "team", "status": "succeeded"}
        config = {"baseBranch": "main", "roundLimits": {"dev": 3, "test": 3, "review": 3}}
        with mock.patch.object(board, "_roles_for", return_value=set()), \
             mock.patch.object(board.board_config, "current", return_value=config), \
             mock.patch.object(board, "_verdict", return_value={"verdict": "pass"}), \
             mock.patch.object(board.worktrees, "changed_paths", return_value=["phases/phase-04/tickets.json"]), \
             mock.patch.object(board.worktrees, "commit_paths") as committed, \
             mock.patch.object(board, "_manifest_result", return_value=(None, ["phases/phase-04/tickets.json: missing"])), \
             mock.patch.object(board, "_write_outcome", return_value=ticket) as written:
            board._apply(mock.Mock(), ticket, run, {})

        committed.assert_not_called()
        outcome, findings = written.call_args.args[4:6]
        self.assertEqual((outcome["to"], outcome["reason"], findings),
                         ("blocked", "MANIFEST_INVALID", ["phases/phase-04/tickets.json: missing"]))
