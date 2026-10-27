from tests.integration.test_p04_s03_team_lifecycle import LifecycleCase
from tests.helpers import key, req, wait_until
from tests.integration.test_p04_s10_run_board import RunBoardCase, WORKTREE_BOARD
from tests.integration.test_p01_s04_start import git


class LiveAgentSwitchTests(LifecycleCase):
    def test_resume_inactive_agent_persists_after_team_restart(self):
        self.write("agents.json", {"version": 1, "agents": [
            {"id": "primary", "name": "Primary", "provider": "fake"},
            {"id": "backup", "name": "Backup", "provider": "fake"}]})
        self.put("alpha", [{"id": "ryan", "name": "Ryan", "role": "developer",
                            "agents": ["primary", "backup"]}])
        team = self.start("alpha")["data"]
        args = {"teamId": team["teamId"], "agentId": team["agents"][0]["agentId"],
                "policy": "read_only", "text": "go",
                "debugProviderOptions": {"scenario": "usage_limit_no_reset", "durationMs": 100}}
        _, result, _ = self.sb.request(req("task.direct", args, idempotencyKey=key()))
        self.assertTrue(result["ok"], result)
        wait_until(lambda: self.status("alpha")["members"][0]["activeAgent"] == "backup", message="quota failover")
        rc, result, process = self.sb.run("team", "resume", "--workspace", self.ws, "--team", "alpha",
                                          "--member", "ryan", "--agent", "primary", "--json")
        self.assertEqual(rc, 0, (result, process.stderr))
        self.assertTrue(result["data"]["cleared"])
        self.assertTrue(self.stop("alpha")["ok"])
        self.assertTrue(self.start("alpha")["ok"])
        member = self.status("alpha")["members"][0]
        self.assertEqual(member["activeAgent"], "backup")
        self.assertNotIn("primary", member["quotaHolds"])

    def test_switch_without_team_restart_and_restore_on_next_start(self):
        self.write("agents.json", {"version": 1, "agents": [
            {"id": "primary", "name": "Primary", "provider": "fake", "model": "fake-1"},
            {"id": "backup", "name": "Backup", "provider": "fake", "model": "fake-2"}]})
        self.put("alpha", [{"id": "ryan", "name": "Ryan", "role": "developer",
                            "agents": ["primary", "backup"]}])
        started = self.start("alpha")
        self.assertTrue(started["ok"], started)
        original_id = started["data"]["teamId"]
        self.assertEqual(self.status("alpha")["members"][0]["activeAgent"], "primary")
        rc, switched, process = self.sb.run("team", "switch-agent", "--workspace", self.ws, "--team", "alpha",
                                            "--member", "ryan", "--agent", "backup", "--json")
        self.assertEqual(rc, 0, (switched, process.stderr))
        self.assertEqual(switched["data"]["activeAgent"], "backup")
        self.assertEqual(self.status("alpha")["team"]["id"], original_id)
        self.assertEqual(self.status("alpha")["members"][0]["activeAgent"], "backup")
        self.assertTrue(self.stop("alpha")["ok"])
        restarted = self.start("alpha")
        self.assertTrue(restarted["ok"], restarted)
        self.assertEqual(self.status("alpha")["members"][0]["activeAgent"], "backup")
        self.assertEqual(restarted["data"]["agents"][0]["model"], "fake-2")

    def test_confirmed_cancel_waits_then_switches(self):
        self.write("agents.json", {"version": 1, "agents": [
            {"id": "primary", "name": "Primary", "provider": "fake"},
            {"id": "backup", "name": "Backup", "provider": "fake"}]})
        self.put("alpha", [{"id": "ryan", "name": "Ryan", "role": "developer",
                            "agents": ["primary", "backup"]}])
        started = self.start("alpha")["data"]
        member = started["agents"][0]
        args = {"teamId": started["teamId"], "agentId": member["agentId"], "policy": "read_only", "text": "go",
                "debugProviderOptions": {"scenario": "slow", "durationMs": 20000, "progressLines": 1}}
        _, accepted, _ = self.sb.request(req("task.direct", args, idempotencyKey=key()))
        self.assertTrue(accepted["ok"], accepted)
        wait_until(lambda: self.status("alpha")["members"][0]["assignment"], message="active assignment")
        rc, result, _ = self.sb.run("team", "switch-agent", "--workspace", self.ws, "--team", "alpha",
                                    "--member", "ryan", "--agent", "backup", "--json")
        self.assertNotEqual(rc, 0)
        self.assertEqual(self.status("alpha")["members"][0]["activeAgent"], "primary")
        rc, result, process = self.sb.run("team", "switch-agent", "--workspace", self.ws, "--team", "alpha",
                                          "--member", "ryan", "--agent", "backup", "--cancel-active", "--json")
        self.assertEqual(rc, 0, (result, process.stderr))
        wait_until(lambda: self.status("alpha")["members"][0]["activeAgent"] == "backup", message="switch completed")
        self.assertEqual(self.status("alpha")["team"]["id"], started["teamId"])

    def test_quota_reports_fail_over_then_hold_and_survive_restart(self):
        self.write("agents.json", {"version": 1, "agents": [
            {"id": "primary", "name": "Primary", "provider": "fake"},
            {"id": "backup", "name": "Backup", "provider": "fake"}]})
        self.put("alpha", [{"id": "ryan", "name": "Ryan", "role": "developer",
                            "agents": ["primary", "backup"]}])
        team = self.start("alpha")["data"]
        def exhaust():
            args = {"teamId": team["teamId"], "agentId": team["agents"][0]["agentId"],
                    "policy": "read_only", "text": "go",
                    "debugProviderOptions": {"scenario": "usage_limit_no_reset", "durationMs": 100}}
            _, response, _ = self.sb.request(req("task.direct", args, idempotencyKey=key()))
            self.assertTrue(response["ok"], response)
        exhaust()
        wait_until(lambda: self.status("alpha")["members"][0]["activeAgent"] == "backup", message="quota failover")
        rc, resumed, process = self.sb.run("team", "resume", "--workspace", self.ws, "--team", "alpha",
                                          "--member", "ryan", "--agent", "primary", "--json")
        self.assertEqual(rc, 0, (resumed, process.stderr))
        self.assertTrue(resumed["data"]["cleared"])
        self.assertEqual(self.status("alpha")["members"][0]["activeAgent"], "backup")
        self.assertNotIn("primary", self.status("alpha")["members"][0]["quotaHolds"])
        rc, result, process = self.sb.run("team", "switch-agent", "--workspace", self.ws, "--team", "alpha",
                                          "--member", "ryan", "--agent", "primary", "--json")
        self.assertEqual(rc, 0, (result, process.stderr))
        exhaust()
        wait_until(lambda: self.status("alpha")["members"][0]["activeAgent"] == "backup", message="second quota failover")
        exhaust()
        wait_until(lambda: self.status("alpha")["members"][0]["availability"] == "limit_reached",
                   message="quota hold")
        held = self.status("alpha")["members"][0]
        self.assertEqual(set(held["quotaHolds"]), {"primary", "backup"})
        self.assertTrue(self.stop("alpha")["ok"])
        self.assertTrue(self.start("alpha")["ok"])
        held = self.status("alpha")["members"][0]
        self.assertEqual(held["availability"], "limit_reached")
        self.assertEqual(set(held["quotaHolds"]), {"primary", "backup"})


