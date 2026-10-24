"""The generic board model (P04-S07): config-driven statuses, phases as data, generic tickets.

A board is data. The statuses come from <workspace>/.agent-studio/board.json; every workspace board has a
board_state row and a protected default phase, created together on first use; every ticket belongs to a phase.
Statuses are validated here, never by SQL CHECKs, so two boards with different status sets run on the same
code and schema. Nothing in this module names a role, a workflow, a status id or a host command; rules (S09)
carry all of that. The coordinator is the only writer; every ticket change appends a ticket_events row.
"""
from __future__ import annotations

import json
import os
import re

from .protocol import AsError, BOARD_CONFIG_INVALID, BOARD_STATUS_UNKNOWN, TICKET_DEPENDENCY_CYCLE, \
    TICKET_NOT_FOUND, TICKET_TRANSITION_INVALID
from .state import utcnow
from .store import new_id

CONFIG_DIR = ".agent-studio"
CONFIG_NAME = "board.json"
CONFIG_VERSION = 2
STATUS_KINDS = ("initial", "done", "closed")
TERMINAL_KINDS = ("done", "closed")
DEFAULT_PHASE_SLUG = "default"
DEFAULT_PHASE_NAME = "Default"
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
FIELD_TYPES = ("text", "number")
EVENTS_SHOWN = 50

_TOP_KEYS = ("version", "statuses", "ticketFields", "rules")
_STATUS_KEYS = ("id", "kind", "name")
_FIELD_KEYS = ("id", "name", "type", "required")


def _invalid(problems):
    text = "; ".join(f"{path}: {message}" for path, message in problems[:10])
    return AsError(BOARD_CONFIG_INVALID, f"{CONFIG_NAME} is invalid: {text}",
                   data={"problems": [{"path": p, "message": m} for p, m in problems]})


def _slug(value, path, problems):
    if not isinstance(value, str) or not SLUG_RE.match(value):
        problems.append((path, "must be a slug (lowercase letters, digits, '-'; at most 64 characters)"))
        return None
    return value


