"""P04-S04: team ask / run-workflow / blocked / resolve / retry through the real coordinator and the fake provider."""
import json
import os
import subprocess
import unittest

from tests.helpers import SHIM, Sandbox, key, make_repo, req, wait_until
from tests.integration.test_p01_s04_start import fake, git

PAIR = {"version": 1, "description": "pair", "stages": [
    {"id": "build", "role": "developer", "permission": "workspace_write", "maxVisits": 2, "prompt": "Do.\n{{task}}",
     "next": {"done": "look"}},
    {"id": "look", "role": "reviewer", "permission": "read_only", "maxVisits": 2, "prompt": "Look.\n{{task}}",
     "next": {"pass": "$succeed", "fail": "build"}}]}
ROLES = {"version": 1, "roles": {"developer": {}, "reviewer": {}}}


def member(mid, name, role):
    return {"id": mid, "name": name, "role": role, "provider": "fake"}


class UseCase(unittest.TestCase):
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
        self.put("teams/trio.json", {"id": "trio", "name": "Trio", "members": [
            member("ryan", "Ryan", "developer"), member("sam", "Sam", "reviewer"), member("sue", "Sue", "reviewer")]})
        git(self.ws, "add", "-A")
        git(self.ws, "commit", "-qm", "team and workflow")

    def tearDown(self):
        self.sb.cleanup()

    def put(self, rel, obj):
        with open(os.path.join(self.ws, ".agent-studio", rel), "w") as f:
            json.dump(obj, f)

    def human(self, *args, stdin=None, timeout=90):
        p = subprocess.run([SHIM, "team"] + list(args) + ["--workspace", self.ws], input=stdin, env=self.sb.env,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=timeout)
        return p.returncode, p.stdout, p.stderr

    def start(self, tid="alpha"):
        rc, r, p = self.sb.run("team", "start", "--workspace", self.ws, "--team", tid)
        self.assertTrue(r["ok"], (r, p.stderr))
        return r["data"]

    def agent(self, team, member_id):
        return next(a["agentId"] for a in team["agents"] if a["memberId"] == member_id)

    def start_workflow(self, team, **extra):
        args = dict({"teamId": team["teamId"], "definition": "pair", "text": "go"}, **extra)
        rc, r, _ = self.sb.request(req("workflow.start", args, idempotencyKey=key("wf")))
        self.assertTrue(r["ok"], r)
        return r["data"]["workflowRunId"]


class Ask(UseCase):
    def test_ask_wait_free_member_prints_name_and_result(self):
        self.start()
        rc, out, err = self.human("ask", "--team", "alpha", "--member", "ryan", "--wait", "say hello")
        self.assertEqual(rc, 0, err)
        self.assertTrue(out.startswith("Ryan [fake/developer]: "), out)
        self.assertGreater(len(out.splitlines()), 1, out)

    def test_ask_busy_member_is_agent_busy(self):
        team = self.start()
        rc, r, p = self.sb.run("debug", "assign", "--agent", self.agent(team, "ryan"), "--scenario", "slow",
                               "--duration-ms", "20000")
        self.assertTrue(r["ok"], (r, p.stderr))
        rc, out, err = self.human("ask", "--team", "alpha", "--member", "Ryan", "again")
        self.assertEqual(rc, 1)
        self.assertTrue(err.startswith("AGENT_BUSY:"), err)

    def test_stopped_team_is_not_running(self):
        rc, out, err = self.human("ask", "--team", "alpha", "--member", "ryan", "hi")
        self.assertEqual(rc, 1)
        self.assertTrue(err.startswith("TEAM_NOT_RUNNING:"), err)


class RunWorkflow(UseCase):
    def test_wait_run_shows_members_route_and_status(self):
        self.start()
        rc, out, err = self.human("run-workflow", "--team", "alpha", "pair", "--wait", "do the thing", timeout=120)
        self.assertEqual(rc, 0, err)
        self.assertIn("developer -> Ryan", out)
        self.assertIn("reviewer -> Sam", out)
        self.assertIn("route: build", out)
        self.assertIn("status: ", out)

    def test_bind_by_name_and_ambiguous_role(self):
        self.start("trio")
        rc, out, err = self.human("run-workflow", "--team", "trio", "pair", "go")
        self.assertEqual(rc, 1)
        self.assertTrue(err.startswith("ROLE_AMBIGUOUS:"), err)
        self.assertIn("reviewer", err)
        self.assertFalse(self.sb.snapshot().get("workflowRuns"))
        rc, out, err = self.human("check", "--team", "trio", "pair", "--bind", "reviewer=sue")
        self.assertEqual(rc, 0, err)
        self.assertIn("reviewer -> Sue", out)
        self.assertIn("pair: OK", out)
        rc, out, err = self.human("workflows", "--team", "trio")
        self.assertIn("developer-reviewer  built-in", out)
        self.assertIn("pair  project", out)


class Blocked(UseCase):
    def stuck(self):
        team = self.start()
        wf = self.start_workflow(team, debugStageOptions={"build": fake("waiting_input"),
                                                          "look": fake("verdict_pass")})
        wait_until(lambda: "Ryan" in self.human("blocked", "--team", "alpha")[1], timeout=40, message="blocked")
        return team, wf

    def test_blocked_then_resolve_cancel_clears_it(self):
        self.stuck()
        rc, out, err = self.human("blocked", "--team", "alpha")
        self.assertIn("Ryan [developer] assignment", out)
        self.assertIn("team resolve --member Ryan", out)
        rc, out, err = self.human("resolve", "--team", "alpha", "--member", "ryan", "--action", "cancel")
        self.assertEqual(rc, 0, err)
        self.assertTrue(out.startswith("Ryan: assignment "), out)
        wait_until(lambda: "No member is waiting" in self.human("blocked", "--team", "alpha")[1], timeout=30,
                   message="cleared")

    def test_retry_runs_the_stuck_stage_again(self):
        self.stuck()
        rc, out, err = self.human("retry", "--team", "alpha")
        self.assertEqual(rc, 0, err)
        self.assertIn(": stage build retried (new assignment ", out)
        wait_until(lambda: "No member is waiting" in self.human("blocked", "--team", "alpha")[1], timeout=30,
                   message="cleared")


if __name__ == "__main__":
    unittest.main()
