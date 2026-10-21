"""P00-S02 integration: concurrency, crash safety, restart, and duplicate commands through the real coordinator."""
import json
import os
import signal
import subprocess
import sys
import tempfile
import textwrap
import threading
import unittest

from tests.helpers import BACKEND, Sandbox, key, req
from agent_studio import queries, state
from agent_studio.store import Store

WRITER = textwrap.dedent("""
    import sys
    sys.path.insert(0, sys.argv[1])
    from agent_studio import state
    from agent_studio.store import Store
    path, teams = sys.argv[2], int(sys.argv[3])
    conn = state.connect(path, role="coordinator")
    st = Store(conn)
    for i in range(teams):
        with st.transaction() as tx:
            t = tx.create("team", {"name": f"t{i}", "workspace": "/w"})
            for n in range(3):
                tx.create("agent", {"team_id": t, "ordinal": n, "provider_id": "fake", "role": "r",
                                    "display_name": f"a{n}"})
""")

CRASHER = textwrap.dedent("""
    import os, signal, sys
    sys.path.insert(0, sys.argv[1])
    from agent_studio import state
    from agent_studio.store import Store
    path = sys.argv[2]
    conn = state.connect(path, role="coordinator")
    st = Store(conn)
    with st.transaction() as tx:
        team = tx.create("team", {"name": "t", "workspace": "/w"})
        agent = tx.create("agent", {"team_id": team, "ordinal": 0, "provider_id": "fake", "role": "r",
                                    "display_name": "a"})
        task = tx.create("task", {"team_id": team, "origin": "direct", "workspace": "/w", "goal": "g"})
        asg = tx.create("assignment", {"team_id": team, "task_id": task, "agent_id": agent, "attempt": 1,
                                       "policy": "read_only", "provider_id": "fake"})
        tx.transition("assignment", asg, "claimed")
        tx.transition("assignment", asg, "running")
    print(asg, flush=True)
    with st.transaction() as tx:
        tx.transition("assignment", asg, "succeeded")
        os.kill(os.getpid(), signal.SIGKILL)   # crash before COMMIT
""")


def fresh_db():
    path = os.path.join(tempfile.mkdtemp(), "state.db")
    conn = state.connect(path, role="coordinator", create=True)
    state.migrate(conn, path)
    conn.close()
    return path


