import io
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock
from datetime import datetime, timedelta, timezone

from tests import helpers  # noqa: F401
from agent_studio import PROTOCOL, board, cli, coordinator, crashpoints, dispatch, serve, state, tickets, worktrees
from agent_studio.protocol import AsError, BAD_REQUEST, TICKET_BUSY, TICKET_TRANSITION_INVALID
from agent_studio.store import Store
from tests.unit.test_p03_s01_tickets import fresh


class LeaseRecoveryTests(unittest.TestCase):
    def test_retry_validator_accepts_ticket_key_and_workspace(self):
        with tempfile.TemporaryDirectory() as workspace:
            self.assertEqual(dispatch._validate_ticket_retry({"workspace": workspace, "key": "T-001"}),
                             {"workspace": os.path.realpath(workspace), "key": "T-001"})
            with self.assertRaises(AsError) as raised:
                dispatch._validate_ticket_retry({"workspace": workspace, "key": "bad"})
        self.assertEqual(raised.exception.code, BAD_REQUEST)

    def test_cli_retry_builds_ticket_retry_request(self):
        with tempfile.TemporaryDirectory() as workspace, mock.patch("agent_studio.cli.dispatch.handle_request",
                                                                     return_value={"ok": True}) as request:
            cli.main(["ticket", "retry", "T-001", "--workspace", workspace, "--key", "retry-key-123"])
        self.assertEqual(request.call_args.args[0]["command"], "ticket.retry")
        self.assertEqual(request.call_args.args[0]["args"], {"workspace": workspace, "key": "T-001"})

    def test_serve_returns_ticket_retry_response(self):
        with tempfile.TemporaryDirectory() as workspace:
            request = {"id": "retry-serve", "protocol": PROTOCOL, "command": "ticket.retry",
                       "idempotencyKey": "retry-key-123", "args": {"workspace": workspace, "key": "T-001"}}
            out = io.BytesIO()
            response = {"ticket": {"key": "T-001", "status": "ready_dev"}}
            with mock.patch("agent_studio.dispatch.client.submit", return_value={"ok": True, "data": response}):
                self.assertEqual(serve.run(io.BytesIO(json.dumps(request).encode() + b"\n"), out), 0)
        self.assertEqual(json.loads(out.getvalue()), {"protocol": PROTOCOL, "id": "retry-serve", "ok": True,
                                                      "data": response})

    def test_claim_commit_crashpoint_is_registered(self):
        self.assertIn("after_ticket_claim_commit", crashpoints.POINTS)


