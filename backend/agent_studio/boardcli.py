"""`agent-studio ticket …` and `agent-studio board …` CLI (P04-S07/S08/S09).

CLI wrappers over the dispatch commands (ticket add/move/phase/apply/unblock/depend/show/list, board.show,
phase.*) plus the CLI-local `board rules check`: human text by default, the response envelope with --json,
errors as CODE: message on stderr. The workspace comes from --workspace or the current directory. Nothing
here names a status, a role or a host command; the board's configuration carries the statuses.
"""
from __future__ import annotations

from . import boardmodel
from .protocol import AsError, BAD_REQUEST, BOARD_CONFIG_INVALID, envelope
from .teamcli import _Fail, _call, _write_call

TICKET_ACTIONS = ("add", "move", "show", "list", "depend", "phase", "apply", "unblock", "retry")
BOARD_ACTIONS = ("show", "phase", "rules")
PHASE_ACTIONS = ("add", "list", "show", "edit", "close", "reopen", "remove", "set-current", "clear-current")
RULES_ACTIONS = ("check",)


def _workspace(ns):
    from . import cli
    return cli._team_workspace(ns)   # --workspace, else the workspace found at or above the current directory


def _parser(action, group="ticket"):
    from . import cli
    p = cli._Parser(prog="agent-studio", add_help=False)
    p.add_argument("--workspace")
    p.add_argument("--json", action="store_true")
    if group in ("board", "rules"):
        return p
    if group == "phase":
        if action == "add":
            p.add_argument("--id", required=True)
            p.add_argument("--name", required=True)
            p.add_argument("--description")
            p.add_argument("--before")
        elif action == "list":
            pass
        elif action == "edit":
            p.add_argument("phase")
            p.add_argument("--name")
            p.add_argument("--description")
        elif action == "remove":
            p.add_argument("phase")
            p.add_argument("--move-to", dest="move_to")
        elif action == "clear-current":
            pass
        else:  # show, close, reopen, set-current
            p.add_argument("phase")
        return p
    if action == "add":
        p.add_argument("--title", required=True)
        p.add_argument("--body")
        p.add_argument("--priority", type=int)
        p.add_argument("--phase")
    elif action == "move":
        p.add_argument("ticket_key")
        p.add_argument("--to", required=True)
        p.add_argument("--reason")
        p.add_argument("--force", action="store_true")
    elif action == "phase":
        p.add_argument("ticket_key")
        p.add_argument("phase")
    elif action == "apply":
        p.add_argument("ticket_key")
        p.add_argument("run")
    elif action == "unblock":
        p.add_argument("ticket_key")
        p.add_argument("--to")
    elif action == "retry":
        p.add_argument("ticket_key")
    elif action in ("show", "depend"):
        p.add_argument("ticket_key")
        if action == "depend":
            p.add_argument("--on", action="append", default=[])
            p.add_argument("--remove", action="append", default=[])
    elif action == "list":
        p.add_argument("--status")
        p.add_argument("--phase")
    return p


# ---- ticket commands -------------------------------------------------------------------------------------


def _add(ns):
    args = {"title": ns.title}
    if ns.body is not None:
        args["body"] = ns.body
    if ns.priority is not None:
        args["priority"] = ns.priority
    if ns.phase is not None:
        args["phase"] = ns.phase
    data = _write_call("ticket.add", dict(args, workspace=_workspace(ns)))
    t = data["ticket"]
    return data, lambda d: (f"added {t['key']} to phase {d['phase']['name']} "
                            f"(status {t['status']}, priority {t['priority']}): {t['title']}")


def _move(ns):
    data = _write_call("ticket.move", {"workspace": _workspace(ns), "key": ns.ticket_key, "to": ns.to,
                                       "force": ns.force, **({"reason": ns.reason} if ns.reason else {})})
    t = data["ticket"]
    return data, lambda d: f"{t['key']}: {d.get('from') or '?'} -> {t['status']}" + ("  (forced)" if ns.force else "")


