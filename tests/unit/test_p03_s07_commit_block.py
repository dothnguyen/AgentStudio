import os
import tempfile
import unittest
from unittest import mock
from types import SimpleNamespace

from tests import helpers  # noqa: F401
from agent_studio import board


class CommitBlockTests(unittest.TestCase):
    ticket = {"key": "T-001", "title": "Useful change"}

    def test_block_among_other_text_is_used(self):
        message, defaulted = board.commit_message("lead text\n```commit\nShip this\n```\nmore", self.ticket)
        self.assertEqual(message, "Ship this\n\nTicket: T-001")
        self.assertFalse(defaulted)

    def test_first_of_two_blocks_wins(self):
        message, defaulted = board.commit_message("```commit\nfirst\n```\n```commit\nsecond\n```", self.ticket)
        self.assertEqual(message, "first\n\nTicket: T-001")
        self.assertFalse(defaulted)

    def test_missing_unclosed_or_empty_block_uses_default(self):
        for text in ("none", "```commit\nnot closed", "```commit\n \n```"):
            with self.subTest(text=text):
                message, defaulted = board.commit_message(text, self.ticket)
                self.assertEqual(message, "T-001: Useful change\n\nTicket: T-001")
                self.assertTrue(defaulted)

    def test_trailer_is_added_only_once(self):
        message, defaulted = board.commit_message("```commit\nTitle\n\nTicket: T-001\n```", self.ticket)
        self.assertEqual(message, "Title\n\nTicket: T-001")
        self.assertFalse(defaulted)

    def test_rewrite_status_changes_only_first_line_and_leaves_missing_line(self):
        with tempfile.TemporaryDirectory() as directory:
            story = os.path.join(directory, "story.md")
            with open(story, "w", encoding="utf-8") as f:
                f.write("Status: To Do\nbody\nStatus: retain\n")
            with mock.patch.object(board, "datetime") as clock:
                clock.now.return_value.date.return_value.isoformat.return_value = "2026-10-23"
                self.assertTrue(board.rewrite_story_status(story))
            with open(story, encoding="utf-8") as f:
                self.assertEqual(f.read(), "Status: Done (2026-10-23)\nbody\nStatus: retain\n")
            missing = os.path.join(directory, "missing.md")
            with open(missing, "w", encoding="utf-8") as f:
                f.write("body\n")
            self.assertFalse(board.rewrite_story_status(missing))
            with open(missing, encoding="utf-8") as f:
                self.assertEqual(f.read(), "body\n")

    def test_conflict_marker_snapshot_failures_do_not_abort_develop_start(self):
        ticket = {"id": "ticket", "key": "T-001", "title": "Useful change", "kind": "story",
                  "status": "changes_requested", "workspace": "/main", "worktree_path": "/worktree",
                  "branch": "ticket/T-001", "story_path": None,
                  "findings_json": '["MERGE_CONFLICT: file.py"]'}
        claimed = dict(ticket, status="in_dev")
        agent = {"id": "agent", "team_id": "team", "role": "Developer"}
        config = {"baseBranch": "main", "leaseSeconds": 60,
                  "columns": {"develop": {"role": "Developer", "definition": "develop"}}}
        definition = SimpleNamespace(stages=[SimpleNamespace(type="agent", role="Developer")])
        tx = mock.Mock()
        tx.get.return_value = claimed
        failed = SimpleNamespace(returncode=1)
        with mock.patch.object(board.tickets, "deps_merged", return_value=True), \
             mock.patch.object(board.tickets, "move", return_value=claimed), \
             mock.patch.object(board.tickets, "_ticket_event"), \
             mock.patch.object(board.gitws, "run", side_effect=[failed, failed, failed]) as git_run, \
             mock.patch.object(board, "_head", return_value="base-merge-head"), \
             mock.patch.object(board, "_record_commit", return_value=claimed) as recorded, \
             mock.patch.object(board.workflowdef, "load", return_value=definition), \
             mock.patch.object(board.workflow, "start", return_value={"workflowRunId": "run"}) as started:
            result = board.start_column(tx, ticket, agent, config, {"stateDir": "/state"})
        self.assertEqual(result["workflowRunId"], "run")
        self.assertEqual(recorded.call_args.args[2], {"branch": "ticket/T-001", "commit": "base-merge-head",
                                                       "baseMerge": True, "runId": None})
        self.assertEqual(started.call_args.kwargs, {})
        self.assertEqual(started.call_args.args[1]["seed"], {"findings": ["MERGE_CONFLICT: file.py"]})
        self.assertEqual(git_run.call_args_list[1].kwargs, {"check": False})
        self.assertEqual(git_run.call_args_list[2].kwargs, {"check": False})
