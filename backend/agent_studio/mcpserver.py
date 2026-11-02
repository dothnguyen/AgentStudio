"""The Agent Studio board MCP server (P04-S12): stdio JSON-RPC 2.0, standard library only.

An MCP client (Claude Code, Codex, the fake provider's test path) launches `agent-studio mcp` with
AGENT_STUDIO_ASSIGNMENT and AGENT_STUDIO_AGENT in the environment. Every tool call becomes a normal
`ticket.add` / `ticket.list` / `ticket.show` / `phase.list` / `board.show` / `command.list` / `command.request` request through the same
validated command path the CLI uses — the server never opens the database, and the coordinator stays
the only writer. Command errors come back as JSON-RPC errors with the command's code in `data.code`.

Operator mode (`agent-studio mcp --operator [--workspace PATH] [--allow-writes]`) is the same server for the
person's own MCP clients (Claude Code, Codex, OpenCode ...): no assignment is needed. It is read-only unless
`--allow-writes` is given, offers a fixed list of tools (never a free-form command), and every call goes through
the same validated command path as the CLI. `agent-studio mcp --print-config` prints setup for each client.
"""
from __future__ import annotations

import json
import os
import shlex
import shutil
import sys
import uuid

from . import PROTOCOL, dispatch
from . import workspace as wsmod
from .protocol import AsError, BAD_REQUEST, MAX_LINE_BYTES, dumps

PROTOCOL_VERSION = "2024-11-05"
SERVER_INFO = {"name": "agent-studio", "version": "1.0.0"}

TOOLS = [
    {"name": "ticket_add",
     "description": "Add a ticket to the Agent Studio board of the workspace this assignment works in.",
     "inputSchema": {"type": "object", "properties": {
         "title": {"type": "string", "maxLength": 200},
         "body": {"type": "string"},
         "priority": {"type": "integer", "minimum": 0, "maximum": 1000},
         "phase": {"type": "string", "description": "phase slug; the default phase when omitted"},
         "dependsOn": {"type": "array", "items": {"type": "string"}}},
         "required": ["title"]}},
    {"name": "ticket_update",
     "description": "Write to the body of the ticket you are working (the ticket in your task): replace it "
                    "with the refined text, or append a section. The next agent receives this body as its task.",
     "inputSchema": {"type": "object", "properties": {
         "key": {"type": "string", "description": "the ticket key from your task, e.g. T-004"},
         "body": {"type": "string"},
         "mode": {"type": "string", "enum": ["replace", "append"], "description": "default replace"}},
         "required": ["key", "body"]}},
    {"name": "ticket_list",
     "description": "List the workspace's tickets, optionally by status or phase. Summary omits bodies and adds "
                    "dependency keys.",
     "inputSchema": {"type": "object", "properties": {
         "status": {"type": "string"}, "workflowStatus": {"type": "string"}, "phase": {"type": "string"},
         "summary": {"type": "boolean", "description": "omit body and add dependsOn/openDependsOn"}}}},
    {"name": "ticket_show",
     "description": "One ticket with its status, phase, dependencies and event history.",
     "inputSchema": {"type": "object", "properties": {"key": {"type": "string"}}, "required": ["key"]}},
    {"name": "phase_list",
     "description": "The board's phases with the current one marked.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "board_show",
     "description": "The board: phases with column and workflow counts.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "delegated_commands_list",
     "description": "The delegated commands this assignment may ask the Agent Studio coordinator to run for you "
                    "(commands your sandbox does not allow, such as reinstalling dependencies), with their params "
                    "and how many requests remain.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "delegated_command_request",
     "description": "Ask the coordinator to run one delegated command (an id from delegated_commands_list). After "
                    "requesting, finish your turn with a short summary of your progress: you will be re-dispatched "
                    "with the command's result. Never run the command yourself.",
     "inputSchema": {"type": "object", "properties": {
         "command": {"type": "string", "description": "the command id"},
         "params": {"type": "object", "description": "the command's declared params, each a string"},
         "reason": {"type": "string", "maxLength": 500, "description": "why you need it"}},
         "required": ["command"]}},
]


