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

from . import PROTOCOL, boardcli, coordinator, dispatch, keepalive, runner, serve, storycli, teamcli, teamdefs, \
    validation, watch, workspace
from .protocol import AsError, BAD_REQUEST, MAX_LINE_BYTES, TEAM_NOT_FOUND, dumps, envelope
from .store import validate_uuid

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
                                           one tmux window with one pane per agent (the P00 form; needs --agent each)
  team add --name NAME [--id ID] [--workspace PATH]   create .agent-studio/teams/<id>.json
  team add-member [--team ID] --name N --role R --provider P [--model M] [--reasoning X]
                  [--can-add-tickets true|false] [--workspace PATH]   canAddTickets: MCP ticket tools
  team remove-member [--team ID] --member ID|NAME [--workspace PATH]
  team list|show|validate [--team ID] [--workspace PATH]   team definitions (read-only)
  team import-legacy [--id ID] [--name N] [--workspace PATH]   convert .agent-studio/team.json into a team file
  team attach --team ID|UUID [--print]     attach this terminal to the team's tmux window (or print commands)
  team start [--team ID] [--workspace PATH] [--name NAME]   start a team definition by id
  team stop [--team ID|UUID] [--workspace PATH]   stop the running team of a definition (or a runtime team UUID)
  team status [--team ID|UUID] [--workspace PATH] [--json]   the runtime team and members of a definition
  team ask [--team T] --member M [--policy read_only|workspace_write] [--wait] (TEXT | --text-file PATH|-)
                                           ask one free member to do something
  team run-workflow [--team T] NAME [--bind ROLE=MEMBER ...] [--wait] (TEXT | --text-file PATH|-)
                                           one-off workflow with roles bound to members (no board)
  team run-board [--team T]               bind the running team to the workspace board and start claiming
                                           (rules check must pass; one team runs a board at a time)
  team stop-board [--team T]              stop claiming tickets; running work finishes untouched
  team workflows|check NAME [--bind ROLE=MEMBER ...]   workflow definitions / validate one against the team
  team retry [--workflow ID]               run the stuck stage of the team's running or paused workflow again
  team blocked                             members waiting for a decision, and how to free them
  team resolve (--member M | --assignment ID) --action fail|retry|cancel   free a blocked member
  team run-workflow NAME --story PATH      deliver a story with a workflow; records what `team commit` needs
                (all of the above take [--team ID|UUID] [--workspace PATH] [--json])
  team unpack BRIEF --out DIR [--member M]   product owner (else team lead) turns a feature brief into story files
  team review STORY [--member M]           team lead reviews a story before work (verdict pass = approved)
  team dev STORY [--force]                 Developer implements, tests run, QA reviews (workflow); saves story state
  team fix STORY [--integration] [--member M]   developer fixes the latest QA findings
  team qa STORY [--integration] [--member M]    you run the tests here; QA reviews diff + results
  team final STORY [--force] [--integration] [--member M]   team lead final review + commit message
  team commit STORY [--skip-integration]   integration gate, then commit with the lead's message (asks first)
  team index                               build the ctags symbol index (.agent-studio/cache/tags)
                (review..index take [--team ID|UUID] [--workspace PATH] [--json])
  task direct --team ID --agent ID --policy read_only|workspace_write (--text TEXT | --text-file PATH|-)
              [--workspace PATH]
              [--deadline-ms N] [--wait]   give one idle agent a task; --wait follows it to the end
  task show --task ID                      a task, its assignments and its event history
  assignment cancel --assignment ID        cancel queued or running work (exactly one outcome wins)
  assignment resolve --assignment ID --action retry|fail|cancel [--policy P]
                                           settle waiting_input / reconciling work or a paused workflow stage
  workflow list --team ID                  workflow definitions available to the team's workspace
  workflow validate --team ID --definition NAME [--bind ROLE=AGENT ...]
                                           check a definition and its role bindings; writes nothing
  workflow start --team ID --definition NAME [--bind ROLE=AGENT ...] (--text TEXT | --text-file PATH|-) [--workspace PATH] [--wait]
                                           run a definition (built-in: developer-reviewer)
  workflow start --team ID --developer ID --reviewer ID (--text TEXT | --text-file PATH|-) [--workspace PATH] [--wait]
                                           the P00 form: same as --definition developer-reviewer
  workflow show --workflow ID              stages, verdicts, validation, handoffs and history
  workflow cancel --workflow ID            cancel a running or paused workflow
  workflow retry --workflow ID             run the current stage again (waiting_input / stuck / failed stage)
  ticket add (--workspace PATH | cwd) --title TEXT [--body TEXT] [--priority N] [--phase ID]
                                           add a ticket to a phase (the default phase) in the initial status
  ticket move (--workspace PATH | cwd) KEY --to STATUS [--reason TEXT] [--force]
                                           move a ticket; finished tickets need --force
  ticket show (--workspace PATH | cwd) KEY   one ticket with its dependencies and event history (read-only)
  ticket list [--status STATUS] [--phase ID] (--workspace PATH | cwd)   the workspace's tickets (read-only)
  ticket depend (--workspace PATH | cwd) KEY (--on KEY ... | --remove KEY ...)   manage dependencies
  ticket phase (--workspace PATH | cwd) KEY ID   move a ticket to another open phase (not while claimed)
  ticket apply (--workspace PATH | cwd) KEY RUN   apply a finished workflow run's outcome to its ticket
  ticket unblock (--workspace PATH | cwd) KEY   return a blocked ticket to its recorded status
  ticket retry (--workspace PATH | cwd) KEY   clear a stuck claim: release it and cancel its run
  board show (--workspace PATH | cwd)      phases (current marked) with status columns and tickets (read-only)
  board rules check (--workspace PATH | cwd)   validate the rules: statuses, roles, workflows, path to done
  board phase add (--workspace PATH | cwd) --id ID --name N [--description D] [--before ID]
                                           add a phase (appended, or inserted before another and renumbered)
  board phase list|clear-current (--workspace PATH | cwd)   the phases with per-status counts / back to default
  board phase show|edit|close|reopen|set-current (--workspace PATH | cwd) ID [options]
                                           one phase / rename it / close it / reopen it / make it current
  board phase remove (--workspace PATH | cwd) ID [--move-to ID]   remove a phase (empty, or move its tickets)
  board resume --workspace PATH (--agent ID | --member NAME | --all)
                                           clear an agent's USAGE_LIMIT hold (limit_reached -> idle)
  init [--name NAME] [--path PATH] [--json]  create and register a workspace (.agent-studio/workspace.json)
  workspace list [--json]                  registered workspaces (missing ones are flagged)
  debug echo --text TEXT [--key KEY]       round-trip text through the command inbox (debug coordinators only)
  debug fixture [--agents N]               create a fake team/task/assignment (debug coordinators only)
  debug assign --agent ID [--scenario S] [--policy P] [--duration-ms N] [--lines N] [--deadline-ms N]
               [--write-file REL]          give an agent a fake-provider assignment (debug coordinators only)
  request                                  read one JSON request from stdin, print one response
  serve                                    line-delimited JSON requests/responses over stdio
  mcp                                      board MCP server (stdio JSON-RPC; started per assignment by the
                                           runner for members with canAddTickets; never by hand)
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


