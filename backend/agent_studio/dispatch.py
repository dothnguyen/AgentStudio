"""Request validation and routing shared by one-shot `request`, human CLI commands, and `serve`."""
from __future__ import annotations

import json
import sys
import traceback

import copy

from . import PROTOCOL, client, coordinator, ops, paths, queries, state, teams, tmuxctl
from .runner import FINAL_STATUSES
from .store import validate_uuid
from .protocol import (AsError, BAD_REQUEST, INTERNAL, UNKNOWN_COMMAND, UNSUPPORTED_PROTOCOL, envelope, req_bool,
                       req_int, req_text, validate_id, validate_idempotency_key)

MAX_ECHO_BYTES = 256 * 1024
DEFAULT_TIMEOUT_MS = 30000


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


def _validate_fixture(args):
    return {"agents": req_int(args, "agents", 1, 8, 2),
            "workspace": req_text(args, "workspace", 4096, required=False) or "/tmp/agent-studio-fixture"}


def _validate_team_start(args):
    teams.validate_roster(copy.deepcopy(args), allow_fake=True)  # shape check only; the coordinator decides
    out = {"workspace": req_text(args, "workspace", 4096, allow_empty=False), "roster": args["roster"]}
    name = req_text(args, "name", 80, required=False)
    if name:
        out["name"] = name
    return out


def _validate_team_stop(args):
    return {"teamId": validate_uuid(args.get("teamId"), "teamId")}


def _validate_debug_assign(args):
    stub = args.get("stub") or {}
    if not isinstance(stub, dict):
        raise AsError(BAD_REQUEST, "stub must be an object.")
    outcome = stub.get("outcome", "succeeded")
    if outcome not in FINAL_STATUSES:
        raise AsError(BAD_REQUEST, f"stub.outcome must be one of {list(FINAL_STATUSES)}.")
    return {"agentId": validate_uuid(args.get("agentId"), "agentId"),
            "goal": req_text(args, "goal", 4096, required=False) or "debug stub task",
            "stub": {"durationMs": req_int(stub, "durationMs", 0, 60000, 1500),
                     "progressLines": req_int(stub, "progressLines", 0, 20, 3),
                     "outcome": outcome, "exitWithoutFinal": req_bool(stub, "exitWithoutFinal"),
                     "summary": req_text(stub, "summary", 500, required=False) or f"stub {outcome}"}}


SESSION_NOT_FOUND = "SESSION_NOT_FOUND"


def _team_attach(args, req):
    team_id = validate_uuid(args.get("teamId"), "teamId")
    conn = _reader()
    try:
        row = conn.execute("SELECT * FROM teams WHERE id = ?", (team_id,)).fetchone()
        if row is None:
            raise AsError("NOT_FOUND", f"Team {team_id} does not exist.")
        team = dict(row)
        tmux = tmuxctl.Tmux()
        check = teams.verify_team(conn, team, tmux)
    finally:
        conn.close()
    if team["status"] not in ("running", "error") or check["state"] != "ok":
        raise AsError(SESSION_NOT_FOUND, f"Team {team_id} has no verified tmux session to attach to "
                                         f"(team {team['status']}, session {check['state']}: {check.get('reason', '')}).")
    return teams.attach_info(team, tmux)


def _reader():
    sd = paths.ensure_state_dir()
    conn = state.connect(state.db_path(sd), role="reader")
    state.check_schema(conn)
    return conn


def _opt_uuid(args, name):
    value = args.get(name)
    return None if value is None else validate_uuid(value, name)


def _snapshot(args, req):
    team_id = _opt_uuid(args, "teamId")
    include_stopped = req_bool(args, "includeStopped")
    conn = _reader()
    try:
        return queries.snapshot(conn, team_id=team_id, include_stopped=include_stopped)
    finally:
        conn.close()


def _events_after(args, req):
    cursor = req_int(args, "cursor", 0, 2 ** 62, 0)
    limit = req_int(args, "limit", 1, 1000, 200)
    team_id = _opt_uuid(args, "teamId")
    db = req_text(args, "dbId", 64, required=False)
    conn = _reader()
    try:
        return queries.events_after(conn, cursor, limit=limit, team_id=team_id, expected_db_id=db)
    finally:
        conn.close()


COMMANDS = {
    "health": lambda args, req: ops.health(args),
    "preflight": lambda args, req: ops.preflight(args),
    "coordinator.start": _coordinator_start,
    "coordinator.stop": _coordinator_stop,
    "snapshot": _snapshot,
    "events.after": _events_after,
    "debug.echo": _inbox("debug.echo", _validate_echo),
    "debug.fixture": _inbox("debug.fixture", _validate_fixture),
    "debug.assign": _inbox("debug.assign", _validate_debug_assign),
    "team.start": _inbox("team.start", _validate_team_start),
    "team.stop": _inbox("team.stop", _validate_team_stop),
    "team.attach": _team_attach,
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
