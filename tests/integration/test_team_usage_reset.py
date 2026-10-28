"""Provider-wide quota reset through the CLI and real coordinator."""
from tests.integration.test_p04_s03_team_lifecycle import LifecycleCase
from tests.helpers import key, req, wait_until


class ProviderUsageResetTests(LifecycleCase):
    def setUp(self):
        super().setUp()
        self.sb.run("coordinator", "stop")
        self.sb.env["AGENT_STUDIO_TEST_FIXTURE_PROVIDERS"] = "codex=fake,claude=fake"
        self.assertTrue(self.sb.run("coordinator", "start", "--enable-debug")[1]["ok"])
        self.write("agents.json", {"version": 1, "agents": [
            {"id": "codex-a", "name": "Codex A", "provider": "codex"},
            {"id": "codex-b", "name": "Codex B", "provider": "codex"},
            {"id": "claude-a", "name": "Claude A", "provider": "claude"}]})
        self.put("alpha", [{"id": "ryan", "name": "Ryan", "role": "developer",
                            "agents": ["codex-a", "claude-a", "codex-b"]}])
        self.team = self.start("alpha")["data"]

    def exhaust(self):
        args = {"teamId": self.team["teamId"], "agentId": self.team["agents"][0]["agentId"],
                "policy": "read_only", "text": "go",
                "debugProviderOptions": {"scenario": "usage_limit_no_reset", "durationMs": 100}}
        _, result, _ = self.sb.request(req("task.direct", args, idempotencyKey=key()))
        self.assertTrue(result["ok"], result)

    def reset(self, provider="codex"):
        return self.sb.run("team", "usage-reset", provider, "--workspace", self.ws, "--team", "alpha", "--json")

    def test_reset_inactive_provider_does_not_switch_available_member(self):
        self.exhaust()
        wait_until(lambda: self.status("alpha")["members"][0]["activeAgent"] == "claude-a")
        rc, result, process = self.reset()
        self.assertEqual(rc, 0, (result, process.stderr))
        item = result["data"]["members"][0]
        self.assertEqual(item["cleared"], ["codex-a"])
        self.assertFalse(item["switched"])
        self.assertEqual(self.status("alpha")["members"][0]["activeAgent"], "claude-a")
        self.assertEqual(self.reset()[1]["data"]["members"][0]["cleared"], [])

    def test_all_held_switches_to_reset_provider(self):
        self.exhaust()
        wait_until(lambda: self.status("alpha")["members"][0]["activeAgent"] == "claude-a")
        self.exhaust()
        wait_until(lambda: self.status("alpha")["members"][0]["activeAgent"] == "codex-b")
        self.exhaust()
        wait_until(lambda: self.status("alpha")["members"][0]["availability"] == "limit_reached")
        rc, result, process = self.reset()
        self.assertEqual(rc, 0, (result, process.stderr))
        member = self.status("alpha")["members"][0]
        self.assertEqual(set(result["data"]["members"][0]["cleared"]), {"codex-a", "codex-b"})
        self.assertEqual(member["availability"], "idle")
        self.assertEqual(member["activeAgent"], "codex-b")
        self.assertIn("claude-a", member["quotaHolds"])
        self.assertNotIn("codex-a", member["quotaHolds"])

    def test_all_held_on_other_provider_switches_to_codex(self):
        self.assertTrue(self.stop("alpha")["ok"])
        self.put("alpha", [{"id": "ryan", "name": "Ryan", "role": "developer",
                            "agents": ["codex-a", "claude-a"]}])
        self.team = self.start("alpha")["data"]
        self.exhaust()
        wait_until(lambda: self.status("alpha")["members"][0]["activeAgent"] == "claude-a")
        self.exhaust()
        wait_until(lambda: self.status("alpha")["members"][0]["availability"] == "limit_reached")
        rc, result, process = self.reset()
        self.assertEqual(rc, 0, (result, process.stderr))
        item = result["data"]["members"][0]
        self.assertTrue(item["switched"])
        member = self.status("alpha")["members"][0]
        self.assertEqual((member["activeAgent"], member["availability"]), ("codex-a", "idle"))
        self.assertIn("claude-a", member["quotaHolds"])
    def test_busy_member_keeps_current_agent_and_assignment(self):
        self.exhaust()
        wait_until(lambda: self.status("alpha")["members"][0]["activeAgent"] == "claude-a")
        args = {"teamId": self.team["teamId"], "agentId": self.team["agents"][0]["agentId"],
                "policy": "read_only", "text": "go",
                "debugProviderOptions": {"scenario": "slow", "durationMs": 20000, "progressLines": 1}}
        _, started, _ = self.sb.request(req("task.direct", args, idempotencyKey=key()))
        self.assertTrue(started["ok"], started)
        wait_until(lambda: self.status("alpha")["members"][0]["assignment"])
        rc, result, process = self.reset()
        self.assertEqual(rc, 0, (result, process.stderr))
        self.assertFalse(result["data"]["members"][0]["switched"])
        member = self.status("alpha")["members"][0]
        self.assertEqual(member["activeAgent"], "claude-a")
        self.assertEqual(member["assignment"]["id"], started["data"]["assignmentId"])
        self.assertNotIn("codex-a", member["quotaHolds"])
    def test_unknown_provider_rejected(self):
        rc, result, _ = self.reset("does-not-exist")
        self.assertNotEqual(rc, 0)
        self.assertEqual(result["error"]["code"], "BAD_REQUEST")