def load_config(workspace: str) -> dict:
    """Read and validate <workspace>/.agent-studio/board.json (§D). -> the normalized board model."""
    path = os.path.join(workspace, CONFIG_DIR, CONFIG_NAME)
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except FileNotFoundError:
        raise AsError(BOARD_CONFIG_INVALID, f"{workspace} has no {CONFIG_DIR}/{CONFIG_NAME}; a board is configured "
                                            "per workspace.", remediation=f"create {CONFIG_DIR}/{CONFIG_NAME} "
                                            "(see phases/phase-04/README.md section D)")
    except (OSError, ValueError) as e:
        raise _invalid([("root", f"cannot be read or is not valid JSON: {e}")])
    if not isinstance(raw, dict):
        raise _invalid([("root", "must be a JSON object")])
    problems = []
    unknown = sorted(set(raw) - set(_TOP_KEYS))
    if unknown:
        problems.append(("root", f"unknown keys {', '.join(unknown)}; the P03 software-board shape is gone "
                                 f"(expected version {CONFIG_VERSION} with {', '.join(k for k in _TOP_KEYS if k != 'version')})"))
    if raw.get("version") != CONFIG_VERSION:
        problems.append(("version", f"must be {CONFIG_VERSION}"))
    statuses = raw.get("statuses")
    if not isinstance(statuses, list) or not statuses:
        problems.append(("statuses", "must be a non-empty list"))
        statuses = []
    seen, initial, done, closed = [], [], [], []
    for i, entry in enumerate(statuses):
        path = f"statuses[{i}]"
        if not isinstance(entry, dict):
            problems.append((path, "must be an object"))
            continue
        unknown = sorted(set(entry) - set(_STATUS_KEYS))
        if unknown:
            problems.append((path, f"unknown keys {', '.join(unknown)}"))
        ident = _slug(entry.get("id"), f"{path}.id", problems)
        if ident is not None:
            if ident in [s["id"] for s in seen]:
                problems.append((f"{path}.id", f"duplicate status id {ident!r}"))
            else:
                seen.append({"id": ident, "kind": entry.get("kind"),
                             "name": entry.get("name") if isinstance(entry.get("name"), str) else ident})
        kind = entry.get("kind")
        if kind is not None:
            if kind == "initial":
                initial.append(ident or f"statuses[{i}]")
            elif kind == "done":
                done.append(ident or f"statuses[{i}]")
            elif kind == "closed":
                closed.append(ident or f"statuses[{i}]")
            else:
                problems.append((f"{path}.kind", f"must be one of {list(STATUS_KINDS)} or omitted"))
    if len(initial) != 1:
        problems.append(("statuses", f"exactly one status must have kind 'initial' (found {len(initial)})"))
    if not done:
        problems.append(("statuses", "at least one status must have kind 'done'"))
    fields = raw.get("ticketFields", [])
    if not isinstance(fields, list):
        problems.append(("ticketFields", "must be a list"))
        fields = []
    field_ids = []
    for i, field in enumerate(fields):
        path = f"ticketFields[{i}]"
        if not isinstance(field, dict):
            problems.append((path, "must be an object"))
            continue
        unknown = sorted(set(field) - set(_FIELD_KEYS))
        if unknown:
            problems.append((path, f"unknown keys {', '.join(unknown)}"))
        ident = _slug(field.get("id"), f"{path}.id", problems)
        if ident is not None:
            if ident in field_ids:
                problems.append((f"{path}.id", f"duplicate field id {ident!r}"))
            else:
                field_ids.append(ident)
        if field.get("type", "text") not in FIELD_TYPES:
            problems.append((f"{path}.type", f"must be one of {list(FIELD_TYPES)}"))
        if "required" in field and not isinstance(field["required"], bool):
            problems.append((f"{path}.required", "must be true or false"))
    rules = raw.get("rules", [])
    if not isinstance(rules, list):
        problems.append(("rules", "must be a list"))
    if problems:
        raise _invalid(problems)
    by_id = {s["id"]: s for s in seen}
    return {"version": CONFIG_VERSION, "statuses": seen, "byId": by_id, "initial": initial[0],
            "terminal": frozenset(s["id"] for s in seen if s["kind"] in TERMINAL_KINDS),
            "ticketFields": fields, "rules": rules}


def config_status_ids(config: dict) -> list:
    return [s["id"] for s in config["statuses"]]


# ---- board state and phases ------------------------------------------------------------------------------

def _row_to_json(row) -> dict:
    out = {}
    for key in row.keys():
        value = row[key]
        if key.endswith("_json"):
            key = key[:-5]
            value = json.loads(value) if value is not None else None
        head, *rest = key.split("_")
        out[head + "".join(p.capitalize() for p in rest)] = value
    return out


def _phase_row(tx, workspace, slug):
    return tx.conn.execute("SELECT * FROM phases WHERE workspace = ? AND slug = ?", (workspace, slug)).fetchone()


def ensure_board(tx, workspace: str) -> dict:
    """Find the workspace's board row and default phase, creating both in this transaction on first use."""
    row = tx.conn.execute("SELECT * FROM board_state WHERE workspace = ?", (workspace,)).fetchone()
    if row is None:
        tx.conn.execute("INSERT INTO board_state (workspace, current_phase_id, created_at, updated_at) "
                        "VALUES (?, NULL, ?, ?)", (workspace, utcnow(), utcnow()))
    phase = _phase_row(tx, workspace, DEFAULT_PHASE_SLUG)
    if phase is None:
        tx.conn.execute("INSERT INTO phases (id, workspace, slug, name, description, position, status, "
                        "created_at, updated_at) VALUES (?, ?, ?, ?, NULL, 0, 'open', ?, ?)",
                        (new_id(), workspace, DEFAULT_PHASE_SLUG, DEFAULT_PHASE_NAME, utcnow(), utcnow()))
        phase = _phase_row(tx, workspace, DEFAULT_PHASE_SLUG)
    return {"board": dict(row) if row is not None else {"workspace": workspace, "currentPhaseId": None},
            "defaultPhase": _phase_row_json(phase)}


