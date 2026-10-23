"""Request validation and routing shared by one-shot `request`, human CLI commands, and `serve`."""
from __future__ import annotations

import re
import json
import os
import sys
import traceback

import copy

from . import workflow, workflowdef, PROTOCOL, client, coordinator, ops, paths, queries, state, teams, tickets, tmuxctl
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
    out = {"workspace": req_text(args, "workspace", 4096, allow_empty=False)}
    if args.get("roster") is not None:  # omitted -> the coordinator reads .agent-studio/team.json
        teams.validate_roster(copy.deepcopy(args), allow_fake=True)  # shape check only; the coordinator decides
        out["roster"] = args["roster"]
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
    final_text = req_text(opts, "finalText", 1500, required=False)
    if final_text:
        out["finalText"] = final_text
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


def _validate_debug_ticket_worktree(args):
    return {"workspace": _ticket_workspace(args), "key": _ticket_key(args.get("key"))}


MAX_TASK_BYTES = 32 * 1024


def _optional_run_workspace(args, out):
    workspace = args.get("workspace")
    if workspace is None:
        return
    try:
        valid = (isinstance(workspace, str) and len(workspace.encode("utf-8")) <= 4096
                 and os.path.isabs(workspace) and "\\" not in workspace and "\0" not in workspace)
    except UnicodeEncodeError:
        valid = False
    if not valid:
        raise AsError(BAD_REQUEST, "workspace must be an absolute POSIX path no longer than 4096 bytes.")
    out["workspace"] = workspace


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
    _optional_run_workspace(args, out)
    return out


STAGE_NAMES = ("developer", "reviewer", "developer_repair", "reviewer_recheck")


STAGE_ID_KEY = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
DEFINITION_NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
TICKET_KEY = re.compile(r"^T-\d{3,}$")


def _ticket_workspace(args):
    return ops.canonical_workspace(req_text(args, "workspace", 4096, allow_empty=False))


def _ticket_key(value, name="key"):
    if not isinstance(value, str) or not TICKET_KEY.match(value):
        raise AsError(BAD_REQUEST, f"Argument '{name}' must match T- followed by at least three digits.")
    return value


def _ticket_keys(args, name):
    value = args.get(name, [])
    if not isinstance(value, list):
        raise AsError(BAD_REQUEST, f"Argument '{name}' must be a list.")
    return [_ticket_key(item, name) for item in value]


def _validate_ticket_create(args):
    kind = args.get("kind", "story")
    if kind != "story":
        raise AsError(BAD_REQUEST, "kind must be story.")
    depends_supplied = "dependsOn" in args
    depends = _ticket_keys(args, "dependsOn")
    no_deps = req_bool(args, "noDeps")
    if depends_supplied and no_deps:
        raise AsError(BAD_REQUEST, "dependsOn and noDeps cannot be used together.")
    out = {"workspace": _ticket_workspace(args), "kind": kind,
           "storyPath": req_text(args, "storyPath", 4096, allow_empty=False),
           "noDeps": no_deps, "priority": req_int(args, "priority", 0, 1000, 100)}
    if depends_supplied:
        # Presence is meaningful: an explicit [] overrides parsed story dependencies.
        out["dependsOn"] = depends
    title = req_text(args, "title", 200, required=False)
    if title is not None:
        out["title"] = title
    return out


def _validate_ticket_move(args):
    to = args.get("to")
    if to not in tickets.TICKET_STATES:
        raise AsError(BAD_REQUEST, "to must be a ticket state.")
    out = {"workspace": _ticket_workspace(args), "key": _ticket_key(args.get("key")), "to": to}
    reason = req_text(args, "reason", 500, required=False)
    if reason is not None:
        out["reason"] = reason
    return out


def _validate_ticket_block(args):
    return {"workspace": _ticket_workspace(args), "key": _ticket_key(args.get("key")),
            "reason": req_text(args, "reason", 500, allow_empty=False)}


