"""Request validation and routing shared by one-shot `request`, human CLI commands, and `serve`."""
from __future__ import annotations

import re
import json
import os
import sys
import traceback

import copy

from . import agentcatalog, teamdefs, boardmodel, boardsettings, roles, workflow, workflowdef, PROTOCOL, client, coordinator, ops, paths, \
    queries, state, teams, teamstatus, teamview, tmuxctl, workspace
from .providers.base import POLICIES
from .providers.fake.fake_cli import SCENARIOS
from .store import validate_uuid
from .protocol import (AsError, BAD_REQUEST, INTERNAL, UNKNOWN_COMMAND, UNSUPPORTED_PROTOCOL, WORKSPACE_NOT_FOUND,
                       envelope, req_bool, req_int, req_text, validate_id, validate_idempotency_key)

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
    if args.get("teamDefId") is not None:
        out["teamDefId"] = _slug(args["teamDefId"], "teamDefId")
    return out


def _slug(value, name):
    if not isinstance(value, str) or not teams.SLUG_RE.match(value):
        raise AsError(BAD_REQUEST, f"{name} must be a slug (lowercase letters, digits, '-'; at most 64 characters).")
    return value


def _team_ref(args):
    """{teamId} (runtime UUID) or {workspace, teamDefId} (definition id)."""
    if args.get("teamId") is not None:
        return {"teamId": validate_uuid(args["teamId"], "teamId")}
    return {"workspace": ops.canonical_workspace(req_text(args, "workspace", 4096, allow_empty=False)),
            "teamDefId": _slug(args.get("teamDefId"), "teamDefId")}


def _validate_team_stop(args):
    return _team_ref(args)


def _team_status(args, req):
    ref = _team_ref(args)
    conn = _reader()
    try:
        return teamstatus.team_status(conn, ref.get("teamId"), ref.get("workspace"), ref.get("teamDefId"))
    finally:
        conn.close()


def _team_list(args, req):
    unknown = sorted(set(args) - {"workspace"})
    if unknown:
        raise AsError(BAD_REQUEST, f"team.list got unknown argument(s): {', '.join(unknown)}.")
    workspace_path = _workspace_arg(args)
    conn = _reader()
    try:
        return teamstatus.workspace_teams(conn, workspace_path)
    finally:
        conn.close()


def _team_overview(args, req):
    ws = _catalog_workspace(args, {"workspace"}, "team.overview")
    running, conn, error = False, None, None
    try:
        running = coordinator.running_info(paths.ensure_state_dir()) is not None
        conn = _reader()
    except AsError as e:
        error = {"code": e.code, "message": e.message}
    try:
        return teamview.overview(conn, ws, running, error)
    finally:
        if conn is not None:
            conn.close()


def _sha_arg(args):
    value = args.get("expectedSha256")
    if value is None:
        return None
    if not isinstance(value, str) or not re.match(r"^[0-9a-f]{64}$", value):
        raise AsError(BAD_REQUEST, "expectedSha256 must be a lowercase hex sha256.")
    return value


def _board_settings(args, req):
    ws = _catalog_workspace(args, {"workspace"}, "board.settings")
    running, conn, error = False, None, None
    try:
        running = coordinator.running_info(paths.ensure_state_dir()) is not None
        conn = _reader()
    except AsError as e:
        error = {"code": e.code, "message": e.message}
    try:
        return boardsettings.settings(conn, ws, running, error)
    finally:
        if conn is not None:
            conn.close()


def _board_settings_update(args, req):
    ws = _catalog_workspace(args, {"workspace", "changes", "expectedSha256"}, "board.settings.update")
    if "changes" not in args:
        raise AsError(BAD_REQUEST, "Missing required argument 'changes'.")
    return boardsettings.update_board(ws, args["changes"], _sha_arg(args))


def _role_update(args, req):
    ws = _catalog_workspace(args, {"workspace", "role", "description", "expectedSha256"}, "role.update")
    role = req_text(args, "role", 200, allow_empty=False)
    if "description" not in args:
        raise AsError(BAD_REQUEST, "Missing required argument 'description'.")
    description = None if args["description"] is None else req_text(args, "description", roles.LIMITS["description"])
    return boardsettings.update_role(ws, role, description, _sha_arg(args))


