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
        self.env.update({"XDG_STATE_HOME": os.path.join(self.root, "state"), "AGENT_STUDIO_ENV_MODE": env_mode})
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

    def cleanup(self):
        try:
            self.run("coordinator", "stop", timeout=30)
        except Exception:
            pass
        shutil.rmtree(self.root, ignore_errors=True)


def key(prefix="test"):
    return f"{prefix}-{uuid.uuid4().hex}"


def req(command, args=None, **extra):
    r = {"protocol": "agent-studio/v1", "command": command, "args": args or {}}
    r.update(extra)
    return r
