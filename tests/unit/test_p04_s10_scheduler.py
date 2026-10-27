"""P04-S10 unit tick tests: binding, the phase filter, requiresDeps, cap, busy members, and that a current
phase change mid-run lets the running ticket finish."""
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from tests import helpers
from tests.helpers import fresh, make_repo
from agent_studio import boardsched, boardmodel, teams, workflow
from agent_studio.protocol import AsError
from tests.unit.test_p04_s09_rules_and_applier import SOLO

ROLES = {"version": 1, "roles": {"worker": {}}}


def rules_board_json(**rule_extra):
    return {"version": 2,
            "statuses": [{"id": "build", "kind": "initial"}, {"id": "in-progress"},
                         {"id": "done", "kind": "done"}],
            "ticketFields": [],
            "rules": [dict({"when": {"status": "build"}, "role": "worker", "workflow": "solo",
                            "onPass": "done", "onFail": "build", "during": "in-progress"}, **rule_extra)]}


class SchedCase(unittest.TestCase):
    def setUp(self):
        self.ws = make_repo()
        self.addCleanup(helpers.reset_repo, self.ws)
        cfg = os.path.join(self.ws, ".agent-studio")
        os.makedirs(os.path.join(cfg, "workflows"), exist_ok=True)
        with open(os.path.join(cfg, "roles.json"), "w") as f:
            json.dump(ROLES, f)
        with open(os.path.join(cfg, "workflows", "solo.json"), "w") as f:
            json.dump(SOLO, f)
        self.write_board(rules_board_json())  # write_board also commits: a run needs a clean tree
        self.conn, self.store = fresh()
        self.ctx = {"stateDir": tempfile.mkdtemp(), "debug": True}
        with self.store.transaction() as tx:
            self.team = tx.create("team", {"name": "t", "workspace": self.ws})
            tx.transition("team", self.team, "running")
            self.worker = tx.create("agent", {"team_id": self.team, "ordinal": 0, "provider_id": "fake",
                                              "role": "worker", "display_name": "w", "pane_state": "alive"})
            tx.transition("agent", self.worker, "idle")
        self.bind()

    def commit_board(self):
        import subprocess
        for args in (["add", "-A"], ["commit", "-qm", "board config"]):
            subprocess.run(["git", "-C", self.ws] + args, check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def write_board(self, config):
        with open(os.path.join(self.ws, ".agent-studio", "board.json"), "w") as f:
            json.dump(config, f)
        if os.path.isdir(os.path.join(self.ws, ".git")):
            self.commit_board()

    def bind(self, team=None):
        with self.store.transaction() as tx:
            return boardsched.bind_team(tx, self.ws, team or self.team)

    def add_ticket(self, title="a", **extra):
        with self.store.transaction() as tx:
            return boardmodel.ticket_add(tx, self.ws, dict({"title": title, "priority": 100}, **extra))["ticket"]

    def ticket(self, key):
        return dict(self.conn.execute("SELECT * FROM tickets WHERE key = ?", (key,)).fetchone())

    def tick(self):
        return boardsched.tick(self.store, self.ctx)

    def finish(self, run_id, status="succeeded"):
        with self.store.transaction() as tx:
            tx.transition("workflow_run", run_id, status)

    def free_member(self):
        """Settle the claimed run's assignment and free the member (the coordinator loop does this from
        the runner's final report; a unit tick test has no loop)."""
        with self.store.transaction() as tx:
            for row in tx.conn.execute(
                    "SELECT id, status FROM assignments WHERE agent_id = ? AND status IN "
                    "('queued', 'claimed', 'running')", (self.worker,)).fetchall():
                if row["status"] == "queued":
                    tx.transition("assignment", row["id"], "claimed")
                if row["status"] in ("queued", "claimed"):
                    tx.transition("assignment", row["id"], "running")
                tx.transition("assignment", row["id"], "succeeded")
            agent = tx.get("agent", self.worker)
            if agent["availability"] != "idle":
                tx.transition("agent", self.worker, "idle")


class Binding(SchedCase):
    def test_run_board_binds_and_rules_check_gates_it(self):
        got = self.bind()
        self.assertEqual((got["board"]["status"], got["board"]["teamId"]), ("running", self.team))
        bad = rules_board_json()
        bad["rules"][0]["role"] = "nobody"
        self.write_board(bad)
        with self.assertRaises(AsError) as caught:
            self.bind()
        self.assertEqual(caught.exception.code, "BOARD_CONFIG_INVALID")

    def test_second_team_is_refused_until_stopped(self):
        with self.store.transaction() as tx:
            other = tx.create("team", {"name": "o", "workspace": self.ws})
            tx.transition("team", other, "running")
        with self.assertRaises(AsError) as caught:
            self.bind(other)
        self.assertEqual(caught.exception.code, "BOARD_ALREADY_RUNNING")
        with self.store.transaction() as tx:
            boardsched.stop_board(tx, self.ws)
        self.assertEqual(self.bind(other)["board"]["teamId"], other)

    def test_a_stopped_teams_binding_is_taken_over_by_a_new_team(self):
        self.bind()
        with self.store.transaction() as tx:
            tx.transition("team", self.team, "stopping")
            tx.transition("team", self.team, "stopped")
            fresh_team = tx.create("team", {"name": "n", "workspace": self.ws})
            tx.transition("team", fresh_team, "running")
        self.assertEqual(self.bind(fresh_team)["board"]["teamId"], fresh_team)

    def test_stop_board_stops_claims_but_applies_finished_runs(self):
        ticket = self.add_ticket()
        self.tick()
        run = self.ticket("T-001")["active_run_id"]
        self.assertIsNotNone(run)
        with self.store.transaction() as tx:
            boardsched.stop_board(tx, self.ws)
        self.add_ticket("second")
        self.tick()  # stopped: no new claims
        self.assertIsNone(self.ticket("T-002")["active_run_id"])
        self.finish(run)
        self.tick()  # ... but the finished run is still applied
        self.assertEqual(self.ticket("T-001")["status"], "done")
        self.assertIsNone(self.ticket("T-001")["assignee"])


class TickRules(SchedCase):
    @patch("agent_studio.providers.probe_many", return_value={"fake": {"available": True}})
    def test_quota_failover_reclaims_ticket_with_fallback_agent(self, probe):
        config = os.path.join(self.ws, ".agent-studio")
        os.makedirs(os.path.join(config, "teams"), exist_ok=True)
        with open(os.path.join(config, "agents.json"), "w") as f:
            json.dump({"version": 1, "agents": [
                {"id": "first", "name": "First", "provider": "fake", "model": "fake-1"},
                {"id": "backup", "name": "Backup", "provider": "fake", "model": "fake-2"}]}, f)
        with open(os.path.join(config, "teams", "t.json"), "w") as f:
            json.dump({"id": "t", "name": "Team", "members": [
                {"id": "worker", "name": "Worker", "role": "worker", "agents": ["first", "backup"]}]}, f)
        self.commit_board()
        with self.store.transaction() as tx:
            tx.update("team", self.team, {"def_id": "t"}, "team.definition_set")
            tx.update("agent", self.worker, {"member_id": "worker", "active_catalog_agent": "first",
                                              "model": "fake-1"}, "agent.option_set")
        self.add_ticket()
        self.tick()
        original = self.ticket("T-001")["active_run_id"]
        assignment = self.conn.execute("SELECT assignment_id FROM stage_attempts WHERE workflow_run_id = ?",
                                       (original,)).fetchone()[0]
        with self.store.transaction() as tx:
            tx.transition("assignment", assignment, "failed", set_values={
                "diagnostic_code": "USAGE_LIMIT", "result_json": {"diagnosticCode": "USAGE_LIMIT"}})
            tx.transition("agent", self.worker, "busy")
            tx.transition("agent", self.worker, "limit_reached")
            teams.handle_quota_limit(tx, self.worker, None, self.ctx)
        workflow.advance(self.store, self.ctx)
        tick = self.tick()
        self.assertEqual(tick["errors"], [])
        replacement = self.ticket("T-001")["active_run_id"]
        self.assertNotEqual(original, replacement)
        row = self.conn.execute("SELECT a.request_json FROM assignments a JOIN stage_attempts s ON s.assignment_id = a.id "
                                "WHERE s.workflow_run_id = ?", (replacement,)).fetchone()
        self.assertEqual(json.loads(row["request_json"])["model"], "fake-2")

    def test_paused_quota_failure_is_released_and_claimed_again(self):
        self.add_ticket()
        self.tick()
        original = self.ticket("T-001")["active_run_id"]
        assignment = self.conn.execute("SELECT assignment_id FROM stage_attempts WHERE workflow_run_id = ?",
                                       (original,)).fetchone()[0]
        with self.store.transaction() as tx:
            tx.transition("assignment", assignment, "failed", set_values={
                "diagnostic_code": "USAGE_LIMIT", "result_json": {"diagnosticCode": "USAGE_LIMIT"}})
        workflow.advance(self.store, self.ctx)
        self.assertEqual(self.conn.execute("SELECT status FROM workflow_runs WHERE id = ?", (original,)).fetchone()[0],
                         "paused")
        tick = self.tick()
        self.assertEqual(tick["errors"], [])
        self.assertEqual((tick["applied"], tick["claimed"]), (1, 1))
        self.assertNotEqual(self.ticket("T-001")["active_run_id"], original)
        self.assertEqual(self.conn.execute("SELECT status FROM workflow_runs WHERE id = ?", (original,)).fetchone()[0],
                         "failed")
        self.assertIsNone(self.ticket("T-001")["rounds_json"])
        names = [r[0] for r in self.conn.execute("SELECT name FROM ticket_events ORDER BY id").fetchall()]
        self.assertEqual(names, ["ticket.created", "ticket.claimed", "ticket.claim_released", "ticket.claimed"])

    def test_other_paused_failure_keeps_its_claim(self):
        self.add_ticket()
        self.tick()
        original = self.ticket("T-001")["active_run_id"]
        assignment = self.conn.execute("SELECT assignment_id FROM stage_attempts WHERE workflow_run_id = ?",
                                       (original,)).fetchone()[0]
        with self.store.transaction() as tx:
            tx.transition("assignment", assignment, "failed", set_values={
                "diagnostic_code": "PROVIDER_ERROR", "result_json": {"diagnosticCode": "PROVIDER_ERROR"}})
        workflow.advance(self.store, self.ctx)
        self.tick()
        self.assertEqual(self.ticket("T-001")["active_run_id"], original)
        self.assertEqual(self.conn.execute("SELECT status FROM workflow_runs WHERE id = ?", (original,)).fetchone()[0],
                         "paused")

    def test_paused_quota_failure_after_team_stop_releases_claim(self):
        self.add_ticket()
        self.tick()
        original = self.ticket("T-001")["active_run_id"]
        wf = self.conn.execute("SELECT task_id FROM workflow_runs WHERE id = ?", (original,)).fetchone()
        assignment = self.conn.execute("SELECT assignment_id FROM stage_attempts WHERE workflow_run_id = ?",
                                       (original,)).fetchone()[0]
        with self.store.transaction() as tx:
            tx.transition("assignment", assignment, "failed", set_values={
                "diagnostic_code": "USAGE_LIMIT", "result_json": {"diagnosticCode": "USAGE_LIMIT"}})
        workflow.advance(self.store, self.ctx)
        with self.store.transaction() as tx:
            tx.transition("task", wf["task_id"], "cancelled")
            boardsched.stop_board(tx, self.ws)
        tick = self.tick()
        self.assertEqual(tick["errors"], [])
        self.assertIsNone(self.ticket("T-001")["active_run_id"])
        self.assertEqual(self.conn.execute("SELECT status FROM tasks WHERE id = ?", (wf["task_id"],)).fetchone()[0],
                         "cancelled")

    def test_claims_by_rule_with_lease_during_status_and_event(self):
        self.add_ticket()
        out = self.tick()
        self.assertEqual((out["claimed"], out["errors"]), (1, []))
        row = self.ticket("T-001")
        self.assertEqual((row["status"], row["assignee"]), ("in-progress", self.worker))
        self.assertIsNotNone(row["active_run_id"])
        self.assertIsNone(row["lease_until"])  # the claim lease ends once the workflow has started
        run = self.conn.execute("SELECT id, status FROM workflow_runs WHERE id = ?",
                                (row["active_run_id"],)).fetchone()
        self.assertEqual(run["status"], "running")
        names = [e["name"] for e in self.conn.execute(
            "SELECT name FROM ticket_events ORDER BY id").fetchall()]
        self.assertEqual(names, ["ticket.created", "ticket.claimed"])
        assignment = self.conn.execute("SELECT agent_id FROM assignments ORDER BY created_at DESC").fetchone()
        self.assertEqual(assignment["agent_id"], self.worker)

    def test_worktree_rule_holds_created_tickets_until_its_merge_action_passes(self):
        old_state_home = os.environ.get("XDG_STATE_HOME")
        state_home = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, state_home, True)
        os.environ["XDG_STATE_HOME"] = state_home
        if old_state_home is None:
            self.addCleanup(os.environ.pop, "XDG_STATE_HOME", None)
        else:
            self.addCleanup(os.environ.__setitem__, "XDG_STATE_HOME", old_state_home)
        self.ctx["stateDir"] = os.path.join(state_home, "agent-studio")
        base_branch = subprocess.run(
            ["git", "-C", self.ws, "symbolic-ref", "--short", "HEAD"], check=True,
            stdout=subprocess.PIPE, text=True).stdout.strip()
        self.write_board({
            "version": 2,
            "baseBranch": base_branch,
            "agentTicketStatus": "unpack-ready",
            "statuses": [{"id": "backlog", "kind": "initial"}, {"id": "unpack-ready"},
                         {"id": "plan-merge-ready"}, {"id": "refine-ready"},
                         {"id": "done", "kind": "done"}],
            "ticketFields": [],
            "rules": [
                {"when": {"status": "unpack-ready"}, "role": "worker", "workflow": "solo",
                 "workspace": "worktree", "createdTicketStatus": "backlog",
                 "onPass": "plan-merge-ready", "onFail": "backlog"},
                {"when": {"status": "plan-merge-ready"}, "action": "merge", "onPass": "done",
                 "onFail": "unpack-ready",
                 "onPassCreatedTickets": {"from": "backlog", "to": "refine-ready"}}
            ]})
        with self.store.transaction() as tx:
            tx.conn.execute("UPDATE agents SET can_add_tickets = 1 WHERE id = ?", (self.worker,))
        self.add_ticket("feature", status="unpack-ready")
        started = self.tick()
        self.assertEqual(started["errors"], [])
        events = [dict(r) for r in self.conn.execute(
            "SELECT name, payload_json FROM ticket_events ORDER BY id").fetchall()]
        self.assertEqual(started["claimed"], 1, events)
        parent = self.ticket("T-001")
        assignment = self.conn.execute(
            "SELECT assignment_id FROM stage_attempts WHERE workflow_run_id = ?",
            (parent["active_run_id"],)).fetchone()[0]
        with open(os.path.join(parent["worktree_path"], "plan.md"), "w") as f:
            f.write("planned in isolation\n")
        with self.store.transaction() as tx:
            child = boardmodel.mcp_ticket_add(
                tx, parent["worktree_path"],
                {"assignment": assignment, "title": "first story", "priority": 100})["ticket"]
        self.assertEqual((child["workspace"], child["status"]), (self.ws, "backlog"))
        self.assertFalse(os.path.exists(os.path.join(self.ws, "plan.md")))

        self.finish(parent["active_run_id"])
        self.free_member()
        self.tick()  # apply the run, merge its branch, then promote only tickets created by that run
        self.assertEqual(self.ticket("T-001")["status"], "done")
        self.assertEqual(self.ticket("T-002")["status"], "refine-ready")
        self.assertTrue(os.path.exists(os.path.join(self.ws, "plan.md")))
        child_events = [r[0] for r in self.conn.execute(
            "SELECT name FROM ticket_events WHERE ticket_id = ? ORDER BY id", (child["id"],)).fetchall()]
        self.assertEqual(child_events, ["ticket.created", "ticket.created_status_promoted"])

    def test_only_the_effective_current_phase_is_claimed(self):
        with self.store.transaction() as tx:
            boardmodel.phase_add(tx, self.ws, {"id": "later", "name": "Later"})
        self.add_ticket("in default")
        self.add_ticket("in later", phase="later")
        self.tick()
        self.assertIsNotNone(self.ticket("T-001")["active_run_id"])  # default is current when no pointer
        self.assertIsNone(self.ticket("T-002")["active_run_id"])
        self.finish(self.ticket("T-001")["active_run_id"])
        self.free_member()
        with self.store.transaction() as tx:
            boardmodel.phase_set_current(tx, self.ws, {"phase": "later"})
        self.tick()  # first ticket finishes; new claims use the new current phase
        self.assertEqual(self.ticket("T-001")["status"], "done")
        self.assertIsNotNone(self.ticket("T-002")["active_run_id"])

    def test_current_phase_change_leaves_the_running_ticket_alone(self):
        with self.store.transaction() as tx:
            boardmodel.phase_add(tx, self.ws, {"id": "later", "name": "Later"})
        self.add_ticket()
        self.tick()
        before = self.ticket("T-001")
        with self.store.transaction() as tx:
            boardmodel.phase_set_current(tx, self.ws, {"phase": "later"})
        after = self.ticket("T-001")
        self.assertEqual((before["status"], before["active_run_id"], before["assignee"]),
                         (after["status"], after["active_run_id"], after["assignee"]))
        self.finish(before["active_run_id"])
        self.tick()  # the outcome still applies by the claiming rule (the during status)
        self.assertEqual(self.ticket("T-001")["status"], "done")

    def test_requires_deps(self):
        self.write_board(rules_board_json(requiresDeps=True))
        self.add_ticket("dep")
        self.add_ticket("waiting")
        with self.store.transaction() as tx:
            boardmodel.ticket_depend(tx, self.ws, {"key": "T-002", "on": ["T-001"], "remove": []})
        self.tick()  # claims the dependency itself; the dependent waits
        self.assertIsNone(self.ticket("T-002")["active_run_id"])
        self.finish(self.ticket("T-001")["active_run_id"])
        self.free_member()
        self.tick()  # the dependency reaches done and releases its claim; the dependent is claimed
        self.assertEqual(self.ticket("T-001")["status"], "done")
        self.assertIsNotNone(self.ticket("T-002")["active_run_id"])

    def test_cap(self):
        self.write_board(rules_board_json(cap=1))
        self.add_ticket("one")
        self.add_ticket("two")
        self.tick()
        self.tick()
        claimed = [k for k in ("T-001", "T-002") if self.ticket(k)["active_run_id"]]
        self.assertEqual(claimed, ["T-001"])  # one active claim under the rule at a time

    def test_busy_member_is_never_claimed(self):
        self.add_ticket()
        with self.store.transaction() as tx:  # the member already runs something else
            task = tx.create("task", {"team_id": self.team, "origin": "direct", "workspace": self.ws,
                                      "goal": "ask"})
            tx.transition("task", task, "assigned")
            tx.create("assignment", {"team_id": self.team, "task_id": task, "agent_id": self.worker,
                                     "attempt": 1, "policy": "read_only", "provider_id": "fake"},
                      state="queued")
        out = self.tick()
        self.assertEqual(out["claimed"], 0)
        self.assertIsNone(self.ticket("T-001")["assignee"])


