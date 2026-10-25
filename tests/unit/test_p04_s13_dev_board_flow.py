"""P04-S13: what a development board needs from the generic board: findings travel with the ticket, failed
tickets jump their queue, agent-made tickets land in a configurable status, an agent writes the ticket it is
working, and the coordinator commits ticket worktrees."""
import json
import unittest
import os
import shutil
import subprocess

import tests.helpers  # noqa: F401
from agent_studio import boardmodel, boardsched
from agent_studio.protocol import AsError
from tests.unit.test_p04_s09_rules_and_applier import ApplierCase, RULES_CONFIG
from tests.unit.test_p04_s12_mcp_server import ServerCase

FLOW = {"version": 2,
        "agentTicketStatus": "refine-ready",
        "statuses": [{"id": "backlog", "kind": "initial"}, {"id": "refine-ready"}, {"id": "dev-ready"},
                     {"id": "qa-ready"}, {"id": "done", "kind": "done"}, {"id": "close", "kind": "closed"}],
        "ticketFields": [],
        "rules": [{"when": {"status": "qa-ready"}, "role": "worker", "workflow": "solo", "onPass": "done",
                   "onFail": "dev-ready", "onFailPriority": 0, "maxRounds": 3}]}


class FailureHandoff(ApplierCase):
    def finished_run(self, status, findings=None):
        run = self.make_run(status)
        if findings is not None:
            with self.store.transaction() as tx:
                tx.create("stage_attempt", {"team_id": self.team, "workflow_run_id": run, "stage": "qa",
                                            "attempt": 1, "verdict_json": {"verdict": "fail",
                                                                           "findings": findings}})
        return run

    def setUp(self):
        super().setUp()
        self.write_config(FLOW)
        self.ticket = self.add("work", body="original brief")
        self.move("T-001", "qa-ready")

    def body_priority(self):
        row = self.conn.execute("SELECT body, priority, status FROM tickets WHERE key = 'T-001'").fetchone()
        return row["body"], row["priority"], row["status"]

    def test_fail_returns_to_the_previous_status_first_in_line_with_findings(self):
        self.apply("T-001", self.finished_run("failed", ["missing test for empty input", "typo in CLI help"]))
        body, priority, status = self.body_priority()
        self.assertEqual((status, priority), ("dev-ready", 0))
        self.assertTrue(body.startswith("original brief"))
        self.assertIn("## Findings from qa-ready, round 1", body)
        self.assertIn("- missing test for empty input", body)
        self.assertIn("- typo in CLI help", body)

    def test_pass_changes_neither_priority_nor_body(self):
        self.apply("T-001", self.finished_run("succeeded"))
        self.assertEqual(self.body_priority(), ("original brief", 100, "done"))

    def test_failed_ticket_is_picked_before_an_older_one_in_the_same_status(self):
        self.add("older")
        self.move("T-002", "dev-ready")
        self.apply("T-001", self.finished_run("failed", ["x"]))
        rows = self.conn.execute("SELECT key FROM tickets WHERE status = 'dev-ready' ORDER BY priority, "
                                 "created_at, key").fetchall()
        self.assertEqual([r["key"] for r in rows], ["T-001", "T-002"])

    def test_blocked_by_round_limit_keeps_priority(self):
        for _ in range(3):
            self.apply("T-001", self.finished_run("failed", ["again"]))
            self.move("T-001", "qa-ready") if self.body_priority()[2] == "dev-ready" else None
        self.assertEqual(self.body_priority()[2], "blocked")

    def test_body_stays_under_the_cap(self):
        with self.store.transaction() as tx:
            for i in range(40):
                boardmodel.append_body(tx, self.ticket["id"], f"note {i} " + "x" * 2000)
        body = self.body_priority()[0]
        self.assertLessEqual(len(body), boardmodel.BODY_LIMIT)
        self.assertTrue(body.startswith("original brief"))
        self.assertIn("note 39", body)

    def test_on_fail_priority_must_be_a_non_negative_integer(self):
        bad = json.loads(json.dumps(FLOW))
        bad["rules"][0]["onFailPriority"] = -1
        self.write_config(bad)
        with self.assertRaises(AsError) as c:
            boardmodel.load_config(self.ws)
        self.assertEqual(c.exception.code, "BOARD_CONFIG_INVALID")


