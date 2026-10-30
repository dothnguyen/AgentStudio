"""P04-S12: a fake-provider run whose agent adds tickets through the real MCP server (started by the fake
CLI exactly as a real CLI would), and a member without canAddTickets gets no MCP config."""
import json
import os
import subprocess
import time
import unittest

from tests.helpers import Sandbox, make_repo
from tests.integration.test_p01_s04_start import git
from tests.integration.test_p04_s10_run_board import WORK as IMPL

ROLES = {"version": 1, "roles": {"writer": {}, "plain": {}}}
BOARD = {"version": 2, "leaseSeconds": 600,
         "statuses": [{"id": "build", "kind": "initial"}, {"id": "in-progress"},
                      {"id": "done", "kind": "done"}],
         "ticketFields": [],
         "rules": [{"when": {"status": "build"}, "role": "writer", "workflow": "impl",
                    "onPass": "done", "onFail": "build", "during": "in-progress"}]}
IMPL_OK = {"version": 1, "description": "impl", "stages": [
    {"id": "work", "role": "writer", "permission": "read_only", "prompt": "Do.\n{{task}}",
     "next": {"done": "$succeed"}}]}


class McpRun(unittest.TestCase):
    def setUp(self):
        self.sb = Sandbox()
        rc, r, p = self.sb.run("coordinator", "start", "--enable-debug")
        self.assertTrue(r["ok"], p.stderr)
        self.ws = make_repo()
        cfg = os.path.join(self.ws, ".agent-studio")
        os.makedirs(os.path.join(cfg, "teams"))
        os.makedirs(os.path.join(cfg, "workflows"))
        for rel, obj in (("roles.json", ROLES), ("board.json", BOARD), ("workflows/impl.json", IMPL_OK)):
            with open(os.path.join(cfg, rel), "w") as f:
                json.dump(obj, f)
        with open(os.path.join(cfg, "teams", "alpha.json"), "w") as f:
            json.dump({"id": "alpha", "name": "Alpha", "members": [
                {"id": "scribe", "name": "Scribe", "role": "writer", "provider": "fake",
                 "canAddTickets": True},
                {"id": "quiet", "name": "Quiet", "role": "plain", "provider": "fake"}]}, f)
        git(self.ws, "add", "-A")
        git(self.ws, "commit", "-qm", "fixture")

    def tearDown(self):
        self.sb.cleanup()

    def data(self, *argv, timeout=120):
        rc, r, p = self.sb.run(*argv, "--workspace", self.ws, "--json", timeout=timeout)
        self.assertTrue(r["ok"], (argv, r, p.stderr))
        return r["data"]

    def command(self, command, args, timeout=90):
        rc, r, p = self.sb.request({"protocol": "agent-studio/v1", "command": command, "args": args,
                                    "timeoutMs": timeout * 1000})
        self.assertTrue(r["ok"], (command, r))
        return r["data"]

    def wait_for(self, fn, timeout=120, message="condition"):
        deadline = time.monotonic() + timeout
        last = None
        while time.monotonic() < deadline:
            last = fn()
            if last:
                return last
            time.sleep(0.3)
        raise AssertionError(f"timed out waiting for {message}; last={last!r}")

    def test_agent_adds_two_tickets_through_mcp_and_plain_member_gets_no_server(self):
        rc, team, p = self.sb.run("team", "start", "--workspace", self.ws, "--team", "alpha")
        self.assertTrue(team["ok"], (team, p.stderr))
        rc, r, p = self.sb.run("team", "run-board", "--workspace", self.ws, "--team", "alpha", "--json")
        self.assertTrue(r["ok"], (r, p.stderr))

        ticket = self.data("ticket", "add", "--title", "mcp host ticket")
        # the board claims it with the writer (canAddTickets) and the run calls the tools
        self.wait_for(lambda: ticket if self.data("ticket", "show", ticket["ticket"]["key"])
                      ["ticket"].get("activeRunId") else None, 120, "claim")
        run = self.data("ticket", "show", ticket["ticket"]["key"])["ticket"]["activeRunId"]
        detail = self.wait_for(lambda: (lambda d: d if d["workflowRun"]["status"] == "succeeded"
                                        else None)(self.command("workflow.show", {"workflowRunId": run})), 120,
                               "run to succeed")
        claiming_assignment = detail["stageAttempts"][0]["assignmentId"]
        summary = ""
        a = {x["id"]: x for x in detail["assignments"]}
        for sa in reversed(detail["stageAttempts"]):
            res = (a.get(sa.get("assignmentId")) or {}).get("result") or {}
            summary = res.get("finalText") or res.get("summary") or ""
            if summary:
                break
        self.assertIn("mcp ok:", summary, summary)

        added = self.wait_for(lambda: [t for t in self.data("ticket", "list")["tickets"]
                                       if t["title"].startswith("Finding:")], 30, "agent tickets")
        self.assertEqual(len(added), 2, added)  # duplicate call collapsed by the idempotency key
        first = self.data("ticket", "show", added[0]["key"])
        # The board may claim the new ticket asynchronously after it appears in the list.
        self.wait_for(lambda: self.data("ticket", "show", added[0]["key"])["ticket"]["status"] == "in-progress", 120, "created ticket claim")
        self.assertEqual(first["ticket"]["phase"], "default")
        self.assertEqual(first["ticket"]["createdByMember"], "scribe")
        self.assertEqual(first["ticket"]["createdByAssignment"], claiming_assignment)
        # the same request id retried: one ticket, not two (2 distinct titles = 2 tickets)
        self.assertEqual(len({t["title"] for t in added}), 2)

    def test_plain_member_runs_without_mcp(self):
        rc, team, p = self.sb.run("team", "start", "--workspace", self.ws, "--team", "alpha")
        self.assertTrue(team["ok"], (team, p.stderr))
        # the runner must not prepare an MCP config for this member (its request has mcpTickets=false)
        from tests.helpers import key as idem
        agents = {a["memberId"]: a["agentId"] for a in team["data"]["agents"]}
        args = {"teamId": team["data"]["teamId"], "agentId": agents["quiet"], "policy": "read_only",
                "text": "plain run",
                "debugProviderOptions": {"scenario": "mcp_tickets", "durationMs": 100, "progressLines": 1}}
        rc, r, p = self.sb.request({"protocol": "agent-studio/v1", "command": "task.direct",
                                    "idempotencyKey": idem("plain"), "timeoutMs": 60000, "args": args})
        self.assertTrue(r["ok"], r)
        assignment = r["data"]["assignmentId"]
        self.wait_for(lambda: (lambda a: a if a["status"] in ("succeeded", "failed") else None)(
            next(x for x in self.sb.snapshot(team["data"]["teamId"])["assignments"]
                 if x["id"] == assignment)), 60, "assignment to settle")
        done = next(x for x in self.sb.snapshot(team["data"]["teamId"])["assignments"]
                    if x["id"] == assignment)
        self.assertEqual(done["status"], "succeeded")
        res = done.get("result") or {}
        self.assertNotIn("mcp ok:", res.get("finalText") or res.get("summary") or "")


if __name__ == "__main__":
    unittest.main()