def _phase_row_json(row) -> dict:
    return {"id": row["id"], "slug": row["slug"], "name": row["name"], "description": row["description"],
            "position": row["position"], "status": row["status"]}


def effective_phase(conn, workspace: str) -> dict:
    """The current phase: the board's pointer when set, else the default phase (§D)."""
    board = conn.execute("SELECT current_phase_id FROM board_state WHERE workspace = ?", (workspace,)).fetchone()
    if board is not None and board["current_phase_id"] is not None:
        row = conn.execute("SELECT * FROM phases WHERE id = ?", (board["current_phase_id"],)).fetchone()
        if row is not None:
            return _phase_row_json(row)
    default = conn.execute("SELECT * FROM phases WHERE workspace = ? AND slug = ?",
                           (workspace, DEFAULT_PHASE_SLUG)).fetchone()
    return _phase_row_json(default) if default is not None else \
        {"id": None, "slug": DEFAULT_PHASE_SLUG, "name": DEFAULT_PHASE_NAME, "description": None,
         "position": 0, "status": "open"}


# ---- tickets ---------------------------------------------------------------------------------------------

def _ticket_event(conn, ticket_id: str, name: str, actor: str, from_status, to_status, payload: dict) -> None:
    conn.execute("INSERT INTO ticket_events (ticket_id, at, actor, name, from_status, to_status, payload_json) "
                 "VALUES (?, ?, ?, ?, ?, ?, ?)",
                 (ticket_id, utcnow(), actor, name, from_status, to_status,
                  json.dumps(payload, ensure_ascii=True, sort_keys=True, separators=(",", ":"))))


def get_ticket(conn, workspace: str, key: str) -> dict:
    row = conn.execute("SELECT * FROM tickets WHERE workspace = ? AND key = ?", (workspace, key)).fetchone()
    if row is None:
        raise AsError(TICKET_NOT_FOUND, "Ticket does not exist.", data={"key": key})
    return dict(row)


def _ticket_json(conn, row) -> dict:
    out = _row_to_json(row)
    phase = conn.execute("SELECT slug, name FROM phases WHERE id = ?", (row["phase_id"],)).fetchone()
    out["phase"] = phase["slug"] if phase else None
    out["phaseName"] = phase["name"] if phase else None
    return out


def next_key(conn, workspace: str) -> str:
    numbers = [int(r[0][2:]) for r in conn.execute(
        "SELECT key FROM tickets WHERE workspace = ? AND key GLOB 'T-[0-9]*'", (workspace,)) if r[0][2:].isdigit()]
    return f"T-{max(numbers, default=0) + 1:03d}"


def ticket_add(tx, workspace: str, args: dict) -> dict:
    config = load_config(workspace)
    ensure_board(tx, workspace)
    phase = _phase_row(tx, workspace, DEFAULT_PHASE_SLUG)
    ident, key, status = new_id(), next_key(tx.conn, workspace), config["initial"]
    now = utcnow()
    tx.conn.execute("INSERT INTO tickets (id, workspace, key, title, body, phase_id, status, priority, assignee, "
                    "lease_until, created_by_member, created_by_assignment, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)",
                    (ident, workspace, key, args["title"], args.get("body"), phase["id"], status,
                     args["priority"], args.get("createdByMember"), args.get("createdByAssignment"), now, now))
    _ticket_event(tx.conn, ident, "ticket.created", "operator", None, status,
                  {"ticketId": ident, "key": key, "title": args["title"], "phase": phase["slug"],
                   "priority": args["priority"]})
    return {"ticket": _ticket_json(tx.conn, tx.conn.execute("SELECT * FROM tickets WHERE id = ?", (ident,)).fetchone()),
            "phase": _phase_row_json(phase)}


