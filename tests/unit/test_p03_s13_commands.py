import json
import os
import tempfile
import unittest
from unittest import mock
from contextlib import redirect_stdout
import io

from tests import helpers  # noqa: F401
from agent_studio import cli, coordinator, dispatch
from agent_studio.protocol import AsError
from tests.unit.test_p03_s01_tickets import fresh


class BoardRunPauseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.workspace = self.temp.name
        os.mkdir(os.path.join(self.workspace, ".agent-studio"))
        self.conn, self.store = fresh()
        with self.store.transaction() as tx:
            self.team = tx.create("team", {"name": "team", "workspace": self.workspace})
            tx.transition("team", self.team, "running")
            self.agent = tx.create("agent", {"team_id": self.team, "ordinal": 0, "provider_id": "fake",
                                               "role": "Developer", "display_name": "dev"})

    def tearDown(self):
        self.conn.close()
        self.temp.cleanup()

    def test_run_freezes_config_and_pause_keeps_it(self):
        with self.store.transaction() as tx:
            result = coordinator._handle_board_run({"workspace": self.workspace}, tx, {})
        self.assertEqual(result["board"]["status"], "running")
        frozen = self.conn.execute("SELECT config_json FROM board_state WHERE workspace = ?", (self.workspace,)).fetchone()[0]
        self.assertEqual(json.loads(frozen)["maxParallelDev"], 2)
        self.assertEqual(self.conn.execute("SELECT name FROM events WHERE name = 'board.started'").fetchone()[0], "board.started")
        with self.store.transaction() as tx:
            result = coordinator._handle_board_pause({"workspace": self.workspace, "reason": "maintenance"}, tx, {})
        row = self.conn.execute("SELECT status, reason, config_json FROM board_state WHERE workspace = ?", (self.workspace,)).fetchone()
        self.assertEqual(result["board"], {"workspace": self.workspace, "status": "paused", "reason": "maintenance"})
        self.assertEqual(tuple(row), ("paused", "maintenance", frozen))

    def test_invalid_config_does_not_create_state(self):
        with open(os.path.join(self.workspace, ".agent-studio", "board.json"), "w", encoding="utf-8") as f:
            f.write("{")
        with self.store.transaction() as tx, self.assertRaises(AsError) as caught:
            coordinator._handle_board_run({"workspace": self.workspace}, tx, {})
        self.assertEqual(caught.exception.code, "BOARD_CONFIG_INVALID")
        self.assertIsNone(self.conn.execute("SELECT 1 FROM board_state").fetchone())

    def test_pause_reason_validation_has_200_character_limit(self):
        self.assertEqual(dispatch._validate_board_pause({"workspace": self.workspace}), {"workspace": os.path.realpath(self.workspace)})
        with self.assertRaises(AsError) as caught:
            dispatch._validate_board_pause({"workspace": self.workspace, "reason": "x" * 201})
        self.assertEqual(caught.exception.code, "BAD_REQUEST")

    def test_run_and_pause_require_running_team_and_pause_without_reason(self):
        with self.store.transaction() as tx:
            tx.conn.execute("UPDATE teams SET status = 'stopped' WHERE id = ?", (self.team,))
            with self.assertRaises(AsError) as caught:
                coordinator._handle_board_run({"workspace": self.workspace}, tx, {})
        self.assertEqual(caught.exception.code, "TEAM_NOT_RUNNING")
        with self.store.transaction() as tx:
            tx.conn.execute("UPDATE teams SET status = 'running' WHERE id = ?", (self.team,))
            coordinator._handle_board_run({"workspace": self.workspace}, tx, {})
            receipt = coordinator._handle_board_pause({"workspace": self.workspace}, tx, {})
        self.assertEqual(receipt["board"]["reason"], None)
        self.assertEqual(self.conn.execute("SELECT name FROM events ORDER BY seq DESC LIMIT 1").fetchone()[0], "board.paused")

    def test_cli_builds_run_and_pause_requests(self):
        with mock.patch("agent_studio.cli.dispatch.handle_request", return_value={"ok": True}) as call:
            cli.main(["board", "run", "--workspace", self.workspace, "--key", "board-run-1"])
        self.assertEqual(call.call_args.args[0]["command"], "board.run")
        self.assertEqual(call.call_args.args[0]["args"], {"workspace": self.workspace})
        with mock.patch("agent_studio.cli.dispatch.handle_request", return_value={"ok": True}) as call:
            cli.main(["board", "pause", "--workspace", self.workspace, "--reason", "x", "--key", "board-pause-1"])
        self.assertEqual(call.call_args.args[0]["command"], "board.pause")
        self.assertEqual(call.call_args.args[0]["args"], {"workspace": self.workspace, "reason": "x"})

    def test_cli_prints_the_command_receipt(self):
        receipt = {"ok": True, "data": {"board": {"workspace": self.workspace, "status": "running", "reason": None, "unstaffed": []}}}
        output = mock.Mock(); output.buffer = io.BytesIO()
        with mock.patch("agent_studio.cli.dispatch.handle_request", return_value=receipt), mock.patch("sys.stdout", output):
            self.assertEqual(cli.main(["board", "run", "--workspace", self.workspace, "--key", "run-output"]), 0)
        self.assertEqual(json.loads(output.buffer.getvalue()), receipt)

