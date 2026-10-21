"""Operator CLI. Every command prints exactly one JSON response on stdout; diagnostics go to stderr.

Machine callers (PowerShell, Electron) should use `request` (one JSON request on stdin) or `serve`
(one JSON request per line) so no user text ever appears on a command line.
"""
from __future__ import annotations

import argparse
import json
import sys
import uuid

from . import PROTOCOL, coordinator, dispatch, keepalive, serve
from .protocol import AsError, BAD_REQUEST, MAX_LINE_BYTES, dumps, envelope

USAGE = """agent-studio <command>

  health                                   backend, coordinator, environment, keep-alive status
  preflight --workspace PATH               infrastructure checks (state dir, workspace, tmux)
  coordinator start [--enable-debug]       start the coordinator daemon (idempotent)
  coordinator stop                         stop the recorded coordinator process
  debug echo --text TEXT [--key KEY]       round-trip text through the command inbox (debug coordinators only)
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
    dbg = sub.add_parser("debug", add_help=False)
    dbg.add_argument("action", choices=["echo"])
    dbg.add_argument("--text", required=True)
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
    elif ns.cmd == "debug":
        req.update(command="debug.echo", args={"text": ns.text}, idempotencyKey=ns.key or str(uuid.uuid4()),
                   timeoutMs=ns.timeout_ms)
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
    if cmd == "request":
        raw = sys.stdin.buffer.read(MAX_LINE_BYTES + 1)
        if len(raw) > MAX_LINE_BYTES:
            return _emit(envelope(None, False, error=AsError(BAD_REQUEST, "Request is too long.").to_error()), pretty)
        return _emit(dispatch.handle_bytes(raw.strip(), require_id=False), pretty)
    try:
        req = _human_request(argv)
    except AsError as e:
        return _emit(envelope(None, False, error=e.to_error()), pretty)
    return _emit(dispatch.handle_request(req, require_id=False), pretty)