def ticket_move(tx, workspace: str, args: dict) -> dict:
    config = load_config(workspace)
    ticket = get_ticket(tx.conn, workspace, args["key"])
    to = args["to"]
    if to not in config["byId"]:
        raise AsError(BOARD_STATUS_UNKNOWN, f"Status {to!r} is not on this board.",
                      data={"key": ticket["key"], "status": to, "statuses": config_status_ids(config)})
    if to == ticket["status"]:
        raise AsError(TICKET_TRANSITION_INVALID, f"Ticket {ticket['key']} is already in status {to!r}.",
                      data={"key": ticket["key"], "from": ticket["status"], "to": to})
    if ticket["status"] in config["terminal"] and not args.get("force"):
        raise AsError(TICKET_TRANSITION_INVALID, f"Ticket {ticket['key']} is in the terminal status "
                                                 f"{ticket['status']!r}; moving it needs --force.",
                      data={"key": ticket["key"], "from": ticket["status"], "to": to},
                      remediation="pass --force to move a finished ticket explicitly")
    tx.conn.execute("UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?", (to, utcnow(), ticket["id"]))
    _ticket_event(tx.conn, ticket["id"], "ticket.moved", "operator", ticket["status"], to,
                  {"ticketId": ticket["id"], "key": ticket["key"], "from": ticket["status"], "to": to,
                   "reason": args.get("reason"), "force": bool(args.get("force")) and ticket["status"] in config["terminal"]})
    return {"ticket": _ticket_json(tx.conn, tx.conn.execute("SELECT * FROM tickets WHERE id = ?",
                                                            (ticket["id"],)).fetchone()),
            "from": ticket["status"]}


# ---- dependencies -----------------------------------------------------------------------------------------

def _blockers(conn, ticket_id: str) -> list:
    return [r[0] for r in conn.execute("SELECT blocked_by_ticket_id FROM ticket_deps WHERE ticket_id = ?",
                                       (ticket_id,))]


def _cycle(conn, start: str, target: str) -> bool:
    pending, seen = [target], set()
    while pending:
        current = pending.pop()
        if current == start:
            return True
        if current not in seen:
            seen.add(current)
            pending.extend(_blockers(conn, current))
    return False


def ticket_depend(tx, workspace: str, args: dict) -> dict:
    ticket = get_ticket(tx.conn, workspace, args["key"])
    on, remove = list(dict.fromkeys(args.get("on", []))), list(dict.fromkeys(args.get("remove", [])))
    requested = [get_ticket(tx.conn, workspace, key) for key in on + remove]
    existing = set(_blockers(tx.conn, ticket["id"]))
    to_add = [t for t in requested if t["key"] in on and t["id"] not in existing]
    for other in to_add:
        if other["id"] == ticket["id"]:
            raise AsError(TICKET_DEPENDENCY_CYCLE, "A ticket cannot depend on itself.",
                          data={"key": ticket["key"], "cycle": [ticket["key"]]})
        if _cycle(tx.conn, ticket["id"], other["id"]):
            raise AsError(TICKET_DEPENDENCY_CYCLE, "Ticket dependency would form a cycle.",
                          data={"key": ticket["key"], "cycle": sorted({t["key"] for t in requested})})
    for other in to_add:
        tx.conn.execute("INSERT INTO ticket_deps (ticket_id, blocked_by_ticket_id) VALUES (?, ?)",
                        (ticket["id"], other["id"]))
    removed = [t["id"] for t in requested if t["key"] in remove and t["id"] in existing]
    if removed:
        tx.conn.executemany("DELETE FROM ticket_deps WHERE ticket_id = ? AND blocked_by_ticket_id = ?",
                            [(ticket["id"], ident) for ident in removed])
    if not to_add and not removed:
        return {"ticket": _ticket_json(tx.conn, tx.conn.execute("SELECT * FROM tickets WHERE id = ?",
                                                                (ticket["id"],)).fetchone()),
                "dependsOn": _dep_keys(tx.conn, ticket["id"])}
    keys = _dep_keys(tx.conn, ticket["id"])
    _ticket_event(tx.conn, ticket["id"], "ticket.depends", "operator", ticket["status"], ticket["status"],
                  {"ticketId": ticket["id"], "key": ticket["key"], "on": keys})
    return {"ticket": _ticket_json(tx.conn, tx.conn.execute("SELECT * FROM tickets WHERE id = ?",
                                                            (ticket["id"],)).fetchone()), "dependsOn": keys}