def _catalog_workspace(args, allowed, command):
    unknown = sorted(set(args) - allowed)
    if unknown:
        raise AsError(BAD_REQUEST, f"{command} got unknown argument(s): {', '.join(unknown)}.")
    ws = _workspace_arg(args)
    if not os.path.isdir(os.path.join(ws, ".agent-studio")):
        raise AsError(WORKSPACE_NOT_FOUND, f"{ws} is not an Agent Studio workspace (no .agent-studio directory).")
    return ws


def _agentdef_list(args, req):
    ws = _catalog_workspace(args, {"workspace"}, "agentdef.list")
    return dict(agentcatalog.list_agents(ws), workspace=ws)


def _agentdef_create(args, req):
    ws = _catalog_workspace(args, {"workspace", "agent"}, "agentdef.create")
    if "agent" not in args:
        raise AsError(BAD_REQUEST, "Missing required argument 'agent'.")
    return dict(agentcatalog.create_agent(ws, args["agent"]), workspace=ws)


def _agentdef_update(args, req):
    ws = _catalog_workspace(args, {"workspace", "agentDefId", "changes"}, "agentdef.update")
    aid = _slug(args.get("agentDefId"), "agentDefId")
    if "changes" not in args:
        raise AsError(BAD_REQUEST, "Missing required argument 'changes'.")
    return dict(agentcatalog.update_agent(ws, aid, args["changes"]), workspace=ws)


def _agentdef_delete(args, req):
    ws = _catalog_workspace(args, {"workspace", "agentDefId"}, "agentdef.delete")
    aid = _slug(args.get("agentDefId"), "agentDefId")
    return dict(agentcatalog.delete_agent(ws, aid), workspace=ws)


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


def _workspace_arg(args):
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


def _validate_board_resume(args):
    agent, member, all_agents = args.get("agentId"), args.get("member"), args.get("all") is True
    given = sum(1 for value in (agent, member, all_agents) if value)
    if given != 1:
        raise AsError(BAD_REQUEST, "board.resume needs exactly one of agentId, member or all: true.")
    workspace = _workspace_arg(args)
    out = {"workspace": workspace, "all": all_agents}
    if agent is not None:
        out["agentId"] = validate_uuid(agent, "agentId")
    if member is not None:
        out["member"] = req_text(args, "member", 80, allow_empty=False)
    return out


def _slug_arg(value, name):
    if not isinstance(value, str) or not DEFINITION_NAME.match(value):
        raise AsError(BAD_REQUEST, f"Argument '{name}' must be a slug (lowercase letters, digits, '-'; at "
                                   f"most 64 characters).")
    return value


def _validate_ticket_add(args):
    out = {"workspace": _workspace_arg(args), "title": req_text(args, "title", 200, allow_empty=False)}
    body = req_text(args, "body", 32 * 1024, required=False)
    if body is not None:
        out["body"] = body
    out["priority"] = req_int(args, "priority", 0, 1000, 100)
    phase = req_text(args, "phase", 64, required=False, allow_empty=False)
    if phase is not None:
        out["phase"] = _slug_arg(phase, "phase")
    # the MCP server path (P04-S12): the caller presents an active assignment and is subject to its rules
    assignment = req_text(args, "assignment", 64, required=False)
    if assignment is not None:
        out["assignment"] = validate_uuid(assignment, "assignment")
        on = args.get("dependsOn")
        if on is not None:
            if not isinstance(on, list) or len(on) > 20 or not all(
                    isinstance(k, str) and TICKET_KEY.match(k) for k in on):
                raise AsError(BAD_REQUEST, "dependsOn must be a list of ticket keys (at most 20).")
            if on:
                out["dependsOn"] = on
        cap = req_int(args, "cap", 1, 100, boardmodel.MCP_TICKET_CAP)
        out["cap"] = cap
    return out


def _validate_ticket_update(args):
    # only the MCP server sends this (an assignment is required); there is no operator CLI for it
    mode = args.get("mode", "replace")
    if mode not in ("replace", "append"):
        raise AsError(BAD_REQUEST, "mode must be replace or append.")
    return {"workspace": _workspace_arg(args), "key": _ticket_key(args.get("key")),
            "assignment": validate_uuid(args.get("assignment"), "assignment"),
            "body": req_text(args, "body", boardmodel.BODY_LIMIT, allow_empty=False), "mode": mode}