class BoardAgentSwitchTests(RunBoardCase):
    board = WORKTREE_BOARD

    def test_cancelled_board_ticket_returns_to_same_member(self):
        self.put("agents.json", {"version": 1, "agents": [
            {"id": "primary", "name": "Primary", "provider": "fake"},
            {"id": "backup", "name": "Backup", "provider": "fake"}]})
        self.put("teams/alpha.json", {"id": "alpha", "name": "Alpha", "members": [
            {"id": "ryan", "name": "Ryan", "role": "worker", "agents": ["primary", "backup"]}]})
        git(self.ws, "add", "-A")
        git(self.ws, "commit", "-qm", "agent choices")
        team = self.start_team()
        self.add_ticket("retry after switch")
        self.run_board()
        self.wait_claimed("T-001")
        rc, result, process = self.sb.run("team", "switch-agent", "--workspace", self.ws, "--team", "alpha",
                                          "--member", "ryan", "--agent", "backup", "--cancel-active", "--json")
        self.assertEqual(rc, 0, (result, process.stderr))
        self.wait_status("T-001", ("done",), timeout=120)
        events = self.board_json("ticket", "show", "T-001")["events"]
        claims = [e for e in events if e["name"] == "ticket.claimed"]
        self.assertGreaterEqual(len(claims), 2, events)
        self.assertTrue(all(e["payload"]["agentId"] == team["agents"][0]["agentId"] for e in claims))
