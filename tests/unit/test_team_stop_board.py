import contextlib
import io
import unittest
from unittest import mock

from tests.helpers import fresh
from agent_studio import boardmodel, boardsettings, cli, teams


class TeamStopBoard(unittest.TestCase):
    def setUp(self):
        self.conn, self.store = fresh()
        self.addCleanup(self.conn.close)
        self.ws = "/workspace"
        self.tmux = mock.Mock()
        self.tmux.list_sessions.return_value = []
        self.tmux.base.return_value = ["tmux"]
        self.ctx = {"tmux": self.tmux, "stateDir": "/tmp"}
        with self.store.transaction() as tx:
            self.team = tx.create("team", {"name": "one", "workspace": self.ws})
            tx.transition("team", self.team, "running")
            boardmodel.ensure_board(tx, self.ws)
            tx.conn.execute("UPDATE board_state SET team_id = ?, run_status = 'running' WHERE workspace = ?",
                            (self.team, self.ws))

    def stop(self):
        with self.store.transaction() as tx:
            return teams.team_stop(tx, {"teamId": self.team}, self.ctx)

    def board(self):
        return self.conn.execute("SELECT team_id, run_status FROM board_state WHERE workspace = ?",
                                 (self.ws,)).fetchone()

    def test_stopping_team_stops_its_board_and_preserves_binding(self):
        self.assertTrue(self.stop()["boardStopped"])
        self.assertEqual(tuple(self.board()), (self.team, "stopped"))
        self.assertEqual(boardsettings.runner(self.conn, self.ws, True, None)["status"], "stopped")

    def test_other_teams_running_board_is_unchanged(self):
        with self.store.transaction() as tx:
            other = tx.create("team", {"name": "other", "workspace": self.ws})
            tx.transition("team", other, "running")
            tx.conn.execute("UPDATE board_state SET team_id = ? WHERE workspace = ?", (other, self.ws))
        self.assertFalse(self.stop()["boardStopped"])
        self.assertEqual(tuple(self.board()), (other, "running"))

    def test_already_stopped_board_reports_false(self):
        with self.store.transaction() as tx:
            tx.conn.execute("UPDATE board_state SET run_status = 'stopped' WHERE workspace = ?", (self.ws,))
        self.assertFalse(self.stop()["boardStopped"])
        self.assertFalse(self.stop()["boardStopped"])

    def test_already_stopped_team_repairs_running_board(self):
        with self.store.transaction() as tx:
            tx.transition("team", self.team, "stopping")
            tx.transition("team", self.team, "stopped")
        result = self.stop()
        self.assertTrue(result["alreadyStopped"])
        self.assertTrue(result["boardStopped"])
        self.assertEqual(tuple(self.board()), (self.team, "stopped"))

    def test_surviving_process_leaves_board_running(self):
        with mock.patch.object(teams, "_reap", return_value=[{"pid": 123}]):
            result = self.stop()
        self.assertEqual(result.error.code, teams.CLEANUP_INCOMPLETE)
        self.assertEqual(tuple(self.board()), (self.team, "running"))

    def test_ownership_mismatch_leaves_board_running(self):
        with mock.patch.object(teams, "verify_team", return_value={"state": "mismatch", "reason": "wrong owner"}):
            result = self.stop()
        self.assertEqual(result.error.code, teams.CLEANUP_INCOMPLETE)
        self.assertEqual(tuple(self.board()), (self.team, "running"))

    def test_no_board_reports_false(self):
        with self.store.transaction() as tx:
            tx.conn.execute("DELETE FROM board_state WHERE workspace = ?", (self.ws,))
        self.assertFalse(self.stop()["boardStopped"])


class TeamStopCli(unittest.TestCase):
    def test_prints_board_stopped_only_when_board_was_stopped(self):
        for stopped in (True, False):
            with self.subTest(stopped=stopped), mock.patch.object(cli.dispatch, "handle_request", return_value={
                    "ok": True, "data": {"boardStopped": stopped}}), \
                    mock.patch.object(cli, "_emit", return_value=0), contextlib.redirect_stderr(io.StringIO()) as err:
                cli.main(["team", "stop", "--team", "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa"])
                self.assertEqual(err.getvalue(), "Board stopped.\n" if stopped else "")