def _ticket_phase(ns):
    data = _write_call("ticket.phase", {"workspace": _workspace(ns), "key": ns.ticket_key, "phase": ns.phase})
    t = data["ticket"]
    if not data.get("moved", True):
        return data, lambda d: f"{t['key']} is already in phase {t['phase']}"
    return data, lambda d: f"{t['key']}: {d.get('from')} -> {t['phase']}"


def _show(ns):
    data = _call("ticket.show", {"workspace": _workspace(ns), "key": ns.ticket_key})
    return data, lambda d: _render_detail(d)


def _list(ns):
    args = {"workspace": _workspace(ns)}
    if ns.status is not None:
        args["status"] = ns.status
    if ns.phase is not None:
        args["phase"] = ns.phase
    data = _call("ticket.list", args)
    return data, lambda d: _render_list(d)


def _ticket_apply(ns):
    data = _write_call("ticket.apply", {"workspace": _workspace(ns), "key": ns.ticket_key, "run": ns.run})
    t = data["ticket"]
    if not data.get("applied"):
        return data, lambda d: f"{t['key']}: run {d['ticket']['runId']} was already applied (no change)"
    outcome = f"{data['outcome']} -> {t['status']}" + (f"  ({data['reason']})" if data.get("reason") else "")
    return data, lambda d: f"{t['key']}: {outcome}  [rule {d['rule']}, round {d['rounds']}]"


def _ticket_unblock(ns):
    args = {"workspace": _workspace(ns), "key": ns.ticket_key}
    if ns.to:
        args["to"] = ns.to
    data = _write_call("ticket.unblock", args)
    return data, lambda d: f"{d['ticket']['key']}: unblocked -> {d['ticket']['status']}"


def _ticket_retry(ns):
    data = _write_call("ticket.retry", {"workspace": _workspace(ns), "key": ns.ticket_key})
    return data, lambda d: f"{d['ticket']['key']}: claim released -> {d['ticket']['status']}"


def _depend(ns):
    if not ns.on and not ns.remove:
        raise AsError(BAD_REQUEST, "ticket depend needs --on KEY or --remove KEY")
    data = _write_call("ticket.depend", {"workspace": _workspace(ns), "key": ns.ticket_key,
                                         "on": ns.on, "remove": ns.remove})
    t = data["ticket"]
    return data, lambda d: (f"{t['key']} depends on: {', '.join(d['dependsOn'])}"
                            if d["dependsOn"] else f"{t['key']} has no dependencies")


# ---- phase commands --------------------------------------------------------------------------------------


def _phase_add(ns):
    args = {"id": ns.id, "name": ns.name}
    if ns.description is not None:
        args["description"] = ns.description
    if ns.before is not None:
        args["before"] = ns.before
    data = _write_call("phase.add", dict(args, workspace=_workspace(ns)))
    p = data["phase"]
    return data, lambda d: f"added phase {p['slug']} ({p['name']}) at position {p['position']}"


def _phase_list(ns):
    data = _call("phase.list", {"workspace": _workspace(ns)})
    return data, lambda d: _render_phase_list(d)


def _phase_show(ns):
    data = _call("phase.show", {"workspace": _workspace(ns), "phase": ns.phase})
    return data, lambda d: _render_phase_detail(d)


def _phase_edit(ns):
    args = {"phase": ns.phase}
    if ns.name is not None:
        args["name"] = ns.name
    if ns.description is not None:
        args["description"] = ns.description
    data = _write_call("phase.edit", dict(args, workspace=_workspace(ns)))
    return data, lambda d: f"edited phase {d['phase']['slug']}"


def _phase_close(ns):
    data = _write_call("phase.close", {"workspace": _workspace(ns), "phase": ns.phase})
    suffix = " (was current; fell back to the default phase)" if data.get("clearedCurrent") else ""
    return data, lambda d: f"closed phase {d['phase']['slug']}{suffix}"


