"""Board workflows end to end on the fake provider (T-207).

One isolated coordinator + fake team + v4 board per class. The board routes through workflow files, never
legacy rules: a develop workflow retries its agent after a failing check, a QA verdict escalates after three
failures in a row, an action-only merge workflow lands a branch or records a conflict, an approval step waits
for ``workflow.approve``, an agent-created child ticket is held by ``createdTickets`` until a later merge pass
releases it, and a usage-limited run returns to its start status without counting a round.
"""
import json
import os
import subprocess
import time
import unittest

from tests.helpers import Sandbox, make_repo
from tests.integration.test_p01_s04_start import git

ROLES = {"version": 1, "roles": {"Developer": {}, "QA": {}, "Publisher": {}, "Planner": {}}}

STATUSES = [
    {"id": "none", "kind": "initial"},
    {"id": "dev-ready"}, {"id": "deving"},
    {"id": "qa-ready"}, {"id": "qa-ing"}, {"id": "need-escalate"},
    {"id": "prepare-ready"}, {"id": "preparing"},
    {"id": "merge-ready"}, {"id": "merging"}, {"id": "merged", "kind": "done"}, {"id": "merge-conflict"},
    {"id": "unpack-ready"}, {"id": "unpacking"}, {"id": "unpacked"},
    {"id": "held"}, {"id": "released"},
    {"id": "publish-ready"}, {"id": "publishing"}, {"id": "published", "kind": "done"},
    {"id": "publish-rejected"},
]
TODO_ENTRY = ["dev-ready", "qa-ready", "prepare-ready", "merge-ready", "unpack-ready", "publish-ready"]


def board_config(branch):
    return {"version": 4, "leaseSeconds": 600, "baseBranch": branch,
            "workflowStatuses": STATUSES, "ticketFields": [],
            "todoEntry": TODO_ENTRY, "todoDefault": "dev-ready"}


DEVELOP = {
    "version": 2, "startsAt": "dev-ready", "whileRunning": "deving", "role": "Developer",
    "workspace": "worktree",
    "end": {"pass": "qa-ready", "fail": "dev-ready"},
    "steps": [
        {"id": "implement", "agent": {"prompt": "implement.md", "access": "write"}},
        {"id": "check", "check": {"checks": "ci"},
         "onFail": {"retry": "implement", "max": 2, "then": "end-fail"}},
    ],
}

QA = {
    "version": 2, "startsAt": "qa-ready", "whileRunning": "qa-ing", "role": "QA",
    "end": {"pass": "merge-ready", "fail": "qa-ready"},
    "limits": {"failuresInARow": {"count": 3, "status": "need-escalate"}},
    "steps": [{"id": "check", "agent": {"prompt": "qa.md", "access": "read"}}],
}

PREPARE = {
    "version": 2, "startsAt": "prepare-ready", "whileRunning": "preparing", "role": "Developer",
    "workspace": "worktree",
    "end": {"pass": "merge-ready", "fail": "prepare-ready"},
    "steps": [{"id": "prepare", "agent": {"prompt": "prepare.md", "access": "write"}}],
}

MERGE = {
    "version": 2, "startsAt": "merge-ready", "whileRunning": "merging",
    "end": {"pass": {"status": "merged",
                     "releaseCreatedTickets": {"from": "held", "to": "released"}},
            "fail": "merge-conflict"},
    "steps": [{"id": "merge", "action": "merge"}],
}

PUBLISH = {
    "version": 2, "startsAt": "publish-ready", "whileRunning": "publishing", "role": "Publisher",
    "end": {"pass": "published", "fail": "publish-rejected"},
    "steps": [
        {"id": "prepare", "agent": {"prompt": "publish.md", "access": "read"}},
        {"id": "approve", "approval": {"ask": "Publish this ticket?"},
         "onPass": "end-pass", "onFail": "end-fail"},
    ],
}

