"""P03-S11 usage limits through the coordinator, inbox, and fake provider."""
import json
import os
import sqlite3
import subprocess
import unittest
import contextlib
import importlib.util
import io

from tests.helpers import Sandbox, key, make_repo, req, wait_until


def git(workspace, *args):
    return subprocess.run(["git", "-C", workspace, *args], check=True, text=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.strip()


class UsageLimitIntegration(unittest.TestCase):
    def setUp(self):
        self.sb = Sandbox(extra_env={"AGENT_STUDIO_TEST_FIXTURE_PROVIDERS": "codex=fake,claude=fake,agy=fake"})
        _, response, proc = self.sb.run("coordinator", "start", "--enable-debug")
        self.assertTrue(response["ok"], proc.stderr)
        self.workspace = make_repo()
        os.makedirs(os.path.join(self.workspace, "stories"))
        with open(os.path.join(self.workspace, "stories", "limit.md"), "w", encoding="utf-8") as f:
            f.write("# Limit\n")
        base = git(self.workspace, "symbolic-ref", "--short", "HEAD")
        with open(os.path.join(self.workspace, ".agent-studio", "board.json"), "w", encoding="utf-8") as f:
            json.dump({"baseBranch": base}, f)
        git(self.workspace, "add", "-A")
        git(self.workspace, "commit", "-m", "fixture")
        _, team, _ = self.sb.request(req("team.start", {"workspace": self.workspace, "roster": [
            {"providerId": "claude", "role": "Developer"}, {"providerId": "agy", "role": "QA"}]}, idempotencyKey=key()))
        self.assertTrue(team["ok"], team)
        self.agents = {a["role"]: a["agentId"] for a in team["data"]["agents"]}

    def tearDown(self):
        self.sb.cleanup()

    def ticket(self):
        _, response, _ = self.sb.request(req("ticket.create", {"workspace": self.workspace, "storyPath": "stories/limit.md"}, idempotencyKey=key()))
        self.assertTrue(response["ok"], response)
        ticket = response["data"]["ticket"]
        _, response, _ = self.sb.request(req("debug.ticket_worktree", {"workspace": self.workspace,
                                                                           "key": ticket["key"]}, idempotencyKey=key()))
        self.assertTrue(response["ok"], response)
        return ticket

    def detail(self, ticket):
        _, response, _ = self.sb.request(req("ticket.show", {"workspace": self.workspace, "key": ticket["key"]}))
        self.assertTrue(response["ok"], response)
        return response["data"]

    def configure_limit(self, run_id, scenario="usage_limit"):
        conn = sqlite3.connect(os.path.join(self.sb.state_dir, "state.db"), timeout=10)
        try:
            row = conn.execute("SELECT config_json FROM workflow_runs WHERE id = ?", (run_id,)).fetchone()
            config = json.loads(row[0]); config["debugStageOptions"] = {"verdict": {"scenario": scenario, "durationMs": 50, "progressLines": 1}}
            conn.execute("UPDATE workflow_runs SET config_json = ? WHERE id = ?", (json.dumps(config), run_id))
            conn.execute("UPDATE assignments SET request_json = json_set(request_json, '$.providerOptions.scenario', ?) "
                         "WHERE id IN (SELECT assignment_id FROM stage_attempts WHERE workflow_run_id = ?)", (scenario, run_id))
            conn.commit()
        finally:
            conn.close()

    def start_limited_ticket(self, ticket, scenario="usage_limit"):
        """Freeze the fixture option before the fake QA worker can claim its request."""
        conn = sqlite3.connect(os.path.join(self.sb.state_dir, "state.db"))
        conn.execute("UPDATE agents SET availability = 'busy' WHERE id = ?", (self.agents["QA"],))
        conn.commit(); conn.close()
        _, started, _ = self.sb.request(req("ticket.start", {"workspace": self.workspace, "key": ticket["key"], "agentId": self.agents["QA"]}, idempotencyKey=key()))
        self.assertTrue(started["ok"], started)
        self.configure_limit(started["data"]["workflowRunId"], scenario)
        conn = sqlite3.connect(os.path.join(self.sb.state_dir, "state.db"))
        conn.execute("UPDATE agents SET availability = 'idle' WHERE id = ?", (self.agents["QA"],))
        conn.commit(); conn.close()
        return started["data"]["workflowRunId"]

    def wait_for_limit(self, ticket):
        return wait_until(lambda: (d := self.detail(ticket))["ticket"]["status"] == "ready_test" and d["ticket"]["appliedRunId"] and d,
                          timeout=int(os.environ.get("TEST_WAIT_SECONDS", "120")), message="usage limit")

    def test_limit_releases_ticket_and_resume_reenables_agent(self):
        ticket = self.ticket()
        _, moved, _ = self.sb.request(req("ticket.move", {"workspace": self.workspace, "key": ticket["key"], "to": "ready_test"}, idempotencyKey=key()))
        ticket = moved["data"]["ticket"]
        first_run = self.start_limited_ticket(ticket)
        detail = self.wait_for_limit(ticket)
        self.assertEqual(detail["ticket"]["testRounds"], 0)
        self.assertIsNone(detail["ticket"]["assigneeAgentId"])
        self.assertIsNone(detail["ticket"]["leaseUntil"])
        self.assertEqual(detail["ticket"]["appliedRunId"], first_run)
        released = next(event for event in detail["events"] if event["name"] == "ticket.released")
        self.assertEqual(released["payload"], {"reason": "usage_limit"})
        self.assertIn("ticket.outcome_applied", [event["name"] for event in detail["events"]])
        snap = self.sb.snapshot()
        qa = next(a for a in snap["agents"] if a["id"] == self.agents["QA"])
        self.assertEqual((qa["availability"], qa["limitResetAt"]), ("limit_reached", "2030-01-01T15:00:00Z"))
        self.assertEqual(next(w for w in snap["workflowRuns"] if w["id"] == first_run)["status"], "cancelled")
        events = self.sb.run("events", "--team", snap["teams"][0]["id"], "--limit", "1000")[1]["data"]["events"]
        limit_event = next(e for e in events if e["name"] == "board.limit_reached" and e["entityId"] == self.agents["QA"])
        self.assertEqual(limit_event["data"], {"agentId": self.agents["QA"], "resetAt": "2030-01-01T15:00:00Z"})

        _, direct, _ = self.sb.request(req("task.direct", {"teamId": snap["teams"][0]["id"], "agentId": self.agents["QA"], "policy": "read_only", "text": "refused"}, idempotencyKey=key()))
        self.assertFalse(direct["ok"]); self.assertEqual(direct["error"]["code"], "AGENT_UNAVAILABLE")
        _, refused, _ = self.sb.request(req("ticket.start", {"workspace": self.workspace, "key": ticket["key"], "agentId": self.agents["QA"]}, idempotencyKey=key()))
        self.assertFalse(refused["ok"]); self.assertEqual(refused["error"]["code"], "AGENT_UNAVAILABLE")
        self.assertEqual(self.detail(ticket)["ticket"]["status"], "ready_test")

        developer_ticket = self.ticket()
        _, moved, _ = self.sb.request(req("ticket.move", {"workspace": self.workspace, "key": developer_ticket["key"], "to": "ready_dev"}, idempotencyKey=key()))
        _, developer_started, _ = self.sb.request(req("ticket.start", {"workspace": self.workspace, "key": developer_ticket["key"], "agentId": self.agents["Developer"]}, idempotencyKey=key()))
        self.assertTrue(developer_started["ok"], developer_started)
        self.assertEqual(self.detail(developer_ticket)["ticket"]["status"], "in_dev")

        _, resumed, _ = self.sb.request(req("board.resume", {"workspace": self.workspace, "agentId": self.agents["QA"]}, idempotencyKey=key()))
        self.assertEqual(resumed["data"]["resumed"], [self.agents["QA"]])
        self.assertEqual(next(a for a in self.sb.snapshot()["agents"] if a["id"] == self.agents["QA"])["availability"], "idle")
        events = self.sb.run("events", "--team", snap["teams"][0]["id"], "--limit", "1000")[1]["data"]["events"]
        self.assertEqual(next(e for e in reversed(events) if e["name"] == "board.resumed")["data"],
                         {"agentIds": [self.agents["QA"]]})

        before = len(self.sb.snapshot()["workflowRuns"])
        second_run = self.start_limited_ticket(ticket)
        detail = self.wait_for_limit(ticket)
        self.assertEqual((detail["ticket"]["status"], detail["ticket"]["testRounds"]), ("ready_test", 0))
        self.assertEqual(len([w for w in self.sb.snapshot()["workflowRuns"] if w["id"] == second_run]), 1)
        self.assertEqual(len(self.sb.snapshot()["workflowRuns"]), before + 1)
        self.assertEqual(next(a for a in self.sb.snapshot()["agents"] if a["id"] == self.agents["QA"])["availability"], "limit_reached")

        _, all_resumed, _ = self.sb.request(req("board.resume", {"workspace": self.workspace, "all": True}, idempotencyKey=key()))
        self.assertIn(self.agents["QA"], all_resumed["data"]["resumed"])
        self.start_limited_ticket(ticket, "usage_limit_no_reset")
        self.wait_for_limit(ticket)
        self.sb.run("coordinator", "stop")
        _, restarted, proc = self.sb.run("coordinator", "start", "--enable-debug")
        self.assertTrue(restarted["ok"], proc.stderr)
        qa = next(a for a in self.sb.snapshot()["agents"] if a["id"] == self.agents["QA"])
        self.assertEqual((qa["availability"], qa["limitResetAt"]), ("limit_reached", None))

        spec = importlib.util.spec_from_file_location("team_usage_limit_status", os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "team", "team.py"))
        team_script = importlib.util.module_from_spec(spec)
        previous_as = os.environ.get("AGENT_STUDIO")
        os.environ["AGENT_STUDIO"] = "/bin/true"
        try:
            spec.loader.exec_module(team_script)
        finally:
            if previous_as is None:
                del os.environ["AGENT_STUDIO"]
            else:
                os.environ["AGENT_STUDIO"] = previous_as
        team_script.team = lambda: {"teamId": snap["teams"][0]["id"]}
        output = io.StringIO()
        team_script.cli = lambda *args: snap
        with contextlib.redirect_stdout(output):
            team_script.c_status(None)
        self.assertIn(f"LIMIT: {qa['displayName']} (agy) until 2030-01-01T15:00:00Z", output.getvalue())
        output = io.StringIO()
        team_script.cli = lambda *args: self.sb.snapshot(snap["teams"][0]["id"])
        with contextlib.redirect_stdout(output):
            team_script.c_status(None)
        self.assertIn(f"LIMIT: {qa['displayName']} (agy) until unknown", output.getvalue())
