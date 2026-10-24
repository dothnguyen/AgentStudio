"""P04-S09: a real fake-provider workflow run's outcome is applied to its ticket through the applier."""
import json
import os
import unittest

from tests.helpers import Sandbox, key, make_repo, req, wait_until
from tests.integration.test_p01_s04_start import fake, git

PAIR = {"version": 1, "description": "pair", "stages": [
    {"id": "build", "role": "developer", "permission": "workspace_write", "maxVisits": 2, "prompt": "Do.\n{{task}}",
     "next": {"done": "look"}},
    {"id": "look", "role": "reviewer", "permission": "read_only", "maxVisits": 2, "prompt": "Look.\n{{task}}",
     "next": {"pass": "$succeed", "fail": "build"}}]}
ROLES = {"version": 1, "roles": {"developer": {}, "reviewer": {}}}
BOARD = {"version": 2,
         "statuses": [{"id": "todo", "kind": "initial"}, {"id": "verify"}, {"id": "done", "kind": "done"}],
         "ticketFields": [],
         "rules": [
             {"when": {"status": "todo"}, "role": "developer", "workflow": "pair",
              "onPass": "verify", "onFail": "todo", "maxRounds": 2},
             {"when": {"status": "verify"}, "role": "reviewer", "workflow": "pair",
              "onPass": "done", "onFail": "todo"}]}


class Applier(unittest.TestCase):
    def setUp(self):
        self.sb = Sandbox()
        rc, r, p = self.sb.run("coordinator", "start", "--enable-debug")
        self.assertTrue(r["ok"], p.stderr)
        self.ws = make_repo()
        cfg = os.path.join(self.ws, ".agent-studio")
        os.makedirs(os.path.join(cfg, "teams"))
        os.makedirs(os.path.join(cfg, "workflows"))
        for rel, obj in (("roles.json", ROLES), ("board.json", BOARD), ("workflows/pair.json", PAIR)):
            with open(os.path.join(cfg, rel), "w") as f:
                json.dump(obj, f)
        with open(os.path.join(cfg, "teams", "alpha.json"), "w") as f:
            json.dump({"id": "alpha", "name": "Alpha", "members": [
                {"id": "ryan", "name": "Ryan", "role": "developer", "provider": "fake"},
                {"id": "sam", "name": "Sam", "role": "reviewer", "provider": "fake"}]}, f)
        git(self.ws, "add", "-A")
        git(self.ws, "commit", "-qm", "team, workflow and board")

    def tearDown(self):
        self.sb.cleanup()

    def cli(self, *argv, timeout=120):
        return self.sb.run(*argv, timeout=timeout)[1]

    def test_real_run_outcome_applied_to_the_ticket(self):
        rc, rules, p = self.sb.run("board", "rules", "check", "--workspace", self.ws, "--json")
        self.assertTrue(rules["ok"], (rules, p.stderr))
        self.assertEqual(rules["data"], {"workspace": self.ws, "rules": 2, "problems": []})

        rc, started, p = self.sb.run("team", "start", "--workspace", self.ws, "--team", "alpha")
        self.assertTrue(started["ok"], (started, p.stderr))
        team = started["data"]
        agents = {a["memberId"]: a["agentId"] for a in team["agents"]}
        args = {"teamId": team["teamId"], "definition": "pair", "text": "do it",
                "bindings": {"developer": agents["ryan"], "reviewer": agents["sam"]},
                "debugStageOptions": {"build": fake("success"), "look": fake("verdict_pass")}}
        rc, r, p = self.sb.request(req("workflow.start", args, idempotencyKey=key("wf")))
        self.assertTrue(r["ok"], r)
        run = r["data"]["workflowRunId"]
        wait_until(lambda: self.cli("workflow", "show", "--workflow", run)["data"]["workflowRun"]["status"]
                   == "succeeded", timeout=90, message="run to succeed")

        ticket = self.cli("ticket", "add", "--workspace", self.ws, "--title", "Real run", "--json")["data"]
        self.assertEqual(ticket["ticket"]["status"], "todo")
        applied = self.cli("ticket", "apply", "--workspace", self.ws, ticket["ticket"]["key"], run,
                           "--json")["data"]
        self.assertEqual((applied["applied"], applied["outcome"], applied["ticket"]["status"]),
                         (True, "pass", "verify"))
        again = self.cli("ticket", "apply", "--workspace", self.ws, ticket["ticket"]["key"], run,
                         "--json")["data"]
        self.assertFalse(again["applied"])  # the same run never applies twice

        detail = self.cli("ticket", "show", "--workspace", self.ws, ticket["ticket"]["key"], "--json")["data"]
        self.assertEqual(detail["ticket"]["runId"], run)
        self.assertEqual([e["name"] for e in detail["events"]], ["ticket.created", "ticket.outcome_applied"])

    def test_failing_runs_count_rounds_and_block(self):
        rc, started, p = self.sb.run("team", "start", "--workspace", self.ws, "--team", "alpha")
        team = started["data"]
        agents = {a["memberId"]: a["agentId"] for a in team["agents"]}
        ticket = self.cli("ticket", "add", "--workspace", self.ws, "--title", "retry me", "--json")["data"]["ticket"]
        for round_no in (1, 2):
            args = {"teamId": team["teamId"], "definition": "pair", "text": "fail it",
                    "bindings": {"developer": agents["ryan"], "reviewer": agents["sam"]},
                    "debugStageOptions": {"build": fake("success"), "look": fake("verdict_fail")}}
            rc, r, p = self.sb.request(req("workflow.start", args, idempotencyKey=key(f"wf{round_no}")))
            run = r["data"]["workflowRunId"]
            wait_until(lambda: self.cli("workflow", "show", "--workflow", run)["data"]["workflowRun"]["status"]
                       == "failed", timeout=90, message="run to fail")
            applied = self.cli("ticket", "apply", "--workspace", self.ws, ticket["key"], run, "--json")["data"]
            self.assertEqual((applied["outcome"], applied["rounds"]), ("fail", round_no))
        blocked = self.cli("ticket", "list", "--workspace", self.ws, "--status", "blocked", "--json")["data"]
        self.assertEqual([t["key"] for t in blocked["tickets"]], [ticket["key"]])
        unblocked = self.cli("ticket", "unblock", "--workspace", self.ws, ticket["key"], "--json")["data"]
        self.assertEqual(unblocked["ticket"]["status"], "todo")


if __name__ == "__main__":
    unittest.main()