def _validate_ticket_phase(args):
    return {"workspace": _workspace_arg(args), "key": _ticket_key(args.get("key")),
            "phase": _slug_arg(args.get("phase"), "phase")}


def _validate_ticket_apply(args):
    return {"workspace": _workspace_arg(args), "key": _ticket_key(args.get("key")),
            "run": validate_uuid(args.get("run"), "run")}


def _validate_ticket_unblock(args):
    out = _validate_ticket_key_args(args)
    to = req_text(args, "to", 64, required=False, allow_empty=False)
    if to is not None:
        out["to"] = to
    return out


def _validate_ticket_retry(args):
    return _validate_ticket_key_args(args)


def _validate_ticket_move(args):
    out = {"workspace": _workspace_arg(args), "key": _ticket_key(args.get("key")),
           "to": req_text(args, "to", 64, allow_empty=False), "force": req_bool(args, "force")}
    reason = req_text(args, "reason", 500, required=False)
    if reason is not None:
        out["reason"] = reason
    return out


def _validate_ticket_depend(args):
    out = {"workspace": _workspace_arg(args), "key": _ticket_key(args.get("key")),
           "on": _ticket_keys(args, "on"), "remove": _ticket_keys(args, "remove")}
    if not out["on"] and not out["remove"]:
        raise AsError(BAD_REQUEST, "ticket.depend needs on or remove.")
    overlap = sorted(set(out["on"]) & set(out["remove"]))
    if overlap:
        raise AsError(BAD_REQUEST, f"ticket.depend got {', '.join(overlap)} in both on and remove.")
    return out


def _validate_ticket_key_args(args):
    return {"workspace": _workspace_arg(args), "key": _ticket_key(args.get("key"))}


def _validate_ticket_list(args):
    out = {"workspace": _workspace_arg(args)}
    status = req_text(args, "status", 64, required=False, allow_empty=False)
    if status is not None:
        out["status"] = status
    phase = req_text(args, "phase", 64, required=False, allow_empty=False)
    if phase is not None:
        out["phase"] = _slug_arg(phase, "phase")
    return out


def _validate_board_show(args):
    return {"workspace": _workspace_arg(args)}


def _validate_board_summary(args):
    out = _validate_board_show(args)
    out["limit"] = req_int(args, "limit", 1, 10, 5)
    return out


def _validate_board_run(args):
    return {"workspace": _workspace_arg(args), "teamId": validate_uuid(args.get("teamId"), "teamId")}


def _validate_phase_add(args):
    out = {"workspace": _workspace_arg(args), "id": _slug_arg(args.get("id"), "id"),
           "name": req_text(args, "name", 80, allow_empty=False)}
    description = req_text(args, "description", 2000, required=False)
    if description is not None:
        out["description"] = description
    before = req_text(args, "before", 64, required=False, allow_empty=False)
    if before is not None:
        out["before"] = _slug_arg(before, "before")
    return out


def _validate_phase_edit(args):
    out = {"workspace": _workspace_arg(args), "phase": _slug_arg(args.get("phase"), "phase")}
    name = req_text(args, "name", 80, required=False, allow_empty=False)
    if name is not None:
        out["name"] = name
    description = req_text(args, "description", 2000, required=False)
    if description is not None:
        out["description"] = description
    if "name" not in out and "description" not in out:
        raise AsError(BAD_REQUEST, "phase edit needs name or description.")
    return out


def _validate_phase_ref(args):
    return {"workspace": _workspace_arg(args), "phase": _slug_arg(args.get("phase"), "phase")}


def _validate_phase_remove(args):
    out = _validate_phase_ref(args)
    move_to = req_text(args, "moveTo", 64, required=False, allow_empty=False)
    if move_to is not None:
        out["moveTo"] = _slug_arg(move_to, "moveTo")
    return out


def _phase_show(args, req):
    clean = _validate_phase_ref(args)
    conn = _reader()
    try:
        return boardmodel.phase_detail(conn, clean["workspace"], clean["phase"])
    finally:
        conn.close()


def _phase_list(args, req):
    clean = _validate_board_show(args)
    conn = _reader()
    try:
        return boardmodel.phase_list(conn, clean["workspace"])
    finally:
        conn.close()


def _ticket_show(args, req):
    clean = _validate_ticket_key_args(args)
    conn = _reader()
    try:
        return boardmodel.ticket_detail(conn, clean["workspace"], clean["key"])
    finally:
        conn.close()