class JsonRpcError(Exception):
    def __init__(self, code: int, message: str, data=None):
        super().__init__(message)
        self.code, self.message, self.data = code, message, data


METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INVALID_REQUEST = -32600
INTERNAL_ERROR = -32603


def _read_env():
    assignment = os.environ.get("AGENT_STUDIO_ASSIGNMENT")
    agent = os.environ.get("AGENT_STUDIO_AGENT")
    workspace = os.environ.get("AGENT_STUDIO_WORKSPACE")
    if not assignment or not agent or not workspace:
        raise AsError(BAD_REQUEST, "AGENT_STUDIO_ASSIGNMENT, AGENT_STUDIO_AGENT and AGENT_STUDIO_WORKSPACE "
                                   "must be set; the server is launched per assignment by the runner, not "
                                   "by hand.",
                      remediation="run a board ticket; the runner starts the server for allowed members")
    return assignment, agent, workspace


def _call(command: str, args: dict, write: bool, assignment: str, agent: str, request_id=None):
    req = {"protocol": PROTOCOL, "command": command, "args": dict(args)}
    if write:
        # a retried tools/call re-sends the same JSON-RPC request id, so the same idempotency key: the
        # coordinator returns the first result instead of writing twice
        digest = uuid.uuid5(uuid.NAMESPACE_URL, _ids(request_id, assignment, agent, args)).hex
        req["idempotencyKey"] = "mcp-" + digest
    req["timeoutMs"] = dispatch.DEFAULT_TIMEOUT_MS
    resp = dispatch.handle_request(req, require_id=False)
    if not resp.get("ok"):
        err = resp.get("error") or {}
        raise AsError(err.get("code", "INTERNAL"), err.get("message", ""),
                      data=resp.get("data") if isinstance(resp.get("data"), dict) else None)
    return resp["data"]


def _ids(request_id, assignment: str, agent: str, args: dict) -> str:
    return json.dumps({"id": request_id, "a": assignment, "g": agent,
                       "args": {k: v for k, v in sorted((args or {}).items()) if k != "cap"}},
                      default=str, sort_keys=True)


