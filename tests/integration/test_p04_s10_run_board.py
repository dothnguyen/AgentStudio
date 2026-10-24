"""P04-S10: `team run-board` works a board end to end on the fake provider — three rules to done, busy
members and stop-board, and worktree isolation with the coordinator-only merge (including a conflict)."""
import json
import os
import subprocess
import time
import unittest

from tests.helpers import SHIM, Sandbox, make_repo
from tests.integration.test_p01_s04_start import git

WORK = {"version": 1, "description": "work", "stages": [
    {"id": "work", "role": "worker", "permission": "read_only", "prompt": "Do.\n{{task}}",
     "next": {"done": "work2"}},
    {"id": "work2", "role": "worker", "permission": "read_only", "prompt": "More.\n{{task}}",
     "next": {"done": "$succeed"}}]}
CHECK = {"version": 1, "description": "check", "stages": [
    {"id": "look", "role": "checker", "permission": "read_only", "prompt": "Look.\n{{task}}",
     "next": {"done": "$succeed"}}]}
ROLES = {"version": 1, "roles": {"worker": {}, "checker": {}}}
THREE_RULES = {"version": 2,
               "statuses": [{"id": "build", "kind": "initial"}, {"id": "verify"},
                            {"id": "done", "kind": "done"}],
               "ticketFields": [],
               "rules": [
                   {"when": {"status": "build"}, "role": "worker", "workflow": "work",
                    "onPass": "verify", "onFail": "build"},
                   {"when": {"status": "verify"}, "role": "checker", "workflow": "check",
                    "onPass": "done", "onFail": "build"}]}
ONE_RULE = {"version": 2,
            "statuses": [{"id": "build", "kind": "initial"}, {"id": "done", "kind": "done"}],
            "ticketFields": [],
            "rules": [{"when": {"status": "build"}, "role": "worker", "workflow": "work",
                       "onPass": "done", "onFail": "build"}]}
WORKTREE_BOARD = {"version": 2, "leaseSeconds": 600,
                  "statuses": [{"id": "build", "kind": "initial"}, {"id": "ready"},
                               {"id": "done", "kind": "done"}],
                  "ticketFields": [],
                  "rules": [
                      {"when": {"status": "build"}, "role": "worker", "workflow": "work",
                       "onPass": "ready", "onFail": "build", "workspace": "worktree", "priority": 2,
                       "cap": 2},
                      {"when": {"status": "ready"}, "action": "merge", "onPass": "done",
                       "onFail": "build", "priority": 1}]}


class RunBoardCase(unittest.TestCase):
    board = THREE_RULES

    def setUp(self):
        self.sb = Sandbox()
        rc, r, p = self.sb.run("coordinator", "start", "--enable-debug")
        self.assertTrue(r["ok"], p.stderr)
        self.ws = make_repo()
        cfg = os.path.join(self.ws, ".agent-studio")
        os.makedirs(os.path.join(cfg, "teams"))
        os.makedirs(os.path.join(cfg, "workflows"))
        self.put("roles.json", ROLES)
        self.put("workflows/work.json", WORK)
        self.put("workflows/check.json", CHECK)
        self.write_board()
        self.put("teams/alpha.json", {"id": "alpha", "name": "Alpha", "members": [
            {"id": "ryan", "name": "Ryan", "role": "worker", "provider": "fake"},
            {"id": "sam", "name": "Sam", "role": "checker", "provider": "fake"}]})
        git(self.ws, "add", "-A")
        git(self.ws, "commit", "-qm", "team, workflows and board")

    def tearDown(self):
        self.sb.cleanup()

    def put(self, rel, obj):
        with open(os.path.join(self.ws, ".agent-studio", rel), "w") as f:
            json.dump(obj, f)

    def write_board(self):
        board = dict(self.board)
        if any(rule.get("workspace") == "worktree" or rule.get("action") == "merge"
               for rule in board["rules"]):
            board["baseBranch"] = subprocess.run(  # whatever branch make_repo made
                ["git", "-C", self.ws, "symbolic-ref", "--short", "HEAD"],
                stdout=subprocess.PIPE, text=True, check=True).stdout.strip()
        self.put("board.json", board)

    def human(self, *args, timeout=90):
        p = subprocess.run([SHIM, "team"] + list(args) + ["--workspace", self.ws], env=self.sb.env,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=timeout)
        return p.returncode, p.stdout, p.stderr

    def board_json(self, *args):
        rc, r, p = self.sb.run(*args, "--workspace", self.ws, "--json")
        self.assertTrue(r["ok"], (args, r, p.stderr))
        return r["data"]

    def ticket_json(self, key):
        return self.board_json("ticket", "show", key)["ticket"]

    def add_ticket(self, title="a"):
        return self.board_json("ticket", "add", "--title", title)["ticket"]

    def start_team(self):
        rc, r, p = self.sb.run("team", "start", "--workspace", self.ws, "--team", "alpha")
        self.assertTrue(r["ok"], (r, p.stderr))
        return r["data"]

    def run_board(self):
        rc, out, err = self.human("run-board", "--team", "alpha")
        self.assertEqual(rc, 0, err)
        return out

    def wait_status(self, key, statuses, timeout=60):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            ticket = self.ticket_json(key)
            if ticket["status"] in statuses:
                return ticket
            time.sleep(0.3)
        raise AssertionError(f"{key} never reached {statuses}; last={ticket}")

    def wait_claimed(self, key, timeout=60):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            ticket = self.ticket_json(key)
            if ticket.get("worktreePath") or ticket.get("assignee"):
                return ticket
            time.sleep(0.1)
        raise AssertionError(f"{key} was never claimed; last={ticket}")

    def wait_event(self, key, name, timeout=90):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            detail = self.board_json("ticket", "show", key)
            found = [e for e in detail["events"] if e["name"] == name]
            if found:
                return found[0]
            time.sleep(0.3)
        raise AssertionError(f"{key} never saw a {name} event; events={[e['name'] for e in detail['events']]}")