def _ticket_list(args, req):
    clean = _validate_ticket_list(args)
    conn = _reader()
    try:
        return boardmodel.ticket_list(conn, clean["workspace"], clean.get("status"))
    finally:
        conn.close()


def _board_show(args, req):
    clean = _validate_board_show(args)
    conn = _reader()
    try:
        return boardmodel.board_show(conn, clean["workspace"])
    finally:
        conn.close()


def _board_summary(args, req):
    clean = _validate_board_summary(args)
    conn = _reader()
    try:
        return boardmodel.board_summary(conn, clean["workspace"], clean["limit"])
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


def _workspace_list(args, req):
    return workspace.list_workspaces()


def _workspace_init(args, req):
    path = req_text(args, "path", 4096, allow_empty=False)
    name = req_text(args, "name", 1024, required=False)
    return workspace.init(path, name or None)


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


def _activity_recent(args, req):
    workspace_path = ops.canonical_workspace(req_text(args, "workspace", 4096, allow_empty=False))
    limit = req_int(args, "limit", 1, queries.RECENT_ACTIVITY_MAX_LIMIT, queries.RECENT_ACTIVITY_DEFAULT_LIMIT)
    kinds = args.get("kinds")
    queries.validate_activity_kinds(kinds)
    conn = _reader()
    try:
        if kinds is None:
            return queries.recent_activity(conn, workspace_path, limit=limit)
        return queries.recent_activity(conn, workspace_path, limit=limit, kinds=kinds)
    finally:
        conn.close()


def _only(command, args, allowed):
    unknown = sorted(set(args) - allowed)
    if unknown:
        raise AsError(BAD_REQUEST, f"{command} got unknown argument(s): {', '.join(unknown)}.")


def _teamdef_ws(args):
    return _workspace_arg(args), _slug(args.get("teamDefId"), "teamDefId")


def _teamdef_active(workspace, team_def_id):
    sd = paths.ensure_state_dir()
    if not os.path.exists(state.db_path(sd)):
        return None
    conn = _reader()
    try:
        return teamdefs.active_runtime(conn, workspace, team_def_id)
    finally:
        conn.close()


def _member_fields(args, keys):
    out = {}
    for k in keys:
        if k not in args:
            continue
        if args[k] is None:
            out[k] = None
        elif k == "name":
            out[k] = req_text(args, k, 200, allow_empty=False)
        elif k == "role" or k == "provider":
            out[k] = req_text(args, k, 64, allow_empty=False)
        elif k == "agent":
            out[k] = _slug(args[k], k)
        elif k in ("model", "reasoning"):
            out[k] = req_text(args, k, 200, allow_empty=False)
        elif k == "canAddTickets":
            out[k] = req_bool(args, k)
    return out


_MEMBER_KEYS = ("name", "role", "agent", "provider", "model", "reasoning", "canAddTickets")


def _teamdef_show(args, req):
    _only("teamdef.show", args, {"workspace", "teamDefId"})
    ws, tid = _teamdef_ws(args)
    return teamdefs.describe(ws, tid, _teamdef_active(ws, tid))


def _teamdef_validate(args, req):
    _only("teamdef.validate", args, {"workspace", "teamDefId"})
    ws, tid = _teamdef_ws(args)
    return teamdefs.check_team(ws, tid)


def _teamdef_create(args, req):
    _only("teamdef.create", args, {"workspace", "name", "teamDefId"})
    ws = _workspace_arg(args)
    name = req_text(args, "name", 200, allow_empty=False)
    tid = _slug(args["teamDefId"], "teamDefId") if args.get("teamDefId") is not None else None
    return teamdefs.create_team(ws, name, tid)


def _teamdef_rename(args, req):
    _only("teamdef.rename", args, {"workspace", "teamDefId", "name"})
    ws, tid = _teamdef_ws(args)
    name = req_text(args, "name", 200, allow_empty=False)
    return teamdefs.rename_team(ws, tid, name, _teamdef_active(ws, tid))


def _teamdef_delete(args, req):
    _only("teamdef.delete", args, {"workspace", "teamDefId"})
    ws, tid = _teamdef_ws(args)
    return teamdefs.delete_team(ws, tid, _teamdef_active(ws, tid))


