"""P04-S11: the recovery doc names every operator-visible board code, and the recovery behaviour of the
scheduler (lease expiry, usage limits, ticket retry) holds."""
import json
import os
import tempfile
import unittest

from tests import helpers  # noqa: F401  (puts backend on sys.path)
from tests.helpers import fresh, make_repo
from agent_studio import boardmodel, boardsched, protocol
from agent_studio.protocol import AsError
from tests.unit.test_p04_s09_rules_and_applier import SOLO

ROLES = {"version": 1, "roles": {"worker": {}}}
BOARD = {"version": 2, "leaseSeconds": 1,
         "statuses": [{"id": "build", "kind": "initial"}, {"id": "in-progress"},
                      {"id": "done", "kind": "done"}],
         "ticketFields": [],
         "rules": [{"when": {"status": "build"}, "role": "worker", "workflow": "solo",
                    "onPass": "done", "onFail": "build", "during": "in-progress"}]}


class RecoveryDoc(unittest.TestCase):
    def test_every_board_code_is_documented(self):
        path = os.path.join(helpers.BACKEND, "RECOVERY.md")
        with open(path, encoding="utf-8") as f:
            doc = f.read()
        codes = sorted(value for name, value in vars(protocol).items()
                       if isinstance(value, str)
                       and name.split("_", 1)[0] in ("BOARD", "PHASE", "TICKET", "WORKTREE"))
        self.assertTrue(codes)
        missing = [code for code in codes if code not in doc]
        self.assertEqual(missing, [], f"RECOVERY.md must name every operator-visible code; missing {missing}")