def emit(resp: dict, human_renderer, json_flag: bool, pretty: bool = False) -> int:
    """Shared output for the human-first commands: text by default, the response envelope with --json."""
    if json_flag:
        return _emit(resp, pretty)
    if resp.get("ok"):
        sys.stdout.write(human_renderer(resp.get("data")).rstrip("\n") + "\n")
        sys.stdout.flush()
        return 0
    err = resp.get("error") or {}
    sys.stderr.write(f"{err.get('code')}: {err.get('message')}\n")
    if err.get("remediation"):
        sys.stderr.write(f"{err['remediation']}\n")
    sys.stderr.flush()
    return 1


def _render_init(d: dict) -> str:
    head = "Workspace already initialised" if d.get("existed") else "Workspace initialised"
    return f"{head}\nname: {d['name']}\nid: {d['id']}\npath: {d['path']}"


def _render_workspaces(d: dict) -> str:
    if not d["workspaces"]:
        return "no workspaces registered"
    return "\n".join(f"{w['name']}  {w['id']}  {w['path']}" + ("  (missing)" if w["missing"] else "")
                     for w in d["workspaces"])


_TEAM_LOCAL = {
    "add": ("--name", "--id"),
    "add-member": ("--team", "--name", "--role", "--provider", "--model", "--reasoning",
                   "--can-add-tickets"),
    "remove-member": ("--team", "--member"),
    "list": (),
    "show": ("--team",),
    "validate": ("--team",),
    "import-legacy": ("--id", "--name"),
}


