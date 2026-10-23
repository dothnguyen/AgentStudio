import json
import os
import shutil
import subprocess
import tempfile
import unittest

from tests import helpers
from tests import board_fixture as bf
from agent_studio import board, queries, tickets
from tests.unit.test_p03_s01_tickets import fresh

GOLDEN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fixtures", "board", "board_show.json")


def repo():
    ws = helpers.make_repo()
    subprocess.run(["git", "-C", ws, "branch", "-M", "main"], check=True)
    return ws


class BoardQueryTests(unittest.TestCase):
    def setUp(self):
        self.conn, self.store = fresh()
        self.ws = repo()

    def tearDown(self):
        self.conn.close()
        shutil.rmtree(self.ws, ignore_errors=True)

    def create(self, texts, workspace=None):
        with self.store.transaction() as tx:
            for text in texts:
                tickets.create(tx, workspace or self.ws, "bug", {"title": text, "raw_text": text})

    def test_board_show_matches_golden_and_writes_nothing(self):
        self.create(bf.ticket_texts())
        with self.store.transaction() as tx:
            ids = bf.apply(tx.conn, self.ws)
        before = self.conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
        data = queries.board_show(self.conn, self.ws)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM events").fetchone()[0], before)
        with open(GOLDEN, encoding="utf-8") as f:
            self.assertEqual(bf.normalise(data, self.ws, ids), json.load(f))

    def test_empty_workspace_has_every_column_and_stopped_board(self):
        data = queries.board_show(self.conn, self.ws)
        self.assertEqual(data["board"], {"status": "stopped", "reason": None})
        self.assertEqual(len(data["columns"]), 21)
        self.assertEqual(data["agents"], [])
        self.assertEqual(data["held"], [])

    def test_dirty_checkout_holds_refine_and_merge(self):
        self.create(["a", "b"])
        with self.store.transaction() as tx:
            tx.conn.execute("UPDATE tickets SET status = 'refine' WHERE key = 'T-001'")
            tx.conn.execute("UPDATE tickets SET status = 'ready_merge' WHERE key = 'T-002'")
        with open(os.path.join(self.ws, "dirty.txt"), "w") as f:
            f.write("x")
        held = queries.board_show(self.conn, self.ws)["held"]
        self.assertEqual(held, [{"column": "refine", "reason": "MAIN_CHECKOUT_DIRTY"},
                                {"column": "merge", "reason": "MAIN_CHECKOUT_DIRTY"}])

    def test_invalid_board_json_gives_no_holds(self):
        self.create(["a"])
        with self.store.transaction() as tx:
            tx.conn.execute("UPDATE tickets SET status = 'refine'")
        with open(os.path.join(self.ws, ".agent-studio", "board.json"), "w") as f:
            f.write("{not json")
        self.assertEqual(queries.board_show(self.conn, self.ws)["held"], [])

    def test_merge_hold_reasons(self):
        from types import SimpleNamespace
        tx = SimpleNamespace(conn=self.conn)
        self.assertIsNone(board.merge_hold(tx, self.ws, {"baseBranch": "main"}))
        self.assertEqual(board.merge_hold(tx, self.ws, {"baseBranch": "other"}), "MAIN_CHECKOUT_WRONG_BRANCH")

    def test_board_list_orders_by_path_and_marks_missing_workspace_unavailable(self):
        gone = tempfile.mkdtemp(prefix="as-gone-")
        shutil.rmtree(gone)
        self.create(["a"], gone)
        self.create(["b"])
        with self.store.transaction() as tx:
            tx.conn.execute("INSERT INTO board_state (workspace, status, reason, config_json, updated_at) VALUES (?, 'paused', 'op', NULL, 'n')",
                            (self.ws,))
        before = self.conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
        boards = queries.board_list(self.conn)["boards"]
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM events").fetchone()[0], before)
        self.assertEqual([b["workspace"] for b in boards], sorted([gone, self.ws]))
        by_ws = {b["workspace"]: b for b in boards}
        self.assertEqual((by_ws[self.ws]["status"], by_ws[self.ws]["reason"]), ("paused", "op"))
        self.assertEqual(by_ws[self.ws]["counts"], {"triage": 1})
        self.assertEqual((by_ws[gone]["status"], by_ws[gone]["held"]), ("unavailable", []))

    def test_board_list_counts_agents_and_limits(self):
        self.create(bf.ticket_texts())
        with self.store.transaction() as tx:
            bf.apply(tx.conn, self.ws)
        (entry,) = queries.board_list(self.conn)["boards"]
        self.assertEqual(entry["agents"], {"total": 3, "idle": 1, "busy": 1, "limitReached": 1})
        self.assertEqual(entry["limits"], [{"agent": "qa-1", "role": "QA", "resetAt": bf.LIMIT_RESET_AT}])
        self.assertEqual(entry["counts"]["merged"], 12)
        self.assertEqual(list(entry["counts"])[:2], ["backlog", "ready_unpack"])
        self.assertEqual(entry["team"], {"teamId": bf.TEAM_ID, "status": "running"})
