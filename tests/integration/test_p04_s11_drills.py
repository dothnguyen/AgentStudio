"""P04-S11 recovery drills on the fake provider — one method per failure, each in its own sandbox
(isolated state dir): coordinator killed, runner killed, merge conflict, round limit, usage limit,
stuck claim."""
import json
import os
import signal
import sqlite3
import subprocess
import time
import unittest

from tests.helpers import SHIM, Sandbox, make_repo
from tests.integration.test_p01_s04_start import git
from tests.integration.test_p04_s10_run_board import ROLES, WORK

STRICT = {"version": 1, "description": "strict", "stages": [
    {"id": "work", "role": "worker", "permission": "read_only", "prompt": "Do.\n{{task}}",
     "next": {"done": "tests"}},
    {"id": "tests", "type": "validation", "next": {"pass": "$succeed", "fail": "$fail"}}]}
DRILL_BOARD = {"version": 2, "leaseSeconds": 8,
               "statuses": [{"id": "build", "kind": "initial"}, {"id": "in-progress"},
                            {"id": "done", "kind": "done"}],
               "ticketFields": [],
               "rules": [{"when": {"status": "build"}, "role": "worker", "workflow": "work",
                          "onPass": "done", "onFail": "build", "during": "in-progress",
                          "maxRounds": 2}]}
STRICT_BOARD = {"version": 2, "leaseSeconds": 600,
                "statuses": [{"id": "build", "kind": "initial"}, {"id": "in-progress"},
                             {"id": "done", "kind": "done"}],
                "ticketFields": [],
                "rules": [{"when": {"status": "build"}, "role": "worker", "workflow": "strict",
                           "onPass": "done", "onFail": "build", "during": "in-progress",
                           "maxRounds": 2}]}
MERGE_BOARD = {"version": 2, "leaseSeconds": 600,
               "statuses": [{"id": "build", "kind": "initial"}, {"id": "ready"},
                            {"id": "done", "kind": "done"}],
               "ticketFields": [],
               "rules": [
                   {"when": {"status": "build"}, "role": "worker", "workflow": "work",
                    "onPass": "ready", "onFail": "build", "workspace": "worktree", "priority": 2,
                    "cap": 2},
                   {"when": {"status": "ready"}, "action": "merge", "onPass": "done",
                    "onFail": "build", "priority": 1}]}


class DrillCase(unittest.TestCase):
    board = DRILL_BOARD
    workflows = (("work.json", WORK),)
    members = ({"id": "ryan", "name": "Ryan", "role": "worker", "provider": "fake"},)

    def setUp(self):
        self.sb = Sandbox()
        rc, r, p = self.sb.run("coordinator", "start", "--enable-debug")
        self.assertTrue(r["ok"], p.stderr)
        self.ws = make_repo()
        cfg = os.path.join(self.ws, ".agent-studio")
        os.makedirs(os.path.join(cfg, "teams"))
        os.makedirs(os.path.join(cfg, "workflows"))
        self.put("roles.json", ROLES)
        for name, definition in self.workflows:
            self.put(f"workflows/{name}", definition)
        board = json.loads(json.dumps(self.board))
        if any(rule.get("workspace") == "worktree" for rule in board["rules"]):
            board["baseBranch"] = subprocess.run(["git", "-C", self.ws, "symbolic-ref", "--short", "HEAD"],
                                                 stdout=subprocess.PIPE, text=True, check=True).stdout.strip()
        self.put("board.json", board)
        self.put("teams/alpha.json", {"id": "alpha", "name": "Alpha", "members": list(self.members)})
        git(self.ws, "add", "-A")
        git(self.ws, "commit", "-qm", "drill fixture")

    def tearDown(self):
        self.sb.cleanup()

    def put(self, rel, obj):
        with open(os.path.join(self.ws, ".agent-studio", rel), "w") as f:
            json.dump(obj, f)

    def json_cmd(self, *argv, timeout=120):
        rc, r, p = self.sb.run(*argv, "--workspace", self.ws, "--json", timeout=timeout)
        self.assertTrue(r["ok"], (argv, r, p.stderr))
        return r["data"]

    def ticket(self, key):
        return self.json_cmd("ticket", "show", key)["ticket"]

    def events(self, key):
        return self.json_cmd("ticket", "show", key)["events"]

    def add_ticket(self, title="drill"):
        return self.json_cmd("ticket", "add", "--title", title)["ticket"]

    def start_and_run(self):
        rc, r, p = self.sb.run("team", "start", "--workspace", self.ws, "--team", "alpha")
        self.assertTrue(r["ok"], (r, p.stderr))
        rc, r, p = self.sb.run("team", "run-board", "--workspace", self.ws, "--team", "alpha", "--json")
        self.assertTrue(r["ok"], (r, p.stderr))

    def wait_for(self, fn, timeout=120, message="condition"):
        deadline = time.monotonic() + timeout
        last = None
        while time.monotonic() < deadline:
            last = fn()
            if last:
                return last
            time.sleep(0.3)
        raise AssertionError(f"timed out waiting for {message}; last={last!r}")

    def wait_status(self, key, statuses, timeout=120):
        return self.wait_for(lambda: self.ticket(key) if self.ticket(key)["status"] in statuses else None,
                             timeout, f"{key} in {statuses}")

    def wait_claimed(self, key, timeout=120):
        return self.wait_for(lambda: (lambda t: t if (t.get("assignee") or t.get("worktreePath")) else None)(
            self.ticket(key)), timeout, f"{key} claimed")

    def db(self):
        conn = sqlite3.connect(os.path.join(self.sb.state_dir, "state.db"), timeout=10)
        conn.row_factory = sqlite3.Row
        self.addCleanup(conn.close)
        return conn