def _tool_call(name: str, args: dict, assignment: str, agent: str, workspace: str, request_id) -> dict:
    if name == "ticket_add":
        if not isinstance(args.get("title"), str) or not args["title"].strip():
            raise AsError(BAD_REQUEST, "ticket_add needs a title.")
        data = _call("ticket.add", dict(args, assignment=assignment, agentId=agent,
                                        workspace=workspace), write=True,
                     assignment=assignment, agent=agent, request_id=request_id)
        t = data["ticket"]
        return {"content": [{"type": "text", "text": f"added {t['key']} in phase {t['phase']} "
                                                    f"(status {t['status']})"}],
                "ticket": {"key": t["key"], "title": t["title"], "status": t["status"],
                           "phase": t["phase"], "createdBy": {"memberId": t.get("createdByMember"),
                                                              "assignmentId": t.get("createdByAssignment")}},
                "dependsOn": data.get("dependsOn") or []}
    if name == "ticket_update":
        if not isinstance(args.get("key"), str) or not isinstance(args.get("body"), str) or not args["body"].strip():
            raise AsError(BAD_REQUEST, "ticket_update needs a key and a non-empty body.")
        data = _call("ticket.update", dict(args, assignment=assignment, workspace=workspace), write=True,
                     assignment=assignment, agent=agent, request_id=request_id)
        t = data["ticket"]
        return {"content": [{"type": "text", "text": f"updated {t['key']} ({len(t.get('body') or '')} characters)"}],
                "ticket": {"key": t["key"], "status": t["status"]}}
    if name == "ticket_list":
        data = _call("ticket.list", dict(args, workspace=workspace), write=False,
                     assignment=assignment, agent=agent)
        return {"content": [{"type": "text", "text": "\n".join(
            f"{t['key']} [{t['status']}] {t['phase']}: {t['title']}" for t in data["tickets"])
            or "(no tickets)"}], "tickets": data["tickets"]}
    if name == "ticket_show":
        if not isinstance(args.get("key"), str) or not args["key"].strip():
            raise AsError(BAD_REQUEST, "ticket_show needs a key.")
        data = _call("ticket.show", dict(args, workspace=workspace), write=False,
                     assignment=assignment, agent=agent)
        t = data["ticket"]
        return {"content": [{"type": "text", "text": f"{t['key']} [{t['status']}] phase {t['phase']}: "
                                                     f"{t['title']}\n" + "\n".join(
            f"  {e['name']} -> {e.get('to')}" for e in data["events"])}], **data}
    if name == "phase_list":
        data = _call("phase.list", {"workspace": workspace}, write=False,
                     assignment=assignment, agent=agent)
        return {"content": [{"type": "text", "text": "\n".join(
            f"{p['slug']}{' (current)' if p['current'] else ''}: {p['name']} [{p['status']}]"
            f" tickets {p['ticketCount']}" for p in data["phases"])}], "phases": data["phases"]}
    if name == "board_show":
        data = _call("board.show", {"workspace": workspace}, write=False,
                     assignment=assignment, agent=agent)
        lines = [f"current phase: {data['currentPhase']['name']}"]
        for phase in data["phases"]:
            lines.append(f"{phase['slug']}{' (current)' if phase['current'] else ''}: " + ", ".join(
                f"{column}({count})" for column, count in phase["columns"].items()))
        return {"content": [{"type": "text", "text": "\n".join(lines)}], **data}
    if name == "delegated_commands_list":
        data = _call("command.list", {"assignment": assignment, "agentId": agent}, write=False,
                     assignment=assignment, agent=agent)
        lines = [f"stage {data['stage']}: " + (f"{len(data['commands'])} delegated command(s)" if data["commands"]
                                               else "no delegated commands are available")]
        for c in data["commands"]:
            params = ", ".join(f"{k} ~ {v['pattern']}" for k, v in c["params"].items())
            lines.append(f"- {c['id']}: {c['description']} (runs `{' '.join(c['argv'])}` in {c['cwd']}"
                         + (f"; params: {params}" if params else "")
                         + ("; needs human approval" if c["approval"] == "human" else "")
                         + f"; {c['remainingThisVisit']} left this visit)")
        return {"content": [{"type": "text", "text": "\n".join(lines)}], **data}
    if name == "delegated_command_request":
        if not isinstance(args.get("command"), str) or not args["command"].strip():
            raise AsError(BAD_REQUEST, "delegated_command_request needs a command id.")
        call = {"assignment": assignment, "agentId": agent, "command": args["command"].strip()}
        if args.get("params") is not None:
            call["params"] = args["params"]
        if args.get("reason") is not None:
            call["reason"] = args["reason"]
        data = _call("command.request", call, write=True, assignment=assignment, agent=agent, request_id=request_id)
        text = (f"queued {data['command']} as request {data['requestId']} ({data['status']}). {data['next']}")
        return {"content": [{"type": "text", "text": text}], **data}
    raise JsonRpcError(METHOD_NOT_FOUND, f"Unknown tool {name!r}.")
    # unreachable; kept for clarity


# ---- operator mode ------------------------------------------------------------------------------------------

def _op_schema(props=None, required=()):
    base = {"workspace": {"type": "string",
                          "description": "Agent Studio workspace path; default: the server's workspace"}}
    out = {"type": "object", "properties": dict(base, **(props or {}))}
    if required:
        out["required"] = list(required)
    return out


_KEY = {"key": {"type": "string", "description": "ticket key, e.g. T-090"}}

