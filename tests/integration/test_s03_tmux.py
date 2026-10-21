"""P00-S03 integration with real tmux: panes, delivery, liveness, attach, and scoped stop."""
import json
import os
import pty
import select
import signal
import subprocess
import tempfile
import time
import unittest

from tests.helpers import BACKEND, Sandbox, key, req, wait_until

WORKER = os.path.join(BACKEND, "bin", "agent-studio-worker")


class TeamCase(unittest.TestCase):
    debug = True

    def setUp(self):
        self.sb = Sandbox()
        args = ["coordinator", "start"] + (["--enable-debug"] if self.debug else [])
        rc, r, p = self.sb.run(*args)
        self.assertTrue(r["ok"], p.stderr)
        self.ws = tempfile.mkdtemp(prefix="as-ws-")

    def tearDown(self):
        self.sb.cleanup()

    def start_team(self, n=2, k=None):
        roster = [{"providerId": "fake", "role": f"role{i}", "displayName": f"agent-{i}"} for i in range(n)]
        rc, r, p = self.sb.request(req("team.start", {"workspace": self.ws, "roster": roster},
                                       idempotencyKey=k or key("team")))
        self.assertTrue(r and r["ok"], (r, p.stderr))
        return r["data"]

    def panes(self):
        out = self.sb.tmux("list-panes", "-a", "-F", "#{session_id} #{window_id} #{pane_id} #{pane_pid} #{pane_dead}",
                           check=False)
        return [dict(zip(("session", "window", "pane", "pid", "dead"), l.split())) for l in out.splitlines()]

    def assign(self, agent_id, **stub):
        stub.setdefault("durationMs", 300)
        stub.setdefault("progressLines", 1)
        rc, r, _ = self.sb.request(req("debug.assign", {"agentId": agent_id, "stub": stub}, idempotencyKey=key("asg")))
        self.assertTrue(r["ok"], r)
        return r["data"]

    def assignment(self, team_id, asg_id):
        return next(a for a in self.sb.snapshot(team_id)["assignments"] if a["id"] == asg_id)

    def agent(self, team_id, agent_id):
        return next(a for a in self.sb.snapshot(team_id)["agents"] if a["id"] == agent_id)

    def state_dir(self):
        return self.sb.state_dir


class PaneLayout(TeamCase):
    def test_n2_and_n3_exact_panes_in_one_window(self):
        for n in (2, 3):
            team = self.start_team(n)
            sid = self.sb.snapshot(team["teamId"])["teams"][0]["tmuxSessionId"]
            mine = [p for p in self.panes() if p["session"] == sid]
            self.assertEqual(len(mine), n)
            self.assertEqual(len({p["window"] for p in mine}), 1)
            self.assertEqual(sorted(p["pane"] for p in mine), sorted(a["paneId"] for a in team["agents"]))
            layout = self.sb.tmux("display-message", "-p", "-t", mine[0]["window"], "#{window_layout}")
            self.assertTrue(layout.strip())
            titles = self.sb.tmux("list-panes", "-t", sid, "-F", "#{pane_title}").split("\n")
            for a in team["agents"]:
                self.assertTrue(any(a["displayName"] in t for t in titles), titles)
            snap = self.sb.snapshot(team["teamId"])
            self.assertEqual(snap["teams"][0]["status"], "running")
            self.assertEqual({a["availability"] for a in snap["agents"]}, {"idle"})
            self.assertEqual({a["paneState"] for a in snap["agents"]}, {"alive"})

    def test_idempotent_start_creates_one_session(self):
        k = key("same")
        a, b = self.start_team(2, k), self.start_team(2, k)
        self.assertEqual(a["teamId"], b["teamId"])
        self.assertEqual(len(self.sb.tmux("list-sessions", "-F", "#{session_id}").split()), 1)

    def test_roster_validation(self):
        bad = [([], "non-empty"), ([{"providerId": "gpt", "role": "x"}], "not supported"),
               ([{"providerId": "fake", "role": ""}], "role"),
               ([{"providerId": "fake", "role": "x"}] * 9, "at most 8")]
        aid = "11111111-1111-4111-8111-111111111111"
        bad.append(([{"providerId": "fake", "role": "a", "agentId": aid}, {"providerId": "fake", "role": "b", "agentId": aid}],
                    "duplicated"))
        for roster, hint in bad:
            rc, r, _ = self.sb.request(req("team.start", {"workspace": self.ws, "roster": roster}, idempotencyKey=key()))
            self.assertEqual(r["error"]["code"], "BAD_REQUEST", roster)
            self.assertIn(hint, r["error"]["message"])
        rc, r, _ = self.sb.request(req("team.start", {"workspace": "/nope/x", "roster": [{"providerId": "fake", "role": "a"}]},
                                       idempotencyKey=key()))
        self.assertEqual(r["error"]["code"], "WORKSPACE_NOT_FOUND")
        self.assertEqual(self.sb.tmux("list-sessions", check=False), "")


