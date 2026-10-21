"""Assignment runner: started by the worker shim, in the foreground of the agent's tmux pane.

It reads the coordinator-written request, reports start evidence (its own PID + start time + boot ID),
prints human-readable progress to the pane, and submits immutable reports. It never changes state itself
and keeps working when the coordinator is down (reports wait in the inbox).

P00-S03: no provider adapters exist yet. Debug requests carry a `stub` describing what to simulate; any other
request fails honestly with NO_PROVIDER_ADAPTER. S04 replaces this with the adapter runner.
"""
from __future__ import annotations

import json
import os
import sys
import time

from . import paths, procid, reports, state
from .protocol import AsError
from .store import validate_uuid
from .textsafe import one_line, terminal_safe

FINAL_STATUSES = ("succeeded", "failed", "cancelled", "waiting_input", "inconclusive")


def request_path(state_dir: str, agent_id: str, assignment_id: str, box: str = "active") -> str:
    return os.path.join(state_dir, "agents", agent_id, box, f"{assignment_id}.request")


def _say(msg: str) -> None:
    sys.stdout.write(f"[{time.strftime('%H:%M:%S')}] {msg}\n")
    sys.stdout.flush()


def run(agent_id: str, assignment_id: str) -> int:
    try:
        validate_uuid(agent_id, "agent")
        validate_uuid(assignment_id, "assignment")
        sd = paths.ensure_state_dir()
        with open(request_path(sd, agent_id, assignment_id), encoding="utf-8") as f:
            req = json.load(f)
        if req.get("agentId") != agent_id or req.get("assignmentId") != assignment_id:
            _say("request file does not belong to this agent; refusing to run it")
            return 3
        conn = state.connect(state.db_path(sd), role="runner")
    except (OSError, ValueError, AsError) as e:
        _say(f"cannot start assignment: {e}")
        return 3

    attempt = req.get("attempt")
    seq = 0

    def report(kind: str, payload: dict) -> None:
        nonlocal seq
        reports.submit(conn, assignment_id, seq, kind, dict(payload, agentId=agent_id, attempt=attempt))
        seq += 1

    ident = procid.identity(os.getpid())
    report("start", {"pid": ident["pid"], "startTime": ident["startTime"], "bootId": ident["bootId"]})
    _say(f"assignment {assignment_id[:8]} started (attempt {attempt}, policy {req.get('policy')})")
    _say("task: " + one_line(str(req.get("goal", ""))))

    stub = (req.get("request") or {}).get("stub")
    if not isinstance(stub, dict):
        _say("no provider adapter is implemented yet (P00-S04); failing honestly")
        report("final", {"status": "failed", "summary": "No provider adapter is implemented yet.",
                         "diagnosticCode": "NO_PROVIDER_ADAPTER"})
        return 1

    lines = int(stub.get("progressLines", 3))
    duration = max(0, int(stub.get("durationMs", 1500))) / 1000.0
    for i in range(lines):
        time.sleep(duration / max(lines, 1))
        msg = f"stub progress {i + 1}/{lines}"
        _say(msg)
        report("progress", {"message": msg})
    if lines == 0:
        time.sleep(duration)
    if stub.get("exitWithoutFinal"):
        _say("stub: exiting without a final report")
        os._exit(4)
    status = stub.get("outcome", "succeeded")
    if status not in FINAL_STATUSES:
        status = "inconclusive"
    report("final", {"status": status, "summary": terminal_safe(str(stub.get("summary", f"stub {status}")), 500),
                     "stub": True})
    _say(f"assignment {assignment_id[:8]} finished: {status}")
    return 0