OPERATOR_READ_TOOLS = [
    {"name": "workspace_list", "description": "The Agent Studio workspaces registered on this computer.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "board_show", "description": "The board: phases with a count per status column.",
     "inputSchema": _op_schema()},
    {"name": "phase_list", "description": "The board's phases with the current one marked.",
     "inputSchema": _op_schema()},
    {"name": "ticket_list", "description": "The workspace's tickets, optionally by status or phase; summary omits "
                                             "bodies and adds dependency keys.",
     "inputSchema": _op_schema({"status": {"type": "string"}, "workflowStatus": {"type": "string"}, "phase": {"type": "string"},
                                "summary": {"type": "boolean", "description": "omit body and add "
                                                                              "dependsOn/openDependsOn"}})},
    {"name": "ticket_show", "description": "One ticket with status, phase, body and event history.",
     "inputSchema": _op_schema(_KEY, ["key"])},
    {"name": "team_overview",
     "description": "Teams, members and what each is doing, stuck or paused runs, blocked tickets and delegated "
                    "commands waiting for approval (JSON).",
     "inputSchema": _op_schema()},
    {"name": "workflow_show", "description": "One workflow run: stages, assignments, command requests, events (JSON).",
     "inputSchema": {"type": "object", "properties": {"workflowRunId": {"type": "string", "description": "run id (uuid)"}},
                     "required": ["workflowRunId"]}},
    {"name": "command_requests",
     "description": "Delegated command requests of one workflow run (workflowRunId) or the open ones of a runtime team "
                    "(teamId). Give exactly one.",
     "inputSchema": {"type": "object", "properties": {"workflowRunId": {"type": "string"}, "teamId": {"type": "string"}}}},
    {"name": "command_catalog", "description": "The workspace's delegated command catalog.",
     "inputSchema": _op_schema()},
]
OPERATOR_WRITE_TOOLS = [
    {"name": "ticket_add", "description": "Add a ticket to the board.",
     "inputSchema": _op_schema({"title": {"type": "string", "maxLength": 200}, "body": {"type": "string"},
                                "priority": {"type": "integer", "minimum": 0, "maximum": 1000},
                                "phase": {"type": "string", "description": "phase slug; the default phase when omitted"}},
                               ["title"])},
    {"name": "ticket_move", "description": "Move a ticket to another Kanban column (finished tickets need force).",
     "inputSchema": _op_schema(dict(_KEY, to={"type": "string"}, reason={"type": "string", "maxLength": 500},
                                    workflowStatus={"type": "string"}, force={"type": "boolean"}), ["key", "to"])},
    {"name": "ticket_depend", "description": "Add (on) or remove (remove) ticket dependencies.",
     "inputSchema": _op_schema(dict(_KEY, on={"type": "array", "items": {"type": "string"}},
                                    remove={"type": "array", "items": {"type": "string"}}), ["key"])},
    {"name": "ticket_unblock", "description": "Return a blocked ticket to its recorded (or the given) status.",
     "inputSchema": _op_schema(dict(_KEY, to={"type": "string"}), ["key"])},
    {"name": "ticket_retry", "description": "Release a stuck ticket's claim and cancel its run.",
     "inputSchema": _op_schema(_KEY, ["key"])},
    {"name": "ticket_phase", "description": "Move a ticket to another open phase (not while it is claimed).",
     "inputSchema": _op_schema(dict(_KEY, phase={"type": "string", "description": "phase slug, e.g. phase-05"}),
                               ["key", "phase"])},
    {"name": "command_approve", "description": "Approve a delegated command waiting for human approval.",
     "inputSchema": {"type": "object", "properties": {"requestId": {"type": "string"}}, "required": ["requestId"]}},
    {"name": "command_reject", "description": "Reject a delegated command waiting for approval.",
     "inputSchema": {"type": "object", "properties": {"requestId": {"type": "string"},
                                                      "reason": {"type": "string", "maxLength": 500}},
                     "required": ["requestId"]}},
]
_WRITE_NAMES = {t["name"] for t in OPERATOR_WRITE_TOOLS}
_READ_NAMES = {t["name"] for t in OPERATOR_READ_TOOLS}


def operator_tools(allow_writes: bool) -> list:
    return OPERATOR_READ_TOOLS + (OPERATOR_WRITE_TOOLS if allow_writes else [])


def _clip(text: str, limit: int = 30000) -> str:
    return text if len(text) <= limit else text[:limit] + "\n[... truncated]"


def _need(args: dict, name: str) -> str:
    value = args.get(name)
    if not isinstance(value, str) or not value.strip():
        raise AsError(BAD_REQUEST, f"{name} is required.")
    return value.strip()