class ThreeRules(RunBoardCase):
    def test_a_ticket_runs_to_done_with_no_command_but_run_board(self):
        self.start_team()
        self.add_ticket("Ship it")
        out = self.run_board()
        self.assertIn("board", out)
        ticket = self.wait_status("T-001", ("done",), timeout=120)
        self.assertEqual(ticket["status"], "done")
        detail = self.board_json("ticket", "show", "T-001")
        names = [e["name"] for e in detail["events"]]
        self.assertEqual(names, ["ticket.created", "ticket.claimed", "ticket.outcome_applied",
                                 "ticket.claimed", "ticket.outcome_applied"])
        self.assertEqual([e["to"] for e in detail["events"]],
                         ["build", "build", "verify", "verify", "done"])


class BusyAndStop(RunBoardCase):
    board = ONE_RULE

    def test_a_busy_member_is_never_claimed_and_stop_board_stops_new_claims_only(self):
        team = self.start_team()
        ryan = next(a["agentId"] for a in team["agents"] if a["memberId"] == "ryan")
        rc, r, p = self.sb.run("debug", "assign", "--agent", ryan, "--scenario", "slow",
                               "--duration-ms", "8000")
        self.assertTrue(r["ok"], (r, p.stderr))
        self.add_ticket("waiting for a free member")
        self.run_board()
        time.sleep(4)  # the board is running, but Ryan is busy with an operator task
        ticket = self.ticket_json("T-001")
        self.assertEqual((ticket["status"], ticket["assignee"]), ("build", None))

        rc, out, err = self.human("stop-board", "--team", "alpha")
        self.assertEqual(rc, 0, err)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:  # Ryan finishes the operator task...
            rc, r, _ = self.sb.run("team", "status", "--team", "alpha", "--workspace", self.ws, "--json")
            if r.get("ok") and all(m["availability"] == "idle" for m in r["data"]["members"]):
                break
            time.sleep(0.5)
        time.sleep(3)  # ...but the stopped board claims nothing
        ticket = self.ticket_json("T-001")
        self.assertEqual((ticket["status"], ticket["assignee"]), ("build", None))


class WorktreesAndMerge(RunBoardCase):
    board = WORKTREE_BOARD

    def seed(self, worktree, path, content):
        with open(os.path.join(worktree, path), "w") as f:
            f.write(content)
        git(worktree, "add", "-A")
        git(worktree, "commit", "-qm", "ticket change")

    def test_two_tickets_isolated_and_merged_including_a_conflict(self):
        # a second worker lets both branches be cut from the same base, so the second merge conflicts
        self.put("teams/alpha.json", {"id": "alpha", "name": "Alpha", "members": [
            {"id": "ryan", "name": "Ryan", "role": "worker", "provider": "fake"},
            {"id": "reese", "name": "Reese", "role": "worker", "provider": "fake"},
            {"id": "sam", "name": "Sam", "role": "checker", "provider": "fake"}]})
        git(self.ws, "add", "-A")
        git(self.ws, "commit", "-qm", "second worker")
        self.start_team()
        self.add_ticket("first change")
        self.add_ticket("conflicting change")

        self.run_board()
        first = self.wait_claimed("T-001")
        second = self.wait_claimed("T-002")
        rc, out, err = self.human("stop-board", "--team", "alpha")  # freeze the flow while we seed
        self.assertEqual(rc, 0, err)
        self.assertNotEqual(second["worktreePath"], first["worktreePath"])  # isolated worktrees
        self.seed(first["worktreePath"], "shared.txt", "from first\n")
        self.seed(second["worktreePath"], "shared.txt", "from second\n")

        self.wait_status("T-001", ("done",), timeout=120)  # the first merge lands
        with open(os.path.join(self.ws, "shared.txt")) as f:
            self.assertEqual(f.read(), "from first\n")
        self.assertFalse(os.path.isdir(first["worktreePath"]))  # the worktree is cleaned up

        conflict = self.wait_event("T-002", "ticket.merge_conflict", timeout=90)  # the second conflicts
        self.assertIn("MERGE_CONFLICT", json.dumps(conflict["payload"]))
        self.assertEqual(self.ticket_json("T-002")["status"], "build")  # onFail returned it to the queue
        with open(os.path.join(self.ws, "shared.txt")) as f:
            self.assertEqual(f.read(), "from first\n")  # the base branch is untouched by the conflict
        self.assertTrue(os.path.isdir(second["worktreePath"]))  # kept for the fixing round
        status = subprocess.run(["git", "-C", self.ws, "status", "--porcelain"], stdout=subprocess.PIPE,
                                text=True).stdout
        self.assertEqual(status, "")  # never leaves the checkout dirty


if __name__ == "__main__":
    unittest.main()