def _dep_keys(conn, ticket_id: str) -> list:
    return [r[0] for r in conn.execute(
        "SELECT t.key FROM ticket_deps d JOIN tickets t ON t.id = d.blocked_by_ticket_id "
        "WHERE d.ticket_id = ? ORDER BY t.key", (ticket_id,))]


# ---- read-only queries ------------------------------------------------------------------------------------

def ticket_detail(conn, workspace: str, key: str) -> dict:
    config = load_config(workspace)
    ticket = get_ticket(conn, workspace, key)
    deps = _dep_keys(conn, ticket["id"])
    dependents = [r[0] for r in conn.execute(
        "SELECT t.key FROM ticket_deps d JOIN tickets t ON t.id = d.ticket_id "
        "WHERE d.blocked_by_ticket_id = ? ORDER BY t.key", (ticket["id"],))]
    events = conn.execute("SELECT * FROM (SELECT * FROM ticket_events WHERE ticket_id = ? ORDER BY id DESC LIMIT ?) "
                          "ORDER BY id", (ticket["id"], EVENTS_SHOWN)).fetchall()
    return {"workspace": workspace, "ticket": _ticket_json(conn, conn.execute(
        "SELECT * FROM tickets WHERE id = ?", (ticket["id"],)).fetchone()),
        "dependsOn": deps, "dependents": dependents,
        "events": [{"id": e["id"], "at": e["at"], "actor": e["actor"], "name": e["name"],
                    "from": e["from_status"], "to": e["to_status"], "payload": json.loads(e["payload_json"])}
                   for e in events],
        "statuses": config_status_ids(config)}


def ticket_list(conn, workspace: str, status=None) -> dict:
    config = load_config(workspace)
    if status is not None and status not in config["byId"]:
        raise AsError(BOARD_STATUS_UNKNOWN, f"Status {status!r} is not on this board.",
                      data={"status": status, "statuses": config_status_ids(config)})
    clauses, params = ["workspace = ?"], [workspace]
    if status is not None:
        clauses.append("status = ?")
        params.append(status)
    rows = conn.execute("SELECT * FROM tickets WHERE " + " AND ".join(clauses) +
                        " ORDER BY priority, created_at, key", params).fetchall()
    return {"workspace": workspace, "statuses": config_status_ids(config), "status": status,
            "tickets": [_ticket_json(conn, r) for r in rows]}


def board_show(conn, workspace: str) -> dict:
    config = load_config(workspace)
    columns = []
    for entry in config["statuses"]:
        rows = conn.execute("SELECT * FROM tickets WHERE workspace = ? AND status = ? "
                            "ORDER BY priority, created_at, key", (workspace, entry["id"])).fetchall()
        columns.append({"status": entry["id"], "kind": entry["kind"], "title": entry["name"],
                        "count": len(rows), "tickets": [_ticket_json(conn, r) for r in rows]})
    return {"workspace": workspace, "currentPhase": effective_phase(conn, workspace),
            "phases": [_phase_row_json(r) for r in conn.execute(
                "SELECT * FROM phases WHERE workspace = ? ORDER BY position, slug", (workspace,))],
            "columns": columns}
