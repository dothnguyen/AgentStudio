"""P04-S07: ticket add/move/show/list/depend and board show through the real coordinator, inbox and CLI."""
import json
import hashlib
import os
import sqlite3
import subprocess
import unittest

from tests.helpers import SHIM, Sandbox

CONFIG = {"version": 2, "statuses": [{"id": "todo", "kind": "initial"}, {"id": "doing"},
                                     {"id": "done", "kind": "done"}, {"id": "dropped", "kind": "closed"}],
          "ticketFields": [], "rules": []}


class BoardCommands(unittest.TestCase):
    def setUp(self):
        self.sb = Sandbox()
        rc, r, p = self.sb.run("coordinator", "start", "--enable-debug")
        self.assertTrue(r["ok"], p.stderr)
        self.ws = os.path.realpath(__import__("tempfile").mkdtemp(prefix="as-board-ws-"))
        os.makedirs(os.path.join(self.ws, ".agent-studio"))
        with open(os.path.join(self.ws, ".agent-studio", "board.json"), "w") as f:
            json.dump(CONFIG, f)

    def tearDown(self):
        self.sb.cleanup()

    def cli(self, *argv, timeout=60):
        p = subprocess.run([SHIM] + list(argv), env=self.sb.env, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, text=True, timeout=timeout)
        return p.returncode, p.stdout, p.stderr

    def ok(self, *argv):
        rc, out, err = self.cli(*argv, "--json")
        resp = json.loads(out.splitlines()[-1])
        self.assertEqual((rc, resp["ok"], err), (0, True, ""), (argv, out, err))
        return resp["data"]

    def test_tickets_and_board_show_end_to_end(self):
        first = self.ok("ticket", "add", "--workspace", self.ws, "--title", "First", "--priority", "10")
        self.assertEqual((first["ticket"]["key"], first["ticket"]["status"], first["phase"]["slug"]),
                         ("T-001", "todo", "default"))
        second = self.ok("ticket", "add", "--workspace", self.ws, "--title", "Second")
        self.assertEqual(second["ticket"]["key"], "T-002")

        moved = self.ok("ticket", "move", "--workspace", self.ws, "T-002", "--to", "doing")
        self.assertEqual((moved["from"], moved["ticket"]["status"]), ("todo", "doing"))
        blocked = self.ok("ticket", "move", "--workspace", self.ws, "T-001", "--to", "done")
        self.assertEqual(blocked["ticket"]["status"], "done")
        rc, out, err = self.cli("ticket", "move", "--workspace", self.ws, "T-001", "--to", "todo")
        self.assertEqual(rc, 1)
        self.assertTrue(err.startswith("TICKET_TRANSITION_INVALID:"), err)
        self.assertIn("--force", err)
        forced = self.ok("ticket", "move", "--workspace", self.ws, "T-001", "--to", "todo", "--force")
        self.assertEqual(forced["ticket"]["status"], "todo")

        self.ok("ticket", "depend", "--workspace", self.ws, "T-001", "--on", "T-002")
        detail = self.ok("ticket", "show", "--workspace", self.ws, "T-001")
        self.assertEqual(detail["dependsOn"], ["T-002"])
        self.assertEqual([e["name"] for e in detail["events"]],
                         ["ticket.created", "ticket.moved", "ticket.moved", "ticket.depends"])

        listed = self.ok("ticket", "list", "--workspace", self.ws, "--status", "todo")
        self.assertEqual([t["key"] for t in listed["tickets"]], ["T-001"])  # T-002 is in doing
        self.assertEqual([t["key"] for t in self.ok("ticket", "list", "--workspace", self.ws)["tickets"]],
                         ["T-001", "T-002"])  # T-001 first: priority 10

        board = self.ok("board", "show", "--workspace", self.ws)
        self.assertEqual([c["status"] for c in board["phases"][0]["columns"]],
                         ["todo", "doing", "done", "dropped"])
        self.assertEqual(board["currentPhase"]["slug"], "default")

        rc, out, err = self.cli("board", "show", "--workspace", self.ws)  # human form
        self.assertEqual(rc, 0, err)
        self.assertIn("current phase: Default", out)
        self.assertIn("default  Default  (current)", out)
        self.assertIn("todo (1) [initial]", out)
        self.assertIn("T-001", out)

        conn = sqlite3.connect(os.path.join(self.sb.state_dir, "state.db"))
        self.addCleanup(conn.close)
        phases = conn.execute("SELECT slug, name, position FROM phases").fetchall()
        self.assertEqual(phases, [("default", "Default", 0)])
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM board_state").fetchone()[0], 1)

    def test_operator_edits_body_and_records_event_without_moving_ticket(self):
        ticket = self.ok("ticket", "add", "--workspace", self.ws, "--title", "Planning", "--body", "Original")
        original_hash = hashlib.sha256(b"Original").hexdigest()
        updated = self.ok("ticket", "edit", "--workspace", self.ws, ticket["ticket"]["key"],
                          "--body", "Updated\nRequirements", "--expected-body-sha256", original_hash)
        self.assertEqual((updated["ticket"]["status"], updated["ticket"]["body"]), ("todo", "Updated\nRequirements"))
        rc, _, err = self.cli("ticket", "edit", "--workspace", self.ws, "T-001", "--body", "Lost update",
                              "--expected-body-sha256", original_hash)
        self.assertEqual(rc, 1)
        self.assertTrue(err.startswith("TICKET_CHANGED:"), err)
        self.ok("ticket", "edit", "--workspace", self.ws, "T-001", "--body", "More", "--mode", "append")
        detail = self.ok("ticket", "show", "--workspace", self.ws, "T-001")
        self.assertEqual(detail["ticket"]["body"], "Updated\nRequirements\n\nMore")
        self.assertEqual([e["actor"] for e in detail["events"] if e["name"] == "ticket.updated"],
                         ["operator", "operator"])

    def test_phases_end_to_end(self):
        added = self.ok("board", "phase", "add", "--workspace", self.ws, "--id", "build-out", "--name", "Build out")
        self.assertEqual(added["phase"]["position"], 1)
        self.ok("board", "phase", "add", "--workspace", self.ws, "--id", "hardening", "--name", "Hardening",
                "--before", "default")
        listed = self.ok("board", "phase", "list", "--workspace", self.ws)
        self.assertEqual([p["slug"] for p in listed["phases"]], ["hardening", "default", "build-out"])
        self.assertTrue(listed["phases"][1]["current"])

        ticket = self.ok("ticket", "add", "--workspace", self.ws, "--title", "In build-out", "--phase", "build-out")
        self.assertEqual(ticket["ticket"]["phase"], "build-out")
        moved = self.ok("ticket", "phase", "--workspace", self.ws, ticket["ticket"]["key"], "default")
        self.assertEqual((moved["from"], moved["ticket"]["phase"]), ("build-out", "default"))

        current = self.ok("board", "phase", "set-current", "--workspace", self.ws, "build-out")
        self.assertEqual(current["currentPhase"]["slug"], "build-out")
        board = self.ok("board", "show", "--workspace", self.ws)
        self.assertEqual({p["slug"]: p["current"] for p in board["phases"]},
                         {"hardening": False, "default": False, "build-out": True})
        cleared = self.ok("board", "phase", "clear-current", "--workspace", self.ws)
        self.assertEqual(cleared["currentPhase"]["slug"], "default")

        self.ok("board", "phase", "close", "--workspace", self.ws, "build-out")
        rc, out, err = self.cli("ticket", "add", "--workspace", self.ws, "--title", "x", "--phase", "build-out")
        self.assertEqual(rc, 1)
        self.assertTrue(err.startswith("PHASE_CLOSED:"), err)
        self.ok("board", "phase", "reopen", "--workspace", self.ws, "build-out")

        # a non-empty phase needs --move-to; its tickets land in the target phase
        keeper = self.ok("ticket", "add", "--workspace", self.ws, "--title", "stays", "--phase", "build-out")
        rc, out, err = self.cli("board", "phase", "remove", "--workspace", self.ws, "build-out")
        self.assertEqual(rc, 1)
        self.assertTrue(err.startswith("PHASE_NOT_EMPTY:"), err)
        removed = self.ok("board", "phase", "remove", "--workspace", self.ws, "build-out", "--move-to", "default")
        self.assertEqual((removed["removed"], removed["movedTickets"]), ("build-out", [keeper["ticket"]["key"]]))
        self.assertEqual(self.ok("ticket", "show", "--workspace", self.ws, keeper["ticket"]["key"])["ticket"]
                         ["phase"], "default")

        self.ok("board", "phase", "remove", "--workspace", self.ws, "hardening")  # empty: no --move-to needed
        rc, out, err = self.cli("board", "phase", "close", "--workspace", self.ws, "default")
        self.assertEqual(rc, 1)
        self.assertTrue(err.startswith("PHASE_PROTECTED:"), err)
        self.assertEqual([p["slug"] for p in self.ok("board", "phase", "list", "--workspace",
                                                     self.ws)["phases"]], ["default"])

    def test_bad_config_reaches_the_cli_as_config_invalid(self):
        with open(os.path.join(self.ws, ".agent-studio", "board.json"), "w") as f:
            json.dump({"version": 1, "columns": {}}, f)
        rc, out, err = self.cli("ticket", "add", "--workspace", self.ws, "--title", "x")
        self.assertEqual(rc, 1)
        self.assertTrue(err.startswith("BOARD_CONFIG_INVALID:"), err)


if __name__ == "__main__":
    unittest.main()
