"""`agent-studio team ask | run-workflow | workflows | check | retry | blocked | resolve` (P04-S04).

Thin CLI wrappers over the existing dispatch commands (team.status, snapshot, task.direct, workflow.list /
validate / start / retry, assignment.resolve). Nothing here touches board code or sends a board.* / ticket.* command.
"""
from __future__ import annotations

import sys
import uuid

from . import PROTOCOL, dispatch, teams, watch
from .protocol import AsError, BAD_REQUEST, MEMBER_NOT_FOUND, TEAM_NOT_RUNNING, envelope

ACTIONS = ("ask", "run-workflow", "workflows", "check", "retry", "blocked", "resolve", "run-board",
           "stop-board", "switch-agent", "resume")
NOT_FOUND = "NOT_FOUND"
POLICIES = ("read_only", "workspace_write")
STUCK = ("waiting_input", "reconciling")


class _Fail(Exception):
    """A coordinator answer that is not ok; passed through to the output unchanged."""

    def __init__(self, resp):
        super().__init__(resp.get("error", {}).get("message"))
        self.resp = resp


def _call(command, args, write=False):
    req = {"protocol": PROTOCOL, "command": command, "args": args}
    if write:
        req.update(idempotencyKey=str(uuid.uuid4()), timeoutMs=dispatch.DEFAULT_TIMEOUT_MS)
    resp = dispatch.handle_request(req, require_id=False)
    if not resp.get("ok"):
        raise _Fail(resp)
    return resp["data"]


def _write_call(command, args):
    return _call(command, args, write=True)


def _parser(action):
    from . import cli
    p = cli._Parser(prog="agent-studio", add_help=False)
    for o in ("--team", "--workspace"):
        p.add_argument(o)
    p.add_argument("--json", action="store_true")
    if action == "ask":
        p.add_argument("--member")
        p.add_argument("--policy", default="read_only")
        p.add_argument("--wait", action="store_true")
        p.add_argument("--text-file")
        p.add_argument("text", nargs="?")
    elif action == "run-workflow":
        p.add_argument("--bind", action="append", default=[])
        p.add_argument("--wait", action="store_true")
        p.add_argument("--story")
        p.add_argument("--text-file")
        p.add_argument("name")
        p.add_argument("text", nargs="?")
    elif action == "check":
        p.add_argument("--bind", action="append", default=[])
        p.add_argument("name")
    elif action == "retry":
        p.add_argument("--workflow")
    elif action == "resolve":
        p.add_argument("--member")
        p.add_argument("--assignment")
        p.add_argument("--action", dest="resolve_action")
    elif action in ("run-board", "stop-board"):
        pass  # --team / --workspace / --json only
    elif action == "switch-agent":
        p.add_argument("--member", required=True)
        p.add_argument("--agent", required=True)
        p.add_argument("--cancel-active", action="store_true")
    elif action == "resume":
        p.add_argument("--member", required=True)
        p.add_argument("--agent", required=True)
    return p


def _running_team(ns, verb="ask"):
    """-> (team, members) of the running runtime team, found like `team status`; nothing is written."""
    from . import cli
    ref = ns.team
    if ref and cli._is_uuid(ref):
        args = {"teamId": ref}
    else:
        ws = cli._team_workspace(ns)
        ref = cli._pick_def(ws, ns.team, verb)
        args = {"workspace": ws, "teamDefId": ref}
    data = _call("team.status", args)
    team = data["team"]
    if team is None or team["status"] != "running":
        shown = (team or {}).get("teamDefId") or ref
        state = "not running" if team is None else team["status"]
        raise AsError(TEAM_NOT_RUNNING, f"Team {shown} is {state}.",
                      remediation=f"run agent-studio team start --team {shown}")
    return team, data["members"]


def running_team_id(ns) -> str:
    """The runtime team UUID of the running team named by ns.team (a definition id); for `team attach`."""
    try:
        team, _ = _running_team(ns)
    except _Fail as f:
        err = f.resp.get("error") or {}
        raise AsError(err.get("code") or BAD_REQUEST, err.get("message") or "team.status failed",
                      remediation=err.get("remediation"))
    return team["id"]


def _member(members, ref):
    row = teams.match_member(members, ref, keys=("agentId", "memberId"), name_key="name")
    if row is None:
        raise AsError(MEMBER_NOT_FOUND, f"No member {ref!r} in this team.",
                      remediation="members: " + ", ".join(m["name"] for m in members))
    return row


def _name_of(members, agent_id):
    for m in members:
        if m["agentId"] == agent_id:
            return m["name"]
    return agent_id


def _bind_args(items, members):
    from . import cli
    return {role: _member(members, who)["agentId"] for role, who in cli._bindings(items).items()}


