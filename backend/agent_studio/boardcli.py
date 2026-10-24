"""`agent-studio ticket add | move | show | list | depend` and `agent-studio board show` (P04-S07).

CLI wrappers over the dispatch commands (ticket.add / move / depend / show / list, board.show): human text
by default, the response envelope with --json, errors as CODE: message on stderr. The workspace comes from
--workspace or the current directory. Nothing here names a status, a role or a host command; the board's
configuration carries the statuses.
"""
from __future__ import annotations

from .protocol import AsError, BAD_REQUEST, envelope
from .teamcli import _Fail, _call, _write_call

TICKET_ACTIONS = ("add", "move", "show", "list", "depend")
BOARD_ACTIONS = ("show",)


def _workspace(ns):
    from . import cli
    if not ns.workspace:
        raise AsError(BAD_REQUEST, "give --workspace PATH (or run from a workspace)",
                      remediation="the board is configured per workspace, in .agent-studio/board.json")
    return cli._team_workspace(ns)


def _parser(action, group="ticket"):
    from . import cli
    p = cli._Parser(prog="agent-studio", add_help=False)
    p.add_argument("--workspace")
    p.add_argument("--json", action="store_true")
    if group != "ticket":
        return p
    if action == "add":
        p.add_argument("--title", required=True)
        p.add_argument("--body")
        p.add_argument("--priority", type=int)
    elif action == "move":
        p.add_argument("ticket_key")
        p.add_argument("--to", required=True)
        p.add_argument("--reason")
        p.add_argument("--force", action="store_true")
    elif action in ("show", "depend"):
        p.add_argument("ticket_key")
        if action == "depend":
            p.add_argument("--on", action="append", default=[])
            p.add_argument("--remove", action="append", default=[])
    elif action == "list":
        p.add_argument("--status")
    return p


# ---- commands ---------------------------------------------------------------------------------------------


def _add(ns):
    args = {"title": ns.title}
    if ns.body is not None:
        args["body"] = ns.body
    if ns.priority is not None:
        args["priority"] = ns.priority
    data = _write_call("ticket.add", dict(args, workspace=_workspace(ns)))
    t = data["ticket"]
    return data, lambda d: (f"added {t['key']} to phase {d['phase']['name']} "
                            f"(status {t['status']}, priority {t['priority']}): {t['title']}")


def _move(ns):
    data = _write_call("ticket.move", {"workspace": _workspace(ns), "key": ns.ticket_key, "to": ns.to,
                                       "force": ns.force, **({"reason": ns.reason} if ns.reason else {})})
    t = data["ticket"]
    return data, lambda d: f"{t['key']}: {d.get('from') or '?'} -> {t['status']}" + ("  (forced)" if ns.force else "")


def _show(ns):
    data = _call("ticket.show", {"workspace": _workspace(ns), "key": ns.ticket_key})
    return data, lambda d: _render_detail(d)


def _list(ns):
    data = _call("ticket.list", dict({"workspace": _workspace(ns)},
                                     **({"status": ns.status} if ns.status else {})))
    return data, lambda d: _render_list(d)


def _depend(ns):
    if not ns.on and not ns.remove:
        raise AsError(BAD_REQUEST, "ticket depend needs --on KEY or --remove KEY")
    data = _write_call("ticket.depend", {"workspace": _workspace(ns), "key": ns.ticket_key,
                                         "on": ns.on, "remove": ns.remove})
    t = data["ticket"]
    return data, lambda d: (f"{t['key']} depends on: {', '.join(d['dependsOn'])}"
                            if d["dependsOn"] else f"{t['key']} has no dependencies")


def _board_show(ns):
    data = _call("board.show", {"workspace": _workspace(ns)})
    return data, lambda d: _render_board(d)


# ---- human rendering --------------------------------------------------------------------------------------


def _render_detail(d) -> str:
    t = d["ticket"]
    lines = [f"{t['key']}  {t['status']}  priority {t['priority']}  phase {t['phase']} ({t.get('phaseName')})",
             f"title: {t['title']}"]
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
            lines.append(f"  {e['id']: >4}  {e['at']}  {e['actor']}  {e['name']}  {arrow}")
    lines.append("statuses: " + ", ".join(d["statuses"]))
    return "\n".join(lines)


def _render_list(d) -> str:
    if not d["tickets"]:
        return "no tickets" + (f" in status {d['status']}" if d.get("status") else "")
    return "\n".join(f"{t['key']}  P{t['priority']:<4}  {t['status']:<10}  {t['phase']:<10}  {t['title']}"
                     for t in d["tickets"])


def _render_board(d) -> str:
    lines = [f"board {d['workspace']}  (current phase: {d['currentPhase']['name']})"]
    for column in d["columns"]:
        lines.append("")
        kind = f" [{column['kind']}]" if column["kind"] else ""
        lines.append(f"{column['title']} ({column['count']}){kind}")
        for t in column["tickets"]:
            lines.append(f"  {t['key']}  P{t['priority']:<4}  {t['phase']:<10}  {t['title']}")
    return "\n".join(lines)


_HANDLERS = {"add": _add, "move": _move, "show": _show, "list": _list, "depend": _depend}
_BOARD_HANDLERS = {"show": _board_show}


def run(argv, pretty) -> int:
    """argv is the full argument list: ['ticket'|'board', ACTION, ...]."""
    from . import cli
    group, action = argv[0], argv[1]
    handlers = _BOARD_HANDLERS if group == "board" else _HANDLERS
    render = None
    try:
        ns = _parser(action, group).parse_intermixed_args(argv[2:])
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
