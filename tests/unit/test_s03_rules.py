import os
import tempfile
import unittest

from tests import helpers  # noqa: F401
from agent_studio import report_rules, reports, state, teams
from agent_studio.protocol import AsError
from agent_studio.store import Store


def setup():
    path = os.path.join(tempfile.mkdtemp(), "state.db")
    conn = state.connect(path, role="coordinator", create=True)
    state.migrate(conn, path)
    st = Store(conn)
    with st.transaction() as tx:
        team = tx.create("team", {"name": "t", "workspace": "/w"})
        tx.transition("team", team, "running")
        agent = tx.create("agent", {"team_id": team, "ordinal": 0, "provider_id": "fake", "role": "r",
                                    "display_name": "a", "pane_state": "alive"})
        tx.transition("agent", agent, "idle")
        task = tx.create("task", {"team_id": team, "origin": "direct", "workspace": "/w", "goal": "g"})
        asg = tx.create("assignment", {"team_id": team, "task_id": task, "agent_id": agent, "attempt": 1,
                                       "policy": "read_only", "provider_id": "fake", "request_json": {"stub": {}}})
        tx.transition("task", task, "assigned")
    return path, conn, st, agent, task, asg


def status(conn, table, id_):
    col = "availability" if table == "agents" else "status"
    return conn.execute(f"SELECT {col} FROM {table} WHERE id = ?", (id_,)).fetchone()[0]


class ReportRules(unittest.TestCase):
    def setUp(self):
        self.path, self.conn, self.st, self.agent, self.task, self.asg = setup()
        self.runner = state.connect(self.path, role="runner")
        self.sd = tempfile.mkdtemp()

    def apply(self):
        reports.apply_pending(self.st, report_rules.apply)

    def claim(self):
        teams.dispatch_claims(self.st, self.sd)

    def outcome(self):
        return self.conn.execute("SELECT outcome FROM report_applications ORDER BY report_id DESC").fetchone()[0]

    def start(self, seq=0, **extra):
        payload = dict({"agentId": self.agent, "attempt": 1, "pid": 10, "startTime": 20, "bootId": "b"}, **extra)
        reports.submit(self.runner, self.asg, seq, "start", payload)
        self.apply()

    def test_claim_writes_private_request_file_after_commit(self):
        self.claim()
        self.assertEqual(status(self.conn, "assignments", self.asg), "claimed")
        path = os.path.join(self.sd, "agents", self.agent, "inbox", f"{self.asg}.request")
        self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
        os.unlink(path)
        self.assertEqual(teams.redeliver(self.st, self.sd), 1)  # never delivered -> safe to rewrite
        os.makedirs(os.path.join(self.sd, "agents", self.agent, "done"))
        os.replace(path, os.path.join(self.sd, "agents", self.agent, "done", f"{self.asg}.request"))
        self.assertEqual(teams.redeliver(self.st, self.sd), 0)  # already seen by a worker -> never again

    def test_start_requires_claim_identity_and_matching_ids(self):
        self.start()
        self.assertEqual(self.outcome(), "rejected:INVALID_TRANSITION")  # not claimed yet
        self.claim()
        self.start(seq=1, agentId="00000000-0000-4000-8000-000000000000")
        self.assertEqual(self.outcome(), "rejected:REPORT_MISMATCH")
        self.start(seq=2, pid=None)
        self.assertEqual(self.outcome(), "rejected:REPORT_MISMATCH")
        self.start(seq=3)
        self.assertEqual(self.outcome(), "started")
        self.assertEqual(status(self.conn, "assignments", self.asg), "running")
        self.assertEqual(status(self.conn, "tasks", self.task), "running")
        self.assertEqual(status(self.conn, "agents", self.agent), "busy")

    def test_inconclusive_goes_to_reconciling_not_success(self):
        self.claim()
        self.start()
        reports.submit(self.runner, self.asg, 1, "final", {"agentId": self.agent, "attempt": 1, "status": "inconclusive"})
        self.apply()
        self.assertEqual(status(self.conn, "assignments", self.asg), "reconciling")
        self.assertEqual(status(self.conn, "tasks", self.task), "running")
        self.assertEqual(status(self.conn, "agents", self.agent), "idle")

    def test_wrong_attempt_and_unknown_status_rejected(self):
        self.claim()
        self.start()
        reports.submit(self.runner, self.asg, 1, "final", {"agentId": self.agent, "attempt": 2, "status": "succeeded"})
        self.apply()
        self.assertEqual(self.outcome(), "rejected:REPORT_MISMATCH")
        reports.submit(self.runner, self.asg, 2, "final", {"agentId": self.agent, "attempt": 1, "status": "great"})
        self.apply()
        self.assertEqual(status(self.conn, "assignments", self.asg), "running")

    def test_pane_command_contains_only_ids_and_paths(self):
        cmd = teams.pane_command("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
        self.assertTrue(cmd.startswith("exec env "))
        self.assertTrue(cmd.endswith("11111111-1111-4111-8111-111111111111 22222222-2222-4222-8222-222222222222"))


if __name__ == "__main__":
    unittest.main()
