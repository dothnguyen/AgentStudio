"""Capture the user's login environment so provider CLIs resolve exactly as in their own terminal.

`wsl.exe --exec` does not start a login shell, so ~/.profile and ~/.bashrc (where nvm, pipx, etc. usually
extend PATH) never run. We run the user's shell once as a login+interactive shell with a fixed script,
read its environment NUL-separated after a marker, and use that for child processes. No user text is ever
part of the script.

AGENT_STUDIO_ENV_MODE: login-interactive (default) | login | inherit
"""
from __future__ import annotations

import os
import pwd
import subprocess
from typing import Dict, Optional, Tuple

MARKER = b"__AGENT_STUDIO_ENV_BEGIN__"
SCRIPT = "printf '%s\\0' __AGENT_STUDIO_ENV_BEGIN__; command env -0"
KEEP_FROM_CALLER = ("XDG_STATE_HOME", "AGENT_STUDIO_ENV_MODE", "AGENT_STUDIO_PYTHON", "AGENT_STUDIO_TMUX_SOCKET",
                    "TMUX_TMPDIR", "PYTHONIOENCODING", "AGENT_STUDIO_TEST_FIXTURE_PROVIDERS",
                    "AGENT_STUDIO_FAKE_POLICIES", "AGENT_STUDIO_TEST_CRASH_AT",
                    "AGENT_STUDIO_TEST_CLAIM_GRACE_S")
TIMEOUT_S = 15

_cache: Optional[Tuple[Dict[str, str], dict]] = None


def _login_shell() -> str:
    try:
        shell = pwd.getpwuid(os.getuid()).pw_shell
    except KeyError:
        shell = ""
    if os.path.basename(shell or "") in ("bash", "zsh") and os.access(shell, os.X_OK):
        return shell
    return "/bin/bash"


def _capture(mode: str) -> Dict[str, str]:
    shell = _login_shell()
    flags = ["-l", "-i", "-c"] if mode == "login-interactive" else ["-l", "-c"]
    proc = subprocess.run([shell] + flags + [SCRIPT], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, timeout=TIMEOUT_S, cwd=os.path.expanduser("~"),
                          start_new_session=True)
    out = proc.stdout
    idx = out.find(MARKER + b"\0")
    if idx < 0:
        raise RuntimeError(f"login shell {shell} produced no environment (exit {proc.returncode})")
    env: Dict[str, str] = {}
    for entry in out[idx + len(MARKER) + 1:].split(b"\0"):
        if not entry or b"=" not in entry:
            continue
        k, _, v = entry.partition(b"=")
        env[k.decode("utf-8", "surrogateescape")] = v.decode("utf-8", "surrogateescape")
    if "PATH" not in env:
        raise RuntimeError("captured environment has no PATH")
    return env


def resolve() -> Tuple[Dict[str, str], dict]:
    """Return (environment, info). Cached per process."""
    global _cache
    if _cache is not None:
        return _cache
    mode = os.environ.get("AGENT_STUDIO_ENV_MODE", "login-interactive")
    info = {"mode": mode, "source": "inherited", "warnings": []}
    env = dict(os.environ)
    if mode in ("login-interactive", "login"):
        try:
            captured = _capture(mode)
            for k in KEEP_FROM_CALLER:
                if k in os.environ:
                    captured[k] = os.environ[k]
                else:
                    captured.pop(k, None)
            env = captured
            info["source"] = "login-shell"
            info["shell"] = _login_shell()
        except (OSError, subprocess.SubprocessError, RuntimeError) as e:
            info["source"] = "inherited-fallback"
            info["warnings"].append(f"Could not capture login environment ({e}); using the inherited environment.")
    elif mode != "inherit":
        info["warnings"].append(f"Unknown AGENT_STUDIO_ENV_MODE {mode!r}; using the inherited environment.")
    _cache = (env, info)
    return _cache


def summarize_path(path_value: str) -> dict:
    dirs = list(dict.fromkeys(d for d in path_value.split(":") if d))
    return {"linux": [d for d in dirs if not d.startswith("/mnt/")],
            "windowsInteropCount": sum(1 for d in dirs if d.startswith("/mnt/"))}