class BoardRecoveryTests(unittest.TestCase):
    """Recovery is deliberately exercised against the durable ticket event log."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.workspace = os.path.join(self.temp.name, "repo")
        self.state_dir = os.path.join(self.temp.name, "state")
        os.mkdir(self.workspace)
        self.git("init", "-b", "main")
        self.git("config", "user.name", "Unit Tester")
        self.git("config", "user.email", "unit@example.invalid")
        with open(os.path.join(self.workspace, "tracked.txt"), "w", encoding="utf-8") as f:
            f.write("initial\\n")
        os.mkdir(os.path.join(self.workspace, ".agent-studio"))
        with open(os.path.join(self.workspace, ".agent-studio", "workflow.json"), "w", encoding="utf-8") as f:
            json.dump({"version": 1, "validation": {"argv": ["true"]}}, f)
        self.git("add", "-A")
        self.git("commit", "-m", "initial")
        self.conn, self.store = fresh()
        self.ctx = {"stateDir": self.state_dir, "debug": True}
        with self.store.transaction() as tx:
            team = tx.create("team", {"name": "team", "workspace": self.workspace})
            tx.transition("team", team, "running")
            self.agent_id = tx.create("agent", {"team_id": team, "ordinal": 1, "provider_id": "fake",
                                                   "role": "Developer", "display_name": "Developer"})
            tx.transition("agent", self.agent_id, "idle")
            tx.update("agent", self.agent_id, {"pane_state": "alive"}, "agent.pane_ready", {})

    def tearDown(self):
        self.conn.close()
        self.temp.cleanup()

    def git(self, *args):
        return subprocess.run(["git", "-C", self.workspace, *args], check=True, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, text=True).stdout.strip()

    def ticket(self):
        with self.store.transaction() as tx:
            ticket = tickets.create(tx, self.workspace, "story", {"title": "Recovery ticket"})
            ticket = tickets.move(tx, ticket, "refining", "coordinator")
            return tickets.move(tx, ticket, "ready_dev", "coordinator")

    def claim(self, ticket):
        with self.store.transaction() as tx:
            return board.claim(tx, tickets.get(tx, self.workspace, ticket["key"]), tx.get("agent", self.agent_id),
                               {"leaseSeconds": 30, "baseBranch": "main",
                                "columns": {"develop": {"role": "Developer", "definition": "board-develop"}}}, self.ctx)

    def current(self, ticket):
        with self.store.transaction() as tx:
            return tickets.get(tx, self.workspace, ticket["key"])

    def event_names(self, ticket):
        return [r[0] for r in self.conn.execute("SELECT name FROM ticket_events WHERE ticket_id = ? ORDER BY id", (ticket["id"],))]

    def reopen_store(self):
        """Model a coordinator restart while retaining the durable database."""
        path = self.conn.execute("PRAGMA database_list").fetchone()[2]
        self.conn.close()
        self.conn = state.connect(path, role="coordinator")
        self.store = Store(self.conn)

    def test_crashed_claim_expires_once_and_keeps_worktree_for_next_start(self):
        ticket = self.ticket()
        with mock.patch.object(crashpoints, "hit", side_effect=RuntimeError("crash")):
            with self.assertRaisesRegex(RuntimeError, "crash"):
                board.claim_and_start(self.store, self.workspace, ticket["key"], self.agent_id, self.ctx)
        claimed = self.current(ticket)
        lease = datetime.fromisoformat(claimed["lease_until"].replace("Z", "+00:00"))
        self.reopen_store()
        self.assertEqual(board.reconcile(self.store, self.ctx, now=lease - timedelta(seconds=1))["released"], [])
        result = board.reconcile(self.store, self.ctx, now=lease + timedelta(seconds=1))
        released = self.current(ticket)
        self.assertEqual(result["released"], [ticket["key"]])
        self.assertEqual((released["status"], released["assignee_agent_id"], released["lease_until"]),
                         ("ready_dev", None, None))
        self.assertEqual(self.event_names(ticket).count("ticket.released"), 1)
        self.assertEqual(board.reconcile(self.store, self.ctx, now=lease + timedelta(seconds=2))["released"], [])
        self.assertTrue(os.path.isdir(released["worktree_path"]))
        self.assertIn(released["worktree_path"], [x["path"] for x in worktrees.list_registered(self.workspace, state_dir=self.state_dir)])
        # The ordinary atomic command must reuse the durable claim-gap tree.
        with self.store.transaction() as tx:
            started = coordinator._handle_ticket_start({"workspace": self.workspace, "key": ticket["key"],
                                                        "agentId": self.agent_id}, tx, self.ctx)
        self.assertEqual(started["ticket"]["worktree_path"], released["worktree_path"])

    def test_reclaimed_event_is_pending_but_started_event_is_not(self):
        ticket = self.ticket()
        claimed = self.claim(ticket)
        with self.store.transaction() as tx:
            # A later claim is the authoritative boundary, even if a prior run id remains.
            team_id = tx.get("agent", self.agent_id)["team_id"]
            task = tx.create("task", {"team_id": team_id, "origin": "direct", "workspace": self.workspace, "goal": "g"})
            previous_run = tx.create("workflow_run", {"team_id": team_id, "task_id": task, "workflow": "develop"})
            tx.transition("workflow_run", previous_run, "running")
            tx.transition("workflow_run", previous_run, "succeeded")
            seq = tx.update("ticket", claimed["id"], {"lease_until": "2000-01-01T00:00:00.000Z",
                                                        "run_id": previous_run, "applied_run_id": previous_run},
                            "ticket.claimed", {})
            current = tx.get("ticket", claimed["id"])
            tickets._ticket_event(tx, current, seq, "ticket.claimed", "coordinator", "in_dev", "in_dev", {})
            self.assertTrue(board._pending(tx, current))
            seq = tx.update("ticket", current["id"], {"lease_until": current["lease_until"]}, "ticket.run_started", {})
            current = tx.get("ticket", current["id"])
            tickets._ticket_event(tx, current, seq, "ticket.run_started", "coordinator", "in_dev", "in_dev", {})
            self.assertFalse(board._pending(tx, current))
        # A started run remains claimed even after the claim lease has elapsed.
        result = board.reconcile(self.store, self.ctx, now=datetime(2000, 1, 1, tzinfo=timezone.utc) + timedelta(seconds=1))
        current = self.current(ticket)
        self.assertEqual(result["released"], [])
        self.assertEqual(current["status"], "in_dev")
        self.assertNotIn("ticket.released", self.event_names(ticket))

    def test_start_failure_releases_claim_and_keeps_worktree(self):
        ticket = self.ticket()
        with mock.patch.object(board, "start_claimed", side_effect=AsError("START_FAILED", "no start")):
            with self.assertRaises(AsError):
                board.claim_and_start(self.store, self.workspace, ticket["key"], self.agent_id, self.ctx)
        current = self.current(ticket)
        self.assertEqual((current["status"], current["assignee_agent_id"], current["lease_until"]), ("ready_dev", None, None))
        self.assertIn("ticket.released", self.event_names(ticket))
        self.assertTrue(os.path.isdir(current["worktree_path"]))

    def test_retry_releases_pending_claim_and_rejects_other_states(self):
        ticket = self.ticket()
        claimed = self.claim(ticket)
        with self.store.transaction() as tx:
            result = coordinator._handle_ticket_retry({"workspace": self.workspace, "key": ticket["key"]}, tx, self.ctx)
        self.assertEqual(result["ticket"]["status"], "ready_dev")
        self.assertIn("ticket.released", self.event_names(ticket))
        with self.store.transaction() as tx:
            with self.assertRaises(AsError) as caught:
                coordinator._handle_ticket_retry({"workspace": self.workspace, "key": ticket["key"]}, tx, self.ctx)
        self.assertEqual(caught.exception.code, TICKET_TRANSITION_INVALID)
        busy = self.ticket()
        claimed = self.claim(busy)
        with self.store.transaction() as tx:
            current = tickets.get(tx, self.workspace, busy["key"])
            seq = tx.update("ticket", current["id"], {"lease_until": current["lease_until"]}, "ticket.run_started", {})
            current = tx.get("ticket", current["id"])
            tickets._ticket_event(tx, current, seq, "ticket.run_started", "coordinator", "in_dev", "in_dev", {})
            with self.assertRaises(AsError) as caught:
                coordinator._handle_ticket_retry({"workspace": self.workspace, "key": busy["key"]}, tx, self.ctx)
        self.assertEqual(caught.exception.code, TICKET_BUSY)

    def test_startup_removes_orphans_reports_plain_directory_and_keeps_orphan_branch(self):
        ticket = self.ticket()
        claimed = self.claim(ticket)
        orphan = worktrees.create(self.workspace, "T-999", "orphan", "main", state_dir=self.state_dir)
        root = worktrees.root_for(self.workspace, state_dir=self.state_dir)
        plain = os.path.join(root, "plain")
        os.mkdir(plain)
        result = board.reconcile(self.store, self.ctx, startup=True)
        self.assertIn(orphan["path"], result["orphansRemoved"])
        self.assertIn(plain, result["unregisteredPaths"])
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM events WHERE name = 'board.worktree_orphan_removed'").fetchone()[0], 1)
        self.assertEqual(subprocess.run(["git", "-C", self.workspace, "show-ref", "--verify", "--quiet",
                                         "refs/heads/" + orphan["branch"]]).returncode, 0)
        self.assertTrue(os.path.isdir(claimed["worktree_path"]))

    def test_startup_skips_a_deleted_workspace_and_still_reconciles_the_others(self):
        gone = tempfile.mkdtemp()
        with self.store.transaction() as tx:
            tickets.create(tx, gone, "story", {"title": "Workspace removed"})
        shutil.rmtree(gone)
        self.ticket()   # the valid workspace must have a ticket to be reconciled at all
        orphan = worktrees.create(self.workspace, "T-998", "orphan", "main", state_dir=self.state_dir)
        result = board.reconcile(self.store, self.ctx, startup=True)
        self.assertIn(orphan["path"], result["orphansRemoved"])

    def test_startup_blocks_deleted_ready_test_worktree_without_recreating_it(self):
        ticket = self.ticket()
        claimed = self.claim(ticket)
        with self.store.transaction() as tx:
            current = tickets.get(tx, self.workspace, ticket["key"])
            board.release(tx, current, "test_setup")
            current = tickets.move(tx, tickets.get(tx, self.workspace, ticket["key"]), "in_dev", "coordinator")
            tickets.move(tx, current, "ready_test", "coordinator")
        worktrees.remove(self.workspace, claimed["worktree_path"], state_dir=self.state_dir)
        result = board.reconcile(self.store, self.ctx, startup=True)
        self.assertIn(ticket["key"], result["worktreesMissing"])
        missing = self.current(ticket)
        self.assertEqual((missing["status"], missing["blocked_reason"], missing["return_status"]),
                         ("blocked", "WORKTREE_MISSING", "ready_test"))
        self.assertFalse(os.path.exists(claimed["worktree_path"]))

    def test_startup_discards_unrecorded_ticket_branch_but_monitor_removes_nothing(self):
        ticket = self.ticket()
        orphan = worktrees.create(self.workspace, ticket["key"], "recovery-ticket", "main", state_dir=self.state_dir)
        self.assertEqual(board.reconcile(self.store, self.ctx, startup=False)["orphansRemoved"], [])
        self.assertTrue(os.path.isdir(orphan["path"]))
        result = board.reconcile(self.store, self.ctx, startup=True)
        self.assertIn(orphan["path"], result["orphansRemoved"])
        self.assertFalse(os.path.exists(orphan["path"]))
        self.assertNotEqual(subprocess.run(["git", "-C", self.workspace, "show-ref", "--verify", "--quiet",
                                            "refs/heads/" + orphan["branch"]]).returncode, 0)

    def test_startup_keeps_cancelled_ticket_worktree_while_its_run_is_running(self):
        ticket = self.ticket()
        claimed = self.claim(ticket)
        with self.store.transaction() as tx:
            team_id = tx.get("agent", self.agent_id)["team_id"]
            task = tx.create("task", {"team_id": team_id, "origin": "direct", "workspace": self.workspace, "goal": "g"})
            run = tx.create("workflow_run", {"team_id": team_id, "task_id": task, "workflow": "test"})
            tx.transition("workflow_run", run, "running")
            tx.update("ticket", claimed["id"], {"run_id": run}, "ticket.run_started", {})
            tickets.cancel(tx, tickets.get(tx, self.workspace, ticket["key"]), "operator")
        result = board.reconcile(self.store, self.ctx, startup=True)
        self.assertNotIn(claimed["worktree_path"], result["orphansRemoved"])
        self.assertTrue(os.path.isdir(claimed["worktree_path"]))
