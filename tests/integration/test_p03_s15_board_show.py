"""P03-S15 board.show: golden board, CLI/serve parity, no writes, live holds."""
import json
import os
import shutil
import sqlite3
import subprocess
import unittest

from tests import board_fixture as bf
from tests.helpers import Sandbox, key, make_repo, req

GOLDEN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fixtures", "board", "board_show.json")


def serve_once(sandbox, request):
    process = sandbox.popen_serve()
    try:
        process.stdin.write(json.dumps(request).encode() + b"\n")
        process.stdin.flush()
        return json.loads(process.stdout.readline())
    finally:
        process.stdin.close()
        process.wait(10)
        process.stdout.close()
        process.stderr.close()


class BoardShowIntegration(unittest.TestCase):
    def setUp(self):
        self.sb = Sandbox()
        rc, response, proc = self.sb.run("coordinator", "start")
        self.assertTrue(response["ok"], proc.stderr)
        self.workspace = os.path.realpath(make_repo())
        subprocess.run(["git", "-C", self.workspace, "branch", "-M", "main"], check=True)

    def tearDown(self):
        self.sb.cleanup()
        shutil.rmtree(self.workspace, ignore_errors=True)

    def create(self, texts):
        for text in texts:
            _, response, _ = self.sb.request(req("ticket.create", {"workspace": self.workspace, "kind": "bug", "text": text},
                                                 idempotencyKey=key()))
            self.assertTrue(response["ok"], response)

    def sql(self, fn):
        conn = sqlite3.connect(self.sb.state_dir + "/state.db")
        try:
            result = fn(conn)
            conn.commit()
            return result
        finally:
            conn.close()

    def show(self):
        _, response, _ = self.sb.run("board", "show", "--workspace", self.workspace)
        self.assertTrue(response["ok"], response)
        return response["data"]

    def test_fixture_board_matches_golden_and_cli_equals_serve(self):
        self.create(bf.ticket_texts())
        ids = self.sql(lambda conn: bf.apply(conn, self.workspace))
        events = self.sql(lambda conn: conn.execute("SELECT COUNT(*) FROM events").fetchone()[0])
        data = self.show()
        # The live scheduler may be running a mutating task here, which makes the merge hold MAIN_CHECKOUT_BUSY;
        # the unit golden test has no such task, so compare the other holds only.
        shown = bf.normalise(data, self.workspace, ids)
        shown["held"] = [h for h in shown["held"] if h["column"] != "merge"]
        with open(GOLDEN, encoding="utf-8") as f:
            self.assertEqual(shown, json.load(f))
        served = serve_once(self.sb, req("board.show", {"workspace": self.workspace}, id="show"))
        self.assertEqual(json.dumps(data, separators=(",", ":")), json.dumps(served["data"], separators=(",", ":")))
        self.assertEqual(self.sql(lambda conn: conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]), events)

    def test_dirty_checkout_holds_refine_and_merge_and_bad_board_json_gives_no_holds(self):
        self.create(["waiting refine", "waiting merge"])
        self.sql(lambda conn: (conn.execute("UPDATE tickets SET status = 'refine' WHERE key = 'T-001'"),
                               conn.execute("UPDATE tickets SET status = 'ready_merge' WHERE key = 'T-002'")))
        # Dirty only after the tickets exist: ticket commands do not need a clean tree, the board does.
        with open(os.path.join(self.workspace, "dirty.txt"), "w") as f:
            f.write("x")
        self.assertEqual(self.show()["held"], [{"column": "refine", "reason": "MAIN_CHECKOUT_DIRTY"},
                                              {"column": "merge", "reason": "MAIN_CHECKOUT_DIRTY"}])
        with open(os.path.join(self.workspace, ".agent-studio", "board.json"), "w") as f:
            f.write("{not json")
        self.assertEqual(self.show()["held"], [])


if __name__ == "__main__":
    unittest.main()
