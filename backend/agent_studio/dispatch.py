"""Request validation and routing shared by one-shot `request`, human CLI commands, and `serve`."""
from __future__ import annotations

import json
import sys
import traceback

import copy

from . import PROTOCOL, client, coordinator, ops, paths, queries, state, teams, tmuxctl
from .providers.base import POLICIES
from .providers.fake.fake_cli import SCENARIOS
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


def _validate_fake_options(opts):
    if not isinstance(opts, dict):
        raise AsError(BAD_REQUEST, "fake options must be an object.")
    scenario = opts.get("scenario", "success")
    if scenario not in SCENARIOS:
        raise AsError(BAD_REQUEST, f"fake.scenario must be one of {list(SCENARIOS)}.")
    out = {"scenario": scenario, "durationMs": req_int(opts, "durationMs", 0, 600000, 1000),
           "progressLines": req_int(opts, "progressLines", 0, 100000, 3)}
    write = req_text(opts, "writeFile", 200, required=False)
    if write:
        out["writeFile"] = write
    return out


def _validate_debug_assign(args):
    policy = args.get("policy", "read_only")
    if policy not in POLICIES:
        raise AsError(BAD_REQUEST, f"policy must be one of {list(POLICIES)}.")
    out = {"agentId": validate_uuid(args.get("agentId"), "agentId"),
           "goal": req_text(args, "goal", 16384, required=False) or "debug fake task",
           "policy": policy, "providerOptions": _validate_fake_options(args.get("fake") or {})}
    if "deadlineMs" in args:
        out["deadlineMs"] = req_int(args, "deadlineMs", 100, 6 * 3600 * 1000, 0)
    if "outputBudgetBytes" in args:
        out["outputBudgetBytes"] = req_int(args, "outputBudgetBytes", 1024, 64 * 1024 * 1024, 0)
    return out


MAX_TASK_BYTES = 32 * 1024


def _validate_task_direct(args):
    policy = args.get("policy")
    if policy not in POLICIES:
        raise AsError(BAD_REQUEST, f"policy must be one of {list(POLICIES)} (there is no unrestricted mode).")
    out = {"teamId": validate_uuid(args.get("teamId"), "teamId"),
           "agentId": validate_uuid(args.get("agentId"), "agentId"),
           "text": req_text(args, "text", MAX_TASK_BYTES, allow_empty=False), "policy": policy}
    if not out["text"].strip():
        raise AsError(BAD_REQUEST, "Task text must not be blank.")
    if "deadlineMs" in args:
        out["deadlineMs"] = req_int(args, "deadlineMs", 100, 6 * 3600 * 1000, 0)
    if args.get("debugProviderOptions") is not None:
        out["debugProviderOptions"] = _validate_fake_options(args["debugProviderOptions"])
    return out


STAGE_NAMES = ("developer", "reviewer", "developer_repair", "reviewer_recheck")


def _validate_workflow_start(args):
    out = {"teamId": validate_uuid(args.get("teamId"), "teamId"),
           "developerAgentId": validate_uuid(args.get("developerAgentId"), "developerAgentId"),
           "reviewerAgentId": validate_uuid(args.get("reviewerAgentId"), "reviewerAgentId"),
           "text": req_text(args, "text", MAX_TASK_BYTES, allow_empty=False)}
    if not out["text"].strip():
        raise AsError(BAD_REQUEST, "Task text must not be blank.")
    if args.get("allowDirtyTree"):
        out["allowDirtyTree"] = req_bool(args, "allowDirtyTree")
    opts = args.get("debugStageOptions")
    if opts is not None:
        if not isinstance(opts, dict) or not set(opts) <= set(STAGE_NAMES):
            raise AsError(BAD_REQUEST, f"debugStageOptions keys must be among {list(STAGE_NAMES)}.")
        out["debugStageOptions"] = {k: _validate_fake_options(v) for k, v in opts.items()}
    return out


def _validate_workflow_id(args):
    return {"workflowRunId": validate_uuid(args.get("workflowRunId"), "workflowRunId")}


def _workflow_show(args, req):
    wf_id = validate_uuid(args.get("workflowRunId"), "workflowRunId")
    conn = _reader()
    try:
        return queries.workflow_detail(conn, wf_id)
    finally:
        conn.close()


def _validate_resolve(args):
    action = args.get("action")
    if action not in ("retry", "fail", "cancel"):
        raise AsError(BAD_REQUEST, "action must be retry, fail, or cancel.")
    out = {"assignmentId": validate_uuid(args.get("assignmentId"), "assignmentId"), "action": action}
    if args.get("policy") is not None:
        if action != "retry" or args["policy"] not in POLICIES:
            raise AsError(BAD_REQUEST, f"policy is only for retry, one of {list(POLICIES)}.")
        out["policy"] = args["policy"]
    if args.get("debugProviderOptions") is not None:
        out["debugProviderOptions"] = _validate_fake_options(args["debugProviderOptions"])
    return out


def _validate_cancel(args):
    return {"assignmentId": validate_uuid(args.get("assignmentId"), "assignmentId")}


def _task_show(args, req):
    task_id = validate_uuid(args.get("taskId"), "taskId")
    conn = _reader()
    try:
        return queries.task_detail(conn, task_id)
    finally:
        conn.close()


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
    "task.direct": _inbox("task.direct", _validate_task_direct),
    "task.show": _task_show,
    "assignment.cancel": _inbox("assignment.cancel", _validate_cancel),
    "assignment.resolve": _inbox("assignment.resolve", _validate_resolve),
    "workflow.start": _inbox("workflow.start", _validate_workflow_start),
    "workflow.cancel": _inbox("workflow.cancel", _validate_workflow_id),
    "workflow.show": _workflow_show,
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