UNPACK = {
    "version": 2, "startsAt": "unpack-ready", "whileRunning": "unpacking", "role": "Planner",
    "workspace": "worktree", "createdTickets": "held",
    "end": {"pass": "unpacked", "fail": "unpack-ready"},
    "steps": [{"id": "unpack", "agent": {"prompt": "unpack.md", "access": "read"}}],
}

PROMPTS = {
    "implement.md": "Implement the ticket.\n{{task}}",
    "qa.md": "Review the work and return a verdict.\n{{task}}",
    "prepare.md": "Prepare the change.\n{{task}}",
    "publish.md": "Prepare this ticket for publishing.\n{{task}}",
    "unpack.md": "Unpack the request and add follow-up tickets.\n{{task}}",
}


class BoardWorkflowCase(unittest.TestCase):
    """A fresh isolated workspace for one scenario, with only the workflow files the scenario needs."""

    workflows = {}
    members = []
    check_counter = False
    fake_scenario = "verdict_pass"

    def setUp(self):
        self.sb = Sandbox(extra_env={"AGENT_STUDIO_FAKE_SCENARIO": self.fake_scenario})
        rc, r, p = self.sb.run("coordinator", "start", "--enable-debug")
        self.assertTrue(r["ok"], p.stderr)
        self.ws = make_repo()
        self.cfg = os.path.join(self.ws, ".agent-studio")
        os.makedirs(os.path.join(self.cfg, "teams"))
        os.makedirs(os.path.join(self.cfg, "workflows", "prompts"))
        branch = subprocess.run(["git", "-C", self.ws, "symbolic-ref", "--short", "HEAD"],
                                stdout=subprocess.PIPE, text=True, check=True).stdout.strip()
        self.put("roles.json", ROLES)
        self.put("board.json", board_config(branch))
        for name, definition in self.workflows.items():
            self.put(f"workflows/{name}.json", definition)
        for name, text in PROMPTS.items():
            with open(os.path.join(self.cfg, "workflows", "prompts", name), "w") as f:
                f.write(text)
        if self.check_counter:
            self.write_commands()
        self.put("teams/alpha.json", {"id": "alpha", "name": "Alpha",
                                      "members": [dict(member) for member in self.members]})
        git(self.ws, "add", "-A")
        git(self.ws, "commit", "-qm", "board workflow fixture")

    def tearDown(self):
        self.sb.cleanup()

    # -- fixture helpers ---------------------------------------------------------------------------------

    def put(self, rel, obj):
        with open(os.path.join(self.cfg, rel), "w") as f:
            json.dump(obj, f)

    def write_commands(self):
        script = os.path.join(self.sb.root, "check_once.py")
        counter = os.path.join(self.sb.root, "check-count")
        with open(script, "w") as f:
            f.write(
                "import os, sys\n"
                "counter = sys.argv[1]\n"
                "seen = int(open(counter).read()) if os.path.exists(counter) else 0\n"
                "open(counter, 'w').write(str(seen + 1))\n"
                "print('check attempt', seen + 1)\n"
                "sys.exit(0 if seen else 1)\n")
        self.put("commands.json", {
            "version": 1,
            "commands": {
                "check-once": {"description": "Fail once, then pass",
                               "argv": ["python3", script, counter], "timeoutMs": 20000},
            },
            "checkSets": {
                "ci": {"run": [{"command": "check-once", "when": ["**"]}],
                       "otherwise": "check-once"},
            },
        })

    def start_team(self):
        rc, r, p = self.sb.run("team", "start", "--workspace", self.ws, "--team", "alpha")
        self.assertTrue(r["ok"], (r, p.stderr))
        return r["data"]

    def json_cmd(self, *argv, timeout=120):
        rc, r, p = self.sb.run(*argv, "--workspace", self.ws, "--json", timeout=timeout)
        self.assertTrue(r["ok"], (argv, r, p.stderr))
        return r["data"]

    def ticket(self, key):
        return self.json_cmd("ticket", "show", key)["ticket"]

    def events(self, key):
        return self.json_cmd("ticket", "show", key)["events"]

    def add_ticket(self, title, workflow_status):
        ticket = self.json_cmd("ticket", "add", "--title", title)["ticket"]
        self.json_cmd("ticket", "move", ticket["key"], "--to", "todo",
                      "--workflow-status", workflow_status)
        return ticket

    def run_board(self):
        return self.json_cmd("team", "run-board", "--team", "alpha")

    def stop_board(self):
        return self.json_cmd("team", "stop-board", "--team", "alpha")

    def workflow_show(self, run):
        rc, r, p = self.sb.run("workflow", "show", "--workflow", run)
        self.assertTrue(r["ok"], (r, p.stderr))
        return r["data"]

    def wait_run_id(self, ticket_key, timeout=120):
        return self.wait_for(lambda: self.ticket(ticket_key).get("activeRunId"), timeout,
                             f"{ticket_key} to be claimed by a run")

    # -- waiting -----------------------------------------------------------------------------------------

    def wait_for(self, fn, timeout=120, message="condition"):
        deadline = time.monotonic() + timeout
        last = None
        while time.monotonic() < deadline:
            last = fn()
            if last:
                return last
            time.sleep(0.25)
        raise AssertionError(f"timed out waiting for {message}; last={last!r}")

    def wait_status(self, ticket_key, statuses, timeout=120):
        return self.wait_for(
            lambda: (lambda t: t if t["workflowStatus"] in statuses else None)(self.ticket(ticket_key)),
            timeout, f"{ticket_key} in {statuses}")

    def wait_claimed(self, ticket_key, timeout=120):
        return self.wait_for(
            lambda: (lambda t: t if t.get("worktreePath") else None)(self.ticket(ticket_key)),
            timeout, f"{ticket_key} claimed with a worktree")

    def wait_event(self, ticket_key, name, timeout=120):
        return self.wait_for(
            lambda: next((e for e in self.events(ticket_key) if e["name"] == name), None),
            timeout, f"{ticket_key} event {name}")


