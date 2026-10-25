"""The Agent Studio board MCP server (P04-S12): stdio JSON-RPC 2.0, standard library only.

An MCP client (Claude Code, Codex, the fake provider's test path) launches `agent-studio mcp` with
AGENT_STUDIO_ASSIGNMENT and AGENT_STUDIO_AGENT in the environment. Every tool call becomes a normal
`ticket.add` / `ticket.list` / `ticket.show` / `phase.list` / `board.show` request through the same
validated command path the CLI uses — the server never opens the database, and the coordinator stays
the only writer. Command errors come back as JSON-RPC errors with the command's code in `data.code`.
"""
from __future__ import annotations

import json
import os
import sys
import uuid

from . import PROTOCOL, dispatch
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
     "description": "List the workspace's tickets, optionally by status or phase.",
     "inputSchema": {"type": "object", "properties": {
         "status": {"type": "string"}, "phase": {"type": "string"}}}},
    {"name": "ticket_show",
     "description": "One ticket with its status, phase, dependencies and event history.",
     "inputSchema": {"type": "object", "properties": {"key": {"type": "string"}}, "required": ["key"]}},
    {"name": "phase_list",
     "description": "The board's phases with the current one marked.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "board_show",
     "description": "The whole board: phases with status columns and tickets.",
     "inputSchema": {"type": "object", "properties": {}}},
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
                f"{c['status']}({c['count']})" for c in phase["columns"]))
        return {"content": [{"type": "text", "text": "\n".join(lines)}], **data}
    raise JsonRpcError(METHOD_NOT_FOUND, f"Unknown tool {name!r}.")
    # unreachable; kept for clarity


def handle(obj, assignment: str, agent: str, workspace: str = "", request_id=None):
    """One decoded JSON-RPC object -> the response object (or None for notifications)."""
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
            result = {"tools": TOOLS}
        elif method == "tools/call":
            params = obj.get("params") or {}
            name = params.get("name")
            args = params.get("arguments") or {}
            try:
                result = _tool_call(name, args if isinstance(args, dict) else {}, assignment, agent,
                                    workspace, rid)
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


def serve(inp=None, out=None) -> int:
    inp = inp if inp is not None else sys.stdin.buffer
    out = out if out is not None else sys.stdout.buffer
    try:
        assignment, agent, workspace = _read_env()
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
                resp = handle(obj, assignment, agent, workspace)
            if resp is not None:
                out.write(dumps(resp) + b"\n")
                out.flush()
    except BrokenPipeError:
        return 0
    except KeyboardInterrupt:
        return 130