class FakeNeedsDebug(TeamCase):
    debug = False

    def test_fake_provider_rejected_by_production_coordinator(self):
        rc, r, _ = self.sb.request(req("team.start", {"workspace": self.ws, "roster": [{"providerId": "fake", "role": "a"}]},
                                       idempotencyKey=key()))
        self.assertEqual(r["error"]["code"], "BAD_REQUEST")
        self.assertIn("test-only", r["error"]["message"])


class Delivery(TeamCase):
    def test_assignment_runs_in_its_own_pane_only(self):
        team = self.start_team(3)
        target = team["agents"][1]
        d = self.assign(target["agentId"], progressLines=2)
        wait_until(lambda: self.assignment(team["teamId"], d["assignmentId"])["status"] == "succeeded",
                   message="assignment succeeded")
        snap = self.sb.snapshot(team["teamId"])
        self.assertEqual(snap["tasks"][0]["status"], "succeeded")
        self.assertEqual(self.agent(team["teamId"], target["agentId"])["availability"], "idle")
        for a in team["agents"]:
            done = os.listdir(os.path.join(self.state_dir(), "agents", a["agentId"], "done"))
            self.assertEqual(done, [f"{d['assignmentId']}.request"] if a is target else [])
            text = self.sb.tmux("capture-pane", "-p", "-t", a["paneId"])  # test-only check of what the operator sees
            self.assertEqual(d["assignmentId"][:8] in text, a is target, a["displayName"])
        rc, ev, _ = self.sb.run("events", "--team", team["teamId"], "--limit", "500")
        names = [e["name"] for e in ev["data"]["events"] if e.get("assignmentId") == d["assignmentId"]]
        self.assertEqual(names[:3], ["assignment.created", "assignment.claimed", "assignment.running"])
        self.assertEqual(names[-1], "assignment.succeeded")

    def test_foreign_and_malformed_request_files_are_not_run(self):
        team = self.start_team(2)
        a, b = team["agents"]
        foreign_id = "22222222-2222-4222-8222-222222222222"
        inbox_b = os.path.join(self.state_dir(), "agents", b["agentId"], "inbox")
        with open(os.path.join(inbox_b, f"{foreign_id}.request"), "w") as f:
            json.dump({"agentId": a["agentId"], "assignmentId": foreign_id, "attempt": 1}, f)
        with open(os.path.join(inbox_b, "not-a-uuid.request"), "w") as f:
            f.write("{}")
        done_b = os.path.join(self.state_dir(), "agents", b["agentId"], "done")
        wait_until(lambda: len(os.listdir(done_b)) == 2, message="worker to archive both files")
        self.assertIn("not-a-uuid.request.rejected", os.listdir(done_b))
        text = self.sb.tmux("capture-pane", "-p", "-t", b["paneId"])
        self.assertIn("does not belong to this agent", text)
        self.assertIn("ignoring malformed request file", text)
        self.assertEqual(self.sb.snapshot(team["teamId"])["assignments"], [])

    def test_unfinished_assignment_never_becomes_succeeded(self):
        team = self.start_team(1)
        d = self.assign(team["agents"][0]["agentId"], exitWithoutFinal=True)
        wait_until(lambda: os.listdir(os.path.join(self.state_dir(), "agents", team["agents"][0]["agentId"], "done")),
                   message="runner to exit")
        time.sleep(1.0)
        self.assertEqual(self.assignment(team["teamId"], d["assignmentId"])["status"], "running")
        self.assertEqual(self.sb.snapshot(team["teamId"])["tasks"][0]["status"], "running")

    def test_failed_outcome_and_agent_back_to_idle(self):
        team = self.start_team(1)
        d = self.assign(team["agents"][0]["agentId"], outcome="failed")
        wait_until(lambda: self.assignment(team["teamId"], d["assignmentId"])["status"] == "failed")
        self.assertEqual(self.sb.snapshot(team["teamId"])["tasks"][0]["status"], "failed")
        wait_until(lambda: self.agent(team["teamId"], team["agents"][0]["agentId"])["availability"] == "idle")

    def test_queue_waits_for_the_agent(self):
        team = self.start_team(1)
        aid = team["agents"][0]["agentId"]
        first = self.assign(aid, durationMs=1500)
        second = self.assign(aid)
        wait_until(lambda: self.assignment(team["teamId"], first["assignmentId"])["status"] == "running")
        self.assertEqual(self.assignment(team["teamId"], second["assignmentId"])["status"], "queued")
        wait_until(lambda: self.assignment(team["teamId"], second["assignmentId"])["status"] == "succeeded")