class DevelopCheckRetry(BoardWorkflowCase):
    workflows = {"develop": DEVELOP, "merge": MERGE}
    members = [{"id": "ryan", "name": "Ryan", "role": "Developer", "provider": "fake"}]
    check_counter = True

    def test_agent_check_step_fails_once_retries_the_agent_then_passes_to_qa_ready(self):
        self.start_team()
        ticket = self.add_ticket("retry the check", "dev-ready")
        self.run_board()
        done = self.wait_status(ticket["key"], ("qa-ready",))
        self.assertIsNone(done["assignee"])

        run = done["runId"]
        detail = self.workflow_show(run)
        self.assertEqual(detail["workflowRun"]["status"], "succeeded")
        self.assertEqual([(s["stage"], s["visit"], s["outcome"]) for s in detail["stageAttempts"]],
                         [("implement", 1, "verdict_pass"), ("check", 1, "validation_failed"),
                          ("implement", 2, "verdict_pass"), ("check", 2, "validation_passed")])
        self.assertEqual([(r["command"], r["status"]) for r in detail["commandRequests"]],
                         [("check-once", "failed"), ("check-once", "succeeded")])
        stages = {s["id"]: s for s in detail["workflowRun"]["definition"]["stages"]}
        self.assertEqual(stages["implement"]["maxVisits"], 3)  # retry max 2 => two retries


