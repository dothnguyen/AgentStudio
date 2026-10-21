"""P00-S07 units: reconciliation decisions, resolve guards, bounded reaping, PID reuse."""
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

from tests import helpers  # noqa: F401
from agent_studio import procid, reconcile, resolve, state, teams
from agent_studio.protocol import AsError
from agent_studio.runner import request_path, run_dir
from agent_studio.store import Store


class Base(unittest.TestCase):
    def setUp(self):
        self.sd = tempfile.mkdtemp()
        path = os.path.join(self.sd, "state.db")
        self.conn = state.connect(path, role="coordinator", create=True)
        state.migrate(self.conn, path)
        self.st = Store(self.conn)
        self.ctx = {"stateDir": self.sd, "debug": True}
        with self.st.transaction() as tx:
            self.team = tx.create("team", {"name": "t", "workspace": "/w"})
            tx.transition("team", self.team, "running")
            self.agent = tx.create("agent", {"team_id": self.team, "ordinal": 0, "provider_id": "fake", "role": "r",
                                             "display_name": "a", "pane_state": "alive"})
            tx.transition("agent", self.agent, "idle")
            self.task = tx.create("task", {"team_id": self.team, "origin": "direct", "workspace": "/w", "goal": "g"})
            self.asg = tx.create("assignment", {"team_id": self.team, "task_id": self.task, "agent_id": self.agent,
                                                "attempt": 1, "policy": "read_only", "provider_id": "fake"})
            tx.transition("task", self.task, "assigned")
        self.procs = []

    def tearDown(self):
        for p in self.procs:
            if p.poll() is None:
                p.kill()
                p.wait()

    def spawn(self, ignore_term=False):
        code = ("import signal, time\n" + ("signal.signal(signal.SIGTERM, signal.SIG_IGN)\n" if ignore_term else "")
                + "time.sleep(60)\n")
        p = subprocess.Popen([sys.executable, "-c", code])
        self.procs.append(p)
        time.sleep(0.2)
        return p

    def status(self):
        return self.conn.execute("SELECT status, diagnostic_code FROM assignments WHERE id = ?", (self.asg,)).fetchone()

    def run_as(self, ident):
        with self.st.transaction() as tx:
            tx.transition("assignment", self.asg, "claimed")
            tx.transition("assignment", self.asg, "running", set_values={
                "process_pid": ident["pid"], "process_start_time": ident["startTime"], "process_boot_id": ident["bootId"]})
            tx.transition("agent", self.agent, "busy")


class Decisions(Base):
    def test_live_runner_left_alone_and_pid_reuse_is_not_identity(self):
        p = self.spawn()
        self.run_as(procid.identity(p.pid))
        reconcile.tick(self.st, self.ctx)
        self.assertEqual(self.status()[0], "running")
        with self.conn:
            self.conn.execute("UPDATE assignments SET process_start_time = process_start_time + 7 WHERE id = ?",
                              (self.asg,))  # same PID, different start time: a different process
        reconcile.tick(self.st, self.ctx)
        self.assertEqual(tuple(self.status()), ("reconciling", "RUNNER_GONE"))
        self.assertEqual(self.conn.execute("SELECT availability FROM agents").fetchone()[0], "idle")
        self.assertIsNone(p.poll(), "an unrelated process is never signalled")

    def test_saved_result_is_applied_once(self):
        p = self.spawn()
        ident = procid.identity(p.pid)
        self.run_as(ident)
        from agent_studio.providers.base import REPORT_PROTOCOL
        os.makedirs(run_dir(self.sd, self.asg))
        with open(os.path.join(run_dir(self.sd, self.asg), "result.json"), "w") as f:
            json.dump({"protocol": REPORT_PROTOCOL, "assignmentId": self.asg, "agentId": self.agent,
                       "providerId": "fake", "attempt": 1, "policy": "read_only", "status": "succeeded",
                       "exitCode": 0, "summary": "done", "artifacts": [], "attention": None, "diagnosticCode": None,
                       "evidence": {"providerTerminalEvent": True, "terminalOk": True, "signal": None,
                                    "timedOut": False, "cancelRequested": False, "truncated": False,
                                    "validation": []}}, f)
        p.kill()
        p.wait()
        reconcile.tick(self.st, self.ctx)
        reconcile.tick(self.st, self.ctx)
        self.assertEqual(self.status()[0], "succeeded")
        n = self.conn.execute("SELECT COUNT(*) FROM events WHERE name = 'assignment.reconciled'").fetchone()[0]
        self.assertEqual(n, 1)

    def test_cancel_requested_and_runner_gone_finishes_cancelled(self):
        p = self.spawn()
        self.run_as(procid.identity(p.pid))
        os.makedirs(run_dir(self.sd, self.asg))
        open(os.path.join(run_dir(self.sd, self.asg), "cancel.requested"), "w").close()
        p.kill()
        p.wait()
        reconcile.tick(self.st, self.ctx)
        self.assertEqual(self.status()[0], "cancelled")

    def test_claimed_never_started(self):
        with self.st.transaction() as tx:
            tx.transition("assignment", self.asg, "claimed")
        for box in ("inbox",):
            path = request_path(self.sd, self.agent, self.asg, box)
            os.makedirs(os.path.dirname(path))
            open(path, "w").close()
        reconcile.tick(self.st, self.ctx)
        self.assertEqual(self.status()[0], "claimed")  # still waiting for a worker
        active = request_path(self.sd, self.agent, self.asg, "active")
        os.makedirs(os.path.dirname(active))
        os.replace(path, active)
        reconcile.tick(self.st, self.ctx)
        self.assertEqual(self.status()[0], "claimed")  # within the grace period
        with mock.patch.object(reconcile, "CLAIM_START_GRACE_S", 0.0):
            time.sleep(0.01)
            reconcile.tick(self.st, self.ctx)
        self.assertEqual(tuple(self.status()), ("reconciling", "RUNNER_NO_START"))