def _optional(args: dict, *names) -> dict:
    return {n: args[n].strip() for n in names if isinstance(args.get(n), str) and args[n].strip()}


def _op_workspace(args: dict, operator: dict) -> str:
    """The workspace a call acts on: its `workspace` argument, else --workspace / AGENT_STUDIO_WORKSPACE, else the
    workspace at or above the directory the client started this server in."""
    explicit = args.get("workspace") if isinstance(args.get("workspace"), str) and args.get("workspace").strip() \
        else operator.get("workspace")
    return wsmod.resolve(os.getcwd(), override=explicit or None)["path"]


def _json_text(data) -> str:
    return _clip(json.dumps(data, indent=1, default=str))


def _operator_tool_call(name: str, args: dict, operator: dict, request_id) -> dict:
    if name not in _READ_NAMES | _WRITE_NAMES:
        raise JsonRpcError(METHOD_NOT_FOUND, f"Unknown tool {name!r}.")
    if name in _WRITE_NAMES and not operator.get("allowWrites"):
        raise AsError("FORBIDDEN", f"{name} changes the board and this server is read-only; "
                                   "restart it with --allow-writes to allow changes.")
    session = operator["session"]   # one id per server process: a client reusing JSON-RPC ids never replays a write

    def call(command: str, extra: dict, write: bool = False, ws: bool = True):
        payload = dict(extra, workspace=_op_workspace(args, operator)) if ws else dict(extra)
        return _call(command, payload, write, "operator", session, request_id)

    def text(body: str, **data) -> dict:
        return {"content": [{"type": "text", "text": _clip(body)}], **data}

    if name == "workspace_list":
        data = call("workspace.list", {}, ws=False)
        return text(_json_text(data), **data)
    if name == "board_show":
        data = call("board.show", {})
        lines = [f"current phase: {data['currentPhase']['name']}"]
        for phase in data["phases"]:
            lines.append(f"{phase['slug']}{' (current)' if phase['current'] else ''}: " + ", ".join(
                f"{column}({count})" for column, count in phase["columns"].items()))
        return text("\n".join(lines), **data)
    if name == "phase_list":
        data = call("phase.list", {})
        return text("\n".join(f"{p['slug']}{' (current)' if p['current'] else ''}: {p['name']} [{p['status']}] "
                              f"tickets {p['ticketCount']}" for p in data["phases"]), phases=data["phases"])
    if name == "ticket_list":
        payload = _optional(args, "status", "workflowStatus", "phase")
        if isinstance(args.get("summary"), bool):
            payload["summary"] = args["summary"]
        data = call("ticket.list", payload)
        return text("\n".join(f"{t['key']} [{t['status']}] {t['phase']}: {t['title']}" for t in data["tickets"])
                    or "(no tickets)", tickets=data["tickets"])
    if name == "ticket_show":
        data = call("ticket.show", {"key": _need(args, "key")})
        t = data["ticket"]
        body = (f"{t['key']} [{t['status']}] phase {t['phase']}: {t['title']}\n{t.get('body') or ''}\nevents:\n"
                + "\n".join(f"  {e['name']} -> {e.get('to')}" for e in data.get("events", [])))
        return text(body, **data)
    if name == "team_overview":
        data = call("team.overview", {})
        return text(_json_text(data), **data)
    if name == "workflow_show":
        data = call("workflow.show", {"workflowRunId": _need(args, "workflowRunId")}, ws=False)
        return text(_json_text(data), **data)
    if name == "command_requests":
        data = call("command.requests", _optional(args, "workflowRunId", "teamId"), ws=False)
        return text(_json_text(data), **data)
    if name == "command_catalog":
        data = call("command.catalog", {})
        return text(_json_text(data), **data)
    # ---- changes (--allow-writes) ----
    if name == "ticket_add":
        extra = dict(_optional(args, "body", "phase"), title=_need(args, "title"),
                     priority=args.get("priority", 100))
        data = call("ticket.add", extra, True)
        t = data["ticket"]
        return text(f"added {t['key']} in phase {t['phase']} (status {t['status']})", ticket=t)
    if name == "ticket_move":
        extra = dict(_optional(args, "reason", "workflowStatus"), key=_need(args, "key"), to=_need(args, "to"),
                     force=args.get("force") is True)
        data = call("ticket.move", extra, True)
        return text(f"moved {data['ticket']['key']} to {data['ticket']['status']}", ticket=data["ticket"])
    if name == "ticket_depend":
        extra = {"key": _need(args, "key"), "on": args.get("on") or [], "remove": args.get("remove") or []}
        data = call("ticket.depend", extra, True)
        return text(_json_text(data), **data)
    if name == "ticket_phase":
        data = call("ticket.phase", {"key": _need(args, "key"), "phase": _need(args, "phase")}, True)
        return text(f"{data['ticket']['key']} is now in phase {data['ticket']['phase']}", ticket=data["ticket"])
    if name in ("ticket_unblock", "ticket_retry"):
        extra = dict(_optional(args, "to") if name == "ticket_unblock" else {}, key=_need(args, "key"))
        data = call("ticket." + name.split("_")[1], extra, True)
        return text(f"{data['ticket']['key']} is now {data['ticket']['status']}", ticket=data["ticket"])
    extra = dict(_optional(args, "reason") if name == "command_reject" else {}, requestId=_need(args, "requestId"))
    data = call("command.approve" if name == "command_approve" else "command.reject", extra, True, ws=False)
    return text(_json_text(data), **data)