class Concurrency(unittest.TestCase):
    def test_two_readers_and_a_writer(self):
        path = fresh_db()
        teams = 60
        writer = subprocess.Popen([sys.executable, "-c", WRITER, BACKEND, path, str(teams)])
        problems, observed = [], []

        def reader(n):
            conn = state.connect(path, role="reader")
            last = -1
            while True:
                snap = queries.snapshot(conn)
                cursor = snap["cursor"]
                per_team = {}
                for a in snap["agents"]:
                    per_team[a["teamId"]] = per_team.get(a["teamId"], 0) + 1
                if cursor < last:
                    problems.append(f"reader {n}: cursor went back {last} -> {cursor}")
                if any(per_team.get(t["id"], 0) != 3 for t in snap["teams"]) or len(per_team) != len(snap["teams"]):
                    problems.append(f"reader {n}: half-written team at cursor {cursor}")
                if cursor != 4 * len(snap["teams"]):
                    problems.append(f"reader {n}: cursor {cursor} inconsistent with {len(snap['teams'])} teams")
                observed.append(cursor)
                last = cursor
                if len(snap["teams"]) == teams:
                    return
                if writer.poll() is not None and writer.returncode != 0:
                    problems.append("writer failed")
                    return

        threads = [threading.Thread(target=reader, args=(i,)) for i in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(120)
        writer.wait(60)
        self.assertEqual(writer.returncode, 0)
        self.assertEqual(problems, [])
        self.assertGreater(len(set(observed)), 2, "readers should have seen intermediate states")


class Crash(unittest.TestCase):
    def test_crash_before_commit_leaves_assignment_explicit(self):
        path = fresh_db()
        proc = subprocess.run([sys.executable, "-c", CRASHER, BACKEND, path], stdout=subprocess.PIPE, timeout=60)
        self.assertEqual(proc.returncode, -signal.SIGKILL)
        asg = proc.stdout.decode().strip()
        conn = state.connect(path, role="coordinator")
        self.assertEqual(conn.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        status = conn.execute("SELECT status FROM assignments WHERE id = ?", (asg,)).fetchone()[0]
        self.assertEqual(status, "running")
        names = [r[0] for r in conn.execute("SELECT name FROM events WHERE assignment_id = ? ORDER BY seq", (asg,))]
        self.assertEqual(names, ["assignment.created", "assignment.claimed", "assignment.running"])


class ThroughCoordinator(unittest.TestCase):
    def setUp(self):
        self.sb = Sandbox()
        rc, r, p = self.sb.run("coordinator", "start", "--enable-debug")
        self.assertTrue(r["ok"], p.stderr)

    def tearDown(self):
        self.sb.cleanup()

    def snapshot(self):
        rc, r, _ = self.sb.run("snapshot")
        self.assertTrue(r["ok"], r)
        return r["data"]

    def test_duplicate_command_creates_nothing_twice(self):
        k = key("fixture")
        _, first, _ = self.sb.request(req("debug.fixture", {"agents": 2}, idempotencyKey=k))
        self.assertTrue(first["ok"], first)
        cursor = self.snapshot()["cursor"]
        _, again, _ = self.sb.request(req("debug.fixture", {"agents": 2}, idempotencyKey=k))
        self.assertEqual(first, again)
        snap = self.snapshot()
        self.assertEqual(snap["cursor"], cursor)
        self.assertEqual(len(snap["assignments"]), 1)
        _, conflict, _ = self.sb.request(req("debug.fixture", {"agents": 3}, idempotencyKey=k))
        self.assertEqual(conflict["error"]["code"], "IDEMPOTENCY_CONFLICT")

    def test_status_survives_coordinator_restart(self):
        _, f, _ = self.sb.request(req("debug.fixture", {"agents": 3}, idempotencyKey=key()))
        before = self.snapshot()
        self.sb.run("coordinator", "stop")
        during = self.snapshot()  # readable with no coordinator at all
        self.sb.run("coordinator", "start")
        after = self.snapshot()
        for snap in (during, after):
            self.assertEqual((snap["dbId"], snap["cursor"]), (before["dbId"], before["cursor"]))
            self.assertEqual(snap["assignments"], before["assignments"])
            self.assertEqual(snap["agents"], before["agents"])

    def test_serve_snapshot_then_events(self):
        self.sb.request(req("debug.fixture", {"agents": 1}, idempotencyKey=key()))
        p = self.sb.popen_serve()
        lines = [req("snapshot", id="s"), req("events.after", {"cursor": 0, "limit": 2}, id="e1"),
                 req("events.after", {"cursor": 0, "teamId": "not-a-uuid"}, id="bad"),
                 req("events.after", {"cursor": 10 ** 6}, id="ahead")]
        out, _ = p.communicate(b"".join(json.dumps(l).encode() + b"\n" for l in lines), timeout=60)
        r = {x["id"]: x for x in map(json.loads, out.splitlines())}
        self.assertEqual(r["s"]["data"]["cursor"], 6)  # team, agent x2, task, assignment, task.assigned
        self.assertEqual([e["seq"] for e in r["e1"]["data"]["events"]], [1, 2])
        self.assertEqual(r["e1"]["data"]["dbId"], r["s"]["data"]["dbId"])
        self.assertEqual(r["bad"]["error"]["code"], "BAD_REQUEST")
        self.assertEqual(r["ahead"]["error"]["code"], "CURSOR_INVALID")

    def test_snapshot_before_any_coordinator(self):
        sb = Sandbox()
        try:
            rc, r, _ = sb.run("snapshot")
            self.assertEqual(r["error"]["code"], "BACKEND_UNAVAILABLE")
        finally:
            sb.cleanup()

    def test_preflight_rejects_state_inside_workspace(self):
        ws = os.path.dirname(self.sb.env["XDG_STATE_HOME"])
        rc, r, _ = self.sb.run("preflight", "--workspace", ws)
        self.assertEqual(r["error"]["code"], "STATE_DIR_UNUSABLE")


if __name__ == "__main__":
    unittest.main()