class QaVerdictEscalation(BoardWorkflowCase):
    workflows = {"qa": QA}
    members = [{"id": "sam", "name": "Sam", "role": "QA", "provider": "fake"}]
    fake_scenario = "verdict_fail"

    def test_three_failed_verdicts_in_a_row_escalate(self):
        self.start_team()
        ticket = self.add_ticket("fails review", "qa-ready")
        self.run_board()
        escalated = self.wait_status(ticket["key"], ("need-escalate",), timeout=180)
        self.assertEqual(escalated["rounds"], {"qa": 3})
        outcomes = [e for e in self.events(ticket["key"]) if e["name"] == "ticket.outcome_applied"]
        self.assertEqual([(e["payload"]["outcome"], e["payload"]["reason"]) for e in outcomes],
                         [("fail", None), ("fail", None), ("fail", "FAILURE_LIMIT:qa")])
        self.assertEqual({e["payload"]["workflow"] for e in outcomes}, {"qa"})


class MergeAction(BoardWorkflowCase):
    workflows = {"prepare": PREPARE, "merge": MERGE}
    members = [{"id": "ryan", "name": "Ryan", "role": "Developer", "provider": "fake"},
               {"id": "reese", "name": "Reese", "role": "Developer", "provider": "fake"}]

    def seed(self, worktree, content):
        with open(os.path.join(worktree, "shared.txt"), "w") as f:
            f.write(content)
        git(worktree, "add", "-A")
        git(worktree, "commit", "-qm", "ticket change")

    def test_action_only_merge_workflow_merges_the_branch(self):
        self.start_team()
        ticket = self.add_ticket("merge me", "prepare-ready")
        self.run_board()
        merged = self.wait_status(ticket["key"], ("merged",))
        self.assertEqual((merged["status"], merged["worktreePath"]), ("done", None))
        outcomes = [e for e in self.events(ticket["key"]) if e["name"] == "ticket.outcome_applied"]
        self.assertEqual(outcomes[-1]["payload"]["workflow"], "merge")
        self.assertEqual(outcomes[-1]["payload"]["outcome"], "pass")

    def test_conflicting_branches_land_in_merge_conflict(self):
        self.start_team()
        first = self.add_ticket("first change", "prepare-ready")
        second = self.add_ticket("second change", "prepare-ready")
        self.run_board()
        claimed_first = self.wait_claimed(first["key"])
        claimed_second = self.wait_claimed(second["key"])
        self.stop_board()  # freeze the flow while both branches are cut from the same base
        self.seed(claimed_first["worktreePath"], "from first\n")
        self.seed(claimed_second["worktreePath"], "from second\n")

        winner = self.wait_for(
            lambda: next((t["key"] for t in (self.ticket(first["key"]), self.ticket(second["key"]))
                          if t["workflowStatus"] == "merged"), None),
            180, "one branch to merge")
        loser = second["key"] if winner == first["key"] else first["key"]
        conflict = self.wait_event(loser, "ticket.merge_conflict", timeout=120)
        self.assertIn("MERGE_CONFLICT", json.dumps(conflict["payload"]))
        self.assertEqual(self.ticket(loser)["workflowStatus"], "merge-conflict")
        with open(os.path.join(self.ws, "shared.txt")) as f:
            self.assertEqual(f.read(), "from first\n" if winner == first["key"] else "from second\n")


class PublishApproval(BoardWorkflowCase):
    workflows = {"publish": PUBLISH}
    members = [{"id": "pat", "name": "Pat", "role": "Publisher", "provider": "fake"}]

    def decide(self, run, approve):
        flags = ["--yes"] if approve else ["--no"]
        rc, r, p = self.sb.run("workflow", "approve", run, "approve", *flags)
        self.assertTrue(r["ok"], (r, p.stderr))
        return r["data"]

    def wait_approval(self, run):
        return self.wait_for(
            lambda: (lambda d: d if d.get("waitingApproval") else None)(self.workflow_show(run)),
            120, f"workflow {run} waiting for approval")

    def test_approval_step_passes_and_rejects_through_workflow_approve(self):
        self.start_team()
        approved = self.add_ticket("publish me", "publish-ready")
        self.run_board()
        waiting = self.wait_approval(self.wait_run_id(approved["key"]))
        self.assertEqual((waiting["waitingApproval"]["stage"], waiting["waitingApproval"]["ask"]),
                         ("approve", "Publish this ticket?"))
        self.assertEqual(self.ticket(approved["key"])["workflowStatus"], "publishing")
        decision = self.decide(waiting["workflowRun"]["id"], True)
        self.assertEqual(decision["outcome"], "pass")
        published = self.wait_status(approved["key"], ("published",))
        self.assertEqual((published["status"], published["assignee"]), ("done", None))

        rejected = self.add_ticket("do not publish", "publish-ready")
        waiting = self.wait_approval(self.wait_run_id(rejected["key"]))
        decision = self.decide(waiting["workflowRun"]["id"], False)
        self.assertEqual(decision["outcome"], "fail")
        refused = self.wait_status(rejected["key"], ("publish-rejected",))
        self.assertEqual(refused["assignee"], None)