class Liveness(TeamCase):
    def test_mapping_survives_resize_focus_and_layout_changes(self):
        team = self.start_team(3)
        sid = self.sb.snapshot(team["teamId"])["teams"][0]["tmuxSessionId"]
        window = self.panes()[0]["window"]
        self.sb.tmux("resize-window", "-t", window, "-x", "90", "-y", "30")
        self.sb.tmux("select-pane", "-t", team["agents"][2]["paneId"])
        self.sb.tmux("select-layout", "-t", window, "even-vertical")
        self.sb.tmux("swap-pane", "-s", team["agents"][0]["paneId"], "-t", team["agents"][2]["paneId"])
        time.sleep(3)  # longer than one monitor interval
        snap = self.sb.snapshot(team["teamId"])
        self.assertEqual({a["id"]: a["paneId"] for a in snap["agents"]},
                         {a["agentId"]: a["paneId"] for a in team["agents"]})
        self.assertEqual({a["paneState"] for a in snap["agents"]}, {"alive"})
        d = self.assign(team["agents"][0]["agentId"])
        wait_until(lambda: self.assignment(team["teamId"], d["assignmentId"])["status"] == "succeeded")
        self.assertIn(d["assignmentId"][:8], self.sb.tmux("capture-pane", "-p", "-t", team["agents"][0]["paneId"]))
        self.assertIn(sid, self.sb.tmux("list-sessions", "-F", "#{session_id}"))

    def test_dead_pane_marks_agent_offline_and_running_work_reconciling(self):
        team = self.start_team(2)
        victim = team["agents"][0]
        d = self.assign(victim["agentId"], durationMs=20000, progressLines=1)
        wait_until(lambda: self.assignment(team["teamId"], d["assignmentId"])["status"] == "running")
        pid = int(self.sb.tmux("display-message", "-p", "-t", victim["paneId"], "#{pane_pid}"))
        os.killpg(os.getpgid(pid), signal.SIGKILL)
        wait_until(lambda: self.agent(team["teamId"], victim["agentId"])["availability"] == "offline",
                   message="agent offline")
        snap = self.sb.snapshot(team["teamId"])
        self.assertEqual(self.agent(team["teamId"], victim["agentId"])["paneState"], "dead")
        self.assertEqual(self.assignment(team["teamId"], d["assignmentId"])["status"], "reconciling")
        self.assertEqual(snap["tasks"][0]["status"], "running")  # never succeeded from pane state
        self.assertEqual(self.agent(team["teamId"], team["agents"][1]["agentId"])["availability"], "idle")
        rc, ev, _ = self.sb.run("events", "--team", team["teamId"], "--limit", "500")
        dead = [e for e in ev["data"]["events"] if e["name"] == "agent.pane_dead"]
        self.assertEqual(dead[0]["data"]["reason"], "pane process exited")

    def test_missing_session_marks_team_error(self):
        team = self.start_team(2)
        sid = self.sb.snapshot(team["teamId"])["teams"][0]["tmuxSessionId"]
        self.sb.tmux("kill-session", "-t", sid)
        wait_until(lambda: self.sb.snapshot(team["teamId"])["teams"][0]["status"] == "error", message="team error")
        self.assertEqual({a["availability"] for a in self.sb.snapshot(team["teamId"])["agents"]}, {"offline"})
        rc, r, _ = self.sb.request(req("team.stop", {"teamId": team["teamId"]}, idempotencyKey=key()))
        self.assertTrue(r["ok"], r)
        self.assertFalse(r["data"]["sessionWasPresent"])

    def test_mismatched_marker_preserves_session(self):
        team = self.start_team(2)
        sid = self.sb.snapshot(team["teamId"])["teams"][0]["tmuxSessionId"]
        self.sb.tmux("set-option", "-t", sid, "@agent_studio_owner", "someone-else")
        rc, r, _ = self.sb.request(req("team.stop", {"teamId": team["teamId"]}, idempotencyKey=key()))
        self.assertEqual(r["error"]["code"], "CLEANUP_INCOMPLETE")
        self.assertIn(sid, self.sb.tmux("list-sessions", "-F", "#{session_id}"))
        self.assertEqual(self.sb.snapshot(team["teamId"])["teams"][0]["status"], "error")

    def test_reused_pane_index_is_not_identity(self):
        team = self.start_team(2)
        first = team["agents"][0]
        window = self.panes()[0]["window"]
        self.sb.tmux("kill-pane", "-t", first["paneId"])
        intruder = self.sb.tmux("split-window", "-d", "-P", "-F", "#{pane_id}", "-t", window, "sleep 600").strip()
        idx = self.sb.tmux("display-message", "-p", "-t", intruder, "#{pane_index}").strip()
        self.assertIn(idx, ("0", "1"))
        wait_until(lambda: self.agent(team["teamId"], first["agentId"])["availability"] == "offline")
        self.assertEqual(self.agent(team["teamId"], first["agentId"])["paneId"], first["paneId"])
        rc, r, _ = self.sb.request(req("team.stop", {"teamId": team["teamId"]}, idempotencyKey=key()))
        self.assertEqual(r["error"]["code"], "CLEANUP_INCOMPLETE")
        self.assertIn("did not create", r["error"]["message"])
        self.assertIn(intruder, self.sb.tmux("list-panes", "-a", "-F", "#{pane_id}"))