def _result_text(assignment):
    res = (assignment or {}).get("result") or {}
    return res.get("finalText") or res.get("summary") or ""


def _follow(label, fn, *args):
    try:
        return fn(*args)
    except KeyboardInterrupt:
        sys.stderr.write(f"stopped watching; the {label} keeps running\n")
        raise


# ---- commands ---------------------------------------------------------------------------------------------

def _ask(ns):
    from . import cli
    if ns.policy not in POLICIES:
        raise AsError(BAD_REQUEST, f"--policy must be one of {list(POLICIES)}.")
    if not ns.member:
        raise AsError(BAD_REQUEST, "team ask needs --member NAME")
    text = cli._task_text(ns)
    team, members = _running_team(ns)
    who = _member(members, ns.member)
    receipt = _write_call("task.direct", {"teamId": team["id"], "agentId": who["agentId"], "policy": ns.policy,
                                          "text": text})
    if not ns.wait:
        return receipt, lambda d: f"asked {who['name']}: task {d['taskId']} assignment {d['assignmentId']}"
    sys.stderr.write(f"accepted: task {receipt['taskId']} assignment {receipt['assignmentId']}\n")
    detail = _follow("task", watch.follow, receipt["assignmentId"], receipt["taskId"])
    data = dict(detail, receipt=receipt)

    def render(d):
        a = next((x for x in d["assignments"] if x["id"] == d["receipt"]["assignmentId"]), None) or {}
        return "\n".join([f"{who['name']} [{who['provider']}/{who['role']}]: {a.get('status')}", _result_text(a)])
    return data, render


def _validate(team, members, ns):
    return _call("workflow.validate", {"teamId": team["id"], "definition": ns.name,
                                       "bindings": _bind_args(ns.bind, members)})


def _role_hint(fail, members):
    err = fail.resp.get("error") or {}
    if err.get("code") in ("ROLE_UNBOUND", "ROLE_AMBIGUOUS"):
        role = (fail.resp.get("data") or {}).get("role", "ROLE")
        ids = (fail.resp.get("data") or {}).get("agentIds")
        names = [_name_of(members, i) for i in ids] if ids else [m["name"] for m in members]
        err["remediation"] = f"pass --bind {role}=<member>; candidates: {', '.join(names)}"
    return fail


def _binding_lines(bindings, members):
    return [f"{role} -> {_name_of(members, a if isinstance(a, str) else a['agentId'])}"
            for role, a in bindings.items()]


def _run_workflow(ns):
    from . import cli, storycli
    story = ns.story
    if story:
        if ns.text is not None or ns.text_file is not None:
            raise AsError(BAD_REQUEST, "--story replaces the task text; give neither TEXT nor --text-file")
        ws = storycli._Run(ns).ws
        text = storycli.story_prompt(ws, story)
        storycli.require_clean(ws)
        base = storycli.head(ws)
        ns.wait = True
    else:
        text = cli._task_text(ns)
    team, members = _running_team(ns)
    try:
        checked = _validate(team, members, ns)
    except _Fail as f:
        raise _role_hint(f, members)
    bindings = {role: b["agentId"] for role, b in checked["bindings"].items()}
    receipt = _write_call("workflow.start", {"teamId": team["id"], "definition": ns.name, "text": text,
                                             "bindings": bindings})
    lines = _binding_lines(receipt.get("bindings") or bindings, members)
    if not ns.wait:
        return receipt, lambda d: "\n".join([f"started workflow {d['workflowRunId']}"] + lines)
    sys.stderr.write(f"accepted: workflow {receipt['workflowRunId']} (base {receipt['baseCommit'][:12]})\n")
    detail = _follow("workflow", watch.follow_workflow, receipt["workflowRunId"])
    data = dict(detail, receipt=receipt)
    next_step = ""
    if story:
        key, state = storycli.save_run(ws, story, base, detail)
        status = detail["workflowRun"]["status"]
        asg = {a["id"]: a for a in detail.get("assignments", [])}
        out_text = ""
        for sa in detail.get("stageAttempts", []):
            if asg.get(sa.get("assignmentId")):
                out_text = _result_text(asg[sa["assignmentId"]])
        data.update(story=story, key=key, state=state, status=status, output=out_text)
        if status == "succeeded" and state["finalPassed"]:
            next_step = f"Approved - next: agent-studio team commit {story}"
        elif status != "succeeded":
            next_step = ("Not finished - fix and run again, or loop by hand with agent-studio team fix / qa / "
                         "final.")

    def render(d):
        asg = {a["id"]: a for a in d.get("assignments", [])}
        findings, last = [], ""
        for sa in d.get("stageAttempts", []):
            if sa.get("verdict"):
                findings = (sa["verdict"] or {}).get("findings") or []
            if asg.get(sa.get("assignmentId")):
                last = _result_text(asg[sa["assignmentId"]])
        out = list(lines) + [f"route: {d.get('route') or ''}", f"status: {d['workflowRun']['status']}"]
        if findings:
            out += ["last findings:"] + [f"- {f}" for f in findings]
        out += ["last stage summary:", last or "(none)"]
        return "\n".join(out + ([next_step] if next_step else []))
    return data, render


