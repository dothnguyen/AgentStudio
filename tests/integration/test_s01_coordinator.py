"""P00-S01 integration: real shim, real coordinator daemon, isolated state directory."""
import hashlib
import json
import os
import signal
import stat
import subprocess
import tempfile
import time
import unittest

from tests.helpers import HOSTILE, SHIM, Sandbox, key, req


class CoordinatorLifecycle(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sb = Sandbox()
        rc, resp, proc = cls.sb.run("coordinator", "start", "--enable-debug")
        assert rc == 0 and resp["ok"], proc.stderr
        cls.info = resp["data"]

    @classmethod
    def tearDownClass(cls):
        cls.sb.cleanup()

    def health(self):
        rc, resp, _ = self.sb.run("health")
        self.assertEqual(rc, 0)
        return resp["data"]

    def test_separate_invocations_reach_same_coordinator(self):
        a, b = self.health()["coordinator"], self.health()["coordinator"]
        self.assertTrue(a["running"])
        self.assertEqual((a["pid"], a["startTime"]), (b["pid"], b["startTime"]))
        self.assertEqual(a["pid"], self.info["pid"])

    def test_second_start_reports_existing(self):
        rc, resp, _ = self.sb.run("coordinator", "start")
        self.assertTrue(resp["ok"])
        self.assertTrue(resp["data"]["alreadyRunning"])
        self.assertEqual(resp["data"]["pid"], self.info["pid"])

    def test_coordinator_is_detached_from_cli(self):
        pid = self.info["pid"]
        with open(f"/proc/{pid}/stat", "rb") as f:
            fields = f.read().rsplit(b")", 1)[1].split()
        ppid, sid = int(fields[1]), int(fields[3])
        self.assertEqual(sid, pid, "coordinator should lead its own session")
        self.assertNotEqual(ppid, os.getpid())

    def test_echo_hostile_payloads_through_inbox(self):
        for text in HOSTILE:
            rc, resp, _ = self.sb.request(req("debug.echo", {"text": text}, idempotencyKey=key()))
            self.assertTrue(resp["ok"], resp)
            self.assertEqual(resp["data"]["text"], text)
            self.assertEqual(resp["data"]["sha256"], hashlib.sha256(text.encode("utf-8")).hexdigest())
            self.assertEqual(resp["data"]["coordinatorPid"], self.info["pid"])

    def test_stdout_is_pure_json(self):
        rc, resp, proc = self.sb.run("debug", "echo", "--text", "x\ny \U0001F600")
        lines = proc.stdout.splitlines()
        self.assertEqual(len(lines), 1)
        lines[0].decode("ascii")
        json.loads(lines[0])

    def test_idempotent_retry_and_conflict(self):
        k = key()
        _, first, _ = self.sb.request(req("debug.echo", {"text": "once"}, idempotencyKey=k))
        _, again, _ = self.sb.request(req("debug.echo", {"text": "once"}, idempotencyKey=k))
        self.assertEqual(first, again)
        rc, conflict, _ = self.sb.request(req("debug.echo", {"text": "twice"}, idempotencyKey=k))
        self.assertEqual(rc, 1)
        self.assertEqual(conflict["error"]["code"], "IDEMPOTENCY_CONFLICT")
        import sqlite3
        conn = sqlite3.connect(os.path.join(self.sb.state_dir, "state.db"))
        n = conn.execute("SELECT COUNT(*) FROM commands WHERE idempotency_key = ?", (k,)).fetchone()[0]
        self.assertEqual(n, 1)

    def test_pending_then_retry_with_same_key(self):
        pid = self.info["pid"]
        k = key("pending")
        os.kill(pid, signal.SIGSTOP)
        try:
            rc, resp, _ = self.sb.request(req("debug.echo", {"text": "later"}, idempotencyKey=k, timeoutMs=300))
            self.assertEqual(resp["error"]["code"], "PENDING")
            self.assertTrue(resp["error"]["retryable"])
            self.assertEqual(resp["data"]["idempotencyKey"], k)
        finally:
            os.kill(pid, signal.SIGCONT)
        rc, resp, _ = self.sb.request(req("debug.echo", {"text": "later"}, idempotencyKey=k))
        self.assertTrue(resp["ok"])
        self.assertEqual(resp["data"]["text"], "later")

    def test_serve_session(self):
        p = self.sb.popen_serve()
        try:
            lines = [req("health", id="h1")]
            for i, text in enumerate(HOSTILE):
                lines.append(req("debug.echo", {"text": text}, id=i, idempotencyKey=key("serve")))
            payload = b"".join(json.dumps(l).encode("utf-8") + b"\n" for l in lines)
            payload = payload.replace(b"\n", b"\nnot json at all\n", 1)  # a bad line after the first request
            out, err = p.communicate(payload, timeout=60)
        finally:
            if p.poll() is None:
                p.kill()
        resps = [json.loads(l) for l in out.splitlines()]
        self.assertEqual(resps[0]["id"], "h1")
        self.assertEqual(resps[1]["error"]["code"], "BAD_REQUEST")
        for i, text in enumerate(HOSTILE):
            r = resps[i + 2]
            self.assertEqual(r["id"], i)
            self.assertEqual(r["data"]["text"], text)

    def test_killing_serve_client_leaves_coordinator(self):
        p = self.sb.popen_serve()
        p.stdin.write(json.dumps(req("health", id=1)).encode() + b"\n")
        p.stdin.flush()
        p.stdout.readline()
        p.kill()
        p.wait(10)
        for stream in (p.stdin, p.stdout, p.stderr):
            stream.close()
        c = self.health()["coordinator"]
        self.assertEqual((c["pid"], c["startTime"]), (self.info["pid"], self.info["startTime"]))

    def test_private_permissions(self):
        sd = self.sb.state_dir
        self.assertEqual(stat.S_IMODE(os.stat(sd).st_mode), 0o700)
        for name in os.listdir(sd):
            mode = stat.S_IMODE(os.stat(os.path.join(sd, name)).st_mode)
            self.assertEqual(mode & 0o077, 0, name)

    def test_log_contains_no_payload(self):
        secret = "do-not-log-" + key()
        self.sb.request(req("debug.echo", {"text": secret}, idempotencyKey=key()))
        with open(os.path.join(self.sb.state_dir, "coordinator.log"), encoding="utf-8") as f:
            self.assertNotIn(secret, f.read())


class StopAndUnavailable(unittest.TestCase):
    def test_stop_then_unavailable_then_restart(self):
        sb = Sandbox()
        try:
            _, r1, _ = sb.run("coordinator", "start")
            self.assertTrue(r1["ok"])
            self.assertFalse(r1["data"]["debugCommands"])
            rc, r, _ = sb.run("debug", "echo", "--text", "x")
            self.assertEqual(r["error"]["code"], "DEBUG_DISABLED")
            _, s, _ = sb.run("coordinator", "stop")
            self.assertTrue(s["data"]["stopped"])
            self.assertFalse(s["data"]["forced"])
            rc, r, _ = sb.run("debug", "echo", "--text", "x")
            self.assertEqual(r["error"]["code"], "BACKEND_UNAVAILABLE")
            _, h, _ = sb.run("health")
            self.assertFalse(h["data"]["coordinator"]["running"])
            _, again, _ = sb.run("coordinator", "stop")
            self.assertFalse(again["data"]["wasRunning"])
            _, r2, _ = sb.run("coordinator", "start")
            self.assertNotEqual(r2["data"]["pid"], r1["data"]["pid"])
        finally:
            sb.cleanup()

    def test_stale_pidfile_is_not_a_running_coordinator(self):
        sb = Sandbox()
        try:
            os.makedirs(sb.state_dir, mode=0o700)
            with open(os.path.join(sb.state_dir, "coordinator.json"), "w") as f:
                json.dump({"pid": os.getpid(), "startTime": 1, "bootId": "x"}, f)
            _, h, _ = sb.run("health")
            self.assertFalse(h["data"]["coordinator"]["running"])
        finally:
            sb.cleanup()

    def test_concurrent_starts_yield_one_coordinator(self):
        sb = Sandbox()
        try:
            procs = [subprocess.Popen([SHIM, "coordinator", "start"], stdout=subprocess.PIPE, env=sb.env)
                     for _ in range(4)]
            pids = {json.loads(p.communicate(timeout=60)[0])["data"]["pid"] for p in procs}
            self.assertEqual(len(pids), 1)
        finally:
            sb.cleanup()


class Preflight(unittest.TestCase):
    def setUp(self):
        self.sb = Sandbox()
        self.ws = tempfile.mkdtemp(prefix="as-ws-")

    def tearDown(self):
        self.sb.cleanup()

    def test_ready(self):
        rc, r, _ = self.sb.run("preflight", "--workspace", self.ws)
        self.assertEqual(rc, 0, r)
        self.assertTrue(r["data"]["ready"])
        self.assertEqual(r["data"]["workspace"], os.path.realpath(self.ws))

    def test_missing_workspace(self):
        rc, r, _ = self.sb.run("preflight", "--workspace", os.path.join(self.ws, "nope"))
        self.assertEqual(rc, 1)
        self.assertEqual(r["error"]["code"], "WORKSPACE_NOT_FOUND")

    def test_relative_workspace(self):
        rc, r, _ = self.sb.request(req("preflight", {"workspace": "relative/dir"}))
        self.assertEqual(r["error"]["code"], "WORKSPACE_NOT_FOUND")

    def test_tmux_hidden_by_path(self):
        self.sb.env["PATH"] = "/nonexistent-dir"
        rc, r, _ = self.sb.run("preflight", "--workspace", self.ws)
        self.assertEqual(r["error"]["code"], "TMUX_NOT_FOUND")
        self.assertIn("remediation", r["error"])

    @unittest.skipIf(os.geteuid() == 0, "root ignores directory permissions")
    def test_unwritable_state_dir(self):
        ro = os.path.join(self.sb.root, "ro")
        os.makedirs(ro)
        os.chmod(ro, 0o500)
        self.sb.env["XDG_STATE_HOME"] = ro
        try:
            rc, r, _ = self.sb.run("preflight", "--workspace", self.ws)
            self.assertEqual(r["error"]["code"], "STATE_DIR_UNUSABLE")
        finally:
            os.chmod(ro, 0o700)

    def test_state_dir_on_windows_drive_rejected(self):
        self.sb.env["XDG_STATE_HOME"] = "/mnt/c/Users/x/state"
        rc, r, _ = self.sb.run("preflight", "--workspace", self.ws)
        self.assertEqual(r["error"]["code"], "STATE_DIR_UNUSABLE")

    def test_preflight_creates_no_tmux_session(self):
        sock = os.path.join(self.sb.root, "tmux-sock")
        self.sb.env["TMUX_TMPDIR"] = sock
        os.makedirs(sock)
        self.sb.run("preflight", "--workspace", os.path.join(self.ws, "nope"))
        self.sb.run("preflight", "--workspace", self.ws)
        self.assertEqual(os.listdir(sock), [])


class LoginEnvironment(unittest.TestCase):
    """A provider-style CLI only on the interactive login PATH (the nvm case) must be found."""

    def test_login_interactive_path_is_captured(self):
        home = tempfile.mkdtemp(prefix="as-home-")
        fakebin = os.path.join(home, ".fake-nvm", "bin")
        os.makedirs(fakebin)
        tmux = os.path.join(fakebin, "tmux")
        with open(tmux, "w") as f:
            f.write("#!/bin/sh\necho 'tmux 9.9-fake'\n")
        os.chmod(tmux, 0o755)
        with open(os.path.join(home, ".bash_profile"), "w") as f:
            f.write('[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"\n')
        with open(os.path.join(home, ".bashrc"), "w") as f:
            f.write('case $- in *i*) ;; *) return;; esac\n'
                    'echo "noisy bashrc output"\n'
                    'export PATH="$HOME/.fake-nvm/bin:$PATH"\n')
        sb = Sandbox(env_mode="login-interactive",
                     extra_env={"HOME": home, "PATH": "/usr/bin:/bin", "SHELL": "/bin/bash"})
        try:
            ws = tempfile.mkdtemp()
            rc, r, proc = sb.run("preflight", "--workspace", ws)
            tmux_check = [c for c in r["data"]["checks"] if c["name"] == "tmux"][0]
            self.assertEqual(tmux_check.get("path"), tmux, r)
            self.assertEqual(tmux_check.get("version"), "tmux 9.9-fake")
            self.assertEqual(r["data"]["environment"]["source"], "login-shell")
            sb.env["AGENT_STUDIO_ENV_MODE"] = "inherit"
            rc, r, _ = sb.run("preflight", "--workspace", ws)
            tmux_check = [c for c in r["data"]["checks"] if c["name"] == "tmux"][0]
            self.assertNotEqual(tmux_check.get("path"), tmux)
        finally:
            sb.cleanup()


if __name__ == "__main__":
    unittest.main()