def _phase_reopen(ns):
    data = _write_call("phase.reopen", {"workspace": _workspace(ns), "phase": ns.phase})
    return data, lambda d: f"reopened phase {d['phase']['slug']}"


def _phase_remove(ns):
    args = {"phase": ns.phase}
    if ns.move_to is not None:
        args["moveTo"] = ns.move_to
    data = _write_call("phase.remove", dict(args, workspace=_workspace(ns)))
    moved = f", moved {len(data.get('movedTickets') or [])} ticket(s) to {data['moveTo']}" if data.get("moveTo") else ""
    return data, lambda d: f"removed phase {d['removed']}{moved}"


def _phase_set_current(ns):
    data = _write_call("phase.set-current", {"workspace": _workspace(ns), "phase": ns.phase})
    return data, lambda d: f"current phase: {d['currentPhase']['name']}" + ("" if data["changed"] else " (already)")


def _phase_clear_current(ns):
    data = _write_call("phase.clear-current", {"workspace": _workspace(ns)})
    return data, lambda d: f"current phase: {d['currentPhase']['name']} (default)"


def _rules_check(ns):
    workspace = _workspace(ns)
    config = boardmodel.load_config(workspace)
    problems = boardmodel.check_rules(workspace, config)
    if problems:
        raise AsError(BOARD_CONFIG_INVALID, f"board rules: {len(problems)} problem(s)",
                      data={"problems": problems})
    return {"workspace": workspace, "rules": len(config["rules"]), "problems": []}, \
        lambda d: f"board rules: OK ({d['rules']} rule(s))"


def _board_show(ns):
    data = _call("board.show", {"workspace": _workspace(ns)})
    return data, lambda d: _render_board(d)


# ---- human rendering --------------------------------------------------------------------------------------


def activity_text(t) -> str:
    """One short phrase for a ticket's activity: working (who), not started, finished, blocked."""
    a = t.get("activity") or {}
    state = a.get("state")
    if state == "working":
        return "working: " + (a.get("agent") or a.get("role") or "agent")
    if state == "not started":
        text = "not started" + (f" (waiting for {a['waitingFor']})" if a.get("waitingFor") else "")
        return text + (f" [{a['note']}]" if a.get("note") else "")
    if state == "blocked":
        return "blocked" + (f" [{a['note']}]" if a.get("note") else "")
    return state or ""


def _render_detail(d) -> str:
    t = d["ticket"]
    lines = [f"{t['key']}  {t['status']}  priority {t['priority']}  phase {t['phase']} ({t.get('phaseName')})",
             f"title: {t['title']}"]
    a = t.get("activity") or {}
    lines.append("activity: " + activity_text(t)
                 + (f"  workflow {a['workflow']}  run {a['run']}" if a.get("state") == "working" and a.get("run")
                    else ""))
    if t.get("body"):
        lines.append("body:")
        lines.extend("  " + line for line in t["body"].splitlines())
    if d["dependsOn"]:
        lines.append("depends on: " + ", ".join(d["dependsOn"]))
    if d["dependents"]:
        lines.append("dependents: " + ", ".join(d["dependents"]))
    if d["events"]:
        lines.append("events:")
        for e in d["events"]:
            arrow = f"{e['from']} -> {e['to']}" if e.get("to") else e["to"]
            why = (e.get("payload") or {}).get("reason") or (e.get("payload") or {}).get("message")
            lines.append(f"  {e['id']: >4}  {e['at']}  {e['actor']}  {e['name']}  {arrow}"
                         + (f"  [{why}]" if why else ""))
    lines.append("statuses: " + ", ".join(d["statuses"]))
    return "\n".join(lines)


def _render_list(d) -> str:
    if not d["tickets"]:
        scope = "".join(f" in {part} {value}" for part, value in (("status", d["status"]), ("phase", d["phase"]))
                        if value)
        return "no tickets" + scope
    return "\n".join(f"{t['key']}  P{t['priority']:<4}  {t['status']:<10}  {t['phase']:<10}  "
                     f"{activity_text(t):<22}  {t['title']}" for t in d["tickets"])