def _validate_ticket_key(args):
    return {"workspace": _ticket_workspace(args), "key": _ticket_key(args.get("key"))}


def _validate_ticket_start(args):
    out = _validate_ticket_key(args)
    out["agentId"] = validate_uuid(args.get("agentId"), "agentId")
    return out


def _validate_ticket_cancel(args):
    out = _validate_ticket_key(args)
    reason = req_text(args, "reason", 500, required=False)
    if reason is not None:
        out["reason"] = reason
    return out


def _validate_ticket_depend(args):
    out = _validate_ticket_key(args)
    out["on"] = _ticket_keys(args, "on")
    out["remove"] = _ticket_keys(args, "remove")
    if not out["on"] and not out["remove"]:
        raise AsError(BAD_REQUEST, "ticket.depend needs on or remove.")
    return out


def _ticket_show(args, req):
    clean = _validate_ticket_key(args)
    conn = _reader()
    try:
        return queries.ticket_detail(conn, clean["workspace"], clean["key"])
    finally:
        conn.close()


def _ticket_list(args, req):
    workspace = _ticket_workspace(args)
    status, kind = args.get("status"), args.get("kind")
    if status is not None and status not in tickets.TICKET_STATES:
        raise AsError(BAD_REQUEST, "status must be a ticket state.")
    if kind is not None and kind not in tickets.TICKET_KINDS:
        raise AsError(BAD_REQUEST, "kind must be a ticket kind.")
    conn = _reader()
    try:
        return queries.ticket_list(conn, workspace, status, kind)
    finally:
        conn.close()


def _validate_definition_start(args):
    name = args.get("definition")
    if not isinstance(name, str) or not DEFINITION_NAME.match(name):
        raise AsError(BAD_REQUEST, "definition must be a name matching [a-z0-9][a-z0-9-]{0,63}.")
    if "developerAgentId" in args or "reviewerAgentId" in args:
        raise AsError(BAD_REQUEST, "developerAgentId / reviewerAgentId belong to the P00 form; use bindings with "
                                   "definition.")
    out = {"teamId": validate_uuid(args.get("teamId"), "teamId"), "definition": name,
           "text": req_text(args, "text", MAX_TASK_BYTES, allow_empty=False)}
    if not out["text"].strip():
        raise AsError(BAD_REQUEST, "Task text must not be blank.")
    bindings = args.get("bindings")
    if bindings is not None:
        if not isinstance(bindings, dict) or len(bindings) > 20:
            raise AsError(BAD_REQUEST, "bindings must be an object {role: agentId} with at most 20 entries.")
        out["bindings"] = {}
        for role, agent in bindings.items():
            if not isinstance(role, str) or not role.strip() or len(role) > 200:
                raise AsError(BAD_REQUEST, "bindings keys must be role names.")
            out["bindings"][role] = validate_uuid(agent, f"bindings.{role}")
    if args.get("allowDirtyTree"):
        out["allowDirtyTree"] = req_bool(args, "allowDirtyTree")
    _optional_run_workspace(args, out)
    opts = args.get("debugStageOptions")
    if opts is not None:
        if not isinstance(opts, dict) or not all(isinstance(k, str) and STAGE_ID_KEY.match(k) for k in opts):
            raise AsError(BAD_REQUEST, "debugStageOptions keys must be stage ids.")
        out["debugStageOptions"] = {k: ([_validate_fake_options(x) for x in v[:10]] if isinstance(v, list) and v
                                        else _validate_fake_options(v)) for k, v in opts.items()}
    return out


