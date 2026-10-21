"""Cancellation of a claimed assignment whose request file no worker has picked up yet."""
import os
import tempfile
import unittest

from tests import helpers  # noqa: F401
from agent_studio import state, tasks, teams
from agent_studio.runner import request_path
from agent_studio.store import Store


class ClaimedCancel(unittest.TestCase):
    def setUp(self):
        self.sd = tempfile.mkdtemp()
        path = os.path.join(self.sd, "state.db")
        self.conn = state.connect(path, role="coordinator", create=True)
        state.migrate(self.conn, path)
        self.st = Store(self.conn)
        with self.st.transaction() as tx:
            team = tx.create("team", {"name": "t", "workspace": "/w"})
            tx.transition("team", team, "running")
            self.agent = tx.create("agent", {"team_id": team, "ordinal": 0, "provider_id": "fake", "role": "r",
                                             "display_name": "a", "pane_state": "alive"})
            tx.transition("agent", self.agent, "idle")
            task = tx.create("task", {"team_id": team, "origin": "direct", "workspace": "/w", "goal": "g"})
            self.asg = tx.create("assignment", {"team_id": team, "task_id": task, "agent_id": self.agent,
                                                "attempt": 1, "policy": "read_only", "provider_id": "fake"})
            tx.transition("task", task, "assigned")
        teams.dispatch_claims(self.st, self.sd)
        self.inbox = request_path(self.sd, self.agent, self.asg, "inbox")
        self.assertTrue(os.path.exists(self.inbox))

    def cancel(self):
        with self.st.transaction() as tx:
            return tasks.assignment_cancel(tx, {"assignmentId": self.asg}, {"stateDir": self.sd, "debug": True})

    def test_pulled_back_before_any_worker_sees_it(self):
        out = self.cancel()
        self.assertEqual(out["outcome"], "cancelled")
        self.assertFalse(os.path.exists(self.inbox))
        self.assertTrue(os.path.exists(os.path.join(os.path.dirname(self.inbox), "..", "done",
                                                    f"{self.asg}.request.cancelled")))
        status = self.conn.execute("SELECT status FROM assignments WHERE id = ?", (self.asg,)).fetchone()[0]
        self.assertEqual(status, "cancelled")
        self.assertEqual(teams.redeliver(self.st, self.sd), 0)

    def test_already_picked_up_gets_a_cancel_marker(self):
        active = request_path(self.sd, self.agent, self.asg, "active")
        os.makedirs(os.path.dirname(active), exist_ok=True)
        os.replace(self.inbox, active)  # a worker took it
        out = self.cancel()
        self.assertEqual(out["outcome"], "cancel_requested")
        self.assertTrue(os.path.exists(os.path.join(self.sd, "runs", self.asg, "cancel.requested")))
        status = self.conn.execute("SELECT status FROM assignments WHERE id = ?", (self.asg,)).fetchone()[0]
        self.assertEqual(status, "claimed")  # the runner decides the single terminal outcome


if __name__ == "__main__":
    unittest.main()