class UnblockResetsRounds(ApplierCase):
    def setUp(self):
        super().setUp()
        self.write_config(FLOW)
        self.add("work")
        self.move("T-001", "qa-ready")
        for _ in range(3):
            self.apply("T-001", self.failed())
            row = self.conn.execute("SELECT status FROM tickets WHERE key='T-001'").fetchone()
            if row["status"] == "dev-ready":
                self.move("T-001", "qa-ready")
        self.assertEqual(self.row()["status"], "blocked")

    def failed(self):
        return self.make_run("failed")

    def row(self):
        return self.conn.execute("SELECT status, rounds_json, return_status, blocked_reason FROM tickets "
                                 "WHERE key = 'T-001'").fetchone()

    def unblock(self, **args):
        with self.store.transaction() as tx:
            return boardmodel.ticket_unblock(tx, self.ws, dict({"key": "T-001"}, **args))

    def test_unblock_to_a_chosen_status_resets_the_round_budget(self):
        self.assertEqual(json.loads(self.row()["rounds_json"]), {"qa-ready": 3})
        self.assertEqual(self.unblock(to="dev-ready")["ticket"]["status"], "dev-ready")
        row = self.row()
        self.assertEqual((row["rounds_json"], row["return_status"], row["blocked_reason"]), (None, None, None))
        self.move("T-001", "qa-ready")
        self.apply("T-001", self.failed())            # the first failure after the reset is not a block
        self.assertEqual(self.row()["status"], "dev-ready")

    def test_default_target_is_the_recorded_status_and_bad_targets_are_refused(self):
        with self.assertRaises(AsError) as c:
            self.unblock(to="done")
        self.assertEqual(c.exception.code, "BOARD_STATUS_UNKNOWN")
        with self.assertRaises(AsError):
            self.unblock(to="nowhere")
        self.assertEqual(self.unblock()["ticket"]["status"], "qa-ready")

    def test_operator_move_out_of_blocked_also_resets(self):
        self.move("T-001", "dev-ready")
        row = self.row()
        self.assertEqual((row["rounds_json"], row["return_status"], row["blocked_reason"]), (None, None, None))


class RulesCheckEntryPoints(ApplierCase):
    def test_path_to_done_may_start_at_the_agent_status(self):
        cfg = {"version": 2, "agentTicketStatus": "review",
               "statuses": [{"id": "todo", "kind": "initial"}, {"id": "review"}, {"id": "done", "kind": "done"}],
               "ticketFields": [],
               "rules": [{"when": {"status": "review"}, "role": "checker", "workflow": "check",
                          "onPass": "done", "onFail": "review"}]}
        self.write_config(cfg)
        self.assertEqual(self.check(boardmodel.load_config(self.ws)), [])
        del cfg["agentTicketStatus"]
        self.write_config(cfg)
        problems = self.check(boardmodel.load_config(self.ws))
        self.assertEqual([p["path"] for p in problems], ["rules"])


