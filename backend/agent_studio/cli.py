"""Operator CLI. Every command prints exactly one JSON response on stdout; diagnostics go to stderr.

Machine callers (PowerShell, Electron) should use `request` (one JSON request on stdin) or `serve`
(one JSON request per line) so no user text ever appears on a command line.
"""
from __future__ import annotations

import argparse
import json
import sys
import uuid

import os

from . import PROTOCOL, coordinator, dispatch, keepalive, runner, serve
from .protocol import AsError, BAD_REQUEST, MAX_LINE_BYTES, dumps, envelope

USAGE = """agent-studio <command>

  health                                   backend, coordinator, environment, keep-alive status
  preflight --workspace PATH               infrastructure checks (state dir, workspace, tmux)
  coordinator start [--enable-debug]       start the coordinator daemon (idempotent)
  coordinator stop                         stop the recorded coordinator process
  snapshot [--team ID] [--include-stopped]  current teams, agents, tasks, workflow runs, assignments + cursor
  events [--after N] [--limit N] [--team ID] [--db-id ID]   journal events after a cursor
  team start --workspace PATH --agent PROVIDER:ROLE[:NAME] [--agent ...] [--name NAME]
                                           launch one tmux window with one pane per agent
  team attach --team ID [--print]          attach this terminal to the team's tmux window (or print commands)
  team stop --team ID                      stop only that team's verified tmux session
  debug echo --text TEXT [--key KEY]       round-trip text through the command inbox (debug coordinators only)
  debug fixture [--agents N]               create a fake team/task/assignment (debug coordinators only)
  debug assign --agent ID [--outcome S] [--duration-ms N] [--lines N] [--exit-without-final]
                                           give an agent a stub assignment (debug coordinators only)
  request                                  read one JSON request from stdin, print one response
  serve                                    line-delimited JSON requests/responses over stdio
  keepalive                                hold the WSL keep-alive lock until terminated

Options: --pretty (indent JSON for humans)
"""


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        raise AsError(BAD_REQUEST, message)


def _emit(resp: dict, pretty: bool) -> int:
    if pretty:
        sys.stdout.write(json.dumps(resp, ensure_ascii=False, indent=2) + "\n")
        sys.stdout.flush()
    else:
        sys.stdout.buffer.write(dumps(resp) + b"\n")
        sys.stdout.buffer.flush()
    return 0 if resp.get("ok") else 1


