"""P03-S04: registered worktrees isolate concurrent workflow and direct runs."""
import json
import os
import subprocess
import unittest

from tests.helpers import Sandbox, key, make_repo, req, wait_until
from tests.integration.test_p01_s04_start import FINAL, fake


ALIASES = {"AGENT_STUDIO_TEST_FIXTURE_PROVIDERS": "codex=fake,claude=fake,agy=fake"}
ONE_WRITE = {"version": 1, "stages": [
    {"id": "develop", "role": "Developer", "permission": "workspace_write", "maxVisits": 1,
     "prompt": "{{task}}", "next": {"done": "$succeed"}},
]}


def git(workspace, *args):
    return subprocess.run(["git", "-C", workspace, *args], check=True, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, text=True).stdout.strip()


class PerRunWorkspace(unittest.TestCase):
    def setUp(self):
        self.sb = Sandbox(extra_env=ALIASES)
        _, response, proc = self.sb.run("coordinator", "start", "--enable-debug")
        self.assertTrue(response["ok"], proc.stderr)
        self.ws = make_repo()
        self._write_definition(self.ws)
        roles = os.path.join(self.ws, ".agent-studio", "roles")
        os.makedirs(roles)
        with open(os.path.join(roles, "Developer.md"), "w", encoding="utf-8") as f:
            f.write("MAIN ROLE TEXT\n")
        os.makedirs(os.path.join(self.ws, "stories"))
        for name in ("one", "two", "three"):
            with open(os.path.join(self.ws, "stories", name + ".md"), "w", encoding="utf-8") as f:
                f.write("# " + name + "\n")
        git(self.ws, "add", "-A")
        git(self.ws, "commit", "-qm", "definitions and stories")
        roster = [{"providerId": "codex", "role": "Developer"}, {"providerId": "claude", "role": "Developer"},
                  {"providerId": "agy", "role": "QA"}]
        _, response, _ = self.sb.request(req("team.start", {"workspace": self.ws, "roster": roster},
                                            idempotencyKey=key()))
        self.assertTrue(response["ok"], response)
        self.team = response["data"]
        self.devs = [a["agentId"] for a in self.team["agents"] if a["role"] == "Developer"]

    def tearDown(self):
        self.sb.cleanup()

    def _write_definition(self, workspace):
        directory = os.path.join(workspace, ".agent-studio", "workflows")
        os.makedirs(directory, exist_ok=True)
        with open(os.path.join(directory, "one-write.json"), "w", encoding="utf-8") as f:
            json.dump(ONE_WRITE, f)

    def ticket_worktree(self, story):
        _, made, _ = self.sb.request(req("ticket.create", {"workspace": self.ws, "storyPath": "stories/" + story + ".md"},
                                         idempotencyKey=key()))
        self.assertTrue(made["ok"], made)
        ticket = made["data"]["ticket"]
        _, created, _ = self.sb.request(req("debug.ticket_worktree", {"workspace": self.ws, "key": ticket["key"]},
                                            idempotencyKey=key()))
        self.assertTrue(created["ok"], created)
        return ticket, created["data"]["worktree"]["path"]

    def start(self, workspace, agent, *, duration=2000, write="out.txt"):
        args = {"teamId": self.team["teamId"], "definition": "one-write", "text": "write", "workspace": workspace,
                "bindings": {"Developer": agent}, "debugStageOptions": {"develop": fake("success", write, duration)}}
        _, response, _ = self.sb.request(req("workflow.start", args, idempotencyKey=key()))
        return response

    @staticmethod
    def touched(detail):
        """Files a captured diff names: tracked changes plus new (untracked) files."""
        diff = detail["stageAttempts"][0]["diff"]
        return sorted(set(diff["changedFiles"]) | set(diff["untrackedFiles"]))

    def show(self, workflow_id):
        _, response, _ = self.sb.run("workflow", "show", "--workflow", workflow_id)
        self.assertTrue(response["ok"], response)
        return response["data"]

    def wait(self, workflow_id, statuses=FINAL, timeout=45):
        return wait_until(lambda: self.show(workflow_id)["workflowRun"]["status"] in statuses and self.show(workflow_id),
                          timeout=timeout, message="workflow completion")

    def direct(self, workspace, agent, duration=1000):
        args = {"teamId": self.team["teamId"], "agentId": agent, "policy": "workspace_write", "text": "write",
                "workspace": workspace, "debugProviderOptions": fake("success", "direct.txt", duration)}
        _, response, _ = self.sb.request(req("task.direct", args, idempotencyKey=key()))
        return response

    def test_parallel_worktrees_are_independent_and_main_is_unchanged(self):
        _, first = self.ticket_worktree("one")
        _, second = self.ticket_worktree("two")
        main_head, main_status = git(self.ws, "rev-parse", "HEAD"), git(self.ws, "status", "--porcelain")
        one = self.start(first, self.devs[0], write="one.txt")
        two = self.start(second, self.devs[1], write="two.txt")
        self.assertTrue(one["ok"] and two["ok"], (one, two))
        wait_until(lambda: self.show(one["data"]["workflowRunId"])["assignments"][0]["status"] == "running" and
                   self.show(two["data"]["workflowRunId"])["assignments"][0]["status"] == "running", timeout=20,
                   message="both worktree runs running")
        done_one, done_two = self.wait(one["data"]["workflowRunId"]), self.wait(two["data"]["workflowRunId"])
        self.assertEqual((done_one["workflowRun"]["status"], done_two["workflowRun"]["status"]), ("succeeded", "succeeded"))
        self.assertEqual(self.touched(done_one), ["one.txt"])
        self.assertEqual(self.touched(done_two), ["two.txt"])
        self.assertEqual((git(self.ws, "rev-parse", "HEAD"), git(self.ws, "status", "--porcelain")), (main_head, main_status))

    def test_workspace_locks_are_per_worktree_and_main_remains_available(self):
        _, worktree = self.ticket_worktree("one")
        active = self.start(worktree, self.devs[0], duration=6000)
        self.assertTrue(active["ok"], active)
        wait_until(lambda: self.show(active["data"]["workflowRunId"])["assignments"][0]["status"] == "running", timeout=20)
        again = self.start(worktree, self.devs[1])
        self.assertEqual(again["error"]["code"], "WORKSPACE_BUSY")
        blocked_direct = self.direct(worktree, self.devs[1])
        self.assertEqual(blocked_direct["error"]["code"], "WORKSPACE_BUSY")
        main = self.direct(self.ws, self.devs[1])
        self.assertTrue(main["ok"], main)

    def test_coordinator_refuses_unregistered_and_cancelled_worktrees_without_tasks(self):
        ticket, registered = self.ticket_worktree("one")
        plain = os.path.join(self.sb.root, "plain")
        git(self.ws, "worktree", "add", "-b", "plain-worktree", plain, "HEAD")
        bad = ("/tmp/x", os.path.dirname(self.ws), plain)
        before = len(self.sb.snapshot()["tasks"])
        for workspace in bad:
            for command, args in (("workflow.start", {"teamId": self.team["teamId"], "definition": "one-write", "text": "x",
                                                         "workspace": workspace, "bindings": {"Developer": self.devs[0]}}),
                                  ("task.direct", {"teamId": self.team["teamId"], "agentId": self.devs[0], "policy": "workspace_write",
                                                   "text": "x", "workspace": workspace})):
                _, response, _ = self.sb.request(req(command, args, idempotencyKey=key()))
                self.assertEqual(response["error"]["code"], "WORKTREE_NOT_REGISTERED")
        _, cancelled, _ = self.sb.request(req("ticket.cancel", {"workspace": self.ws, "key": ticket["key"]},
                                              idempotencyKey=key()))
        self.assertTrue(cancelled["ok"], cancelled)
        for command, args in (("workflow.start", {"teamId": self.team["teamId"], "definition": "one-write", "text": "x",
                                                     "workspace": registered, "bindings": {"Developer": self.devs[0]}}),
                              ("task.direct", {"teamId": self.team["teamId"], "agentId": self.devs[0], "policy": "workspace_write",
                                               "text": "x", "workspace": registered})):
            _, response, _ = self.sb.request(req(command, args, idempotencyKey=key()))
            self.assertEqual(response["error"]["code"], "WORKTREE_NOT_REGISTERED")
        self.assertEqual(len(self.sb.snapshot()["tasks"]), before)

    def test_worktree_role_context_and_validation_configuration_are_frozen_from_worktree(self):
        _, worktree = self.ticket_worktree("one")
        roles = os.path.join(worktree, ".agent-studio", "roles")
        with open(os.path.join(roles, "Developer.md"), "w", encoding="utf-8") as f:
            f.write("WORKTREE ROLE TEXT\n")
        with open(os.path.join(worktree, ".agent-studio", "workflow.json"), "w", encoding="utf-8") as f:
            json.dump({"version": 1, "validation": {"argv": ["python3", "-c", "print('worktree validation')"], "timeoutMs": 20000}}, f)
        git(worktree, "add", "-A")
        git(worktree, "commit", "-qm", "worktree settings")
        response = self.start(worktree, self.devs[0], duration=100)
        self.assertTrue(response["ok"], response)
        self.assertEqual(response["data"]["validationArgv"], ["python3", "-c", "print('worktree validation')"])
        detail = self.show(response["data"]["workflowRunId"])
        self.assertIn("WORKTREE ROLE TEXT", detail["assignments"][0]["request"]["roleContext"]["text"])
        with open(os.path.join(self.ws, ".agent-studio", "roles", "Developer.md"), encoding="utf-8") as f:
            self.assertEqual(f.read(), "MAIN ROLE TEXT\n")
        with open(os.path.join(self.ws, ".agent-studio", "workflow.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["validation"]["argv"], ["python3", "check.py"])

    def test_restart_after_claim_uses_the_worktree(self):
        _, worktree = self.ticket_worktree("one")
        main_head, main_status = git(self.ws, "rev-parse", "HEAD"), git(self.ws, "status", "--porcelain")
        self.sb.run("coordinator", "stop")
        self.sb.env["AGENT_STUDIO_TEST_CRASH_AT"] = "after_claim_commit"
        _, started, proc = self.sb.run("coordinator", "start", "--enable-debug")
        self.assertTrue(started["ok"], proc.stderr)
        response = self.start(worktree, self.devs[0], duration=200, write="recovered.txt")
        self.assertTrue(response["ok"], response)
        wait_until(lambda: not self.sb.run("health")[1]["data"]["coordinator"]["running"], timeout=40,
                   message="crash point")
        self.sb.env.pop("AGENT_STUDIO_TEST_CRASH_AT")
        _, restarted, proc = self.sb.run("coordinator", "start", "--enable-debug")
        self.assertTrue(restarted["ok"], proc.stderr)
        detail = self.wait(response["data"]["workflowRunId"], timeout=60)
        self.assertEqual(self.touched(detail), ["recovered.txt"])
        self.assertEqual((git(self.ws, "rev-parse", "HEAD"), git(self.ws, "status", "--porcelain")), (main_head, main_status))


if __name__ == "__main__":
    unittest.main()
