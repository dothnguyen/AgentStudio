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
  preflight --workspace PATH [--provider ID ...] [--policy P ...] [--role NAME ...] [--deep]
                                           state dir, workspace, tmux, providers/policies, workspace roles;
                                           --deep proves provider authentication with a tiny read-only task
  provider verify --provider ID [--model M] [--reasoning R]
                                           on-machine evidence for an adapter story (real runs, captured output)
  coordinator start [--enable-debug]       start the coordinator daemon (idempotent)
  coordinator stop                         stop the recorded coordinator process
  snapshot [--team ID] [--include-stopped]  current teams, agents, tasks, workflow runs, assignments + cursor
  events [--after N] [--limit N] [--team ID] [--db-id ID]   journal events after a cursor
  team start --workspace PATH [--agent PROVIDER:ROLE[:NAME][,model=M][,reasoning=R] ...] [--name NAME]
                                           one tmux window with one pane per agent; without --agent the
                                           roster comes from <workspace>/.agent-studio/team.json
  team attach --team ID [--print]          attach this terminal to the team's tmux window (or print commands)
  team stop --team ID                      stop only that team's verified tmux session
  task direct --team ID --agent ID --policy read_only|workspace_write (--text TEXT | --text-file PATH|-)
              [--deadline-ms N] [--wait]   give one idle agent a task; --wait follows it to the end
  task show --task ID                      a task, its assignments and its event history
  assignment cancel --assignment ID        cancel queued or running work (exactly one outcome wins)
  assignment resolve --assignment ID --action retry|fail|cancel [--policy P]
                                           settle waiting_input / reconciling work or a paused workflow stage
  workflow list --team ID                  workflow definitions available to the team's workspace
  workflow validate --team ID --definition NAME [--bind ROLE=AGENT ...]
                                           check a definition and its role bindings; writes nothing
  workflow start --team ID --definition NAME [--bind ROLE=AGENT ...] (--text TEXT | --text-file PATH|-) [--wait]
                                           run a definition (built-in: developer-reviewer)
  workflow start --team ID --developer ID --reviewer ID (--text TEXT | --text-file PATH|-) [--wait]
                                           the P00 form: same as --definition developer-reviewer
  workflow show --workflow ID              stages, verdicts, validation, handoffs and history
  workflow cancel --workflow ID            cancel a running or paused workflow
  workflow retry --workflow ID             run the current stage again (waiting_input / stuck / failed stage)
  ticket create --workspace PATH --story PATH [--title T] [--depends KEY ...] [--no-deps] [--priority N] [--key K]
  ticket show|list|move|block|unblock|cancel|depend --workspace PATH [KEY] [ticket options]
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