def _human_request(argv) -> dict:
    p = _Parser(prog="agent-studio", add_help=False)
    sub = p.add_subparsers(dest="cmd")
    sub.add_parser("health", add_help=False)
    pf = sub.add_parser("preflight", add_help=False)
    pf.add_argument("--workspace", required=True)
    co = sub.add_parser("coordinator", add_help=False)
    co.add_argument("action", choices=["start", "stop"])
    co.add_argument("--enable-debug", action="store_true")
    sn = sub.add_parser("snapshot", add_help=False)
    sn.add_argument("--team")
    sn.add_argument("--include-stopped", action="store_true")
    ev = sub.add_parser("events", add_help=False)
    ev.add_argument("--after", type=int, default=0)
    ev.add_argument("--limit", type=int, default=200)
    ev.add_argument("--team")
    ev.add_argument("--db-id")
    tm = sub.add_parser("team", add_help=False)
    tm.add_argument("action", choices=["start", "stop", "attach"])
    tm.add_argument("--workspace")
    tm.add_argument("--agent", action="append", default=[])
    tm.add_argument("--name")
    tm.add_argument("--team")
    tm.add_argument("--print", action="store_true")
    tm.add_argument("--key")
    tm.add_argument("--timeout-ms", type=int, default=dispatch.DEFAULT_TIMEOUT_MS)
    dbg = sub.add_parser("debug", add_help=False)
    dbg.add_argument("action", choices=["echo", "fixture", "assign"])
    dbg.add_argument("--text")
    dbg.add_argument("--agents", type=int, default=2)
    dbg.add_argument("--agent")
    dbg.add_argument("--goal")
    dbg.add_argument("--outcome", default="succeeded")
    dbg.add_argument("--duration-ms", type=int, default=1500)
    dbg.add_argument("--lines", type=int, default=3)
    dbg.add_argument("--exit-without-final", action="store_true")
    dbg.add_argument("--key")
    dbg.add_argument("--timeout-ms", type=int, default=dispatch.DEFAULT_TIMEOUT_MS)
    ns = p.parse_args(argv)
    req = {"protocol": PROTOCOL, "args": {}}
    if ns.cmd == "health":
        req["command"] = "health"
    elif ns.cmd == "preflight":
        req.update(command="preflight", args={"workspace": ns.workspace})
    elif ns.cmd == "coordinator":
        req["command"] = f"coordinator.{ns.action}"
        if ns.action == "start":
            req["args"] = {"enableDebug": ns.enable_debug}
    elif ns.cmd == "snapshot":
        req.update(command="snapshot", args={"includeStopped": ns.include_stopped})
        if ns.team:
            req["args"]["teamId"] = ns.team
    elif ns.cmd == "events":
        req.update(command="events.after", args={"cursor": ns.after, "limit": ns.limit})
        if ns.team:
            req["args"]["teamId"] = ns.team
        if ns.db_id:
            req["args"]["dbId"] = ns.db_id
    elif ns.cmd == "team":
        if ns.action == "start":
            if not ns.workspace or not ns.agent:
                raise AsError(BAD_REQUEST, "team start needs --workspace and at least one --agent PROVIDER:ROLE[:NAME]")
            roster = []
            for spec in ns.agent:
                parts = spec.split(":", 2)
                if len(parts) < 2:
                    raise AsError(BAD_REQUEST, f"--agent {spec!r} must look like PROVIDER:ROLE[:NAME]")
                member = {"providerId": parts[0], "role": parts[1]}
                if len(parts) == 3:
                    member["displayName"] = parts[2]
                roster.append(member)
            req.update(command="team.start", args={"workspace": ns.workspace, "roster": roster})
            if ns.name:
                req["args"]["name"] = ns.name
        else:
            if not ns.team:
                raise AsError(BAD_REQUEST, f"team {ns.action} needs --team ID")
            req.update(command=f"team.{ns.action}", args={"teamId": ns.team})
            req["_print"] = ns.print
        if ns.action != "attach":
            req.update(idempotencyKey=ns.key or str(uuid.uuid4()), timeoutMs=ns.timeout_ms)
    elif ns.cmd == "debug":
        if ns.action == "assign":
            if not ns.agent:
                raise AsError(BAD_REQUEST, "debug assign needs --agent ID")
            req.update(command="debug.assign", args={"agentId": ns.agent, "stub": {
                "outcome": ns.outcome, "durationMs": ns.duration_ms, "progressLines": ns.lines,
                "exitWithoutFinal": ns.exit_without_final}})
            if ns.goal:
                req["args"]["goal"] = ns.goal
        elif ns.action == "echo":
            if ns.text is None:
                raise AsError(BAD_REQUEST, "debug echo needs --text")
            req.update(command="debug.echo", args={"text": ns.text})
        elif ns.action == "fixture":
            req.update(command="debug.fixture", args={"agents": ns.agents})
        req.update(idempotencyKey=ns.key or str(uuid.uuid4()), timeoutMs=ns.timeout_ms)
    else:
        raise AsError(BAD_REQUEST, "Unknown command. Run: agent-studio help")
    return req


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    pretty = "--pretty" in argv
    argv = [a for a in argv if a != "--pretty"]
    if not argv or argv[0] in ("help", "--help", "-h"):
        sys.stderr.write(USAGE)
        return 0 if argv else 2
    cmd = argv[0]
    if cmd == "serve":
        return serve.run()
    if cmd == "keepalive":
        return keepalive.run()
    if cmd == "coordinator" and argv[1:2] == ["run"]:
        return coordinator.run(enable_debug="--enable-debug" in argv[2:])
    if cmd == "runner":
        p = _Parser(prog="agent-studio runner", add_help=False)
        p.add_argument("--agent", required=True)
        p.add_argument("--assignment", required=True)
        try:
            ns = p.parse_args(argv[1:])
        except AsError as e:
            sys.stderr.write(e.message + "\n")
            return 2
        return runner.run(ns.agent, ns.assignment)
    if cmd == "request":
        raw = sys.stdin.buffer.read(MAX_LINE_BYTES + 1)
        if len(raw) > MAX_LINE_BYTES:
            return _emit(envelope(None, False, error=AsError(BAD_REQUEST, "Request is too long.").to_error()), pretty)
        return _emit(dispatch.handle_bytes(raw.strip(), require_id=False), pretty)
    try:
        req = _human_request(argv)
    except AsError as e:
        return _emit(envelope(None, False, error=e.to_error()), pretty)
    print_only = req.pop("_print", False)
    resp = dispatch.handle_request(req, require_id=False)
    if (req.get("command") == "team.attach" and resp.get("ok") and not print_only
            and sys.stdin.isatty() and sys.stdout.isatty()):
        argv_ = resp["data"]["argv"]
        os.execv(argv_[0], argv_)  # native tmux takes over this terminal; detach with Ctrl-b d
    return _emit(resp, pretty)