def _render_team_warnings(d: dict) -> list:
    return [f"warning: {w['path']}: {w['message']}" for w in d.get("warnings") or []]


def _render_team(d: dict) -> str:
    if "teams" in d:
        if not d["teams"]:
            return "no teams defined"
        return "\n".join(f"{t['id']}  {t['name']}  {t['members']} member(s)" + ("  (legacy team.json)" if t["legacy"] else "")
                         for t in d["teams"])
    team = d["team"]
    if "problems" in d:
        return f"team {team}: valid"
    if "legacy" in d:
        lines = [f"{team.get('name')}  ({team.get('id')})" + ("  legacy team.json" if d["legacy"] else "")]
        for m in team.get("members") or []:
            extra = "".join(f"  {k}={m[k]}" for k in ("model", "reasoning") if m.get(k))
            lines.append(f"  {m.get('id')}  {m.get('name')}  {m.get('role')}  {m.get('provider')}{extra}")
        return "\n".join(lines)
    return f"team {team['id']}"


def _team_command(argv, pretty):
    action = argv[1]
    opts = _TEAM_LOCAL[action]
    p = _Parser(prog="agent-studio", add_help=False)
    for o in opts + ("--workspace",):
        p.add_argument(o)
    p.add_argument("--json", action="store_true")
    json_flag = "--json" in argv
    try:
        ns = p.parse_args(argv[2:])
        ws = workspace.resolve(os.getcwd(), override=ns.workspace)["path"]
        if action == "add":
            data = teamdefs.add_team(ws, ns.name, ns.id)
        elif action == "add-member":
            can_add = (ns.can_add_tickets.lower() in ("1", "true", "yes")
                       if ns.can_add_tickets is not None else None)
            data = teamdefs.add_member(ws, ns.team, ns.name, ns.role, ns.provider, ns.model, ns.reasoning,
                                       can_add)
        elif action == "remove-member":
            data = teamdefs.remove_member(ws, ns.team, ns.member)
        elif action == "list":
            data = teamdefs.list_teams(ws)
        elif action == "show":
            data = teamdefs.show(ws, ns.team)
        elif action == "validate":
            data = teamdefs.validate_team(ws, ns.team)
        else:
            data = teamdefs.import_legacy(ws, ns.id or teamdefs.LEGACY_ID, ns.name or teamdefs.LEGACY_ID)
        resp = envelope(None, True, data=data)
    except AsError as e:
        err = e.to_error()
        if e.data is not None:
            err["data"] = e.data
        resp = envelope(None, False, error=err)
    return emit(resp, lambda d: _render_team_action(action, d), json_flag, pretty)


def _render_team_action(action, d):
    if action in ("add", "add-member", "remove-member", "import-legacy"):
        t = d["team"]
        head = {"add": f"created team {t['id']} ({t['name']})",
                "add-member": f"added member {d.get('member', {}).get('id')} to team {t['id']}",
                "remove-member": f"removed member {d.get('removed', {}).get('id')} from team {t['id']}",
                "import-legacy": f"imported team.json as team {t['id']} ({len(t['members'])} member(s))"}[action]
        return "\n".join([head] + _render_team_warnings(d))
    return _render_team(d)


def _is_uuid(value) -> bool:
    try:
        validate_uuid(value)
    except AsError:
        return False
    return True


def _team_workspace(ns) -> str:
    """--workspace PATH is used as is; otherwise the workspace found from the current directory."""
    return ns.workspace if ns.workspace else workspace.resolve(os.getcwd())["path"]