def _bindings(items):
    out = {}
    for item in items:
        role, sep, agent = item.partition("=")
        if not sep or not role.strip() or not agent.strip():
            raise AsError(BAD_REQUEST, f"--bind expects ROLE=AGENT_ID, got {item!r}")
        if role.strip() in out:
            raise AsError(BAD_REQUEST, f"--bind names the role {role.strip()!r} twice")
        out[role.strip()] = agent.strip()
    return out


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
    pf.add_argument("--role", action="append", default=[])
    pf.add_argument("--deep", action="store_true")
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
    wf_p.add_argument("action", choices=["start", "show", "cancel", "list", "validate", "retry"])
    wf_p.add_argument("--team")
    wf_p.add_argument("--developer")
    wf_p.add_argument("--reviewer")
    wf_p.add_argument("--workflow")
    wf_p.add_argument("--definition")
    wf_p.add_argument("--bind", action="append", default=[])
    wf_p.add_argument("--text")
    wf_p.add_argument("--text-file")
    wf_p.add_argument("--wait", action="store_true")
    wf_p.add_argument("--key")
    wf_p.add_argument("--timeout-ms", type=int, default=dispatch.DEFAULT_TIMEOUT_MS)
    ticket_p = sub.add_parser("ticket", add_help=False)
    ticket_p.add_argument("action", choices=["create", "show", "list", "move", "block", "unblock", "cancel", "depend"])
    ticket_p.add_argument("ticket_key", nargs="?")
    ticket_p.add_argument("--workspace", required=True)
    ticket_p.add_argument("--story")
    ticket_p.add_argument("--title")
    ticket_p.add_argument("--depends", action="append", default=[])
    ticket_p.add_argument("--no-deps", action="store_true")
    ticket_p.add_argument("--priority", type=int)
    ticket_p.add_argument("--to")
    ticket_p.add_argument("--reason")
    ticket_p.add_argument("--status")
    ticket_p.add_argument("--kind")
    ticket_p.add_argument("--on", action="append", default=[])
    ticket_p.add_argument("--remove", action="append", default=[])
    ticket_p.add_argument("--key")
    ticket_p.add_argument("--timeout-ms", type=int, default=dispatch.DEFAULT_TIMEOUT_MS)
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
        if ns.role:
            req["args"]["roles"] = ns.role
        if ns.deep:
            req["args"]["deep"] = True
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
        if ns.action in ("list", "validate"):
            if not ns.team:
                raise AsError(BAD_REQUEST, f"workflow {ns.action} needs --team ID")
            args = {"teamId": ns.team}
            if ns.action == "validate":
                if not ns.definition:
                    raise AsError(BAD_REQUEST, "workflow validate needs --definition NAME")
                args["definition"] = ns.definition
                if ns.bind:
                    args["bindings"] = _bindings(ns.bind)
            req.update(command=f"workflow.{ns.action}", args=args)
        elif ns.action == "start" and ns.definition:
            if not ns.team:
                raise AsError(BAD_REQUEST, "workflow start needs --team")
            if ns.developer or ns.reviewer:
                raise AsError(BAD_REQUEST, "--developer / --reviewer belong to the P00 form; use --bind with "
                                           "--definition")
            args = {"teamId": ns.team, "definition": ns.definition, "text": _task_text(ns)}
            if ns.bind:
                args["bindings"] = _bindings(ns.bind)
            req.update(command="workflow.start", args=args, idempotencyKey=ns.key or str(uuid.uuid4()),
                       timeoutMs=ns.timeout_ms)
            req["_wait_workflow"] = ns.wait
        elif ns.action == "start":
            if ns.bind:
                raise AsError(BAD_REQUEST, "--bind needs --definition")
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
            if ns.action in ("cancel", "retry"):
                req.update(idempotencyKey=ns.key or str(uuid.uuid4()), timeoutMs=ns.timeout_ms)
    elif ns.cmd == "ticket":
        args = {"workspace": ns.workspace}
        if ns.action == "create":
            if not ns.story:
                raise AsError(BAD_REQUEST, "ticket create needs --story PATH")
            args["storyPath"] = ns.story
            if ns.title is not None:
                args["title"] = ns.title
            if ns.depends:
                args["dependsOn"] = ns.depends
            if ns.no_deps:
                args["noDeps"] = True
            if ns.priority is not None:
                args["priority"] = ns.priority
        elif ns.action == "list":
            if ns.status is not None:
                args["status"] = ns.status
            if ns.kind is not None:
                args["kind"] = ns.kind
        else:
            if not ns.ticket_key:
                raise AsError(BAD_REQUEST, f"ticket {ns.action} needs a ticket KEY")
            args["key"] = ns.ticket_key
            if ns.action == "move":
                if ns.to is None:
                    raise AsError(BAD_REQUEST, "ticket move needs --to STATE")
                args["to"] = ns.to
            if ns.action == "block":
                if ns.reason is None:
                    raise AsError(BAD_REQUEST, "ticket block needs --reason TEXT")
                args["reason"] = ns.reason
            elif ns.action == "cancel" and ns.reason is not None:
                args["reason"] = ns.reason
            elif ns.action == "depend":
                if ns.on:
                    args["on"] = ns.on
                if ns.remove:
                    args["remove"] = ns.remove
        req.update(command=f"ticket.{ns.action}", args=args)
        if ns.action not in ("show", "list"):
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
            if not ns.workspace:
                raise AsError(BAD_REQUEST, "team start needs --workspace")
            roster = []
            for spec in ns.agent:
                head, *opts = spec.split(",")
                parts = head.split(":", 2)
                if len(parts) < 2:
                    raise AsError(BAD_REQUEST, f"--agent {spec!r} must look like PROVIDER:ROLE[:NAME][,model=M][,reasoning=R]")
                member = {"providerId": parts[0], "role": parts[1]}
                if len(parts) == 3:
                    member["displayName"] = parts[2]
                for opt in opts:
                    k, sep, v = opt.partition("=")
                    if not sep or k not in ("model", "reasoning") or not v:
                        raise AsError(BAD_REQUEST, f"--agent option {opt!r}: use model=NAME or reasoning=LEVEL")
                    member[k] = v
                roster.append(member)
            req.update(command="team.start", args={"workspace": ns.workspace})
            if roster:
                req["args"]["roster"] = roster
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
    if cmd == "provider":
        from . import provider_verify
        p = _Parser(prog="agent-studio provider", add_help=False)
        p.add_argument("action", choices=["verify"])
        p.add_argument("--provider", required=True)
        p.add_argument("--model")
        p.add_argument("--reasoning")
        try:
            ns = p.parse_args(argv[1:])
            data = provider_verify.verify(ns.provider, ns.model, ns.reasoning)
            return _emit(envelope(None, data["passed"], data=data, error=None if data["passed"] else
                                  {"code": "VERIFY_FAILED", "message": "; ".join(data["failures"])[:2000],
                                   "retryable": False}), pretty)
        except AsError as e:
            return _emit(envelope(None, False, error=e.to_error()), pretty)
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
        if detail.get("route"):
            sys.stderr.write(f"route: {detail['route']}  ({detail['workflowRun']['status']})\n")
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
    if pretty and req.get("command") == "workflow.show" and resp.get("ok") and resp["data"].get("route"):
        run = resp["data"]["workflowRun"]
        sys.stderr.write(f"route: {resp['data']['route']}  ({run['status']}, {run.get('stepCount', 0)} steps)\n")
    return _emit(resp, pretty)
