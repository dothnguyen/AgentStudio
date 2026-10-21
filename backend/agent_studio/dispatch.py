"""Request validation and routing shared by one-shot `request`, human CLI commands, and `serve`."""
from __future__ import annotations

import json
import sys
import traceback

from . import PROTOCOL, client, coordinator, ops
from .protocol import (AsError, BAD_REQUEST, INTERNAL, UNKNOWN_COMMAND, UNSUPPORTED_PROTOCOL, envelope, req_bool,
                       req_int, req_text, validate_id, validate_idempotency_key)

MAX_ECHO_BYTES = 256 * 1024
DEFAULT_TIMEOUT_MS = 10000


def _coordinator_start(args, req):
    return coordinator.start(enable_debug=req_bool(args, "enableDebug"))


def _coordinator_stop(args, req):
    return coordinator.stop()


def _inbox(command, validator):
    def run(args, req):
        key = validate_idempotency_key(req.get("idempotencyKey"))
        clean = validator(args)
        timeout_ms = req_int(req, "timeoutMs", 0, 60000, DEFAULT_TIMEOUT_MS)
        stored = client.submit(command, clean, key, timeout_ms)
        if not stored.get("ok"):
            err = stored.get("error", {})
            raise AsError(err.get("code", INTERNAL), err.get("message", ""), err.get("retryable", False),
                          err.get("remediation"), stored.get("data"))
        return stored.get("data")
    return run


def _validate_echo(args):
    return {"text": req_text(args, "text", MAX_ECHO_BYTES)}


COMMANDS = {
    "health": lambda args, req: ops.health(args),
    "preflight": lambda args, req: ops.preflight(args),
    "coordinator.start": _coordinator_start,
    "coordinator.stop": _coordinator_stop,
    "debug.echo": _inbox("debug.echo", _validate_echo),
}


def handle_request(obj, require_id: bool) -> dict:
    rid = None
    try:
        if not isinstance(obj, dict):
            raise AsError(BAD_REQUEST, "A request must be a JSON object.")
        if "id" in obj:
            rid = validate_id(obj["id"])
        elif require_id:
            raise AsError(BAD_REQUEST, "Missing request id.")
        proto = obj.get("protocol")
        if proto is None:
            raise AsError(BAD_REQUEST, "Missing protocol.")
        if proto != PROTOCOL:
            raise AsError(UNSUPPORTED_PROTOCOL, f"Unsupported protocol; this backend speaks {PROTOCOL}.")
        command = obj.get("command")
        if not isinstance(command, str):
            raise AsError(BAD_REQUEST, "Missing command.")
        handler = COMMANDS.get(command)
        if handler is None:
            raise AsError(UNKNOWN_COMMAND, f"Unknown command {command[:64]!r}.")
        args = obj.get("args", {})
        if not isinstance(args, dict):
            raise AsError(BAD_REQUEST, "args must be a JSON object.")
        return envelope(rid, True, data=handler(args, obj))
    except AsError as e:
        return envelope(rid, False, data=e.data, error=e.to_error())
    except Exception:
        sys.stderr.write(traceback.format_exc())
        return envelope(rid, False, error={"code": INTERNAL, "message": "Internal error.", "retryable": False})


def handle_bytes(raw: bytes, require_id: bool) -> dict:
    raw = raw.strip()
    # Tolerate UTF-8 BOMs that some Windows stream writers emit at the start (or, on close, the end).
    while raw.startswith(b"\xef\xbb\xbf"):
        raw = raw[3:].lstrip()
    while raw.endswith(b"\xef\xbb\xbf"):
        raw = raw[:-3].rstrip()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return envelope(None, False, error=AsError(BAD_REQUEST, "Request is not valid UTF-8.").to_error())
    try:
        obj = json.loads(text)
    except ValueError:
        return envelope(None, False, error=AsError(BAD_REQUEST, "Request is not valid JSON.").to_error())
    return handle_request(obj, require_id)