def _pick_def(ws, ref, verb) -> str:
    ids = teamdefs.list_ids(ws)
    if not ids:
        if ref is None:
            raise AsError(BAD_REQUEST, f"team {verb} needs --team ID")
        raise AsError(TEAM_NOT_FOUND, f"No team {ref!r}.", remediation="run agent-studio team add --name NAME")
    return teamdefs._select(ws, ref)[1]


def _definition_start_args(ws, ns) -> dict:
    fid = _pick_def(ws, ns.team, "start")
    team = teamdefs.load(ws, fid)
    problems = teamdefs.validate(ws, team, fid)
    if not problems and not team.get("members"):
        problems = [{"path": "members", "message": "the team has no members"}]
    if problems:
        raise teamdefs._invalid(fid, problems)
    roster = []
    for m in team["members"]:
        item = {"memberId": m["id"], "displayName": m["name"], "providerId": m["provider"], "role": m["role"]}
        for k in ("model", "reasoning"):
            if m.get(k):
                item[k] = m[k]
        if m.get("canAddTickets") is not None:
            item["canAddTickets"] = bool(m["canAddTickets"])
        roster.append(item)
    return {"workspace": ws, "name": ns.name or team["name"], "teamDefId": fid, "roster": roster}


def _render_team_status(d: dict) -> str:
    team = d["team"]
    if team is None:
        return "team {}: not running".format(d.get("_ref") or "")
    lines = [f"{team['teamDefId'] or team['id']} ({team['name']}): {team['status']}"]
    for m in d["members"]:
        line = f"{m['name']} [{m['provider']}/{m['role']}] {m['availability']}"
        if m["assignment"]:
            line += f"  {m['assignment']['id']} {m['assignment']['status']}"
        lines.append(line)
    return "\n".join(lines)


def _team_status_command(argv, pretty):
    p = _Parser(prog="agent-studio", add_help=False)
    for o in ("--team", "--workspace"):
        p.add_argument(o)
    p.add_argument("--json", action="store_true")
    ref = None
    try:
        ns = p.parse_args(argv[2:])
        ref = ns.team
        if ns.team and _is_uuid(ns.team):
            args = {"teamId": ns.team}
        else:
            ws = _team_workspace(ns)
            ref = _pick_def(ws, ns.team, "status")
            args = {"workspace": ws, "teamDefId": ref}
        resp = dispatch.handle_request({"protocol": PROTOCOL, "command": "team.status", "args": args},
                                       require_id=False)
        if resp.get("ok") and resp["data"]["team"] is None:
            resp["data"]["_ref"] = ref
    except AsError as e:
        err = e.to_error()
        if e.data is not None:
            err["data"] = e.data
        resp = envelope(None, False, error=err)
    if resp.get("ok") and "--json" in argv:
        resp["data"].pop("_ref", None)
    return emit(resp, _render_team_status, "--json" in argv, pretty)


