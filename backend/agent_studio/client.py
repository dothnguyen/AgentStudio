"""Client side of the command inbox."""
from __future__ import annotations

import os
import signal

from . import coordinator, inbox, paths, state
from .protocol import AsError, BACKEND_UNAVAILABLE, PENDING


def submit(command: str, args: dict, key: str, timeout_ms: int) -> dict:
    sd = paths.ensure_state_dir()
    info = coordinator.running_info(sd)
    if not info:
        raise AsError(BACKEND_UNAVAILABLE, "The coordinator is not running.", retryable=True,
                      remediation="Run: agent-studio coordinator start")
    conn = state.connect(state.db_path(sd), role="client")
    try:
        state.check_schema(conn)
        seq = inbox.insert_or_get(conn, key, command, args)
        try:
            os.kill(info["pid"], signal.SIGUSR1)  # identity verified just above; wake-up is best effort
        except OSError:
            pass
        resp = inbox.wait_response(conn, seq, timeout_ms / 1000.0)
    finally:
        conn.close()
    if resp is None:
        raise AsError(PENDING, "The command was recorded but the coordinator has not answered yet. "
                               "Retry with the same idempotencyKey to get the result.",
                      retryable=True, data={"idempotencyKey": key})
    return resp
