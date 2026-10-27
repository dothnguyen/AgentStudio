"""P05-S11: board settings and live controls over the real coordinator — conflict statuses stay with TeamLead and
the runner state reported by `board.settings` follows board.run / board.stop."""
import json
import os
import subprocess
import unittest

from tests.helpers import Sandbox, key, make_repo, req
from tests.integration.test_p01_s04_start import git
from tests.unit.test_p05_s11_board_settings import BOARD, wf


class BoardControls(unittest.TestCase):
    def setUp(self):
        self.sb = Sandbox()
        rc, r, p = self.sb.run("coordinator", "start", "--enable-debug")
        self.assertTrue(r["ok"], p.stderr)
        self.ws = make_repo()
        os.makedirs(os.path.join(self.ws, ".agent-studio", "teams"))
        os.makedirs(os.path.join(self.ws, ".agent-studio", "workflows"))
        self.put("roles.json", {"version": 1, "roles": {"worker": {}, "TeamLead": {}}})
        self.put("workflows/work.json", wf("worker"))
        self.put("workflows/resolve.json", wf("TeamLead"))
        board = dict(BOARD)
        board["baseBranch"] = subprocess.run(["git", "-C", self.ws, "symbolic-ref", "--short", "HEAD"],
                                             stdout=subprocess.PIPE, text=True, check=True).stdout.strip()
        self.put("board.json", board)
        self.put("teams/alpha.json", {"id": "alpha", "name": "Alpha", "members": [
            {"id": "ryan", "name": "Ryan", "role": "worker", "provider": "fake"},
            {"id": "lead", "name": "Lead", "role": "TeamLead", "provider": "fake"}]})
        git(self.ws, "add", "-A")
        git(self.ws, "commit", "-qm", "team, workflows and board")
        self.addCleanup(self.sb.cleanup)

    def put(self, rel, obj):
        with open(os.path.join(self.ws, ".agent-studio", rel), "w") as f:
            json.dump(obj, f)

    def call(self, request):
        return self.sb.request(request)[1]

    def settings(self):
        r = self.call(req("board.settings", {"workspace": self.ws}))
        self.assertTrue(r["ok"], r)
        return r["data"]

    def test_conflict_statuses_route_to_teamlead(self):
        data = self.settings()
        self.assertTrue(all(p["satisfied"] for p in data["protectedRoutes"]))
        self.assertEqual(len(data["protectedRoutes"]), 2)
        roles = {r["status"]: r["role"] for r in data["rules"]}
        self.assertEqual((roles["merge-conflict"], roles["plan-merge-conflict"]), ("TeamLead", "TeamLead"))
        path = os.path.join(self.ws, ".agent-studio", "board.json")
        before = open(path, "rb").read()
        rules = [dict(r) for r in json.loads(before)["rules"]]
        rules[3].update(role="worker", workflow="work")
        r = self.call(req("board.settings.update", {"workspace": self.ws, "changes": {"rules": rules}}))
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"]["code"], "BOARD_CONFIG_INVALID")
        self.assertEqual(open(path, "rb").read(), before)

    def test_board_controls_report_truthful_runner_state(self):
        self.assertEqual(self.settings()["runner"]["status"], "not_bound")
        rc, r, p = self.sb.run("team", "start", "--workspace", self.ws, "--team", "alpha")
        self.assertTrue(r["ok"], (r, p.stderr))
        team_id = r["data"]["teamId"] if "teamId" in r["data"] else r["data"]["team"]["id"]
        args = {"workspace": self.ws, "teamId": team_id}
        run_key = key()
        first = self.call(req("board.run", args, idempotencyKey=run_key))
        self.assertTrue(first["ok"], first)
        self.assertEqual(first["data"]["board"]["status"], "running")
        runner = self.settings()["runner"]
        self.assertEqual((runner["status"], runner["teamId"], runner["coordinatorRunning"]),
                         ("running", team_id, True))
        replay = self.call(req("board.run", args, idempotencyKey=run_key))
        self.assertTrue(replay["ok"], replay)
        self.assertEqual(replay["data"], first["data"])
        stop = self.call(req("board.stop", {"workspace": self.ws}, idempotencyKey=key()))
        self.assertTrue(stop["ok"], stop)
        self.assertEqual(stop["data"]["board"]["status"], "stopped")
        self.assertEqual(self.settings()["runner"]["status"], "stopped")
        again = self.call(req("board.stop", {"workspace": self.ws}, idempotencyKey=key()))
        self.assertTrue(again["ok"], again)
        self.assertEqual(self.settings()["runner"]["status"], "stopped")
        rerun = self.call(req("board.run", args, idempotencyKey=key()))
        self.assertTrue(rerun["ok"], rerun)
        self.assertEqual(self.settings()["runner"]["status"], "running")


if __name__ == "__main__":
    unittest.main()
