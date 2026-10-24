"""P04-S06/S07: the team commands run end to end on the current-schema database; the generic board tables
sit empty until a board command uses them, and the P03 board commands stay gone."""
import json
import os
import sqlite3
import subprocess
import unittest

from tests.helpers import SHIM, Sandbox, make_repo
from tests.integration.test_p01_s04_start import git

PAIR = {"version": 1, "description": "pair", "stages": [
    {"id": "build", "role": "developer", "permission": "workspace_write", "maxVisits": 2, "prompt": "Do.\n{{task}}",
     "next": {"done": "look"}},
    {"id": "look", "role": "reviewer", "permission": "read_only", "maxVisits": 2, "prompt": "Look.\n{{task}}",
     "next": {"pass": "$succeed", "fail": "build"}}]}
ROLES = {"version": 1, "roles": {"developer": {}, "reviewer": {}}}
P03_ONLY = ("board_locks",)
BOARD_TABLES = ("tickets", "ticket_deps", "ticket_events", "board_state", "phases")


def member(mid, name, role):
    return {"id": mid, "name": name, "role": role, "provider": "fake"}


class CleanSlate(unittest.TestCase):
    def setUp(self):
        self.sb = Sandbox()
        rc, r, p = self.sb.run("coordinator", "start", "--enable-debug")
        self.assertTrue(r["ok"], p.stderr)
        self.ws = make_repo()
        cfg = os.path.join(self.ws, ".agent-studio")
        os.makedirs(os.path.join(cfg, "teams"))
        os.makedirs(os.path.join(cfg, "workflows"))
        self.put("roles.json", ROLES)
        self.put("workflows/pair.json", PAIR)
        self.put("teams/alpha.json", {"id": "alpha", "name": "Alpha", "members": [
            member("ryan", "Ryan", "developer"), member("sam", "Sam", "reviewer")]})
        git(self.ws, "add", "-A")
        git(self.ws, "commit", "-qm", "team and workflow")

    def tearDown(self):
        self.sb.cleanup()

    def put(self, rel, obj):
        with open(os.path.join(self.ws, ".agent-studio", rel), "w") as f:
            json.dump(obj, f)

    def human(self, *args, timeout=120):
        p = subprocess.run([SHIM, "team"] + list(args) + ["--workspace", self.ws], env=self.sb.env,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=timeout)
        return p.returncode, p.stdout, p.stderr

    def start(self):
        rc, r, p = self.sb.run("team", "start", "--workspace", self.ws, "--team", "alpha")
        self.assertTrue(r["ok"], (r, p.stderr))
        return r["data"]

    def state_db(self):
        conn = sqlite3.connect(os.path.join(self.sb.state_dir, "state.db"))
        conn.row_factory = sqlite3.Row
        self.addCleanup(conn.close)
        return conn

    def test_start_status_ask_run_workflow_and_stop_on_the_current_schema(self):
        from agent_studio import state
        conn = self.state_db()
        self.assertEqual(conn.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0],
                         state.SCHEMA_VERSION)
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        self.assertFalse(set(P03_ONLY) & tables, tables)
        self.assertTrue(set(BOARD_TABLES) <= tables, tables)  # generic board tables, empty until first use
        for table in BOARD_TABLES:
            self.assertEqual(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0], 0, table)

        self.start()
        rc, out, err = self.human("status", "--team", "alpha")
        self.assertEqual(rc, 0, err)
        self.assertIn("running", out)
        self.assertIn("Ryan", out)

        rc, out, err = self.human("ask", "--team", "alpha", "--member", "ryan", "--wait", "say hello")
        self.assertEqual(rc, 0, err)
        self.assertTrue(out.startswith("Ryan [fake/developer]: "), out)

        rc, out, err = self.human("run-workflow", "--team", "alpha", "pair", "--wait", "do the thing")
        self.assertEqual(rc, 0, err)
        self.assertIn("developer -> Ryan", out)
        self.assertIn("route: build", out)

        rc, out, err = self.human("stop", "--team", "alpha")
        self.assertEqual(rc, 0, err)
        conn = self.state_db()
        for table in BOARD_TABLES:  # team work alone never touches the board
            self.assertEqual(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0], 0, table)

    def test_p03_board_commands_are_gone_but_the_generic_board_is_routed(self):
        for argv in (["board", "run", "--workspace", self.ws], ["board", "pause", "--workspace", self.ws],
                     ["board", "list"], ["ticket", "start", "--workspace", self.ws, "T-001"],
                     ["ticket", "retry", "--workspace", self.ws, "T-001"]):
            rc, r, p = self.sb.run(*argv)
            self.assertEqual(rc, 1, argv)
            self.assertIn(r["error"]["code"], ("BAD_REQUEST", "UNKNOWN_COMMAND"), (argv, r))
        for command, args in (("board.run", {"workspace": self.ws}), ("board.pause", {"workspace": self.ws}),
                               ("debug.ticket_worktree", {"workspace": self.ws, "key": "T-001"})):
            rc, r, p = self.sb.request({"protocol": "agent-studio/v1", "command": command, "args": args})
            self.assertFalse(r["ok"], command)
            self.assertEqual(r["error"]["code"], "UNKNOWN_COMMAND", (command, r))
        # the generic board is routed; this workspace has no board.json yet, so it answers BOARD_CONFIG_INVALID
        rc, r, p = self.sb.run("board", "show", "--workspace", self.ws, "--json")
        self.assertEqual(r["error"]["code"], "BOARD_CONFIG_INVALID", r)
        rc, r, p = self.sb.run("board", "resume", "--workspace", self.ws, "--all")
        self.assertEqual(r["error"]["code"], "TEAM_NOT_RUNNING", r)  # routed and validated; no team runs here


if __name__ == "__main__":
    unittest.main()