def _local_command(cmd, argv, pretty):
    """init / workspace list run in the CLI process (serve/request use dispatch workspace.init / workspace.list, same functions). Returns None if not ours."""
    if cmd == "team" and argv[1:2] == ["status"]:
        return _team_status_command(argv, pretty)
    if cmd == "team" and argv[1:2] and argv[1] in teamcli.ACTIONS:
        return teamcli.run(argv, pretty)
    if cmd == "team" and argv[1:2] and argv[1] in storycli.ACTIONS:
        return storycli.run(argv, pretty)
    if cmd == "team" and argv[1:2] and argv[1] in _TEAM_LOCAL:
        return _team_command(argv, pretty)
    if cmd == "ticket" and argv[1:2] and argv[1] in boardcli.TICKET_ACTIONS:
        return boardcli.run(argv, pretty)
    if cmd == "board" and argv[1:2] and argv[1] in boardcli.BOARD_ACTIONS:
        return boardcli.run(argv, pretty)
    if cmd == "init":
        render, run = _render_init, lambda ns: workspace.init(ns.path or os.getcwd(), ns.name)
        opts = ("--name", "--path")
        rest = argv[1:]
    elif cmd == "workspace" and argv[1:2] == ["list"]:
        render, run = _render_workspaces, lambda ns: workspace.list_workspaces()
        opts = ()
        rest = argv[2:]
    else:
        return None
    p = _Parser(prog="agent-studio", add_help=False)
    for o in opts:
        p.add_argument(o)
    p.add_argument("--json", action="store_true")
    json_flag = "--json" in rest
    try:
        ns = p.parse_args(rest)
        resp = envelope(None, True, data=run(ns))
    except AsError as e:
        resp = envelope(None, False, error=e.to_error())
    return emit(resp, render, json_flag, pretty)


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
    tk.add_argument("--workspace")
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
    wf_p.add_argument("--workspace")
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
    board_p = sub.add_parser("board", add_help=False)
    board_p.add_argument("action", choices=["resume"])
    board_p.add_argument("--workspace")
    board_p.add_argument("--agent")
    board_p.add_argument("--member")
    board_p.add_argument("--all", action="store_true")
    board_p.add_argument("--key")
    board_p.add_argument("--timeout-ms", type=int, default=dispatch.DEFAULT_TIMEOUT_MS)
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
            if ns.workspace:
                req["args"]["workspace"] = ns.workspace
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
            if ns.workspace:
                args["workspace"] = ns.workspace
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
            if ns.workspace:
                req["args"]["workspace"] = ns.workspace
            req["_wait_workflow"] = ns.wait
        else:
            if not ns.workflow:
                raise AsError(BAD_REQUEST, f"workflow {ns.action} needs --workflow ID")
            req.update(command=f"workflow.{ns.action}", args={"workflowRunId": ns.workflow})
            if ns.action in ("cancel", "retry"):
                req.update(idempotencyKey=ns.key or str(uuid.uuid4()), timeoutMs=ns.timeout_ms)
    elif ns.cmd == "board":
        if not ns.workspace:
            raise AsError(BAD_REQUEST, "board resume needs --workspace PATH")
        args = {"workspace": ns.workspace, "all": ns.all}
        if ns.agent:
            args["agentId"] = ns.agent
        if ns.member:
            args["member"] = ns.member
        req.update(command="board.resume", args=args, idempotencyKey=ns.key or str(uuid.uuid4()),
                   timeoutMs=ns.timeout_ms)
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
            if ns.agent and ns.team:
                raise AsError(BAD_REQUEST, "team start: --team cannot be combined with --agent")
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
            if ns.agent and not ns.workspace:
                raise AsError(BAD_REQUEST, "team start needs --workspace")
            if ns.agent:
                args = {"workspace": ns.workspace}
                if roster:
                    args["roster"] = roster
                if ns.name:
                    args["name"] = ns.name
                req.update(command="team.start", args=args)
            else:
                ws = _team_workspace(ns)
                if not teamdefs.list_ids(ws):
                    remediation = ("run agent-studio team import-legacy" if teamdefs.legacy_exists(ws)
                                   else "run agent-studio team add --name NAME")
                    raise AsError(TEAM_NOT_FOUND, "No team definition in this workspace.", remediation=remediation)
                req.update(command="team.start", args=_definition_start_args(ws, ns))
        elif ns.action == "stop" and (ns.team is None or not _is_uuid(ns.team)):
            ws = _team_workspace(ns)
            req.update(command="team.stop", args={"workspace": ws, "teamDefId": _pick_def(ws, ns.team, "stop")})
        else:
            if not ns.team:
                raise AsError(BAD_REQUEST, f"team {ns.action} needs --team ID")
            team_id = ns.team
            if ns.action == "attach" and not _is_uuid(team_id):
                team_id = teamcli.running_team_id(ns)
            req.update(command=f"team.{ns.action}", args={"teamId": team_id})
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
    local = _local_command(cmd, argv, pretty)
    if local is not None:
        return local
    if cmd == "serve":
        return serve.run()
    if cmd == "mcp":
        from . import mcpserver
        return mcpserver.serve()
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
        return _emit(envelope(None, False, data=e.data, error=e.to_error()), pretty)
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
