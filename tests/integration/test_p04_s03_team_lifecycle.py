"""P04-S03: team start / stop / status by definition id, through the real coordinator, tmux and the fake provider."""
import json
import os
import tempfile
import unittest

from tests.helpers import Sandbox, key, req, wait_until

ROLES = {"version": 1, "roles": {"developer": {}, "reviewer": {}}}


def member(mid, name, role="developer"):
    return {"id": mid, "name": name, "role": role, "provider": "fake"}


class LifecycleCase(unittest.TestCase):
    def setUp(self):
        self.sb = Sandbox()
        rc, r, p = self.sb.run("coordinator", "start", "--enable-debug")
        self.assertTrue(r["ok"], p.stderr)
        self.ws = os.path.realpath(tempfile.mkdtemp(prefix="as-ws-"))
        os.makedirs(os.path.join(self.ws, ".agent-studio", "teams"))
        self.write("roles.json", ROLES)
        self.put("alpha", [member("ryan", "Ryan"), member("sam", "Sam", "reviewer")])
        self.put("beta", [member("kim", "Kim")])

    def tearDown(self):
        self.sb.cleanup()

    def write(self, name, obj):
        with open(os.path.join(self.ws, ".agent-studio", name), "w") as f:
            json.dump(obj, f)

    def put(self, tid, members):
        self.write(f"teams/{tid}.json", {"id": tid, "name": tid.title(), "members": members})

    def start(self, tid):
        return self.sb.run("team", "start", "--workspace", self.ws, "--team", tid)[1]

    def stop(self, ref):
        return self.sb.run("team", "stop", "--workspace", self.ws, "--team", ref)[1]

    def status(self, tid):
        rc, r, p = self.sb.run("team", "status", "--workspace", self.ws, "--team", tid, "--json")
        self.assertTrue(r["ok"], (r, p.stderr))
        return r["data"]

    def titles(self, team):
        sid = self.sb.snapshot(team["teamId"])["teams"][0]["tmuxSessionId"]
        return self.sb.tmux("list-panes", "-t", sid, "-F", "#{pane_title}").split("\n")


class Lifecycle(LifecycleCase):
    def test_two_definitions_run_and_stop_independently(self):
        a, b = self.start("alpha"), self.start("beta")
        self.assertTrue(a["ok"] and b["ok"], (a, b))
        again = self.start("alpha")
        self.assertFalse(again["ok"])
        self.assertEqual(again["error"]["code"], "TEAM_ALREADY_RUNNING")
        self.assertEqual(again["data"], {"teamId": a["data"]["teamId"], "teamDefId": "alpha"})
        self.assertEqual(len(self.sb.snapshot()["teams"]), 2)
        sess_a = self.sb.snapshot(a["data"]["teamId"])["teams"][0]["tmuxSessionId"]
        sess_b = self.sb.snapshot(b["data"]["teamId"])["teams"][0]["tmuxSessionId"]
        stopped = self.stop("alpha")
        self.assertTrue(stopped["ok"], stopped)
        live = self.sb.tmux("list-sessions", "-F", "#{session_id}").split()
        self.assertNotIn(sess_a, live)
        self.assertIn(sess_b, live)
        self.assertEqual(stopped["data"]["teamId"], a["data"]["teamId"])
        snap = self.sb.snapshot()
        teams = {t["id"]: t for t in snap["teams"]}
        self.assertEqual(teams[a["data"]["teamId"]]["status"], "stopped")
        self.assertEqual(teams[b["data"]["teamId"]]["status"], "running")
        agents = {g["id"]: g for g in snap["agents"]}
        self.assertTrue(all(agents[x["agentId"]]["availability"] == "offline" for x in a["data"]["agents"]))
        self.assertTrue(all(agents[x["agentId"]]["availability"] == "idle" for x in b["data"]["agents"]))
        self.assertTrue(any("Kim" in t for t in self.titles(b["data"])))
        self.assertEqual(self.stop("alpha")["error"]["code"], "TEAM_NOT_RUNNING")
        self.assertTrue(self.start("alpha")["ok"])

    def test_names_ids_and_uuid_addressing_still_work(self):
        a = self.start("alpha")["data"]
        titles = self.titles(a)
        self.assertTrue(any("Ryan [fake/developer]" in t for t in titles), titles)
        agents = {g["id"]: g for g in self.sb.snapshot(a["teamId"])["agents"]}
        ryan = next(x for x in a["agents"] if x["memberId"] == "ryan")
        self.assertEqual((agents[ryan["agentId"]]["displayName"], agents[ryan["agentId"]]["memberId"]),
                         ("Ryan", "ryan"))
        args = {"teamId": a["teamId"], "agentId": ryan["agentId"], "policy": "read_only", "text": "go",
                "debugProviderOptions": {"scenario": "success", "durationMs": 4000, "progressLines": 1}}
        rc, r, _ = self.sb.request(req("task.direct", args, idempotencyKey=key()))
        self.assertTrue(r["ok"], r)
        st = wait_until(lambda: next(m for m in self.status("alpha")["members"] if m["memberId"] == "ryan")
                        ["assignment"], message="assignment shown in status")
        self.assertEqual(st["id"], r["data"]["assignmentId"])
        data = self.status("alpha")
        self.assertEqual((data["team"]["teamDefId"], data["team"]["status"]), ("alpha", "running"))
        self.assertEqual([m["name"] for m in data["members"]], ["Ryan", "Sam"])
        self.assertIsNone(self.status("beta")["team"])
        self.assertTrue(self.stop(a["teamId"])["ok"])

    def test_editing_definition_does_not_change_running_team(self):
        a = self.start("alpha")["data"]
        self.put("alpha", [member("ryan", "Ryan Renamed"), member("sam", "Sam", "reviewer"), member("zed", "Zed")])
        data = self.status("alpha")
        self.assertEqual([m["name"] for m in data["members"]], ["Ryan", "Sam"])
        self.assertEqual(len(self.sb.snapshot(a["teamId"])["agents"]), 2)
        self.assertTrue(self.stop("alpha")["ok"])
        b = self.start("alpha")["data"]
        self.assertEqual([x["displayName"] for x in b["agents"]], ["Ryan Renamed", "Sam", "Zed"])
        self.assertEqual([m["name"] for m in self.status("alpha")["members"]], ["Ryan Renamed", "Sam", "Zed"])


if __name__ == "__main__":
    unittest.main()
