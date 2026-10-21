"""Shared test helpers. Tests run the real entry shim in an isolated XDG_STATE_HOME."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import uuid

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKEND = os.path.join(REPO, "backend")
SHIM = os.path.join(BACKEND, "bin", "agent-studio")
if BACKEND not in sys.path:
    sys.path.insert(0, BACKEND)

HOSTILE = [
    "single 'quote' and double \"quote\"",
    "dollar $HOME $(whoami) ${PATH}",
    "backtick `id` and `$x",
    "percent %PATH% ^& ^|",
    "shell ; rm -rf ~ && echo pwned || true | cat > /tmp/x",
    "newline\nsecond\r\nthird\ttab",
    "emoji \U0001F600\U0001F680 and CJK \u6f22\u5b57\u304b\u306a \ud55c\uad6d\uc5b4",
    "C:\\Users\\Some One\\My Projects\\file.txt",
    "{\"protocol\":\"agent-studio/v1\",\"command\":\"coordinator.stop\"}",
    "",
]


class Sandbox:
    """An isolated state directory plus helpers to run the shim against it."""

    def __init__(self, env_mode="inherit", extra_env=None):
        self.root = tempfile.mkdtemp(prefix="as-test-")
        self.env = dict(os.environ)
        tmux_dir = os.path.join(self.root, "tmux")
        os.makedirs(tmux_dir, mode=0o700)
        self.env.update({"XDG_STATE_HOME": os.path.join(self.root, "state"), "AGENT_STUDIO_ENV_MODE": env_mode,
                         "TMUX_TMPDIR": tmux_dir})
        for k in ("TMUX", "TMUX_PANE"):
            self.env.pop(k, None)
        self.env.update(extra_env or {})

    @property
    def state_dir(self):
        return os.path.join(self.env["XDG_STATE_HOME"], "agent-studio")

    def run(self, *args, stdin=None, timeout=60):
        proc = subprocess.run([SHIM] + list(args), input=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              env=self.env, timeout=timeout)
        lines = [l for l in proc.stdout.splitlines() if l.strip()]
        resp = json.loads(lines[-1]) if lines else None
        return proc.returncode, resp, proc

    def request(self, obj, timeout=60):
        return self.run("request", stdin=json.dumps(obj).encode("utf-8"), timeout=timeout)

    def popen_serve(self):
        return subprocess.Popen([SHIM, "serve"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, env=self.env)

    def tmux(self, *args, socket="agent-studio", check=True):
        """Test-only direct tmux access on this sandbox's private TMUX_TMPDIR."""
        base = ["tmux"] + (["-L", socket] if socket else [])
        proc = subprocess.run(base + list(args), stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=self.env,
                              timeout=20)
        if check and proc.returncode != 0:
            raise AssertionError(f"tmux {args}: {proc.stderr.decode()}")
        return proc.stdout.decode()

    def snapshot(self, team_id=None):
        args = ["snapshot", "--include-stopped"] + (["--team", team_id] if team_id else [])
        rc, resp, proc = self.run(*args)
        assert resp and resp["ok"], (resp, proc.stderr)
        return resp["data"]

    def cleanup(self):
        try:
            self.run("coordinator", "stop", timeout=30)
        except Exception:
            pass
        for socket in ("agent-studio", None):  # private sandbox servers only (TMUX_TMPDIR is ours)
            try:
                self.tmux("kill-server", socket=socket, check=False)
            except Exception:
                pass
        shutil.rmtree(self.root, ignore_errors=True)


def wait_until(fn, timeout=15.0, interval=0.2, message="condition"):
    import time
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = fn()
        if last:
            return last
        time.sleep(interval)
    raise AssertionError(f"timed out waiting for {message}; last={last!r}")


def key(prefix="test"):
    return f"{prefix}-{uuid.uuid4().hex}"


def req(command, args=None, **extra):
    r = {"protocol": "agent-studio/v1", "command": command, "args": args or {}}
    r.update(extra)
    return r