class CoordinatorKilled(DrillCase):
    def test_drill_coordinator_killed(self):
        self.add_ticket()
        self.start_and_run()
        claimed = self.wait_claimed("T-001")
        run = claimed["activeRunId"]
        self.assertIsNotNone(run)

        with open(os.path.join(self.sb.state_dir, "coordinator.json")) as f:
            pid = json.load(f)["pid"]
        os.kill(pid, signal.SIGKILL)  # the runner keeps working and reports into the inbox
        time.sleep(2)
        rc, r, p = self.sb.run("coordinator", "start", "--enable-debug")
        self.assertTrue(r["ok"], p.stderr)

        self.wait_status("T-001", ("done",), timeout=120)  # the report is applied once, the board carries on
        outcome = [e for e in self.events("T-001") if e["name"] == "ticket.outcome_applied"]
        self.assertEqual(len(outcome), 1, self.events("T-001"))
        self.assertEqual(outcome[0]["to"], "done")


class RunnerKilled(DrillCase):
    def test_drill_runner_killed(self):
        self.add_ticket()
        self.start_and_run()
        claimed = self.wait_claimed("T-001")
        run = claimed["activeRunId"]

        pid = self.wait_for(self._runner_pid, 60, "runner process")
        os.kill(pid, signal.SIGKILL)

        # Assignment reconciliation, not the ticket's pre-start lease, owns a runner that disappears after
        # workflow start. The uncertain run pauses for an operator instead of discarding possible work.
        conn = self.db()
        paused = self.wait_for(
            lambda: (lambda row: row if row and row["status"] == "paused" else None)(
                conn.execute("SELECT status, transition_reason FROM workflow_runs WHERE id = ?", (run,)).fetchone()),
            timeout=60, message="runner-gone workflow to pause")
        self.assertIn("reconciling", paused["transition_reason"])
        ticket = self.ticket("T-001")
        self.assertEqual((ticket["status"], ticket["activeRunId"], ticket["leaseUntil"]),
                         ("in-progress", run, None))
        names = [e["name"] for e in self.events("T-001")]
        self.assertNotIn("ticket.lease_expired", names)
        diagnostic = conn.execute(
            "SELECT diagnostic_code FROM assignments WHERE task_id = "
            "(SELECT task_id FROM workflow_runs WHERE id = ?) ORDER BY created_at DESC LIMIT 1", (run,)).fetchone()[0]
        self.assertEqual(diagnostic, "RUNNER_GONE")

    def _runner_pid(self):
        row = self.db().execute(
            "SELECT a.process_pid FROM assignments a JOIN workflow_runs w ON w.task_id = a.task_id "
            "WHERE w.id = (SELECT active_run_id FROM tickets WHERE key = 'T-001') "
            "AND a.process_pid IS NOT NULL ORDER BY a.created_at DESC LIMIT 1").fetchone()
        return row[0] if row else None


