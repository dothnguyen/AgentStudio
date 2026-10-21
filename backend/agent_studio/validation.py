"""Workflow configuration and deterministic validation (P00-S06).

The validation command comes from `<workspace>/.agent-studio/workflow.json` (committed, read once at workflow
start and frozen into the run), never from free text. It runs as an argv - no shell - in the workspace, in a
detached `agent-studio validate` process so a slow test suite never blocks the coordinator, with a timeout,
an allowlisted environment, and bounded output. Its result is a file, so it survives a coordinator restart.
"""
from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import time

from . import procid
from .protocol import AsError, BAD_REQUEST
from .providers.base import BASE_ENV

CONFIG_REL = os.path.join(".agent-studio", "workflow.json")
WORKFLOW_CONFIG_INVALID = "WORKFLOW_CONFIG_INVALID"
MAX_OUTPUT = 64 * 1024
EXAMPLE = '{"version": 1, "validation": {"argv": ["python3", "-m", "unittest"], "timeoutMs": 600000}}'


def load_config(workspace: str) -> dict:
    path = os.path.join(workspace, CONFIG_REL)
    try:
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
    except FileNotFoundError:
        raise AsError(WORKFLOW_CONFIG_INVALID, f"Missing {CONFIG_REL} in the workspace.",
                      remediation=f"Commit a file like: {EXAMPLE}")
    except (OSError, ValueError) as e:
        raise AsError(WORKFLOW_CONFIG_INVALID, f"{CONFIG_REL} is not valid JSON: {e}")
    if not isinstance(raw, dict) or raw.get("version") != 1:
        raise AsError(WORKFLOW_CONFIG_INVALID, f"{CONFIG_REL} must be an object with \"version\": 1.")
    v = raw.get("validation")
    if not isinstance(v, dict):
        raise AsError(WORKFLOW_CONFIG_INVALID, f"{CONFIG_REL} needs a \"validation\" object.")
    argv = v.get("argv")
    if (not isinstance(argv, list) or not 1 <= len(argv) <= 64
            or not all(isinstance(a, str) and a and "\x00" not in a and len(a) <= 4096 for a in argv)):
        raise AsError(WORKFLOW_CONFIG_INVALID, "validation.argv must be a list of 1-64 non-empty strings "
                                               "(an argv, not a shell command line).")

    def ms(obj, key, default, lo, hi):
        value = obj.get(key, default)
        if isinstance(value, bool) or not isinstance(value, int) or not lo <= value <= hi:
            raise AsError(WORKFLOW_CONFIG_INVALID, f"{key} must be an integer between {lo} and {hi}.")
        return value

    return {"validation": {"argv": argv, "timeoutMs": ms(v, "timeoutMs", 600000, 1000, 3600000)},
            "stageDeadlineMs": ms(raw, "stageDeadlineMs", 1800000, 1000, 6 * 3600000),
            "workflowDeadlineMs": ms(raw, "workflowDeadlineMs", 7200000, 1000, 24 * 3600000)}


def spawn(stage_dir: str, workspace: str, config: dict) -> dict:
    """Start the detached validator for one stage; returns its process identity."""
    os.makedirs(stage_dir, mode=0o700, exist_ok=True)
    request = {"argv": config["validation"]["argv"], "cwd": workspace, "timeoutMs": config["validation"]["timeoutMs"]}
    tmp = os.path.join(stage_dir, "validation.request.json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(request, f)
    os.replace(tmp, os.path.join(stage_dir, "validation.request.json"))
    launcher = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "launch.py")
    p = subprocess.Popen([sys.executable, "-s", launcher, "validate", "--dir", stage_dir], stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd="/", start_new_session=True,
                         close_fds=True)
    return procid.identity(p.pid)


def result(stage_dir: str):
    try:
        with open(os.path.join(stage_dir, "validation.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def run_validator(stage_dir: str) -> int:
    """Entry point of `agent-studio validate --dir DIR` (detached)."""
    with open(os.path.join(stage_dir, "validation.request.json"), encoding="utf-8") as f:
        req = json.load(f)
    out_path = os.path.join(stage_dir, "validation.out")
    started = time.monotonic()
    res = {"exitCode": None, "timedOut": False, "error": None, "outputPath": out_path, "outputTruncated": False}
    exe = req["argv"][0]
    exe = exe if os.path.isabs(exe) else shutil.which(exe)
    if not exe:
        res["error"] = f"validation command not found: {req['argv'][0]}"
    else:
        env = {k: os.environ[k] for k in BASE_ENV if k in os.environ}
        fd = os.open(out_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            p = subprocess.Popen([exe] + req["argv"][1:], cwd=req["cwd"], stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env, start_new_session=True)
            written = 0
            deadline = started + req["timeoutMs"] / 1000.0
            os.set_blocking(p.stdout.fileno(), False)
            import select
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    res["timedOut"] = True
                    for sig in (signal.SIGTERM, signal.SIGKILL):
                        try:
                            os.killpg(p.pid, sig)
                        except ProcessLookupError:
                            break
                        try:
                            p.wait(timeout=3)
                            break
                        except subprocess.TimeoutExpired:
                            continue
                    break
                if select.select([p.stdout], [], [], min(0.2, remaining))[0]:
                    chunk = os.read(p.stdout.fileno(), 65536)
                    if not chunk:
                        break
                    if written < MAX_OUTPUT:
                        piece = chunk[:MAX_OUTPUT - written]
                        os.write(fd, piece)
                        written += len(piece)
                    if written >= MAX_OUTPUT and len(chunk) > 0:
                        res["outputTruncated"] = res["outputTruncated"] or written + len(chunk) > MAX_OUTPUT
            p.wait()
            res["exitCode"] = p.returncode
        except OSError as e:
            res["error"] = f"validation command could not start: {e.strerror}"
        finally:
            os.close(fd)
    res["durationMs"] = int((time.monotonic() - started) * 1000)
    res["passed"] = res["error"] is None and not res["timedOut"] and res["exitCode"] == 0
    tmp = os.path.join(stage_dir, "validation.json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(res, f)
    os.chmod(tmp, 0o600)
    os.replace(tmp, os.path.join(stage_dir, "validation.json"))
    return 0


def output_head(path: str, limit: int = 2000) -> str:
    try:
        with open(path, "rb") as f:
            return f.read(limit).decode("utf-8", "replace")
    except OSError:
        return ""