class AttachAndStop(TeamCase):
    def attach_and_detach(self, team_id):
        """Attach through `agent-studio team attach` on a real pseudo-terminal, then press Ctrl-b d."""
        import fcntl
        import struct
        import termios
        pid, fd = pty.fork()
        if pid == 0:
            os.execve(os.path.join(BACKEND, "bin", "agent-studio"),
                      ["agent-studio", "team", "attach", "--team", team_id], dict(self.sb.env, TERM="xterm"))
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))  # a real terminal has a size
        out = b""

        def pump(seconds, until=None):
            nonlocal out
            deadline = time.monotonic() + seconds
            while time.monotonic() < deadline:
                if until and until in out:
                    return
                if select.select([fd], [], [], 0.2)[0]:
                    try:
                        chunk = os.read(fd, 65536)
                    except OSError:
                        return
                    if not chunk:
                        return
                    out += chunk

        pump(10, until=b"idle")
        time.sleep(0.3)
        os.write(fd, b"\x02d")
        pump(5, until=b"[detached")
        status = None
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            done, status = os.waitpid(pid, os.WNOHANG)
            if done:
                break
            time.sleep(0.1)
        else:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
            self.fail("tmux client did not exit after Ctrl-b d")
        os.close(fd)
        return out, status

    def test_unrelated_sessions_untouched_and_attach_detach_reattach(self):
        self.sb.tmux("new-session", "-d", "-s", "users-own", "sleep 600", socket=None)
        self.sb.tmux("new-session", "-d", "-s", "not-ours", "sleep 600")
        before_default = self.sb.tmux("list-sessions", "-F", "#{session_id} #{session_name}", socket=None)
        team = self.start_team(2)
        d = self.assign(team["agents"][1]["agentId"], durationMs=2500, progressLines=5)
        out1, st1 = self.attach_and_detach(team["teamId"])
        self.assertIn(b"detached", out1)
        self.assertEqual(st1 >> 8, 0)
        out2, _ = self.attach_and_detach(team["teamId"])  # reattach to the same session
        self.assertIn(b"detached", out2)
        wait_until(lambda: self.assignment(team["teamId"], d["assignmentId"])["status"] == "succeeded",
                   message="work continued while detached")
        self.assertEqual(len([a for a in self.sb.snapshot(team["teamId"])["assignments"]]), 1)  # no re-dispatch
        rc, r, _ = self.sb.request(req("team.stop", {"teamId": team["teamId"]}, idempotencyKey=key()))
        self.assertTrue(r["ok"], r)
        inv = r["data"]["tmuxInventory"]
        self.assertEqual({s["session_name"] for s in inv["before"]} - {s["session_name"] for s in inv["after"]},
                         {"as-" + team["teamId"].replace("-", "")[:16]})
        self.assertIn("not-ours", {s["session_name"] for s in inv["after"]})
        self.assertEqual(self.sb.tmux("list-sessions", "-F", "#{session_id} #{session_name}", socket=None), before_default)

    def test_attach_without_tty_returns_commands(self):
        team = self.start_team(2)
        rc, r, _ = self.sb.run("team", "attach", "--team", team["teamId"])
        self.assertTrue(r["ok"], r)
        a = r["data"]
        self.assertIn("-L agent-studio attach-session -t =as-", a["wsl"])
        self.assertTrue(a["windowsTerminal"].startswith("wt.exe -w new wsl.exe -d "))
        self.assertIn("--exec /", a["windowsTerminal"])
        self.assertNotIn("$", a["windowsTerminal"])  # safe to paste into PowerShell
        rc, r, _ = self.sb.request(req("team.attach", {"teamId": "33333333-3333-4333-8333-333333333333"}))
        self.assertEqual(r["error"]["code"], "NOT_FOUND")

    def test_stop_cancels_active_work_and_is_repeatable(self):
        team = self.start_team(2)
        d = self.assign(team["agents"][0]["agentId"], durationMs=20000)
        wait_until(lambda: self.assignment(team["teamId"], d["assignmentId"])["status"] == "running")
        rc, r, _ = self.sb.request(req("team.stop", {"teamId": team["teamId"]}, idempotencyKey=key()))
        self.assertTrue(r["ok"], r)
        snap = self.sb.snapshot(team["teamId"])
        self.assertEqual(snap["teams"][0]["status"], "stopped")
        self.assertEqual(self.assignment(team["teamId"], d["assignmentId"])["status"], "cancelled")
        self.assertEqual({a["availability"] for a in snap["agents"]}, {"offline"})
        rc, again, _ = self.sb.request(req("team.stop", {"teamId": team["teamId"]}, idempotencyKey=key()))
        self.assertTrue(again["data"]["alreadyStopped"])
        rc, att, _ = self.sb.run("team", "attach", "--team", team["teamId"])
        self.assertEqual(att["error"]["code"], "SESSION_NOT_FOUND")
        time.sleep(1)
        self.assertEqual(self.assignment(team["teamId"], d["assignmentId"])["status"], "cancelled")


class WorkerShim(unittest.TestCase):
    def test_rejects_invalid_ids(self):
        for args in ([], ["x", "y"], ["11111111-1111-4111-8111-111111111111", "; rm -rf ~"]):
            p = subprocess.run([WORKER] + args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
            self.assertEqual(p.returncode, 2)
            self.assertIn(b"refusing", p.stderr)


if __name__ == "__main__":
    unittest.main()