# ---- client setup ---------------------------------------------------------------------------------------------

def _exe() -> str:
    found = shutil.which("agent-studio")
    if found:
        return os.path.abspath(found)
    for cand in (os.path.expanduser("~/.local/bin/agent-studio"),
                 os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bin", "agent-studio")):
        if os.access(cand, os.X_OK):
            return cand
    return "agent-studio"


def config_text(exe: str, workspace: str = "", allow_writes: bool = False, distro: str = "") -> str:
    """Ready-to-paste setup of the operator server for Claude Code, Codex and OpenCode."""
    tail = ["mcp", "--operator"] + (["--workspace", workspace] if workspace else []) + \
           (["--allow-writes"] if allow_writes else [])
    variants = [("", [exe] + tail)]
    if distro:
        variants.append((" (from Windows, through WSL)", ["wsl.exe", "-d", distro, "-e", exe] + tail))
    out = []
    for label, argv in variants:
        cmd = " ".join(shlex.quote(a) for a in argv)
        out += [f"# Claude Code{label}", f"claude mcp add --scope user agent-studio -- {cmd}", "",
                f"# Codex{label}  (or put the block below in ~/.codex/config.toml)",
                f"codex mcp add agent-studio -- {cmd}",
                "[mcp_servers.agent-studio]", f"command = {json.dumps(argv[0])}",
                f"args = {json.dumps(argv[1:])}", "",
                f"# OpenCode{label}  (opencode.json, project or ~/.config/opencode/opencode.json)",
                json.dumps({"$schema": "https://opencode.ai/config.json",
                            "mcp": {"agent-studio": {"type": "local", "command": argv, "enabled": True}}}, indent=2),
                ""]
    return "\n".join(out)


def handle(obj, assignment: str, agent: str, workspace: str = "", request_id=None, operator=None):
    """One decoded JSON-RPC object -> the response object (or None for notifications). `operator` (a dict with
    `workspace`, `allowWrites`, `session`) selects the operator tool set; assignment mode is unchanged."""
    try:
        if not isinstance(obj, dict):
            raise JsonRpcError(INVALID_REQUEST, "A request must be a JSON object.")
        if obj.get("jsonrpc") != "2.0":
            raise JsonRpcError(INVALID_REQUEST, "jsonrpc must be exactly '2.0'.")
        rid = obj.get("id")
        method = obj.get("method")
        if method is None:
            raise JsonRpcError(INVALID_REQUEST, "Missing method.")
        if method == "initialize":
            result = {"protocolVersion": PROTOCOL_VERSION, "capabilities": {"tools": {}}, "serverInfo": SERVER_INFO}
        elif method == "notifications/initialized" or (method or "").startswith("notifications/"):
            return None  # notifications are answered with nothing
        elif method == "ping":
            result = {}
        elif method == "tools/list":
            result = {"tools": operator_tools(bool(operator.get("allowWrites"))) if operator is not None else TOOLS}
        elif method == "tools/call":
            params = obj.get("params") or {}
            name = params.get("name")
            args = params.get("arguments") or {}
            try:
                args = args if isinstance(args, dict) else {}
                result = (_operator_tool_call(name, args, operator, rid) if operator is not None else
                          _tool_call(name, args, assignment, agent, workspace, rid))
                result["isError"] = False
            except AsError as e:
                # command errors are tool results (isError), not protocol errors: the client sees the code
                result = {"isError": True,
                          "content": [{"type": "text", "text": f"{e.code}: {e.message}"}],
                          "code": e.code,
                          **({"data": e.data} if e.data is not None else {})}
        else:
            raise JsonRpcError(METHOD_NOT_FOUND, f"Unknown method {method!r}.")
        return {"jsonrpc": "2.0", "id": rid, "result": result}
    except JsonRpcError as e:
        data = e.data if isinstance(e.data, dict) else None
        return {"jsonrpc": "2.0", "id": obj.get("id") if isinstance(obj, dict) else None,
                "error": {"code": e.code, "message": e.message, **({"data": data} if data else {})}}
    except Exception as e:  # never kill the server on one bad line
        return {"jsonrpc": "2.0", "id": obj.get("id") if isinstance(obj, dict) else None,
                "error": {"code": INTERNAL_ERROR, "message": f"internal error: {e}"}}


def serve(inp=None, out=None, operator=None) -> int:
    inp = inp if inp is not None else sys.stdin.buffer
    out = out if out is not None else sys.stdout.buffer
    try:
        assignment, agent, workspace = ("", "", "") if operator is not None else _read_env()
    except AsError as e:
        out.write(dumps({"jsonrpc": "2.0", "id": None,
                         "error": {"code": INVALID_REQUEST, "message": e.message}}) + b"\n")
        out.flush()
        return 1
    try:
        while True:
            line = inp.readline(MAX_LINE_BYTES)
            if not line:
                return 0
            text = line.strip()
            if not text:
                continue
            try:
                obj = json.loads(text.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                resp = {"jsonrpc": "2.0", "id": None,
                        "error": {"code": INVALID_REQUEST, "message": "Request is not valid JSON."}}
            else:
                resp = handle(obj, assignment, agent, workspace, operator=operator)
            if resp is not None:
                out.write(dumps(resp) + b"\n")
                out.flush()
    except BrokenPipeError:
        return 0
    except KeyboardInterrupt:
        return 130


def main(argv) -> int:
    """`agent-studio mcp [--operator [--workspace PATH] [--allow-writes]] | --print-config`."""
    flags, workspace, i = set(), "", 0
    while i < len(argv):
        a = argv[i]
        if a == "--workspace" and i + 1 < len(argv):
            workspace, i = argv[i + 1], i + 2
        elif a in ("--operator", "--allow-writes", "--print-config"):
            flags.add(a)
            i += 1
        else:
            sys.stderr.write(f"agent-studio mcp: unknown argument {a!r}\n"
                             "usage: agent-studio mcp [--operator [--workspace PATH] [--allow-writes]] | --print-config\n")
            return 2
    if "--print-config" in flags:
        sys.stdout.write(config_text(_exe(), workspace, "--allow-writes" in flags,
                                     os.environ.get("WSL_DISTRO_NAME", "")))
        return 0
    if "--operator" in flags:
        ws = workspace or os.environ.get("AGENT_STUDIO_WORKSPACE", "")
        return serve(operator={"workspace": ws, "allowWrites": "--allow-writes" in flags,
                               "session": uuid.uuid4().hex})
    if "--allow-writes" in flags or workspace:
        sys.stderr.write("agent-studio mcp: --workspace and --allow-writes need --operator\n")
        return 2
    return serve()