def _phase_header(p, current=None) -> str:
    marker = "  (current)" if (current is None and p.get("current")) or p.get("slug") == (current or {}).get("slug") \
        else ""
    state = f"  [{p['status']}]" if p["status"] != "open" else ""
    description = f"  - {p['description']}" if p.get("description") else ""
    return f"{p['slug']}  {p['name']}{state}{marker}{description}"


def _render_phase_list(d) -> str:
    lines = [f"phases of {d['workspace']}  (current: {d['currentPhase']['name']})"]
    for p in d["phases"]:
        counts = "  ".join(f"{status}:{n}" for status, n in p["counts"].items())
        lines.append(f"{_phase_header(p)}  tickets: {p['ticketCount']}  ({counts})")
    return "\n".join(lines)


def _render_phase_detail(d) -> str:
    p = d["phase"]
    lines = [_phase_header(p, d["currentPhase"].get("slug")),
             f"tickets: {p['ticketCount']}  (" + "  ".join(f"{s}:{n}" for s, n in p["counts"].items()) + ")"]
    for t in d["tickets"]:
        lines.append(f"  {t['key']}  P{t['priority']:<4}  {t['status']:<10}  {t['title']}")
    if not d["tickets"]:
        lines.append("  (no tickets)")
    return "\n".join(lines)


def _render_board(d) -> str:
    lines = [f"board {d['workspace']}  (current phase: {d['currentPhase']['name']})"]
    for phase in d["phases"]:
        lines.append("")
        lines.append(_phase_header(phase))
        if not phase["ticketCount"]:
            lines.append("  (no tickets)")
            continue
        for column in phase["columns"]:
            if not column["count"]:
                continue
            kind = f" [{column['kind']}]" if column["kind"] else ""
            lines.append(f"  {column['title']} ({column['count']}){kind}")
            for t in column["tickets"]:
                lines.append(f"    {t['key']}  P{t['priority']:<4}  {t['title']}  <{activity_text(t)}>")
    return "\n".join(lines)


_HANDLERS = {"add": _add, "move": _move, "show": _show, "list": _list, "depend": _depend, "phase": _ticket_phase,
             "apply": _ticket_apply, "unblock": _ticket_unblock, "retry": _ticket_retry}
_PHASE_HANDLERS = {"add": _phase_add, "list": _phase_list, "show": _phase_show, "edit": _phase_edit,
                   "close": _phase_close, "reopen": _phase_reopen, "remove": _phase_remove,
                   "set-current": _phase_set_current, "clear-current": _phase_clear_current}
_RULES_HANDLERS = {"check": _rules_check}
_BOARD_HANDLERS = {"show": _board_show}


def run(argv, pretty) -> int:
    """argv is the full argument list: ['ticket', ACTION, ...] or ['board', ACTION, ...] where ACTION may be
    'phase' or 'rules' followed by that group's action."""
    from . import cli
    group = argv[0]
    action = argv[1]
    if group == "board" and action == "phase":
        action = argv[2]
        handlers, rest, kind = _PHASE_HANDLERS, argv[3:], "phase"
    elif group == "board" and action == "rules":
        action = argv[2]
        handlers, rest, kind = _RULES_HANDLERS, argv[3:], "rules"
    elif group == "board":
        handlers, rest, kind = _BOARD_HANDLERS, argv[2:], "board"
    else:
        handlers, rest, kind = _HANDLERS, argv[2:], "ticket"
    render = None
    try:
        ns = _parser(action, kind).parse_intermixed_args(rest)
        data, render = handlers[action](ns)
        resp = envelope(None, True, data=data)
    except _Fail as f:
        resp = f.resp
    except AsError as e:
        err = e.to_error()
        if e.data is not None:
            err["data"] = e.data
        resp = envelope(None, False, data=e.data, error=err)
    return cli.emit(resp, render or (lambda d: ""), "--json" in argv, pretty)