class ResolveGuards(Base):
    def resolve(self, **args):
        with self.st.transaction() as tx:
            return resolve.resolve(tx, dict({"assignmentId": self.asg}, **args), self.ctx)

    def test_not_allowed_for_queued_or_running(self):
        with self.assertRaises(AsError) as cm:
            self.resolve(action="fail")
        self.assertEqual(cm.exception.code, "RESOLVE_NOT_ALLOWED")

    def test_never_while_the_attempt_may_still_run(self):
        p = self.spawn()
        self.run_as(procid.identity(p.pid))
        with self.st.transaction() as tx:
            tx.transition("assignment", self.asg, "reconciling")
        with self.assertRaises(AsError) as cm:
            self.resolve(action="retry")
        self.assertEqual(cm.exception.code, "PROCESS_STILL_RUNNING")
        p.kill()
        p.wait()
        out = self.resolve(action="retry", policy="workspace_write")
        self.assertEqual(out["policyChange"], {"from": "read_only", "to": "workspace_write"})
        new = self.conn.execute("SELECT attempt, policy, status FROM assignments WHERE id = ?",
                                (out["newAssignmentId"],)).fetchone()
        self.assertEqual(tuple(new), (2, "workspace_write", "queued"))
        self.assertEqual(tuple(self.status()), ("failed", "SUPERSEDED_BY_RETRY"))

    def test_fail_and_cancel_settle_the_task(self):
        with self.st.transaction() as tx:
            tx.transition("assignment", self.asg, "claimed")
            tx.transition("assignment", self.asg, "reconciling")
        self.assertEqual(self.resolve(action="fail")["status"], "failed")
        self.assertEqual(self.conn.execute("SELECT status FROM tasks").fetchone()[0], "failed")
        with self.assertRaises(AsError):
            self.resolve(action="cancel")  # already settled


class Reaping(unittest.TestCase):
    def test_bounded_escalation_only_for_verified_identities(self):
        stubborn = subprocess.Popen([sys.executable, "-c", "import signal,time\n"
                                     "signal.signal(signal.SIGTERM, signal.SIG_IGN)\ntime.sleep(60)"])
        bystander = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
        time.sleep(0.3)
        try:
            ident = procid.identity(stubborn.pid)
            wrong = dict(procid.identity(bystander.pid), startTime=procid.start_time(bystander.pid) + 3)
            t = time.monotonic()
            left = teams._reap([dict(ident, role="runner", assignmentId="a"), dict(wrong, role="runner", assignmentId="b")],
                               grace_s=0.5)
            self.assertEqual(left, [])
            self.assertLess(time.monotonic() - t, 5)
            stubborn.wait(5)
            self.assertEqual(stubborn.returncode, -signal.SIGKILL)
            self.assertIsNone(bystander.poll(), "a process whose identity does not match is never touched")
        finally:
            for p in (stubborn, bystander):
                if p.poll() is None:
                    p.kill()
                    p.wait()


if __name__ == "__main__":
    unittest.main()