def _validate_workflow_start(args):
    if "seed" in args:
        raise AsError(BAD_REQUEST, "seed is reserved for coordinator board starts.")
    if "definition" in args:
        return _validate_definition_start(args)
    out = {"teamId": validate_uuid(args.get("teamId"), "teamId"),
           "developerAgentId": validate_uuid(args.get("developerAgentId"), "developerAgentId"),
           "reviewerAgentId": validate_uuid(args.get("reviewerAgentId"), "reviewerAgentId"),
           "text": req_text(args, "text", MAX_TASK_BYTES, allow_empty=False)}
    if not out["text"].strip():
        raise AsError(BAD_REQUEST, "Task text must not be blank.")
    if args.get("allowDirtyTree"):
        out["allowDirtyTree"] = req_bool(args, "allowDirtyTree")
    _optional_run_workspace(args, out)
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


def _team_row(conn, team_id):
    row = conn.execute("SELECT * FROM teams WHERE id = ?", (team_id,)).fetchone()
    if row is None:
        raise AsError("NOT_FOUND", f"Team {team_id} does not exist.")
    return dict(row)


def _workflow_list(args, req):
    team_id = validate_uuid(args.get("teamId"), "teamId")
    conn = _reader()
    try:
        ws = _team_row(conn, team_id)["workspace"]
    finally:
        conn.close()
    return {"teamId": team_id, "workspace": ws, "definitions": workflowdef.list_definitions(ws, workflow.BUILTIN_DIR)}


def _workflow_validate(args, req):
    """Load the definition and bind its roles exactly as workflow.start would, writing nothing."""
    parsed = _validate_definition_start({**args, "text": "x"})
    conn = _reader()
    try:
        team = _team_row(conn, parsed["teamId"])
        definition = workflowdef.load(team["workspace"], parsed["definition"], workflow.BUILTIN_DIR)
        bound = workflow.bind_roles(workflow.ReadTx(conn), team, definition, parsed.get("bindings") or {},
                                    {"debug": False}, check_providers=False)
    finally:
        conn.close()
    return {"ok": True, "definition": definition.name, "definitionSha256": definition.source_sha256,
            "stages": [{"id": st.id, "role": st.role, "kind": st.kind} for st in definition.stages],
            "bindings": {role: {"agentId": a["id"], "name": a.get("name")} for role, a in bound.items()},
            "warnings": json.loads(json.dumps(list(definition.warnings), default=dict))}


def _validate_workflow_retry(args):
    out = _validate_workflow_id(args)
    if args.get("debugProviderOptions") is not None:
        out["debugProviderOptions"] = _validate_fake_options(args["debugProviderOptions"])
    return out


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
    "debug.ticket_worktree": _inbox("debug.ticket_worktree", _validate_debug_ticket_worktree),
    "team.start": _inbox("team.start", _validate_team_start),
    "team.stop": _inbox("team.stop", _validate_team_stop),
    "team.attach": _team_attach,
    "task.direct": _inbox("task.direct", _validate_task_direct),
    "task.show": _task_show,
    "assignment.cancel": _inbox("assignment.cancel", _validate_cancel),
    "assignment.resolve": _inbox("assignment.resolve", _validate_resolve),
    "workflow.start": _inbox("workflow.start", _validate_workflow_start),
    "workflow.cancel": _inbox("workflow.cancel", _validate_workflow_id),
    "workflow.retry": _inbox("workflow.retry", _validate_workflow_retry),
    "workflow.show": _workflow_show,
    "workflow.list": _workflow_list,
    "workflow.validate": _workflow_validate,
    "ticket.create": _inbox("ticket.create", _validate_ticket_create),
    "ticket.move": _inbox("ticket.move", _validate_ticket_move),
    "ticket.block": _inbox("ticket.block", _validate_ticket_block),
    "ticket.unblock": _inbox("ticket.unblock", _validate_ticket_key),
    "ticket.cancel": _inbox("ticket.cancel", _validate_ticket_cancel),
    "ticket.depend": _inbox("ticket.depend", _validate_ticket_depend),
    "ticket.start": _inbox("ticket.start", _validate_ticket_start),
    "ticket.show": _ticket_show,
    "ticket.list": _ticket_list,
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
