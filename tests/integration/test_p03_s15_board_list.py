"""P03-S15 board.list: several workspaces, a deleted one, CLI/serve parity, no writes."""
import json
import os
import shutil
import sqlite3
import unittest

from tests.helpers import Sandbox, key, make_repo, req
from tests.integration.test_p03_s15_board_show import serve_once

TEAM = "33333333-0000-4000-8000-000000000001"


class BoardListIntegration(unittest.TestCase):
    def setUp(self):
        self.sb = Sandbox()
        rc, response, proc = self.sb.run("coordinator", "start")
        self.assertTrue(response["ok"], proc.stderr)
        self.running, self.paused, self.gone = (os.path.realpath(make_repo()) for _ in range(3))

    def tearDown(self):
        self.sb.cleanup()
        for path in (self.running, self.paused, self.gone):
            shutil.rmtree(path, ignore_errors=True)

    def create(self, workspace, text):
        _, response, _ = self.sb.request(req("ticket.create", {"workspace": workspace, "kind": "bug", "text": text},
                                             idempotencyKey=key()))
        self.assertTrue(response["ok"], response)

    def test_three_boards_in_path_order_without_writes(self):
        for workspace in (self.running, self.paused, self.gone):
            self.create(workspace, "a bug")
        self.create(self.running, "another bug")
        conn = sqlite3.connect(self.sb.state_dir + "/state.db")
        try:
            conn.execute("INSERT INTO board_state (workspace, status, reason, config_json, updated_at) VALUES (?, 'running', NULL, NULL, 'n')",
                         (self.running,))
            conn.execute("INSERT INTO board_state (workspace, status, reason, config_json, updated_at) VALUES (?, 'paused', 'op', NULL, 'n')",
                         (self.paused,))
            conn.execute("INSERT INTO teams (id, name, workspace, status, created_at, updated_at) VALUES (?, 't', ?, 'running', 'n', 'n')",
                         (TEAM, self.paused))
            conn.execute("INSERT INTO agents (id, team_id, ordinal, provider_id, role, display_name, availability, pane_state, "
                         "created_at, updated_at, limit_reset_at) VALUES (?, ?, 0, 'fake', 'QA', 'qa-1', 'limit_reached', 'unknown', "
                         "'n', 'n', '2026-05-01T14:05:00Z')", ("44444444-0000-4000-8000-000000000001", TEAM))
            conn.commit()
            events = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
        finally:
            conn.close()
        shutil.rmtree(self.gone)

        _, response, _ = self.sb.run("board", "list")
        self.assertTrue(response["ok"], response)
        boards = response["data"]["boards"]
        self.assertEqual([b["workspace"] for b in boards], sorted([self.running, self.paused, self.gone]))
        by_ws = {b["workspace"]: b for b in boards}
        run, pause, gone = by_ws[self.running], by_ws[self.paused], by_ws[self.gone]
        self.assertEqual((run["status"], run["counts"], run["team"]), ("running", {"triage": 2}, None))
        self.assertEqual((pause["status"], pause["reason"]), ("paused", "op"))
        self.assertEqual(pause["agents"], {"total": 1, "idle": 0, "busy": 0, "limitReached": 1})
        self.assertEqual(pause["limits"], [{"agent": "qa-1", "role": "QA", "resetAt": "2026-05-01T14:05:00Z"}])
        self.assertEqual((gone["status"], gone["reason"], gone["held"]), ("unavailable", None, []))

        served = serve_once(self.sb, req("board.list", {}, id="list"))
        self.assertEqual(json.dumps(response["data"], separators=(",", ":")), json.dumps(served["data"], separators=(",", ":")))
        conn = sqlite3.connect(self.sb.state_dir + "/state.db")
        try:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM events").fetchone()[0], events)
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()