class MergeConflict(DrillCase):
    board = MERGE_BOARD
    members = ({"id": "ryan", "name": "Ryan", "role": "worker", "provider": "fake"},
               {"id": "reese", "name": "Reese", "role": "worker", "provider": "fake"})

    def seed(self, worktree, content):
        with open(os.path.join(worktree, "shared.txt"), "w") as f:
            f.write(content)
        git(worktree, "add", "-A")
        git(worktree, "commit", "-qm", "drill change")

    def test_drill_merge_conflict(self):
        self.add_ticket("first")
        self.add_ticket("second")
        self.start_and_run()
        first = self.wait_claimed("T-001")
        second = self.wait_claimed("T-002")
        rc, r, p = self.sb.run("team", "stop-board", "--workspace", self.ws, "--json")
        self.assertTrue(r["ok"], r)
        self.seed(first["worktreePath"], "from first\n")
        self.seed(second["worktreePath"], "from second\n")
        self.wait_status("T-001", ("done",), timeout=180)
        conflict = self.wait_for(
            lambda: next((e for e in self.events("T-002") if e["name"] == "ticket.merge_conflict"), None),
            120, "merge conflict")
        self.assertIn("MERGE_CONFLICT", json.dumps(conflict["payload"]))
        self.assertEqual(self.ticket("T-002")["status"], "build")
        with open(os.path.join(self.ws, "shared.txt")) as f:
            self.assertEqual(f.read(), "from first\n")


class RoundLimit(DrillCase):
    board = STRICT_BOARD
    workflows = (("work.json", WORK), ("strict.json", STRICT))

    def test_drill_round_limit(self):
        self.add_ticket("keeps failing validation")
        self.start_and_run()
        deadline = time.monotonic() + 240
        while time.monotonic() < deadline:
            if self.ticket("T-001")["status"] == "blocked":
                break
            time.sleep(0.5)
        ticket = self.ticket("T-001")
        self.assertEqual(ticket["status"], "blocked")
        self.assertEqual(ticket["blockedReason"], "ROUND_LIMIT:build")
        self.assertEqual(ticket["rounds"], {"build": 2})
        rc, r, p = self.sb.run("team", "stop-board", "--workspace", self.ws, "--json")
        self.assertTrue(r["ok"], r)
        unblocked = self.json_cmd("ticket", "unblock", "T-001")
        self.assertEqual(unblocked["ticket"]["status"], "build")


class UsageLimit(DrillCase):
    def test_drill_usage_limit(self):
        ticket = self.add_ticket()
        self.start_and_run()
        claimed = self.wait_claimed("T-001")
        run = claimed["activeRunId"]

        # the fake provider's usage_limit scenario, replayed at the database level: the run failed with
        # USAGE_LIMIT and the member is limit_reached (report_rules does this from the real report)
        conn = self.db()
        task = conn.execute("SELECT task_id FROM workflow_runs WHERE id = ?", (run,)).fetchone()[0]
        agent = conn.execute("SELECT assignee FROM tickets WHERE key = 'T-001'").fetchone()[0]
        conn.execute("UPDATE assignments SET status = 'failed', diagnostic_code = 'USAGE_LIMIT', "
                     "process_pid = NULL WHERE task_id = ? AND agent_id = ?", (task, agent))
        conn.execute("UPDATE workflow_runs SET status = 'failed' WHERE id = ?", (run,))
        conn.execute("UPDATE agents SET availability = 'limit_reached', limit_reset_at = '2030-01-01T00:00:00Z' "
                     "WHERE id = ?", (agent,))
        conn.commit()

        released = self.wait_for(lambda: self.ticket("T-001") if self.ticket("T-001")["assignee"] is None
                                 and self.ticket("T-001")["status"] == "build" else None, 60, "release")
        self.assertIsNone(released["rounds"])  # the round was not counted
        self.assertEqual(released["runId"], run)

        rc, resumed, p = self.sb.run("board", "resume", "--workspace", self.ws, "--member", "Ryan")
        self.assertTrue(resumed["ok"], (resumed, p.stderr))
        self.assertTrue(resumed["data"]["resumed"])
        self.wait_status("T-001", ("done",), timeout=180)  # eligible again: the board finishes the ticket


class StuckClaim(DrillCase):
    def test_drill_stuck_claim(self):
        self.add_ticket()
        self.start_and_run()
        claimed = self.wait_claimed("T-001")
        run = claimed["activeRunId"]
        released = self.json_cmd("ticket", "retry", "T-001")
        self.assertEqual(released["ticket"]["status"], "build")
        self.assertIsNone(released["ticket"]["assignee"])
        self.wait_for(lambda: self.db().execute(
            "SELECT status FROM workflow_runs WHERE id = ?", (run,)).fetchone()[0] in ("cancelled", "failed"),
            60, "run cancelled")
        self.wait_status("T-001", ("done",), timeout=180)  # claimed again and finished


if __name__ == "__main__":
    unittest.main()
