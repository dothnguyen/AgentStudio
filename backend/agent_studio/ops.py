"""Read-only commands: health and infrastructure preflight."""
from __future__ import annotations

import os
import platform
import re
import shutil
import subprocess
import uuid

from . import PROTOCOL, VERSION, coordinator, envresolve, paths, procid
from .protocol import AsError, STATE_DIR_UNUSABLE, TMUX_NOT_FOUND, WORKSPACE_NOT_FOUND, req_text

WINDOWS_PATH_RE = re.compile(r"^(?:[A-Za-z]:(?:[\\/]|$)|\\\\)")


def wsl_info() -> dict:
    try:
        with open("/proc/sys/kernel/osrelease", encoding="ascii", errors="replace") as f:
            kernel = f.read().strip()
    except OSError:
        kernel = ""
    low = kernel.lower()
    is_wsl = "microsoft" in low or os.path.exists("/proc/sys/fs/binfmt_misc/WSLInterop")
    version = ("2" if "wsl2" in low else "1") if is_wsl else None
    return {"isWsl": is_wsl, "version": version, "kernel": kernel}


def health(args: dict) -> dict:
    data = {"backendVersion": VERSION, "protocol": PROTOCOL, "python": platform.python_version(),
            "distro": os.environ.get("WSL_DISTRO_NAME"), "wsl": wsl_info()}
    try:
        sd = paths.ensure_state_dir()
        data["stateDir"] = {"path": sd, "ok": True}
    except AsError as e:
        data["stateDir"] = {"path": paths.raw_state_dir(), "ok": False, "error": e.to_error()}
        data["coordinator"] = {"running": False}
        return data
    info = coordinator.running_info(sd)
    if info:
        data["coordinator"] = coordinator.describe(sd, info, already=True)
        del data["coordinator"]["alreadyRunning"]
        runtime = procid.read_json(os.path.join(sd, coordinator.RUNTIME_FILE))
        if isinstance(runtime, dict):
            data["environment"] = runtime
    else:
        data["coordinator"] = {"running": False}
    data["keepAlive"] = {"active": procid.lock_is_held(os.path.join(sd, "keepalive.lock"))}
    return data


def canonical_workspace(raw: str) -> str:
    path = raw
    if WINDOWS_PATH_RE.match(raw):
        wslpath = shutil.which("wslpath") or "/usr/bin/wslpath"
        if not os.access(wslpath, os.X_OK):
            raise AsError(WORKSPACE_NOT_FOUND, "A Windows path was given but wslpath is unavailable (not running in WSL?).")
        proc = subprocess.run([wslpath, "-u", raw], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL, timeout=5)
        if proc.returncode != 0:
            raise AsError(WORKSPACE_NOT_FOUND, "The Windows path could not be translated to a WSL path.")
        path = proc.stdout.decode("utf-8", "surrogateescape").rstrip("\n")
    if not os.path.isabs(path):
        raise AsError(WORKSPACE_NOT_FOUND, "The workspace path must be absolute.")
    real = os.path.realpath(path)
    if not os.path.isdir(real):
        raise AsError(WORKSPACE_NOT_FOUND, f"Workspace {real} does not exist or is not a directory.",
                      remediation="Choose an existing folder.")
    return real


def preflight(args: dict) -> dict:
    raw = req_text(args, "workspace", 4096, allow_empty=False)
    checks, warnings = [], []
    first_error = None

    def record(name, error=None, **extra):
        nonlocal first_error
        entry = {"name": name, "ok": error is None}
        entry.update(extra)
        if error is not None:
            entry["error"] = error.to_error()
            if first_error is None:
                first_error = error
        checks.append(entry)

    try:
        sd = paths.ensure_state_dir()
        probe = os.path.join(sd, f".probe-{uuid.uuid4().hex}")
        with open(probe, "w"):
            pass
        os.unlink(probe)
        record("stateDir", path=sd)
    except AsError as e:
        record("stateDir", e)

    workspace = None
    try:
        workspace = canonical_workspace(raw)
        sd_real = os.path.realpath(paths.raw_state_dir())
        if sd_real == workspace or sd_real.startswith(workspace.rstrip("/") + "/"):
            raise AsError(STATE_DIR_UNUSABLE, f"The state directory {sd_real} is inside the workspace.",
                          remediation="Keep Agent Studio state outside the project folder (unset XDG_STATE_HOME).")
        record("workspace", path=workspace)
        if paths.is_windows_or_network_path(workspace):
            warnings.append({"code": "WORKSPACE_ON_WINDOWS_FS",
                             "message": "The workspace is on a Windows drive; agents will run slower and may hit "
                                        "line-ending or file-watch issues. A WSL-native folder is recommended."})
    except AsError as e:
        record("workspace", e)

    env, envinfo = envresolve.resolve()
    warnings.extend({"code": "ENVIRONMENT", "message": w} for w in envinfo["warnings"])
    tmux = shutil.which("tmux", path=env.get("PATH", ""))
    if not tmux:
        record("tmux", AsError(TMUX_NOT_FOUND, "tmux was not found on the login PATH.",
                               remediation="Install it in WSL, e.g. sudo apt install tmux"))
    else:
        try:
            out = subprocess.run([tmux, "-V"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                 stderr=subprocess.DEVNULL, timeout=5, env=env)
            version = out.stdout.decode("utf-8", "replace").strip()
            if out.returncode != 0:
                raise OSError(f"exit {out.returncode}")
            record("tmux", path=tmux, version=version)
        except (OSError, subprocess.SubprocessError) as e:
            record("tmux", AsError(TMUX_NOT_FOUND, f"tmux at {tmux} did not run ({e}).",
                                   remediation="Reinstall tmux in WSL."))

    data = {"ready": first_error is None, "workspace": workspace, "checks": checks, "warnings": warnings,
            "environment": {"mode": envinfo["mode"], "source": envinfo["source"]}}
    if first_error is not None:
        raise AsError(first_error.code, first_error.message, retryable=first_error.retryable,
                      remediation=first_error.remediation, data=data)
    return data
