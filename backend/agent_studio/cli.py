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

from . import PROTOCOL, coordinator, dispatch, keepalive, runner, serve, validation, watch
from .protocol import AsError, BAD_REQUEST, MAX_LINE_BYTES, dumps, envelope

USAGE = """agent-studio <command>

  health                                   backend, coordinator, environment, keep-alive status
  preflight --workspace PATH [--provider ID ...] [--policy P ...]
                                           state dir, workspace, tmux, and selected providers/policies
  coordinator start [--enable-debug]       start the coordinator daemon (idempotent)
  coordinator stop                         stop the recorded coordinator process
  snapshot [--team ID] [--include-stopped]  current teams, agents, tasks, workflow runs, assignments + cursor
  events [--after N] [--limit N] [--team ID] [--db-id ID]   journal events after a cursor
  team start --workspace PATH --agent PROVIDER:ROLE[:NAME] [--agent ...] [--name NAME]
                                           launch one tmux window with one pane per agent
  team attach --team ID [--print]          attach this terminal to the team's tmux window (or print commands)
  team stop --team ID                      stop only that team's verified tmux session
  task direct --team ID --agent ID --policy read_only|workspace_write (--text TEXT | --text-file PATH|-)
              [--deadline-ms N] [--wait]   give one idle agent a task; --wait follows it to the end
  task show --task ID                      a task, its assignments and its event history
  assignment cancel --assignment ID        cancel queued or running work (exactly one outcome wins)
  assignment resolve --assignment ID --action retry|fail|cancel [--policy P]
                                           settle waiting_input / reconciling work or a paused workflow stage
  workflow start --team ID --developer ID --reviewer ID (--text TEXT | --text-file PATH|-) [--wait]
                                           Developer -> validation -> Reviewer, one bounded repair
  workflow show --workflow ID              stages, verdicts, validation, handoffs and history
  workflow cancel --workflow ID            cancel a running or paused workflow
  debug echo --text TEXT [--key KEY]       round-trip text through the command inbox (debug coordinators only)
  debug fixture [--agents N]               create a fake team/task/assignment (debug coordinators only)
  debug assign --agent ID [--scenario S] [--policy P] [--duration-ms N] [--lines N] [--deadline-ms N]
               [--write-file REL]          give an agent a fake-provider assignment (debug coordinators only)
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


def _task_text(ns) -> str:
    if (ns.text is None) == (ns.text_file is None):
        raise AsError(BAD_REQUEST, "give exactly one of --text or --text-file")
    if ns.text is not None:
        return ns.text
    try:
        if ns.text_file == "-":
            return sys.stdin.buffer.read(dispatch.MAX_TASK_BYTES + 1).decode("utf-8")
        with open(ns.text_file, "rb") as f:
            return f.read(dispatch.MAX_TASK_BYTES + 1).decode("utf-8")
    except (OSError, UnicodeDecodeError) as e:
        raise AsError(BAD_REQUEST, f"Cannot read the task text: {e}")


def _human_request(argv) -> dict:
    p = _Parser(prog="agent-studio", add_help=False)
    sub = p.add_subparsers(dest="cmd")
    sub.add_parser("health", add_help=False)
    pf = sub.add_parser("preflight", add_help=False)
    pf.add_argument("--workspace", required=True)
    pf.add_argument("--provider", action="append", default=[])
    pf.add_argument("--policy", action="append", default=[])
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
    tk = sub.add_parser("task", add_help=False)
    tk.add_argument("action", choices=["direct", "show"])
    tk.add_argument("--team")
    tk.add_argument("--agent")
    tk.add_argument("--task")
    tk.add_argument("--policy")
    tk.add_argument("--text")
    tk.add_argument("--text-file")
    tk.add_argument("--deadline-ms", type=int)
    tk.add_argument("--wait", action="store_true")
    tk.add_argument("--scenario")
    tk.add_argument("--duration-ms", type=int, default=1000)
    tk.add_argument("--lines", type=int, default=3)
    tk.add_argument("--key")
    tk.add_argument("--timeout-ms", type=int, default=dispatch.DEFAULT_TIMEOUT_MS)
    wf_p = sub.add_parser("workflow", add_help=False)
    wf_p.add_argument("action", choices=["start", "show", "cancel"])
    wf_p.add_argument("--team")
    wf_p.add_argument("--developer")
    wf_p.add_argument("--reviewer")
    wf_p.add_argument("--workflow")
    wf_p.add_argument("--text")
    wf_p.add_argument("--text-file")
    wf_p.add_argument("--wait", action="store_true")
    wf_p.add_argument("--key")
    wf_p.add_argument("--timeout-ms", type=int, default=dispatch.DEFAULT_TIMEOUT_MS)
    asg_p = sub.add_parser("assignment", add_help=False)
    asg_p.add_argument("action", choices=["cancel", "resolve"])
    asg_p.add_argument("--action", dest="resolve_action", choices=["retry", "fail", "cancel"])
    asg_p.add_argument("--policy")
    asg_p.add_argument("--assignment", required=True)
    asg_p.add_argument("--key")
    asg_p.add_argument("--timeout-ms", type=int, default=dispatch.DEFAULT_TIMEOUT_MS)
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
    dbg.add_argument("--scenario", default="success")
    dbg.add_argument("--policy", default="read_only")
    dbg.add_argument("--duration-ms", type=int, default=1500)
    dbg.add_argument("--lines", type=int, default=3)
    dbg.add_argument("--deadline-ms", type=int)
    dbg.add_argument("--write-file")
    dbg.add_argument("--key")
    dbg.add_argument("--timeout-ms", type=int, default=dispatch.DEFAULT_TIMEOUT_MS)
    ns = p.parse_args(argv)
    req = {"protocol": PROTOCOL, "args": {}}
    if ns.cmd == "health":
        req["command"] = "health"
    elif ns.cmd == "preflight":
        req.update(command="preflight", args={"workspace": ns.workspace})
        if ns.provider:
            req["args"]["providers"] = ns.provider
        if ns.policy:
            req["args"]["policies"] = ns.policy
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
    elif ns.cmd == "task":
        if ns.action == "show":
            if not ns.task:
                raise AsError(BAD_REQUEST, "task show needs --task ID")
            req.update(command="task.show", args={"taskId": ns.task})
        else:
            if not (ns.team and ns.agent and ns.policy):
                raise AsError(BAD_REQUEST, "task direct needs --team, --agent and --policy")
            text = _task_text(ns)
            req.update(command="task.direct", args={"teamId": ns.team, "agentId": ns.agent, "policy": ns.policy,
                                                    "text": text})
            if ns.deadline_ms:
                req["args"]["deadlineMs"] = ns.deadline_ms
            if ns.scenario:
                req["args"]["debugProviderOptions"] = {"scenario": ns.scenario, "durationMs": ns.duration_ms,
                                                       "progressLines": ns.lines}
            req.update(idempotencyKey=ns.key or str(uuid.uuid4()), timeoutMs=ns.timeout_ms)
            req["_wait"] = ns.wait
    elif ns.cmd == "workflow":
        if ns.action == "start":
            if not (ns.team and ns.developer and ns.reviewer):
                raise AsError(BAD_REQUEST, "workflow start needs --team, --developer and --reviewer")
            text = _task_text(ns)
            req.update(command="workflow.start", args={"teamId": ns.team, "developerAgentId": ns.developer,
                                                       "reviewerAgentId": ns.reviewer, "text": text},
                       idempotencyKey=ns.key or str(uuid.uuid4()), timeoutMs=ns.timeout_ms)
            req["_wait_workflow"] = ns.wait
        else:
            if not ns.workflow:
                raise AsError(BAD_REQUEST, f"workflow {ns.action} needs --workflow ID")
            req.update(command=f"workflow.{ns.action}", args={"workflowRunId": ns.workflow})
            if ns.action == "cancel":
                req.update(idempotencyKey=ns.key or str(uuid.uuid4()), timeoutMs=ns.timeout_ms)
    elif ns.cmd == "assignment":
        if ns.action == "resolve":
            if not ns.resolve_action:
                raise AsError(BAD_REQUEST, "assignment resolve needs --action retry|fail|cancel")
            req.update(command="assignment.resolve", args={"assignmentId": ns.assignment, "action": ns.resolve_action})
            if ns.policy:
                req["args"]["policy"] = ns.policy
        else:
            req.update(command="assignment.cancel", args={"assignmentId": ns.assignment})
        req.update(idempotencyKey=ns.key or str(uuid.uuid4()), timeoutMs=ns.timeout_ms)
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
            fake = {"scenario": ns.scenario, "durationMs": ns.duration_ms, "progressLines": ns.lines}
            if ns.write_file:
                fake["writeFile"] = ns.write_file
            req.update(command="debug.assign", args={"agentId": ns.agent, "policy": ns.policy, "fake": fake})
            if ns.deadline_ms:
                req["args"]["deadlineMs"] = ns.deadline_ms
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
    if cmd == "validate":
        if argv[1:2] != ["--dir"] or len(argv) != 3:
            sys.stderr.write("usage: agent-studio validate --dir DIR (internal)\n")
            return 2
        return validation.run_validator(argv[2])
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
    wait = req.pop("_wait", False)
    wait_wf = req.pop("_wait_workflow", False)
    resp = dispatch.handle_request(req, require_id=False)
    if wait_wf and resp.get("ok"):
        receipt = resp["data"]
        sys.stderr.write(f"accepted: workflow {receipt['workflowRunId']} (base {receipt['baseCommit'][:12]})\n")
        try:
            detail = watch.follow_workflow(receipt["workflowRunId"])
        except KeyboardInterrupt:
            sys.stderr.write("stopped watching; the workflow keeps running (see: agent-studio workflow show)\n")
            return 130
        return _emit(envelope(None, True, data=dict(detail, receipt=receipt)), pretty)
    if wait and resp.get("ok"):
        receipt = resp["data"]
        sys.stderr.write(f"accepted: task {receipt['taskId']} assignment {receipt['assignmentId']}\n")
        try:
            detail = watch.follow(receipt["assignmentId"], receipt["taskId"])
        except KeyboardInterrupt:
            sys.stderr.write("stopped watching; the task keeps running (see: agent-studio task show)\n")
            return 130
        resp = envelope(None, True, data=dict(detail, receipt=receipt))
    if (req.get("command") == "team.attach" and resp.get("ok") and not print_only
            and sys.stdin.isatty() and sys.stdout.isatty()):
        argv_ = resp["data"]["argv"]
        os.execv(argv_[0], argv_)  # native tmux takes over this terminal; detach with Ctrl-b d
    return _emit(resp, pretty)