class WorktreeRegistration(SchedCase):
    """§F restored: a run workspace is accepted only while it is a claimed ticket's registered worktree."""

    def test_registered_worktree_rules(self):
        from agent_studio import tasks as tasks_mod
        from agent_studio.protocol import AsError

        self.add_ticket()
        worktree = os.path.join(tempfile.mkdtemp(), "T-001")
        self.conn.execute("UPDATE tickets SET assignee = ?, worktree_path = ?, branch = 'ticket/T-001-a' "
                          "WHERE key = 'T-001'", (self.worker, worktree))
        team = dict(self.conn.execute("SELECT * FROM teams WHERE id = ?", (self.team,)).fetchone())
        for path, why in ((worktree, "not a worktree git lists"), (worktree + "-other", "another path")):
            with self.store.transaction() as tx:
                with self.assertRaises(AsError) as caught:
                    tasks_mod.run_workspace(tx, team, path)
                self.assertEqual(caught.exception.code, "WORKTREE_NOT_REGISTERED", why)
        self.conn.execute("UPDATE tickets SET assignee = NULL WHERE key = 'T-001'")  # released: not live
        with self.store.transaction() as tx:
            with self.assertRaises(AsError) as caught:
                tasks_mod.run_workspace(tx, team, worktree)
            self.assertEqual(caught.exception.code, "WORKTREE_NOT_REGISTERED")


if __name__ == "__main__":
    unittest.main()