class AgentStatusAndUpdate(ServerCase):
    def setUp(self):
        super().setUp()
        cfg = json.loads(json.dumps(FLOW))
        cfg["rules"] = []
        with open(os.path.join(self.ws, ".agent-studio", "board.json"), "w") as f:
            json.dump(cfg, f)

    def test_agent_tickets_land_in_the_configured_status_and_operator_tickets_in_initial(self):
        got = self.add(self.asg_ok)
        self.assertEqual(got["ticket"]["status"], "refine-ready")
        with self.store.transaction() as tx:
            mine = boardmodel.ticket_add(tx, self.ws, {"title": "by hand", "priority": 100})
        self.assertEqual(mine["ticket"]["status"], "backlog")

    def test_agent_status_defaults_to_initial_and_cannot_be_terminal(self):
        for value, ok in (("done", False), ("close", False), ("nope", False), ("dev-ready", True)):
            cfg = json.loads(json.dumps(FLOW))
            cfg["agentTicketStatus"] = value
            cfg["rules"] = []
            with open(os.path.join(self.ws, ".agent-studio", "board.json"), "w") as f:
                json.dump(cfg, f)
            if ok:
                self.assertEqual(boardmodel.load_config(self.ws)["agentStatus"], value)
            else:
                with self.assertRaises(AsError):
                    boardmodel.load_config(self.ws)
        cfg = json.loads(json.dumps(FLOW))
        del cfg["agentTicketStatus"]
        cfg["rules"] = []
        with open(os.path.join(self.ws, ".agent-studio", "board.json"), "w") as f:
            json.dump(cfg, f)
        self.assertEqual(boardmodel.load_config(self.ws)["agentStatus"], "backlog")

    def claim(self, key, agent):
        self.conn.execute("UPDATE tickets SET assignee = ? WHERE key = ?", (agent, key))
        self.conn.commit()

    def update(self, assignment, key, body, mode=None):
        args = {"assignment": assignment, "key": key, "body": body}
        if mode:
            args["mode"] = mode
        with self.store.transaction() as tx:
            return boardmodel.mcp_ticket_update(tx, self.ws, args)

    def test_agent_updates_only_the_ticket_it_is_working(self):
        with self.store.transaction() as tx:
            boardmodel.ticket_add(tx, self.ws, {"title": "mine", "priority": 100, "body": "brief"})
            boardmodel.ticket_add(tx, self.ws, {"title": "other", "priority": 100})
        self.claim("T-001", self.allowed)
        got = self.update(self.asg_ok, "T-001", "refined spec")
        self.assertEqual(got["ticket"]["body"], "refined spec")
        got = self.update(self.asg_ok, "T-001", "extra section", mode="append")
        self.assertEqual(got["ticket"]["body"], "refined spec\n\nextra section")
        for assignment, key in ((self.asg_ok, "T-002"), (self.asg_no, "T-001"), (self.asg_done, "T-001")):
            with self.assertRaises(AsError) as c:
                self.update(assignment, key, "nope")
            self.assertEqual(c.exception.code, "FORBIDDEN")
        names = [e["name"] for e in self.conn.execute(
            "SELECT name FROM ticket_events WHERE ticket_id = (SELECT id FROM tickets WHERE key='T-001')")]
        self.assertEqual(names.count("ticket.updated"), 2)

    def test_tool_and_validator(self):
        from agent_studio import dispatch
        with self.assertRaises(AsError):
            dispatch._validate_ticket_update({"workspace": self.ws, "key": "T-001", "assignment": str(self.asg_ok),
                                              "body": "x", "mode": "wipe"})
        with self.assertRaises(AsError):
            dispatch._validate_ticket_update({"workspace": self.ws, "key": "T-001", "body": "x"})
        got = self.rpc("tools/call", {"name": "ticket_update", "arguments": {"key": "T-001", "body": ""}})
        self.assertEqual(got["error"]["code"] if "error" in got else got["result"]["code"], "BAD_REQUEST")


class TicketActivity(ApplierCase):
    def setUp(self):
        super().setUp()
        self.write_config(FLOW)
        self.add("work")

    def activity(self):
        from agent_studio import boardcli
        t = boardmodel.ticket_detail(self.conn, self.ws, "T-001")["ticket"]
        return t["activity"], boardcli.activity_text(t)

    def test_not_started_working_blocked_and_finished(self):
        self.move("T-001", "qa-ready")
        activity, text = self.activity()
        self.assertEqual((activity["state"], activity["waitingFor"]), ("not started", "worker"))
        self.assertEqual(text, "not started (waiting for worker)")
        with self.store.transaction() as tx:
            agent = {"id": tx.create("agent", {"team_id": self.team, "ordinal": 0, "provider_id": "fake",
                                               "role": "QA", "display_name": "qa"}), "display_name": "qa"}
            tx.conn.execute("UPDATE tickets SET assignee = ? WHERE key = 'T-001'", (agent["id"],))
        activity, text = self.activity()
        self.assertEqual(activity["state"], "working")
        self.assertEqual(text, "working: " + agent["display_name"])
        with self.store.transaction() as tx:
            tx.conn.execute("UPDATE tickets SET assignee = NULL WHERE key = 'T-001'")
        self.move("T-001", "done")
        self.assertEqual(self.activity()[0]["state"], "finished")

    def test_a_failed_start_is_shown_as_a_note(self):
        self.move("T-001", "qa-ready")
        row = self.conn.execute("SELECT id FROM tickets WHERE key = 'T-001'").fetchone()
        boardmodel._ticket_event(self.conn, row["id"], "ticket.claim_released", "coordinator", "qa-ready",
                                 "qa-ready", {"reason": "start_failed:WORKSPACE_DIRTY"})
        self.assertEqual(self.activity()[1], "not started (waiting for worker) [start_failed:WORKSPACE_DIRTY]")


