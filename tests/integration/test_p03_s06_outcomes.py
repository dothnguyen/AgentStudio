"""P03-S06 outcomes through the real coordinator and fake providers.

The board command deliberately has no debug-provider argument.  These tests set
the already-created, test-only fake assignment request before the coordinator
claims it; production requests cannot supply these options.
"""
import json
import os
import sqlite3
import subprocess
import unittest

from tests.helpers import Sandbox, key, make_repo, req, wait_until


def git(workspace, *args):
    return subprocess.run(["git", "-C", workspace, *args], check=True, text=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.strip()


def fake(scenario, write=None, duration=900):
    value = {"scenario": scenario, "durationMs": duration, "progressLines": 1}
    if write:
        value["writeFile"] = write
    return value


class OutcomeIntegration(unittest.TestCase):
    def setUp(self):
        self.sb = Sandbox(extra_env={"AGENT_STUDIO_TEST_FIXTURE_PROVIDERS": "codex=fake,claude=fake,agy=fake"})
        _, started, proc = self.sb.run("coordinator", "start", "--enable-debug")
        self.assertTrue(started["ok"], proc.stderr)
        self.workspace = make_repo()
        self.story = "phases/phase-03/stories/example.md"
        os.makedirs(os.path.join(self.workspace, os.path.dirname(self.story)))
        with open(os.path.join(self.workspace, self.story), "w", encoding="utf-8") as f:
            f.write("# Example\n")
        base = git(self.workspace, "symbolic-ref", "--short", "HEAD")
        self.base_branch = base
        with open(os.path.join(self.workspace, ".agent-studio", "board.json"), "w", encoding="utf-8") as f:
            json.dump({"baseBranch": base}, f)
        git(self.workspace, "add", "-A")
        git(self.workspace, "commit", "-m", "board fixture")
        roster = [{"providerId": "codex", "role": "TeamLead"},
                  {"providerId": "claude", "role": "Developer"},
                  {"providerId": "agy", "role": "QA"}]
        _, team, _ = self.sb.request(req("team.start", {"workspace": self.workspace, "roster": roster},
                                         idempotencyKey=key()))
        self.assertTrue(team["ok"], team)
        self.agents = {a["role"]: a["agentId"] for a in team["data"]["agents"]}

    def tearDown(self):
        self.sb.cleanup()

    def create(self):
        _, response, _ = self.sb.request(req("ticket.create", {"workspace": self.workspace, "storyPath": self.story},
                                             idempotencyKey=key()))
        self.assertTrue(response["ok"], response)
        return response["data"]["ticket"]

    def move(self, ticket, status):
        _, response, _ = self.sb.request(req("ticket.move", {"workspace": self.workspace, "key": ticket["key"],
                                                            "to": status}, idempotencyKey=key()))
        self.assertTrue(response["ok"], response)
        return response["data"]["ticket"]

    def detail(self, ticket):
        _, response, _ = self.sb.request(req("ticket.show", {"workspace": self.workspace, "key": ticket["key"]}))
        self.assertTrue(response["ok"], response)
        return response["data"]

    def configure_fake(self, workflow_id, stage, option):
        """Install a fake option in the frozen test run before its worker claims it."""
        conn = sqlite3.connect(os.path.join(self.sb.state_dir, "state.db"), timeout=10)
        try:
            row = conn.execute("SELECT config_json FROM workflow_runs WHERE id = ?", (workflow_id,)).fetchone()
            config = json.loads(row[0])
            config["debugStageOptions"] = {stage: option}
            conn.execute("UPDATE workflow_runs SET config_json = ? WHERE id = ?", (json.dumps(config), workflow_id))
            rows = conn.execute("SELECT a.id, a.request_json FROM assignments a JOIN stage_attempts s "
                                "ON s.assignment_id = a.id WHERE s.workflow_run_id = ?", (workflow_id,)).fetchall()
            for assignment_id, request in rows:
                request = json.loads(request)
                request["providerOptions"] = option[0] if isinstance(option, list) and option else option
                conn.execute("UPDATE assignments SET request_json = ? WHERE id = ?",
                             (json.dumps(request), assignment_id))
            conn.commit()
        finally:
            conn.close()

    def configure_next_fake(self, workflow_id, stage, option):
        """Set the option a retry will read while it is being dispatched."""
        conn = sqlite3.connect(os.path.join(self.sb.state_dir, "state.db"), timeout=10)
        try:
            row = conn.execute("SELECT config_json FROM workflow_runs WHERE id = ?", (workflow_id,)).fetchone()
            config = json.loads(row[0])
            config["debugStageOptions"] = {stage: option}
            conn.execute("UPDATE workflow_runs SET config_json = ? WHERE id = ?", (json.dumps(config), workflow_id))
            conn.commit()
        finally:
            conn.close()

    def start(self, ticket, role, stage, option):
        # Keep the worker from claiming the new assignment until its test-only
        # fixture option has been installed.  Without this small gate a busy
        # coordinator can deliver the request between ticket.start returning
        # and configure_fake updating the frozen request.
        conn = sqlite3.connect(os.path.join(self.sb.state_dir, "state.db"), timeout=10)
        try:
            conn.execute("UPDATE agents SET availability = 'busy' WHERE id = ?", (self.agents[role],))
            conn.commit()
        finally:
            conn.close()
        _, response, _ = self.sb.request(req("ticket.start", {"workspace": self.workspace, "key": ticket["key"],
                                                             "agentId": self.agents[role]}, idempotencyKey=key()))
        try:
            self.assertTrue(response["ok"], response)
            self.configure_fake(response["data"]["workflowRunId"], stage, option)
        finally:
            conn = sqlite3.connect(os.path.join(self.sb.state_dir, "state.db"), timeout=10)
            try:
                conn.execute("UPDATE agents SET availability = 'idle' WHERE id = ?", (self.agents[role],))
                conn.commit()
            finally:
                conn.close()
        return response["data"]

    def wait_ticket(self, ticket, status):
        # Some outcomes return to the queue they started from.  A status-only
        # wait would observe that queue before the run has finished.
        return wait_until(lambda: (d := self.detail(ticket))["ticket"]["status"] == status
                          and (status == "blocked" or d["ticket"]["appliedRunId"] == d["ticket"]["runId"])
                          and d,
                          timeout=int(os.environ.get("TEST_WAIT_SECONDS", "120")), message="ticket outcome " + status)

    def prepare_worktree(self, ticket):
        _, response, _ = self.sb.request(req("debug.ticket_worktree", {"workspace": self.workspace,
                                                                         "key": ticket["key"]}, idempotencyKey=key()))
        self.assertTrue(response["ok"], response)
        return response["data"]["worktree"]["path"]

    def coordinator_pid(self):
        _, response, _ = self.sb.run("health")
        coordinator = response["data"]["coordinator"]
        return coordinator["pid"] if coordinator["running"] else None

    def restart_with_crash(self, point):
        self.sb.run("coordinator", "stop")
        self.sb.env["AGENT_STUDIO_TEST_CRASH_AT"] = point
        _, response, proc = self.sb.run("coordinator", "start", "--enable-debug")
        self.assertTrue(response["ok"], proc.stderr)

    def recover(self, point):
        wait_until(lambda: self.coordinator_pid() is None, timeout=40, message="coordinator crash")
        self.assertTrue(os.path.exists(os.path.join(self.sb.state_dir, "crashed-at-" + point)))
        self.sb.env.pop("AGENT_STUDIO_TEST_CRASH_AT", None)
        _, response, proc = self.sb.run("coordinator", "start", "--enable-debug")
        self.assertTrue(response["ok"], proc.stderr)

    def assert_outcome(self, detail, *, applied=True, findings=False, paused=False):
        ticket = detail["ticket"]
        self.assertEqual(bool(ticket["appliedRunId"]), applied)
        self.assertEqual(ticket["leaseUntil"], None)
        self.assertEqual(ticket["assigneeAgentId"] is not None, paused)
        self.assertEqual(sum(e["name"] == "ticket.outcome_applied" for e in detail["events"]), 1)
        self.assertEqual(any(e["name"] == "ticket.findings" for e in detail["events"]), findings)

    def test_fake_outcome_rows_apply_once(self):
        # Each row is an independent live ticket/run, rather than a mocked call to apply_outcomes.
        cases = (("refine", "TeamLead", "verdict", fake("verdict_pass", self.story), "ready_dev", 0, False),
                 ("refine", "TeamLead", "verdict", fake("verdict_fail"), "blocked", 0, True),
                 ("develop", "Developer", "work", fake("success", "fixed.txt"), "ready_test", 0, False),
                 ("develop", "Developer", "work", fake("success", "not-fixed.txt"), "ready_dev", 1, True),
                 ("test", "QA", "verdict", fake("verdict_pass"), "ready_review", 0, False),
                 ("test", "QA", "verdict", fake("verdict_fail"), "fail_test", 1, True),
                 ("review", "TeamLead", "verdict", fake("verdict_pass"), "ready_merge", 0, False),
                 ("review", "TeamLead", "verdict", fake("verdict_fail"), "changes_requested", 1, True))
        for column, role, stage, option, expected, count, has_findings in cases:
            with self.subTest(column=column, expected=expected):
                ticket = self.create()
                if column == "develop":
                    ticket = self.move(ticket, "ready_dev")
                elif column in ("test", "review"):
                    self.prepare_worktree(ticket)
                    ticket = self.move(ticket, "ready_" + column)
                self.start(ticket, role, stage, option)
                detail = self.wait_ticket(ticket, expected)
                self.assert_outcome(detail, findings=has_findings)
                field = {"develop": "devRounds", "test": "testRounds", "review": "reviewRounds"}.get(column)
                if field:
                    self.assertEqual(detail["ticket"][field], count)

    def test_full_path_commits_and_test_prompt_contains_develop_diff(self):
        ticket = self.create()
        self.start(ticket, "TeamLead", "verdict", fake("verdict_pass", self.story))
        self.wait_ticket(ticket, "ready_dev")
        self.start(ticket, "Developer", "work", fake("success", "fixed.txt"))
        developed = self.wait_ticket(ticket, "ready_test")
        branch = developed["ticket"]["branch"]
        self.assertEqual(git(self.workspace, "rev-list", "--count", f"{self.base_branch}..{branch}"), "1")
        self.assertEqual(git(self.workspace, "log", "--format=%s", branch).splitlines()[0],
                         ticket["key"] + ": develop round 1")
        self.assertTrue(developed["ticket"]["headCommit"])
        started = self.start(ticket, "QA", "verdict", fake("verdict_pass"))
        run = self.workflow(started["workflowRunId"])
        prompt = open(run["stageAttempts"][0]["promptPath"], encoding="utf-8").read()
        self.assertIn("fixed.txt", prompt)
        self.wait_ticket(ticket, "ready_review")
        self.start(ticket, "TeamLead", "verdict", fake("verdict_pass"))
        self.wait_ticket(ticket, "ready_merge")
        self.assertEqual(git(self.workspace, "log", "--format=%s", "-1"),
                         ticket["key"] + ": refine " + self.story)

    def test_two_qa_failures_then_pass_commits_three_rounds_and_seeds_findings(self):
        ticket = self.move(self.create(), "ready_dev")
        self.start(ticket, "Developer", "work", fake("success", "fixed.txt"))
        self.wait_ticket(ticket, "ready_test")

        self.start(ticket, "QA", "verdict", fake("verdict_fail"))
        self.wait_ticket(ticket, "fail_test")
        self.start(ticket, "Developer", "work", fake("success", "fixed-two.txt"))
        self.wait_ticket(ticket, "ready_test")

        self.start(ticket, "QA", "verdict", fake("verdict_fail"))
        failed = self.wait_ticket(ticket, "fail_test")
        second_findings = failed["ticket"]["findings"]
        third = self.start(ticket, "Developer", "work", fake("success", "fixed-three.txt"))
        third_run = self.workflow(third["workflowRunId"])
        third_prompt = open(third_run["stageAttempts"][0]["promptPath"], encoding="utf-8").read()
        self.assertTrue(second_findings)
        self.assertTrue(all(finding in third_prompt for finding in second_findings))
        developed = self.wait_ticket(ticket, "ready_test")
        self.assertEqual(developed["ticket"]["testRounds"], 2)
        self.assertEqual(git(developed["ticket"]["worktreePath"], "log", "--format=%s").splitlines()[:3],
                         [ticket["key"] + ": develop round 3", ticket["key"] + ": develop round 2",
                          ticket["key"] + ": develop round 1"])

        self.start(ticket, "QA", "verdict", fake("verdict_pass"))
        self.wait_ticket(ticket, "ready_review")

    def workflow(self, workflow_id):
        _, response, _ = self.sb.run("workflow", "show", "--workflow", workflow_id)
        self.assertTrue(response["ok"], response)
        return response["data"]

    def test_limits_no_change_invalid_plan_and_paused_retry(self):
        # A no-change develop visit is counted and returns to its picked queue.
        no_change = self.move(self.create(), "ready_dev")
        self.start(no_change, "Developer", "work", fake("success"))
        detail = self.wait_ticket(no_change, "ready_dev")
        self.assertEqual((detail["ticket"]["devRounds"], detail["ticket"]["findings"]), (1, ["NO_CHANGES"]))

        paused = self.create()
        self.prepare_worktree(paused)
        paused = self.move(paused, "ready_test")
        started = self.start(paused, "QA", "verdict", fake("verdict_malformed"))
        detail = self.wait_ticket(paused, "blocked")
        self.assertEqual((detail["ticket"]["blockedReason"], detail["ticket"]["returnStatus"]),
                         ("RUN_PAUSED:MALFORMED_VERDICT", "ready_test"))
        self.assert_outcome(detail, applied=False, paused=True)
        run = self.workflow(started["workflowRunId"])
        assignment = run["assignments"][-1]["id"]
        self.configure_next_fake(started["workflowRunId"], "verdict", fake("verdict_pass"))
        _, resolved, _ = self.sb.request(req("assignment.resolve", {"assignmentId": assignment, "action": "retry"},
                                              idempotencyKey=key()))
        self.assertTrue(resolved["ok"], resolved)
        detail = self.wait_ticket(paused, "ready_review")
        self.assertEqual((detail["ticket"]["returnStatus"], detail["ticket"]["blockedReason"]), (None, None))

        # Planning changes outside the phase are deliberately left uncommitted and block the ticket.
        invalid = self.create()
        self.start(invalid, "TeamLead", "verdict", fake("verdict_pass", "outside.txt"))
        detail = self.wait_ticket(invalid, "blocked")
        self.assertEqual((detail["ticket"]["blockedReason"], detail["ticket"]["returnStatus"]),
                         ("PLANNING_DIFF_INVALID", "refine"))
        self.assertTrue(os.path.exists(os.path.join(self.workspace, "outside.txt")))

    def test_develop_validation_failure_at_visit_limit_counts_one_failed_round(self):
        ticket = self.move(self.create(), "ready_dev")
        options = [fake("success", "broken-one.txt"), fake("success", "broken-two.txt"),
                   fake("success", "broken-three.txt")]
        started = self.start(ticket, "Developer", "work", options)
        detail = self.wait_ticket(ticket, "ready_dev")
        run = self.workflow(started["workflowRunId"])
        self.assertEqual((run["workflowRun"]["status"], run["visits"].get("work")), ("failed", 3))
        self.assertEqual((detail["ticket"]["status"], detail["ticket"]["devRounds"]), ("ready_dev", 1))

    def test_cancelled_releases_and_second_test_failure_crosses_limit(self):
        cancelled = self.move(self.create(), "ready_dev")
        started = self.start(cancelled, "Developer", "work", fake("slow", duration=30000))
        _, response, _ = self.sb.request(req("workflow.cancel", {"workflowRunId": started["workflowRunId"]},
                                             idempotencyKey=key()))
        self.assertTrue(response["ok"], response)
        detail = self.wait_ticket(cancelled, "ready_dev")
        self.assert_outcome(detail)
        self.assertEqual(detail["ticket"]["devRounds"], 0)
        self.assertIn("ticket.released", [event["name"] for event in detail["events"]])

        config_path = os.path.join(self.workspace, ".agent-studio", "board.json")
        with open(config_path, encoding="utf-8") as f:
            config = json.load(f)
        config["roundLimits"] = {"dev": 3, "test": 1, "review": 3}
        with open(config_path, "w", encoding="utf-8") as f:
            json.dump(config, f)
        limited = self.create()
        self.prepare_worktree(limited)
        limited = self.move(limited, "ready_test")
        self.start(limited, "QA", "verdict", fake("verdict_fail"))
        self.wait_ticket(limited, "fail_test")
        self.start(limited, "Developer", "work", fake("success", "fixed.txt"))
        self.wait_ticket(limited, "ready_test")
        self.start(limited, "QA", "verdict", fake("verdict_fail"))
        detail = self.wait_ticket(limited, "blocked")
        self.assertEqual((detail["ticket"]["testRounds"], detail["ticket"]["blockedReason"],
                          detail["ticket"]["returnStatus"]), (2, "ROUND_LIMIT:test", "fail_test"))

    def test_outcome_crashes_recover_without_duplicate_commits_or_events(self):
        for point in ("before_outcome_apply", "after_outcome_git_commit", "after_outcome_commit"):
            with self.subTest(point=point):
                self.restart_with_crash(point)
                ticket = self.move(self.create(), "ready_dev")
                self.start(ticket, "Developer", "work", fake("success", "fixed.txt"))
                self.recover(point)
                detail = self.wait_ticket(ticket, "ready_test")
                events = detail["events"]
                self.assertEqual(sum(e["name"] == "ticket.outcome_applied" for e in events), 1)
                self.assertEqual(sum(e["name"] == "ticket.committed" for e in events), 1)
                self.assertEqual(git(detail["ticket"]["worktreePath"], "log", "--format=%s", "-1"),
                                 ticket["key"] + ": develop round 1")

        # Crash markers are intentionally one-shot per coordinator state; use a fresh drill marker.
        os.unlink(os.path.join(self.sb.state_dir, "crashed-at-after_outcome_git_commit"))
        self.restart_with_crash("after_outcome_git_commit")
        refine = self.create()
        self.start(refine, "TeamLead", "verdict", fake("verdict_pass", self.story))
        self.recover("after_outcome_git_commit")
        detail = self.wait_ticket(refine, "ready_dev")
        self.assertEqual(sum(e["name"] == "ticket.committed" for e in detail["events"]), 1)
        self.assertEqual(git(self.workspace, "log", "--format=%s", "-1"),
                         refine["key"] + ": refine " + self.story)


if __name__ == "__main__":
    unittest.main()