class UnpackCreatedTickets(BoardWorkflowCase):
    workflows = {"unpack": UNPACK, "merge": MERGE}
    members = [{"id": "lee", "name": "Lee", "role": "Planner", "provider": "fake",
                "canAddTickets": True}]

    def children(self, parent):
        tickets = self.json_cmd("ticket", "list")["tickets"]
        return [t for t in tickets if t.get("parentTicketId") == parent["id"]]

    def test_created_tickets_are_held_then_released_by_the_merge_workflows_pass(self):
        self.start_team()
        parent = self.add_ticket("unpack the request", "unpack-ready")
        self.run_board()
        unpacked = self.wait_status(parent["key"], ("unpacked",))
        self.stop_board()

        children = self.wait_for(lambda: self.children(unpacked) if len(self.children(unpacked)) == 2 else None,
                                 120, "two created tickets")
        self.assertEqual({c["title"] for c in children},
                         {"Finding: retry swallows errors", "Finding: cache never invalidates"})
        self.assertEqual({c["workflowStatus"] for c in children}, {"held"})

        self.json_cmd("ticket", "workflow", parent["key"], "merge-ready")
        merged = self.wait_status(parent["key"], ("merged",))
        self.assertEqual((merged["status"], merged["worktreePath"]), ("done", None))
        released = self.wait_for(
            lambda: (lambda all_children: all_children
                     if all(c["workflowStatus"] == "released" for c in all_children)
                     and len(all_children) == 2 else None)(self.children(merged)),
            120, "children released")
        for child in released:
            event = next(e for e in self.events(child["key"]) if e["name"] == "ticket.workflow_changed")
            self.assertEqual(event["payload"]["reason"], f"released by {parent['key']}")


class UsageLimitPause(BoardWorkflowCase):
    workflows = {"qa": QA}
    members = [{"id": "sam", "name": "Sam", "role": "QA", "provider": "fake"}]
    fake_scenario = "usage_limit"

    def test_usage_limited_run_returns_to_starts_at_without_counting_a_round(self):
        self.start_team()
        ticket = self.add_ticket("limit reached", "qa-ready")
        self.run_board()
        released = self.wait_for(
            lambda: (lambda t: t if t["workflowStatus"] == "qa-ready" and t["assignee"] is None
                     and t["runId"] else None)(self.ticket(ticket["key"])),
            120, "the usage-limited ticket to return to qa-ready")
        self.assertEqual((released["workflowStatus"], released["rounds"]), ("qa-ready", None))
        run = released["runId"]
        detail = self.workflow_show(run)
        self.assertEqual(detail["workflowRun"]["status"], "failed")
        event = self.wait_event(ticket["key"], "ticket.run_paused")
        self.assertEqual((event["payload"]["reason"], event["payload"]["to"]), ("USAGE_LIMIT", "qa-ready"))
        self.assertFalse([e for e in self.events(ticket["key"]) if e["name"] == "ticket.outcome_applied"])


if __name__ == "__main__":
    unittest.main()