class CommitWorktree(ApplierCase):
    def git(self, *a, cwd=None):
        return subprocess.run(["git", "-C", cwd or self.repo] + list(a), check=True, capture_output=True,
                              text=True).stdout.strip()

    def test_uncommitted_worktree_changes_are_committed_when_the_outcome_is_applied(self):
        self.repo = tests.helpers.make_repo()
        self.addCleanup(tests.helpers.reset_repo, self.repo)
        wt = self.repo + "-wt"
        self.addCleanup(shutil.rmtree, wt, True)
        self.git("add", "-A")
        self.git("commit", "--allow-empty", "-qm", "base")
        self.git("worktree", "add", "-q", "-b", "t-1", wt)
        with open(os.path.join(wt, "new.txt"), "w") as f:
            f.write("work\n")
        ticket = {"key": "T-001", "worktree_path": wt, "id": "x"}
        notes = []
        orig = boardsched._ticket_event_note
        boardsched._ticket_event_note = lambda tx, t, name, payload: notes.append((name, payload))
        try:
            rule = {"workspace": "worktree", "when": {"status": "dev-ready"}}
            boardsched._commit_worktree(None, ticket, rule)
            self.assertEqual(self.git("status", "--porcelain", cwd=wt), "")
            self.assertEqual(self.git("log", "-1", "--format=%s", cwd=wt), "T-001: dev-ready")
            self.assertEqual(notes[0][0], "ticket.committed")
            boardsched._commit_worktree(None, ticket, rule)          # nothing new: no second commit
            self.assertEqual(len(notes), 1)
            boardsched._commit_worktree(None, ticket, {"workspace": "main", "when": {"status": "x"}})
            boardsched._commit_worktree(None, dict(ticket, worktree_path=None), rule)
        finally:
            boardsched._ticket_event_note = orig


class SettleMain(unittest.TestCase):
    """A `workspace: main` rule leaves the main checkout clean: commit on pass, stash otherwise."""

    def setUp(self):
        self.repo = tests.helpers.make_repo()
        self.addCleanup(tests.helpers.reset_repo, self.repo)
        subprocess.run(["git", "-C", self.repo, "add", "-A"], check=True)
        subprocess.run(["git", "-C", self.repo, "commit", "--allow-empty", "-qm", "base"], check=True)
        self.notes = []
        self.orig = boardsched._ticket_event_note
        boardsched._ticket_event_note = lambda tx, t, name, payload: self.notes.append(name)
        self.addCleanup(setattr, boardsched, "_ticket_event_note", self.orig)
        self.rule = {"workspace": "main", "when": {"status": "unpack-ready"}}
        self.ticket = {"key": "T-001"}

    def git(self, *a):
        return subprocess.run(["git", "-C", self.repo] + list(a), check=True, capture_output=True,
                              text=True).stdout.strip()

    def write(self):
        os.makedirs(os.path.join(self.repo, "phases", "phase-05", "stories"), exist_ok=True)
        with open(os.path.join(self.repo, "phases", "phase-05", "stories", "P05-S01-x.md"), "w") as f:
            f.write("# story\n")

    def test_pass_commits_the_planning_files(self):
        self.write()
        boardsched._settle_main(None, self.repo, self.ticket, self.rule, "succeeded")
        self.assertEqual(self.git("status", "--porcelain"), "")
        self.assertEqual(self.git("log", "-1", "--format=%s"), "T-001: unpack-ready")
        self.assertIn("phases/phase-05/stories/P05-S01-x.md", self.git("show", "--name-only", "--format=", "HEAD"))
        self.assertEqual(self.notes, ["ticket.committed"])

    def test_failure_stashes_so_the_board_is_not_blocked_and_nothing_is_lost(self):
        self.write()
        boardsched._settle_main(None, self.repo, self.ticket, self.rule, "failed")
        self.assertEqual(self.git("status", "--porcelain"), "")
        self.assertIn("agent-studio T-001 unpack-ready (failed)", self.git("stash", "list"))
        self.assertEqual(self.git("log", "-1", "--format=%s"), "base")
        self.assertEqual(self.notes, ["ticket.stashed"])

    def test_clean_tree_and_other_modes_do_nothing(self):
        boardsched._settle_main(None, self.repo, self.ticket, self.rule, "succeeded")
        self.write()
        boardsched._settle_main(None, self.repo, self.ticket, dict(self.rule, workspace="none"), "succeeded")
        boardsched._settle_main(None, self.repo, self.ticket, None, "succeeded")
        self.assertNotEqual(self.git("status", "--porcelain"), "")
        self.assertEqual(self.notes, [])


if __name__ == "__main__":
    unittest.main()