class RecoveryCase(unittest.TestCase):
    def setUp(self):
        self.ws = make_repo()
        self.addCleanup(helpers.reset_repo, self.ws)
        cfg = os.path.join(self.ws, ".agent-studio")
        os.makedirs(os.path.join(cfg, "workflows"), exist_ok=True)
        with open(os.path.join(cfg, "roles.json"), "w") as f:
            json.dump(ROLES, f)
        with open(os.path.join(cfg, "workflows", "solo.json"), "w") as f:
            json.dump(SOLO, f)
        with open(os.path.join(cfg, "board.json"), "w") as f:
            json.dump(BOARD, f)
        import subprocess
        for args in (["add", "-A"], ["commit", "-qm", "board"]):
            subprocess.run(["git", "-C", self.ws] + args, check=True, stdout=subprocess.DEVNULL)
        self.conn, self.store = fresh()
        self.ctx = {"stateDir": tempfile.mkdtemp(), "debug": True}
        with self.store.transaction() as tx:
            self.team = tx.create("team", {"name": "t", "workspace": self.ws})
            tx.transition("team", self.team, "running")
            self.worker = tx.create("agent", {"team_id": self.team, "ordinal": 0, "provider_id": "fake",
                                              "role": "worker", "display_name": "w", "pane_state": "alive"})
            tx.transition("agent", self.worker, "idle")
            boardsched.bind_team(tx, self.ws, self.team)
            boardmodel.ticket_add(tx, self.ws, {"title": "a", "priority": 100})

    def ticket(self):
        return dict(self.conn.execute("SELECT * FROM tickets").fetchone())

    def tick(self):
        return boardsched.tick(self.store, self.ctx)

    def make_unavailable(self, limit=False):
        """The member is not free, so a released ticket is not instantly re-claimed (mirrors reality: the
        member is busy with the crash's aftermath or limit_reached)."""
        with self.store.transaction() as tx:
            tx.transition("agent", self.worker, "busy")
            if limit:
                tx.transition("agent", self.worker, "limit_reached",
                              set_values={"limit_reset_at": "2030-01-01T15:00:00Z"})

    def make_run(self, status="running"):
        with self.store.transaction() as tx:
            task = tx.create("task", {"team_id": self.team, "origin": "workflow", "workspace": self.ws,
                                      "goal": "g"})
            tx.transition("task", task, "assigned")
            tx.transition("task", task, "running")
            run = tx.create("workflow_run", {"team_id": self.team, "task_id": task, "workflow": "definition"})
            tx.transition("workflow_run", run, "running")
            if status != "running":
                tx.transition("workflow_run", run, status)
        return run

    def claim(self, run=None, lease_in_past=True):
        lease = "2000-01-01T00:00:00.000Z" if lease_in_past else "2099-01-01T00:00:00.000Z"
        with self.store.transaction() as tx:
            tx.conn.execute("UPDATE tickets SET assignee = ?, lease_until = ?, active_run_id = ?, "
                            "status = 'in-progress' WHERE key = 'T-001'", (self.worker, lease, run))

    def test_pending_claim_lease_expiry_releases_once_and_returns_the_ticket(self):
        self.claim()
        self.make_unavailable()
        out = self.tick()
        self.assertEqual(out["errors"], [])
        ticket = self.ticket()
        self.assertEqual((ticket["status"], ticket["assignee"], ticket["active_run_id"]),
                         ("build", None, None))
        self.assertIsNone(ticket["run_id"])
        names = [e["name"] for e in self.conn.execute("SELECT name FROM ticket_events ORDER BY id")]
        self.assertEqual(names, ["ticket.created", "ticket.claim_released", "ticket.lease_expired"])
        again = self.tick()  # exactly once: nothing more to release
        self.assertEqual([e["name"] for e in self.conn.execute("SELECT name FROM ticket_events ORDER BY id")],
                         names)

    def test_started_run_is_not_released_when_claim_lease_is_expired(self):
        run = self.make_run("paused")
        self.claim(run)
        self.make_unavailable()
        self.tick()
        ticket = self.ticket()
        self.assertEqual((ticket["status"], ticket["assignee"], ticket["active_run_id"]),
                         ("in-progress", self.worker, run))
        self.assertEqual(self.conn.execute("SELECT status FROM workflow_runs WHERE id = ?",
                                           (run,)).fetchone()[0], "paused")
        self.assertEqual([e["name"] for e in self.conn.execute("SELECT name FROM ticket_events ORDER BY id")],
                         ["ticket.created"])

    def test_usage_limit_releases_without_a_round(self):
        run = self.make_run("failed")
        with self.store.transaction() as tx:
            task = tx.conn.execute("SELECT task_id FROM workflow_runs WHERE id = ?", (run,)).fetchone()[0]
            assignment = tx.create("assignment", {"team_id": self.team, "task_id": task,
                                                  "agent_id": self.worker, "attempt": 1,
                                                  "policy": "read_only", "provider_id": "fake"})
            tx.transition("assignment", assignment, "failed", set_values={"diagnostic_code": "USAGE_LIMIT"})
        self.claim(run, lease_in_past=False)
        self.make_unavailable(limit=True)  # report_rules marks the member limit_reached in reality
        self.tick()
        ticket = self.ticket()
        self.assertEqual((ticket["status"], ticket["assignee"]), ("build", None))
        self.assertIsNone(ticket["rounds_json"])  # no round counted
        self.assertEqual(ticket["run_id"], run)
        names = [e["name"] for e in self.conn.execute("SELECT name FROM ticket_events ORDER BY id")]
        self.assertEqual(names[-1], "ticket.claim_released")

    def test_ticket_retry_clears_a_stuck_claim(self):
        run = self.make_run("running")
        self.claim(run, lease_in_past=False)
        with self.store.transaction() as tx:
            got = boardsched.ticket_retry(tx, self.ws, {"key": "T-001"}, self.ctx)
        self.assertEqual(got["ticket"]["status"], "build")
        ticket = self.ticket()
        self.assertEqual((ticket["assignee"], ticket["active_run_id"], ticket["run_id"]),
                         (None, None, run))
        self.assertEqual(self.conn.execute("SELECT status FROM workflow_runs WHERE id = ?",
                                           (run,)).fetchone()[0], "cancelled")
        with self.assertRaises(AsError) as caught:  # only a claimed ticket
            with self.store.transaction() as tx:
                boardsched.ticket_retry(tx, self.ws, {"key": "T-001"}, self.ctx)
        self.assertEqual(caught.exception.code, "TICKET_TRANSITION_INVALID")

    def test_board_resume_accepts_a_member(self):
        from agent_studio import coordinator
        with self.store.transaction() as tx:
            tx.transition("agent", self.worker, "busy")
            tx.transition("agent", self.worker, "limit_reached",
                          set_values={"limit_reset_at": "2030-01-01T15:00:00Z"})
        with self.store.transaction() as tx:
            got = coordinator._handle_board_resume({"workspace": self.ws, "all": False, "member": "w"}, tx, {})
        self.assertEqual(got, {"resumed": [self.worker]})
        row = self.conn.execute("SELECT availability FROM agents WHERE id = ?",
                                (self.worker,)).fetchone()
        self.assertEqual(row["availability"], "idle")
        with self.assertRaises(AsError) as caught:
            with self.store.transaction() as tx:
                coordinator._handle_board_resume({"workspace": self.ws, "all": False, "member": "nobody"},
                                                 tx, {})
        self.assertEqual(caught.exception.code, "MEMBER_NOT_FOUND")


if __name__ == "__main__":
    unittest.main()