def _teamdef_member_add(args, req):
    _only("teamdef.member.add", args, {"workspace", "teamDefId", "memberId", *_MEMBER_KEYS})
    ws, tid = _teamdef_ws(args)
    fields = {k: v for k, v in _member_fields(args, _MEMBER_KEYS).items() if v is not None}
    if args.get("memberId") is not None:
        fields["id"] = _slug(args["memberId"], "memberId")
    return teamdefs.member_add(ws, tid, fields, _teamdef_active(ws, tid))


def _teamdef_member_update(args, req):
    _only("teamdef.member.update", args, {"workspace", "teamDefId", "memberId", *_MEMBER_KEYS})
    ws, tid = _teamdef_ws(args)
    mid = _slug(args.get("memberId"), "memberId")
    changes = _member_fields(args, _MEMBER_KEYS)
    return teamdefs.member_update(ws, tid, mid, changes, _teamdef_active(ws, tid))


def _teamdef_member_remove(args, req):
    _only("teamdef.member.remove", args, {"workspace", "teamDefId", "memberId"})
    ws, tid = _teamdef_ws(args)
    mid = _slug(args.get("memberId"), "memberId")
    return teamdefs.member_remove(ws, tid, mid, _teamdef_active(ws, tid))


COMMANDS = {
    "health": lambda args, req: ops.health(args),
    "preflight": lambda args, req: ops.preflight(args),
    "workspace.list": _workspace_list,
    "workspace.init": _workspace_init,
    "coordinator.start": _coordinator_start,
    "coordinator.stop": _coordinator_stop,
    "snapshot": _snapshot,
    "events.after": _events_after,
    "activity.recent": _activity_recent,
    "debug.echo": _inbox("debug.echo", _validate_echo),
    "debug.fixture": _inbox("debug.fixture", _validate_fixture),
    "debug.assign": _inbox("debug.assign", _validate_debug_assign),
    "team.start": _inbox("team.start", _validate_team_start),
    "team.stop": _inbox("team.stop", _validate_team_stop),
    "team.attach": _team_attach,
    "team.list": _team_list,
    "team.status": _team_status,
    "team.overview": _team_overview,
    "teamdef.show": _teamdef_show,
    "teamdef.validate": _teamdef_validate,
    "teamdef.create": _teamdef_create,
    "teamdef.rename": _teamdef_rename,
    "teamdef.delete": _teamdef_delete,
    "teamdef.member.add": _teamdef_member_add,
    "teamdef.member.update": _teamdef_member_update,
    "teamdef.member.remove": _teamdef_member_remove,
    "agentdef.list": _agentdef_list,
    "agentdef.create": _agentdef_create,
    "agentdef.update": _agentdef_update,
    "agentdef.delete": _agentdef_delete,
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
    "board.resume": _inbox("board.resume", _validate_board_resume),
    "ticket.add": _inbox("ticket.add", _validate_ticket_add),
    "ticket.update": _inbox("ticket.update", _validate_ticket_update),
    "ticket.move": _inbox("ticket.move", _validate_ticket_move),
    "ticket.depend": _inbox("ticket.depend", _validate_ticket_depend),
    "ticket.phase": _inbox("ticket.phase", _validate_ticket_phase),
    "ticket.apply": _inbox("ticket.apply", _validate_ticket_apply),
    "ticket.unblock": _inbox("ticket.unblock", _validate_ticket_unblock),
    "ticket.retry": _inbox("ticket.retry", _validate_ticket_retry),
    "ticket.show": _ticket_show,
    "ticket.list": _ticket_list,
    "board.show": _board_show,
    "board.summary": _board_summary,
    "board.settings": _board_settings,
    "board.settings.update": _board_settings_update,
    "role.update": _role_update,
    "board.run": _inbox("board.run", _validate_board_run),
    "board.stop": _inbox("board.stop", _validate_board_show),
    "phase.add": _inbox("phase.add", _validate_phase_add),
    "phase.edit": _inbox("phase.edit", _validate_phase_edit),
    "phase.close": _inbox("phase.close", _validate_phase_ref),
    "phase.reopen": _inbox("phase.reopen", _validate_phase_ref),
    "phase.remove": _inbox("phase.remove", _validate_phase_remove),
    "phase.set-current": _inbox("phase.set-current", _validate_phase_ref),
    "phase.clear-current": _inbox("phase.clear-current", _validate_board_show),
    "phase.show": _phase_show,
    "phase.list": _phase_list,
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