def _workflows(ns):
    team, _ = _running_team(ns)

    def render(d):
        lines = []
        for x in d["definitions"]:
            parts = [x["name"], "built-in" if x.get("builtin") else "project", x.get("description")]
            if x.get("errors"):
                parts.append(f"INVALID ({len(x['errors'])} error(s))")
            lines.append("  ".join(p for p in parts if p))
        return "\n".join(lines) or "no workflow definitions"
    return _call("workflow.list", {"teamId": team["id"]}), render


def _check(ns):
    team, members = _running_team(ns)
    data = _validate(team, members, ns)

    def render(d):
        lines = [f"{d['definition']}: OK  stages: {' -> '.join(s['id'] for s in d['stages'])}"]
        lines += [f"  {x}" for x in _binding_lines(d["bindings"], members)]
        lines += [f"  warning: {w.get('message')} ({w.get('path')})" for w in d.get("warnings") or []]
        return "\n".join(lines)
    return data, render


def _snapshot(team):
    return _call("snapshot", {"teamId": team["id"]})


def _retry(ns):
    team, _ = _running_team(ns)
    wf_id = ns.workflow
    if not wf_id:
        runs = [w for w in _snapshot(team).get("workflowRuns", []) if w.get("status") in ("running", "paused")]
        if not runs:
            raise AsError(NOT_FOUND, "No running or paused workflow for this team.")
        wf_id = max(runs, key=lambda w: w.get("createdAt") or "")["id"]
    data = _write_call("workflow.retry", {"workflowRunId": wf_id})
    return data, lambda d: (f"workflow {wf_id}: stage {d.get('stage')} retried "
                            f"(new assignment {d.get('newAssignmentId')})")


def _blocked_items(team, members):
    snap = _snapshot(team)
    agents = {g["id"]: g for g in snap.get("agents", [])}
    assignments = {a["id"]: a for a in snap.get("assignments", [])}
    attempts = snap.get("stageAttempts", [])
    wf_of = {sa["assignmentId"]: sa["workflowRunId"] for sa in attempts if sa.get("assignmentId")}
    chosen = {}
    for a in snap.get("assignments", []):
        if a["status"] in STUCK:
            chosen[a["id"]] = a
    for wf in snap.get("workflowRuns", []):
        if wf.get("status") != "paused":
            continue
        mine = [sa for sa in attempts if sa.get("workflowRunId") == wf["id"] and sa.get("assignmentId")]
        if mine:
            current = max(mine, key=lambda sa: sa.get("createdAt") or "")
            if current["assignmentId"] in assignments:
                chosen.setdefault(current["assignmentId"], assignments[current["assignmentId"]])
    items = []
    for a in chosen.values():
        g = agents.get(a.get("agentId"), {})
        res = a.get("result") or {}
        wf_id = wf_of.get(a["id"])
        wf = next((w for w in snap.get("workflowRuns", []) if w["id"] == wf_id), None)
        items.append({"assignmentId": a["id"], "status": a["status"], "agentId": a.get("agentId"),
                      "memberId": g.get("memberId"), "member": g.get("displayName") or _name_of(members, a.get("agentId")),
                      "role": g.get("role"), "workflowRunId": wf_id if wf and wf["status"] == "paused" else None,
                      "summary": res.get("summary") or "",
                      "attention": res.get("attention") or {}})
    return items


def _blocked(ns):
    team, members = _running_team(ns)
    items = _blocked_items(team, members)

    def render(d):
        if not d["items"]:
            return "No member is waiting for a decision."
        out = []
        for it in d["items"]:
            out.append(f"{it['member']} [{it['role']}] assignment {it['assignmentId']} {it['status']}"
                       + (f"  workflow {it['workflowRunId']} paused" if it["workflowRunId"] else ""))
            out.append(f"  summary: {it['summary'][:300]}")
            att = it.get("attention") or {}
            out += [f"  {att.get('kind')}: {x}" for x in att.get("items") or []]
            out += [f"  decide with:  agent-studio team resolve --member {it['member']} --action {act}"
                    for act in ("fail", "retry", "cancel")]
        return "\n".join(out)
    return {"items": items}, render


