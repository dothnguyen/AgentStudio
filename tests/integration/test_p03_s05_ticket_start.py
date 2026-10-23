"""P03-S05 manual board starts exercise the live coordinator and fake providers."""
import json
import os
import sqlite3
import subprocess
import unittest

from tests.helpers import Sandbox, key, make_repo, req


def git(workspace, *args):
    return subprocess.run(["git", "-C", workspace, *args], check=True, text=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.strip()


class TicketStartIntegration(unittest.TestCase):
    def setUp(self):
        self.sb = Sandbox(extra_env={"AGENT_STUDIO_TEST_FIXTURE_PROVIDERS": "codex=fake,claude=fake,agy=fake"})
        _, started, proc = self.sb.run("coordinator", "start", "--enable-debug")
        self.assertTrue(started["ok"], proc.stderr)
        self.workspace = make_repo()
        os.makedirs(os.path.join(self.workspace, "stories"))
        for name in ("one", "two", "three", "four"):
            with open(os.path.join(self.workspace, "stories", name + ".md"), "w", encoding="utf-8") as f:
                f.write("# " + name.title() + "\n")
        base_branch = git(self.workspace, "symbolic-ref", "--short", "HEAD")
        with open(os.path.join(self.workspace, ".agent-studio", "board.json"), "w", encoding="utf-8") as f:
            json.dump({"baseBranch": base_branch}, f)
        git(self.workspace, "add", "-A")
        git(self.workspace, "commit", "-m", "stories")
        roster = [{"providerId": "codex", "role": "TeamLead"},
                  {"providerId": "claude", "role": "Developer"},
                  {"providerId": "agy", "role": "QA"}]
        _, team, _ = self.sb.request(req("team.start", {"workspace": self.workspace, "roster": roster},
                                         idempotencyKey=key()))
        self.assertTrue(team["ok"], team)
        self.agents = {agent["role"]: agent["agentId"] for agent in team["data"]["agents"]}

    def tearDown(self):
        self.sb.cleanup()

    def create(self, story, **extra):
        args = {"workspace": self.workspace, "storyPath": "stories/" + story + ".md", **extra}
        _, response, _ = self.sb.request(req("ticket.create", args, idempotencyKey=key()))
        self.assertTrue(response["ok"], response)
        return response["data"]["ticket"]

    def move(self, ticket, status):
        _, response, _ = self.sb.request(req("ticket.move", {"workspace": self.workspace, "key": ticket["key"],
                                                            "to": status}, idempotencyKey=key()))
        self.assertTrue(response["ok"], response)
        return response["data"]["ticket"]

    def start(self, ticket, role):
        _, response, _ = self.sb.request(req("ticket.start", {"workspace": self.workspace, "key": ticket["key"],
                                                             "agentId": self.agents[role]}, idempotencyKey=key()))
        return response

    def detail(self, key_name):
        _, response, _ = self.sb.request(req("ticket.show", {"workspace": self.workspace, "key": key_name}))
        self.assertTrue(response["ok"], response)
        return response["data"]

    def workflow(self, workflow_id):
        _, response, _ = self.sb.run("workflow", "show", "--workflow", workflow_id)
        self.assertTrue(response["ok"], response)
        return response["data"]

    def update_findings(self, ticket, findings):
        conn = sqlite3.connect(os.path.join(self.sb.state_dir, "state.db"), timeout=10)
        try:
            conn.execute("UPDATE tickets SET findings_json = ? WHERE id = ?", (json.dumps(findings), ticket["id"]))
            conn.commit()
        finally:
            conn.close()

    @staticmethod
    def unchanged(ticket):
        return tuple(ticket[name] for name in ("status", "assigneeAgentId", "leaseUntil", "runId", "branch", "worktreePath"))

    def test_refine_claims_ticket_and_renders_task_on_main(self):
        ticket = self.create("one")
        started = self.start(ticket, "TeamLead")
        self.assertTrue(started["ok"], started)
        ticket = started["data"]["ticket"]
        self.assertEqual(ticket["status"], "refining")
        self.assertEqual(ticket["assignee_agent_id"], self.agents["TeamLead"])
        self.assertTrue(ticket["lease_until"])
        self.assertTrue(ticket["run_id"])
        self.assertEqual(started["data"]["definition"], "board-refine")
        self.assertEqual(started["data"]["workspace"], self.workspace)
        detail = self.detail(ticket["key"])
        self.assertEqual([event["name"] for event in detail["events"]][-2:], ["ticket.claimed", "ticket.run_started"])
        run = self.workflow(ticket["run_id"])
        prompt = open(run["stageAttempts"][0]["promptPath"], encoding="utf-8").read()
        self.assertIn("T-001", prompt)
        self.assertIn("stories/one.md", prompt)

    def test_develop_creates_worktree_and_renders_findings_seed(self):
        self.create("one")  # Reserve T-001; the scenario under test is T-002.
        ticket = self.move(self.create("two"), "ready_dev")
        self.update_findings(ticket, ["fix-me-123"])
        started = self.start(ticket, "Developer")
        self.assertTrue(started["ok"], started)
        ticket = started["data"]["ticket"]
        self.assertEqual(ticket["status"], "in_dev")
        self.assertEqual(ticket["branch"], "ticket/T-002-two")
        self.assertTrue(ticket["worktree_path"])
        self.assertTrue(os.path.isdir(ticket["worktree_path"]))
        self.assertEqual(started["data"]["definition"], "board-develop")
        self.assertEqual(started["data"]["workspace"], ticket["worktree_path"])
        detail = self.detail(ticket["key"])
        self.assertIn("ticket.worktree_created", [event["name"] for event in detail["events"]])
        run = self.workflow(ticket["run_id"])
        prompt = open(run["stageAttempts"][0]["promptPath"], encoding="utf-8").read()
        self.assertIn("fix-me-123", prompt)

    def test_test_uses_registered_worktree_diff_as_seed(self):
        ticket = self.create("one")
        _, created, _ = self.sb.request(req("debug.ticket_worktree", {"workspace": self.workspace, "key": ticket["key"]},
                                            idempotencyKey=key()))
        self.assertTrue(created["ok"], created)
        worktree = created["data"]["worktree"]["path"]
        with open(os.path.join(worktree, "seeded.txt"), "w", encoding="utf-8") as f:
            f.write("seed\n")
        git(worktree, "add", "seeded.txt")
        git(worktree, "commit", "-m", "seed diff")
        ticket = self.move(ticket, "ready_test")
        started = self.start(ticket, "QA")
        self.assertTrue(started["ok"], started)
        self.assertEqual(started["data"]["ticket"]["status"], "in_test")
        run = self.workflow(started["data"]["ticket"]["run_id"])
        prompt = open(run["stageAttempts"][0]["promptPath"], encoding="utf-8").read()
        self.assertIn("seeded.txt", prompt)

    def test_refusals_leave_tickets_unchanged_and_do_not_create_runs(self):
        role_mismatch = self.create("one")
        blocked_by = self.create("two")
        dependency = self.create("three", dependsOn=[blocked_by["key"]])
        dependency = self.move(dependency, "ready_dev")
        already_started = self.move(self.create("four"), "ready_dev")
        first_start = self.start(already_started, "Developer")
        self.assertTrue(first_start["ok"], first_start)
        no_worktree = self.move(self.create("one"), "ready_test")
        cases = ((role_mismatch, "QA", "TICKET_ROLE_MISMATCH"),
                 (dependency, "Developer", "TICKET_DEPS_NOT_MERGED"),
                 (already_started, "Developer", "TICKET_TRANSITION_INVALID"),
                 (no_worktree, "QA", "WORKTREE_NOT_REGISTERED"))
        for ticket, role, code in cases:
            before = self.detail(ticket["key"])["ticket"]
            response = self.start(ticket, role)
            self.assertFalse(response["ok"], response)
            self.assertEqual(response["error"]["code"], code)
            after = self.detail(ticket["key"])["ticket"]
            self.assertEqual(self.unchanged(after), self.unchanged(before))
        # The already-started ticket owns its original run; none of the refusals added one.
        self.assertEqual(len(self.sb.snapshot()["workflowRuns"]), 1)

    def test_failures_roll_back_dirty_refine_and_created_develop_worktree(self):
        dirty = self.create("one")
        with open(os.path.join(self.workspace, "uncommitted.txt"), "w", encoding="utf-8") as f:
            f.write("dirty\n")
        response = self.start(dirty, "TeamLead")
        self.assertFalse(response["ok"], response)
        self.assertEqual(response["error"]["code"], "WORKSPACE_DIRTY")
        after_dirty = self.detail(dirty["key"])["ticket"]
        self.assertEqual((after_dirty["status"], after_dirty["runId"]), ("refine", None))
        os.unlink(os.path.join(self.workspace, "uncommitted.txt"))

        config_path = os.path.join(self.workspace, ".agent-studio", "board.json")
        with open(config_path, encoding="utf-8") as f:
            config = json.load(f)
        config["columns"] = {"develop": {"definition": "missing-definition", "role": "Developer"}}
        with open(config_path, "w", encoding="utf-8") as f:
            json.dump(config, f)
        developing = self.move(self.create("two"), "ready_dev")
        response = self.start(developing, "Developer")
        self.assertFalse(response["ok"], response)
        self.assertEqual(response["error"]["code"], "WORKFLOW_DEFINITION_NOT_FOUND")
        after_develop = self.detail(developing["key"])["ticket"]
        self.assertEqual((after_develop["status"], after_develop["runId"], after_develop["worktreePath"]),
                         ("ready_dev", None, None))
        self.assertEqual(git(self.workspace, "branch", "--list", "ticket/T-002-two"), "")
        self.assertNotIn("ticket/T-002-two", git(self.workspace, "worktree", "list", "--porcelain"))


if __name__ == "__main__":
    unittest.main()
