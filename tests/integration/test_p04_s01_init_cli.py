import json
import os
import shutil
import tempfile
import unittest

from tests.helpers import Sandbox


class InitCliTests(unittest.TestCase):
    def setUp(self):
        self.sb = Sandbox()
        self.addCleanup(self.sb.cleanup)
        self.cwd = os.path.realpath(tempfile.mkdtemp(prefix="as-init-"))
        self.addCleanup(shutil.rmtree, self.cwd, True)

    def test_init_then_list_json_and_request_still_json(self):
        import subprocess
        from tests.helpers import SHIM
        proc = subprocess.run([SHIM, "init", "--json"], cwd=self.cwd, env=self.sb.env,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue(json.loads(proc.stdout)["ok"])
        self.assertTrue(os.path.isfile(os.path.join(self.cwd, ".agent-studio", "workspace.json")))
        rc, resp, _ = self.sb.run("workspace", "list", "--json")
        self.assertEqual(rc, 0)
        self.assertEqual([w["path"] for w in resp["data"]["workspaces"]], [self.cwd])
        rc, resp, _ = self.sb.request({"protocol": "agent-studio/v1", "id": "1", "command": "health"})
        self.assertEqual(rc, 0)
        self.assertTrue(resp["ok"])

    def test_init_from_the_real_shim_scaffolds_a_loadable_workspace_and_resumes(self):
        import subprocess
        from agent_studio import boardmodel
        from tests.helpers import SHIM

        def init():
            proc = subprocess.run([SHIM, "init", "--json"], cwd=self.cwd, env=self.sb.env,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            return json.loads(proc.stdout)["data"]

        first = init()
        cfg = os.path.join(self.cwd, ".agent-studio")
        files = ("workspace.json", "board.json", "roles.json", "agents.json", "workflow.json",
                 "commands.json", "permissions.json")
        for name in files:
            with open(os.path.join(cfg, name), encoding="utf-8") as f:
                self.assertIsInstance(json.load(f), dict, name)
        self.assertEqual(boardmodel.load_config(self.cwd)["version"], boardmodel.CONFIG_VERSION)
        with open(os.path.join(cfg, "board.json"), "w", encoding="utf-8") as f:
            json.dump({"version": 4, "baseBranch": "main", "leaseSeconds": 600, "ticketFields": [],
                       "workflowStatuses": [{"id": "none", "kind": "initial"},
                                            {"id": "done", "kind": "done"}],
                       "todoEntry": [], "todoDefault": None}, f)
        with open(os.path.join(cfg, "board.json"), "rb") as f:
            before = f.read()
        os.unlink(os.path.join(cfg, "roles.json"))

        second = init()

        self.assertTrue(second["existed"])
        self.assertEqual(second["id"], first["id"])
        with open(os.path.join(cfg, "board.json"), "rb") as f:
            self.assertEqual(f.read(), before)
        self.assertTrue(os.path.isfile(os.path.join(cfg, "roles.json")))
        self.assertTrue(os.path.isdir(os.path.join(cfg, "workflows", "prompts")))

    def test_workspace_init_persists_default_phase_for_board_apis_and_repairs_missing_rows(self):
        from agent_studio import state

        def request(command, args):
            rc, response, proc = self.sb.request({"protocol": "agent-studio/v1", "id": command,
                                                   "command": command, "args": args})
            self.assertEqual(rc, 0, proc.stderr.decode())
            self.assertTrue(response["ok"], response)
            return response["data"]

        created = request("workspace.init", {"path": self.cwd})
        self.assertFalse(created["existed"])
        listing = request("phase.list", {"workspace": self.cwd})
        self.assertEqual([(p["slug"], p["id"]) for p in listing["phases"]],
                         [("default", listing["currentPhase"]["id"])])
        self.assertIsNotNone(listing["currentPhase"]["id"])
        self.assertEqual(request("ticket.list", {"workspace": self.cwd, "phase": "default"})["tickets"], [])
        self.assertEqual(request("phase.show", {"workspace": self.cwd, "phase": "default"})["phase"]["id"],
                         listing["currentPhase"]["id"])
        summary = request("board.summary", {"workspace": self.cwd})
        self.assertEqual(summary["workspace"], self.cwd)

        # Simulate the T-237 regression on an already configured workspace.
        db_path = os.path.join(self.sb.state_dir, "state.db")
        conn = state.connect(db_path, role="coordinator")
        try:
            conn.execute("DELETE FROM phases WHERE workspace = ?", (self.cwd,))
            conn.execute("DELETE FROM board_state WHERE workspace = ?", (self.cwd,))
        finally:
            conn.close()
        repaired = request("phase.list", {"workspace": self.cwd})
        self.assertEqual(repaired["phases"][0]["slug"], "default")
        request("workspace.init", {"path": self.cwd})
        again = request("phase.list", {"workspace": self.cwd})
        self.assertEqual([p["id"] for p in again["phases"]], [repaired["phases"][0]["id"]])

    def test_multiple_board_apis_agree_on_new_workspace_default_phase(self):
        """Test that all board read APIs agree on the default phase after workspace init."""
        def request(command, args):
            rc, response, proc = self.sb.request({"protocol": "agent-studio/v1", "id": command,
                                                   "command": command, "args": args})
            self.assertEqual(rc, 0, proc.stderr.decode())
            self.assertTrue(response["ok"], response)
            return response["data"]

        request("workspace.init", {"path": self.cwd})

        # Collect default phase ID from phase.list
        listing = request("phase.list", {"workspace": self.cwd})
        default_phase_id = listing["currentPhase"]["id"]
        self.assertIsNotNone(default_phase_id)

        # All read APIs should report the same default phase ID
        phase_detail = request("phase.show", {"workspace": self.cwd, "phase": "default"})
        self.assertEqual(phase_detail["phase"]["id"], default_phase_id,
                        "phase.show must return same default phase as phase.list")

        board_detail = request("board.show", {"workspace": self.cwd})
        # board.show includes phase information, verify it has the default phase
        default_phases = [p for p in board_detail["phases"] if p["slug"] == "default"]
        self.assertEqual(len(default_phases), 1)
        self.assertEqual(default_phases[0]["id"], default_phase_id,
                        "board.show must return same default phase as phase.list")

        summary = request("board.summary", {"workspace": self.cwd})
        # board.summary should reference the default phase (via slug)
        self.assertEqual(summary["currentPhase"]["slug"], "default",
                        "board.summary must reference the default phase")

        # Verify ticket.list works with the default phase
        tickets = request("ticket.list", {"workspace": self.cwd, "phase": "default"})
        self.assertEqual(tickets["tickets"], [])  # Empty phase
        self.assertEqual(tickets["phase"], "default",
                        "ticket.list must reference the default phase by slug")


if __name__ == "__main__":
    unittest.main()