def _resolve(ns):
    if ns.resolve_action not in ("fail", "retry", "cancel"):
        raise AsError(BAD_REQUEST, "team resolve needs --action fail|retry|cancel")
    if bool(ns.member) == bool(ns.assignment):
        raise AsError(BAD_REQUEST, "give exactly one of --member or --assignment")
    team, members = _running_team(ns)
    if ns.member:
        who = _member(members, ns.member)
        item = next((i for i in _blocked_items(team, members) if i["agentId"] == who["agentId"]), None)
        if item is None:
            raise AsError(NOT_FOUND, f"No assignment of {who['name']} is waiting for a decision")
        assignment, name = item["assignmentId"], who["name"]
    else:
        assignment = ns.assignment
        snap_agent = next((a.get("agentId") for a in _snapshot(team).get("assignments", [])
                           if a["id"] == assignment), None)
        name = _name_of(members, snap_agent)
    data = _write_call("assignment.resolve", {"assignmentId": assignment, "action": ns.resolve_action})
    return data, lambda d: f"{name}: assignment {assignment} resolved with {ns.resolve_action}"


def _run_board(ns):
    from . import cli
    team, _members = _running_team(ns, "run-board")
    ws = cli._team_workspace(ns)
    data = _write_call("board.run", {"workspace": ws, "teamId": team["id"]})
    return data, lambda d: (f"board {ws} running (team {team['teamDefId'] or team['id']}, "
                            f"{d['rules']} rule(s)); stop with agent-studio team stop-board")


def _stop_board(ns):
    from . import cli
    ws = cli._team_workspace(ns)
    data = _write_call("board.stop", {"workspace": ws})
    return data, lambda d: f"board {ws} stopped (running work finishes; no new claims)"


def _switch_agent(ns):
    from . import cli
    ws = cli._team_workspace(ns)
    team, members = _running_team(ns, "switch-agent")
    who = _member(members, ns.member)
    if not team.get("teamDefId") or not who.get("memberId"):
        raise AsError(BAD_REQUEST, "Switching requires a team definition and member id.")
    args = {"workspace": ws, "teamDefId": team["teamDefId"], "memberId": who["memberId"], "agent": ns.agent}
    assignment = who.get("assignment")
    if assignment:
        if not ns.cancel_active:
            if not sys.stdin.isatty():
                raise AsError(BAD_REQUEST, f"Member has active assignment {assignment['id']}; confirmation required. "
                              "Run interactively or pass --cancel-active to confirm cancellation.")
            answer = input(f"Cancel assignment {assignment['id']} for {who['name']} and switch agent? [y/N] ")
            if answer.strip().lower() not in ("y", "yes"):
                return {"switched": False, "reason": "cancel declined"}, lambda d: "Switch cancelled; assignment continues."
        args.update(cancelActive=True, assignmentId=assignment["id"])
    data = _write_call("team.member.switch", args)
    return data, lambda d: (f"{who['name']}: cancelling assignment {d['assignmentId']}; switching to {d['pendingAgent']}"
                            if d.get("pendingAgent") else
                            f"{who['name']}: active agent is {d['activeAgent']} ({d['provider']})")


def _resume_agent(ns):
    team, members = _running_team(ns, "resume")
    who = _member(members, ns.member)
    if not team.get("teamDefId") or not who.get("memberId"):
        raise AsError(BAD_REQUEST, "Resuming an agent option requires a team definition and member id.")
    data = _write_call("team.member.resume", {"workspace": team["workspace"], "teamDefId": team["teamDefId"],
                                             "memberId": who["memberId"], "agent": ns.agent})
    return data, lambda d: (f"{who['name']}: quota hold cleared for {d['option']}"
                            if d["cleared"] else f"{who['name']}: {d['option']} has no quota hold")


_HANDLERS = {"ask": _ask, "run-workflow": _run_workflow, "workflows": _workflows, "check": _check,
             "retry": _retry, "blocked": _blocked, "resolve": _resolve, "run-board": _run_board,
             "stop-board": _stop_board, "switch-agent": _switch_agent, "resume": _resume_agent}


def run(argv, pretty) -> int:
    """argv is the full argument list: ['team', ACTION, ...]."""
    from . import cli
    action = argv[1]
    json_flag = "--json" in argv
    render = None
    try:
        ns = _parser(action).parse_intermixed_args(argv[2:])
        data, render = _HANDLERS[action](ns)
        resp = envelope(None, True, data=data)
    except _Fail as f:
        resp = f.resp
    except AsError as e:
        resp = envelope(None, False, data=e.data, error=e.to_error())
    except KeyboardInterrupt:
        return 130
    return cli.emit(resp, render or (lambda d: ""), json_flag, pretty)
