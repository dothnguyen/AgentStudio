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

from . import roles as rolefiles, workflowdef
from .protocol import AsError, BOARD_CONFIG_INVALID, BOARD_RULE_MISSING, BOARD_STATUS_UNKNOWN, FORBIDDEN, \
    PHASE_CLOSED, PHASE_EXISTS, PHASE_NOT_EMPTY, PHASE_NOT_FOUND, PHASE_PROTECTED, TICKET_BUSY, \
    TICKET_CAP_REACHED, TICKET_DEPENDENCY_CYCLE, TICKET_DUPLICATE, TICKET_NOT_FOUND, \
    TICKET_TRANSITION_INVALID
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
BLOCKED_STATUS = "blocked"            # reserved ticket status; boards may not configure an id like it
RUN_OUTCOMES = {"succeeded": "pass", "failed": "fail", "paused": "blocked", "cancelled": "blocked"}
FINISHED_RUN_STATES = tuple(RUN_OUTCOMES)
WORKSPACE_MODES = ("main", "worktree", "none")
BUILTIN_DEFINITIONS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "workflows")

_TOP_KEYS = ("version", "statuses", "ticketFields", "rules", "leaseSeconds", "baseBranch", "agentTicketStatus")
_STATUS_KEYS = ("id", "kind", "name")
_FIELD_KEYS = ("id", "name", "type", "required")
RULE_KEYS = ("when", "role", "workflow", "onPass", "onFail", "onBlocked", "maxRounds", "during", "cap",
             "requiresDeps", "workspace", "action", "priority", "onFailPriority")
RULE_ACTIONS = ("merge",)
DEFAULT_LEASE_SECONDS = 120
DEFAULT_BASE_BRANCH = "main"
BODY_LIMIT = 32 * 1024         # a ticket body is the next agent's task text, so it is capped
MCP_TICKET_CAP = 10            # per assignment, unless the call says otherwise (§G)
ACTIVE_ASSIGNMENT_STATES = ("queued", "claimed", "running", "waiting_input", "reconciling")


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
            if ident == BLOCKED_STATUS:
                problems.append((f"{path}.id", f"{BLOCKED_STATUS!r} is reserved for blocked tickets"))
            elif ident in [s["id"] for s in seen]:
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
        rules = []
    lease_seconds = raw.get("leaseSeconds", DEFAULT_LEASE_SECONDS)
    if not isinstance(lease_seconds, int) or isinstance(lease_seconds, bool) or lease_seconds < 1:
        problems.append(("leaseSeconds", f"must be an integer of at least 1"))
        lease_seconds = DEFAULT_LEASE_SECONDS
    base_branch = raw.get("baseBranch", DEFAULT_BASE_BRANCH)
    if not isinstance(base_branch, str) or not SLUG_RE.match(base_branch or ""):
        problems.append(("baseBranch", "must be a slug (a branch name like 'main')"))
        base_branch = DEFAULT_BASE_BRANCH
    known = {s["id"] for s in seen}

    def rule_status(value, path, required=True):
        if value is None:
            if required:
                problems.append((path, "is required"))
            return
        if not isinstance(value, str) or value not in known:
            problems.append((path, f"must be a status on this board (got {value!r})"))

    def rule_text(value, path, limit, slug=False):
        ok = isinstance(value, str) and bool(value.strip()) and len(value) <= limit
        if ok and slug and not SLUG_RE.match(value):
            ok = False
        if not ok:
            problems.append((path, f"must be {'a slug of at most ' if slug else 'text of at most '} "
                                   f"{limit} characters"))

    def rule_int(value, path, minimum):
        if not isinstance(value, int) or isinstance(value, bool) or value < minimum:
            problems.append((path, f"must be an integer of at least {minimum}"))

    rule_statuses = []
    for i, rule in enumerate(rules):
        path = f"rules[{i}]"
        if not isinstance(rule, dict):
            problems.append((path, "must be an object"))
            continue
        unknown = sorted(set(rule) - set(RULE_KEYS))
        if unknown:
            problems.append((path, f"unknown keys {', '.join(unknown)}"))
        when = rule.get("when")
        if not isinstance(when, dict) or set(when) != {"status"}:
            problems.append((f"{path}.when", 'must be {"status": ID}'))
        else:
            rule_status(when.get("status"), f"{path}.when.status")
            if isinstance(when.get("status"), str):
                rule_statuses.append(when["status"])
        for key, required in (("onPass", True), ("onFail", True), ("onBlocked", False)):
            if key in rule or required:
                rule_status(rule.get(key), f"{path}.{key}", required)
        has_action, has_pair = "action" in rule, "role" in rule or "workflow" in rule
        if has_action and has_pair:
            problems.append((path, "has action and role/workflow; a rule takes one or the other, never both"))
        if not has_action and not ("role" in rule and "workflow" in rule):
            problems.append((path, "needs action, or role and workflow"))
        if "role" in rule:
            rule_text(rule["role"], f"{path}.role", 200)
        if "workflow" in rule:
            rule_text(rule["workflow"], f"{path}.workflow", 64, slug=True)
        if "action" in rule:
            rule_text(rule["action"], f"{path}.action", 64)
        for key, minimum in (("maxRounds", 1), ("cap", 1), ("priority", 0), ("onFailPriority", 0)):
            if key in rule:
                rule_int(rule[key], f"{path}.{key}", minimum)
        if "requiresDeps" in rule and not isinstance(rule["requiresDeps"], bool):
            problems.append((f"{path}.requiresDeps", "must be true or false"))
        if "workspace" in rule and rule["workspace"] not in WORKSPACE_MODES:
            problems.append((f"{path}.workspace", f"must be one of {list(WORKSPACE_MODES)}"))
        if "during" in rule:
            rule_status(rule["during"], f"{path}.during")
    agent_status = raw.get("agentTicketStatus")
    if agent_status is not None:
        rule_status(agent_status, "agentTicketStatus")
        entry = next((s for s in seen if s["id"] == agent_status), None)
        if entry is not None and entry["kind"] in TERMINAL_KINDS:
            problems.append(("agentTicketStatus", "must not be a done or closed status"))
    duplicates = sorted({s for s in rule_statuses if rule_statuses.count(s) > 1})
    for slug in duplicates:
        problems.append(("rules", f"more than one rule for status {slug!r}"))
    if problems:
        raise _invalid(problems)
    by_id = {s["id"]: s for s in seen}
    return {"version": CONFIG_VERSION, "statuses": seen, "byId": by_id, "initial": initial[0],
            "terminal": frozenset(s["id"] for s in seen if s["kind"] in TERMINAL_KINDS),
            "ticketFields": fields, "rules": rules,
            "rulesByStatus": {r["when"]["status"]: r for r in rules},
            "leaseSeconds": lease_seconds, "baseBranch": base_branch,
            "agentStatus": agent_status or initial[0]}


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


def _phase_row(conn_or_tx, workspace, slug):
    conn = getattr(conn_or_tx, "conn", conn_or_tx)
    return conn.execute("SELECT * FROM phases WHERE workspace = ? AND slug = ?",
                        (workspace, slug)).fetchone()


def get_phase(conn, workspace: str, slug: str) -> dict:
    row = _phase_row(conn, workspace, slug)
    if row is None:
        raise AsError(PHASE_NOT_FOUND, f"Phase {slug!r} does not exist on this board.",
                      data={"phase": slug})
    return dict(row)


def ensure_board(tx, workspace: str) -> dict:
    """Find the workspace's board row and default phase, creating both in this transaction on first use."""
    row = tx.conn.execute("SELECT * FROM board_state WHERE workspace = ?", (workspace,)).fetchone()
    if row is None:
        tx.conn.execute("INSERT INTO board_state (workspace, current_phase_id, created_at, updated_at) "
                        "VALUES (?, NULL, ?, ?)", (workspace, utcnow(), utcnow()))
    phase = _phase_row(tx, workspace, DEFAULT_PHASE_SLUG)
    if phase is None:
        tx.create("phase", {"workspace": workspace, "slug": DEFAULT_PHASE_SLUG, "name": DEFAULT_PHASE_NAME,
                            "description": None, "position": 0})
        phase = _phase_row(tx, workspace, DEFAULT_PHASE_SLUG)
    return {"board": dict(row) if row is not None else {"workspace": workspace, "currentPhaseId": None},
            "defaultPhase": _phase_row_json(phase)}


def _phase_row_json(row) -> dict:
    return {"id": row["id"], "slug": row["slug"], "name": row["name"], "description": row["description"],
            "position": row["position"], "status": row["status"]}


def _synthetic_default_phase() -> dict:
    return {"id": None, "slug": DEFAULT_PHASE_SLUG, "name": DEFAULT_PHASE_NAME, "description": None,
            "position": 0, "status": "open"}


def _board_pointer(conn, workspace):
    row = conn.execute("SELECT current_phase_id FROM board_state WHERE workspace = ?", (workspace,)).fetchone()
    return row["current_phase_id"] if row is not None else None


def effective_current_phase(conn, workspace: str) -> dict:
    """The current phase (§D): the board's pointer when it names an open phase, else the default phase."""
    pointer = _board_pointer(conn, workspace)
    if pointer is not None:
        row = conn.execute("SELECT * FROM phases WHERE id = ?", (pointer,)).fetchone()
        if row is not None and row["status"] == "open":
            return _phase_row_json(row)
    default = conn.execute("SELECT * FROM phases WHERE workspace = ? AND slug = ?",
                           (workspace, DEFAULT_PHASE_SLUG)).fetchone()
    return _phase_row_json(default) if default is not None else _synthetic_default_phase()


def ticket_in_scope(ticket: dict, current_phase: dict) -> bool:
    """True when the ticket's phase is the effective current phase; the S10 scheduler offers only these."""
    return ticket["phase_id"] == current_phase["id"]


def _clear_pointer(tx, workspace: str, phase, why: str):
    tx.conn.execute("UPDATE board_state SET current_phase_id = NULL, updated_at = ? WHERE workspace = ?",
                    (utcnow(), workspace))
    tx.note("phase", phase["id"], "phase.clear_current", {"workspace": workspace, "phase": phase["slug"],
                                                          "why": why})


# ---- phase commands ---------------------------------------------------------------------------------------

def _ordered_phases(conn, workspace):
    return conn.execute("SELECT * FROM phases WHERE workspace = ? ORDER BY position, slug",
                        (workspace,)).fetchall()


def _renumber(tx, rows):
    for position, row in enumerate(rows):
        if row["position"] != position:
            tx.conn.execute("UPDATE phases SET position = ? WHERE id = ?", (position, row["id"]))


def phase_add(tx, workspace: str, args: dict) -> dict:
    ensure_board(tx, workspace)
    if _phase_row(tx, workspace, args["id"]) is not None:
        raise AsError(PHASE_EXISTS, f"Phase {args['id']!r} already exists on this board.",
                      data={"phase": args["id"]})
    rows = [dict(r) for r in _ordered_phases(tx.conn, workspace)]
    index = len(rows)
    if args.get("before"):
        target = get_phase(tx.conn, workspace, args["before"])
        index = next((i for i, r in enumerate(rows) if r["id"] == target["id"]), len(rows))
    for offset, row in enumerate(rows[index:]):  # make room at `index`
        tx.conn.execute("UPDATE phases SET position = ? WHERE id = ?", (index + 1 + offset, row["id"]))
    tx.create("phase", {"workspace": workspace, "slug": args["id"], "name": args["name"],
                        "description": args.get("description"), "position": index},
              payload={"phase": args["id"], "name": args["name"], "position": index})
    return {"phase": _phase_row_json(_phase_row(tx, workspace, args["id"]))}


def phase_edit(tx, workspace: str, args: dict) -> dict:
    ensure_board(tx, workspace)
    phase = get_phase(tx.conn, workspace, args["phase"])
    values, changes = {}, {}
    for field in ("name", "description"):
        if field in args:
            values[field] = args[field]
            changes[field] = {"from": phase[field], "to": args[field]}
    if not values:
        raise AsError("BAD_REQUEST", "phase edit needs --name or --description.")
    tx.update("phase", phase["id"], values, "phase.edited", {"phase": phase["slug"], "changes": changes})
    return {"phase": _phase_row_json(_phase_row(tx, workspace, phase["slug"]))}


def phase_close(tx, workspace: str, args: dict) -> dict:
    ensure_board(tx, workspace)
    phase = get_phase(tx.conn, workspace, args["phase"])
    if phase["slug"] == DEFAULT_PHASE_SLUG:
        raise AsError(PHASE_PROTECTED, "The default phase cannot be closed.",
                      data={"phase": phase["slug"]})
    if phase["status"] == "closed":
        return {"phase": _phase_row_json(_phase_row(tx, workspace, phase["slug"]))}
    tx.transition("phase", phase["id"], "closed", event="phase.closed",
                  payload={"phase": phase["slug"]})
    cleared = _board_pointer(tx.conn, workspace) == phase["id"]
    if cleared:
        _clear_pointer(tx, workspace, phase, "phase_closed")
    return {"phase": _phase_row_json(_phase_row(tx, workspace, phase["slug"])), "clearedCurrent": cleared}


def phase_reopen(tx, workspace: str, args: dict) -> dict:
    ensure_board(tx, workspace)
    phase = get_phase(tx.conn, workspace, args["phase"])
    if phase["slug"] == DEFAULT_PHASE_SLUG and phase["status"] == "closed":
        raise AsError(PHASE_PROTECTED, "The default phase cannot be closed.", data={"phase": phase["slug"]})
    if phase["status"] == "closed":
        tx.transition("phase", phase["id"], "open", event="phase.reopened", payload={"phase": phase["slug"]})
    return {"phase": _phase_row_json(_phase_row(tx, workspace, phase["slug"]))}


def phase_remove(tx, workspace: str, args: dict) -> dict:
    ensure_board(tx, workspace)
    phase = get_phase(tx.conn, workspace, args["phase"])
    if phase["slug"] == DEFAULT_PHASE_SLUG:
        raise AsError(PHASE_PROTECTED, "The default phase cannot be removed.", data={"phase": phase["slug"]})
    tickets = tx.conn.execute("SELECT id, key FROM tickets WHERE phase_id = ?", (phase["id"],)).fetchall()
    moved = []
    if tickets:
        if not args.get("moveTo"):
            raise AsError(PHASE_NOT_EMPTY, f"Phase {phase['slug']!r} still holds {len(tickets)} ticket(s); "
                                           f"name a target with --move-to.",
                          data={"phase": phase["slug"], "tickets": len(tickets)},
                          remediation="pass --move-to <open phase> or move the tickets first")
        if args["moveTo"] == phase["slug"]:
            raise AsError("BAD_REQUEST", "A phase's tickets cannot move into the phase being removed.",
                          data={"phase": phase["slug"]})
        target = get_phase(tx.conn, workspace, args["moveTo"])
        if target["status"] != "open":
            raise AsError(PHASE_CLOSED, f"Phase {target['slug']!r} is closed; tickets cannot move into it.",
                          data={"phase": target["slug"]})
        now = utcnow()
        for ticket in tickets:
            tx.conn.execute("UPDATE tickets SET phase_id = ?, updated_at = ? WHERE id = ?",
                            (target["id"], now, ticket["id"]))
            _ticket_event(tx.conn, ticket["id"], "ticket.phase_changed", "operator", None, None,
                          {"ticketId": ticket["id"], "key": ticket["key"], "from": phase["slug"],
                           "to": target["slug"], "why": "phase_removed"})
            moved.append(ticket["key"])
    tx.note("phase", phase["id"], "phase.removed", {"phase": phase["slug"], "movedTickets": moved,
                                                    "moveTo": args.get("moveTo")})
    cleared = _board_pointer(tx.conn, workspace) == phase["id"]
    if cleared:
        _clear_pointer(tx, workspace, phase, "phase_removed")
    tx.conn.execute("DELETE FROM phases WHERE id = ?", (phase["id"],))
    _renumber(tx, _ordered_phases(tx.conn, workspace))
    return {"removed": phase["slug"], "movedTickets": moved, "moveTo": args.get("moveTo"),
            "clearedCurrent": cleared}


def phase_set_current(tx, workspace: str, args: dict) -> dict:
    ensure_board(tx, workspace)
    phase = get_phase(tx.conn, workspace, args["phase"])
    if phase["status"] != "open":
        raise AsError(PHASE_CLOSED, f"Phase {phase['slug']!r} is closed; it cannot be the current phase.",
                      data={"phase": phase["slug"]})
    if _board_pointer(tx.conn, workspace) == phase["id"]:
        return {"currentPhase": _phase_row_json(phase), "changed": False}
    previous = _board_pointer(tx.conn, workspace)
    tx.conn.execute("UPDATE board_state SET current_phase_id = ?, updated_at = ? WHERE workspace = ?",
                    (phase["id"], utcnow(), workspace))
    tx.note("phase", phase["id"], "phase.set_current",
            {"workspace": workspace, "phase": phase["slug"], "previous": previous})
    return {"currentPhase": _phase_row_json(phase), "changed": True}


def phase_clear_current(tx, workspace: str, args: dict) -> dict:
    ensure_board(tx, workspace)
    pointer = _board_pointer(tx.conn, workspace)
    if pointer is None:
        return {"currentPhase": effective_current_phase(tx.conn, workspace), "changed": False}
    phase = dict(tx.conn.execute("SELECT * FROM phases WHERE id = ?", (pointer,)).fetchone())
    _clear_pointer(tx, workspace, phase, "operator")
    return {"currentPhase": effective_current_phase(tx.conn, workspace), "changed": True}


def _phase_counts(conn, phase_id, config):
    return {r["status"]: r["n"] for r in conn.execute(
        "SELECT status, COUNT(*) AS n FROM tickets WHERE phase_id = ? GROUP BY status", (phase_id,))}


def phase_list(conn, workspace: str) -> dict:
    config = load_config(workspace)
    current = effective_current_phase(conn, workspace)
    rows = _ordered_phases(conn, workspace)
    if not rows:
        rows = [{"id": None, "slug": DEFAULT_PHASE_SLUG, "name": DEFAULT_PHASE_NAME, "description": None,
                 "position": 0, "status": "open"}]
    counts = {s["id"]: 0 for s in config["statuses"]}
    phases = []
    for row in rows:
        per_status = dict(counts, **_phase_counts(conn, row["id"], config)) if row["id"] else dict(counts)
        phases.append(dict(_phase_row_json(row), current=row["id"] == current["id"],
                           ticketCount=sum(per_status.values()), counts=per_status))
    return {"workspace": workspace, "currentPhase": current, "phases": phases}


def phase_detail(conn, workspace: str, slug: str) -> dict:
    config = load_config(workspace)
    listed = phase_list(conn, workspace)
    phase = next((p for p in listed["phases"] if p["slug"] == slug), None)
    if phase is None:
        raise AsError(PHASE_NOT_FOUND, f"Phase {slug!r} does not exist on this board.", data={"phase": slug})
    tickets = conn.execute("SELECT * FROM tickets WHERE phase_id = ? ORDER BY priority, created_at, key",
                           (phase["id"],)).fetchall() if phase["id"] else []
    return {"workspace": workspace, "currentPhase": listed["currentPhase"], "phase": phase,
            "tickets": [_ticket_json(conn, r) for r in tickets]}


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


def _ticket_json(conn, row, config=None) -> dict:
    out = _row_to_json(row)
    phase = conn.execute("SELECT slug, name FROM phases WHERE id = ?", (row["phase_id"],)).fetchone()
    out["phase"] = phase["slug"] if phase else None
    out["phaseName"] = phase["name"] if phase else None
    out["activity"] = ticket_activity(conn, row, config)
    return out


def ticket_activity(conn, row, config=None) -> dict:
    """What the agents are doing with a ticket: `working` (claimed, with who), `not started` (waiting for the
    next agent, or parked with no rule; a failed start is reported in `note`), `finished` (done or closed),
    or `blocked`. Derived from the claim, the board rules and the latest ticket event; nothing is stored."""
    if config is None:
        try:
            config = load_config(row["workspace"])
        except AsError:
            config = None
    status = row["status"]
    if status == BLOCKED_STATUS:
        return {"state": "blocked", "note": row["blocked_reason"]}
    if row["assignee"] is not None:
        agent = conn.execute("SELECT role, display_name FROM agents WHERE id = ?", (row["assignee"],)).fetchone()
        rule = (config or {}).get("rulesByStatus", {}).get(status)
        return {"state": "working", "agent": agent["display_name"] if agent else None,
                "role": agent["role"] if agent else None, "run": row["active_run_id"],
                "leaseUntil": row["lease_until"], "workflow": rule.get("workflow") if rule else None}
    if config is not None and status in config["terminal"]:
        return {"state": "finished"}
    out = {"state": "not started"}
    rule = (config or {}).get("rulesByStatus", {}).get(status)
    if rule is not None:
        out["waitingFor"] = rule.get("role") or "coordinator"
    last = conn.execute("SELECT name, payload_json FROM ticket_events WHERE ticket_id = ? ORDER BY id DESC LIMIT 1",
                        (row["id"],)).fetchone()
    if last is not None and last["name"] == "ticket.claim_released":
        reason = (json.loads(last["payload_json"]) or {}).get("reason")
        if reason:
            out["note"] = reason
    return out


def next_key(conn, workspace: str) -> str:
    numbers = [int(r[0][2:]) for r in conn.execute(
        "SELECT key FROM tickets WHERE workspace = ? AND key GLOB 'T-[0-9]*'", (workspace,)) if r[0][2:].isdigit()]
    return f"T-{max(numbers, default=0) + 1:03d}"


def _target_phase(tx, workspace: str, slug):
    """The phase a new ticket or a moved ticket goes to: an open phase, else PHASE_CLOSED/PHASE_NOT_FOUND."""
    phase = get_phase(tx.conn, workspace, slug)
    if phase["status"] != "open":
        raise AsError(PHASE_CLOSED, f"Phase {phase['slug']!r} is closed; it cannot take tickets.",
                      data={"phase": phase["slug"]})
    return phase


def mcp_ticket_add(tx, workspace: str, args: dict) -> dict:
    """A ticket added by an agent through the MCP server (design contract §G).

    The call rides the normal command path and names the assignment it belongs to. The coordinator checks
    that the assignment is active and its member may add tickets, records `createdBy`, puts the ticket in
    the board's initial status and the requested phase (default when omitted), enforces a per-assignment
    cap and a duplicate check against open tickets, and links dependencies. The server sends the same
    idempotency key for a retried call, so the coordinator's receipt deduplicates it."""
    config = load_config(workspace)
    assignment_id = args["assignment"]
    row = tx.conn.execute(
        "SELECT a.id, a.agent_id, a.status, a.team_id, ag.can_add_tickets, ag.member_id, ag.team_id AS agent_team "
        "FROM assignments a JOIN agents ag ON ag.id = a.agent_id WHERE a.id = ?",
        (assignment_id,)).fetchone()
    if row is None or row["status"] not in ACTIVE_ASSIGNMENT_STATES:
        raise AsError(FORBIDDEN, "The assignment is not active; tickets cannot be added through it.",
                      data={"assignment": assignment_id})
    if not row["can_add_tickets"]:
        raise AsError(FORBIDDEN, "This member may not add tickets (canAddTickets is not enabled).",
                      data={"assignment": assignment_id})
    member_id = row["member_id"] or row["agent_id"]
    existing = tx.conn.execute("SELECT COUNT(*) FROM tickets WHERE created_by_assignment = ?",
                               (assignment_id,)).fetchone()[0]
    if existing >= int(args.get("cap", MCP_TICKET_CAP)):
        raise AsError(TICKET_CAP_REACHED, f"The assignment already added {existing} ticket(s) "
                                          f"(cap {args.get('cap', MCP_TICKET_CAP)}).",
                      data={"assignment": assignment_id, "cap": args.get("cap", MCP_TICKET_CAP)})
    title = args["title"].strip()
    terminal = {s["id"] for s in config["statuses"] if s["kind"] in TERMINAL_KINDS}
    duplicate = tx.conn.execute(
        "SELECT key FROM tickets WHERE workspace = ? AND title = ? AND status NOT IN "
        f"({','.join('?' * len(terminal))}) LIMIT 1", (workspace, title) + tuple(terminal)).fetchone()
    if duplicate is not None:
        raise AsError(TICKET_DUPLICATE, f"An open ticket with this title already exists ({duplicate[0]}).",
                      data={"key": duplicate[0], "title": title})
    ensure_board(tx, workspace)
    phase = _target_phase(tx, workspace, args["phase"]) if args.get("phase") \
        else _phase_row(tx, workspace, DEFAULT_PHASE_SLUG)
    added = ticket_add(tx, workspace, dict(args, priority=args.get("priority", 100), status=config["agentStatus"],
                                           createdByMember=member_id, createdByAssignment=assignment_id))
    deps = []
    for key in list(dict.fromkeys(args.get("dependsOn") or [])):
        other = get_ticket(tx.conn, workspace, key)
        tx.conn.execute("INSERT INTO ticket_deps (ticket_id, blocked_by_ticket_id) VALUES (?, ?)",
                        (added["ticket"]["id"], other["id"]))
        deps.append(other["key"])
    if deps:
        _ticket_event(tx.conn, added["ticket"]["id"], "ticket.depends", "coordinator",
                      added["ticket"]["status"], added["ticket"]["status"],
                      {"ticketId": added["ticket"]["id"], "key": added["ticket"]["key"], "on": deps})
    return dict(added, dependsOn=deps)


def ticket_add(tx, workspace: str, args: dict) -> dict:
    config = load_config(workspace)
    ensure_board(tx, workspace)
    if args.get("phase"):
        phase = _target_phase(tx, workspace, args["phase"])
    else:
        phase = _phase_row(tx, workspace, DEFAULT_PHASE_SLUG)
    ident, key, status = new_id(), next_key(tx.conn, workspace), args.get("status") or config["initial"]
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


def ticket_phase(tx, workspace: str, args: dict) -> dict:
    """Move a ticket to another open phase; a claimed or running ticket stays put (TICKET_BUSY)."""
    ticket = get_ticket(tx.conn, workspace, args["key"])
    if ticket["assignee"] is not None:
        raise AsError(TICKET_BUSY, f"Ticket {ticket['key']} is claimed by an agent; its phase cannot change.",
                      data={"key": ticket["key"], "assignee": ticket["assignee"]})
    target = get_phase(tx.conn, workspace, args["phase"])
    if target["id"] == ticket["phase_id"]:
        return {"ticket": _ticket_json(tx.conn, tx.conn.execute("SELECT * FROM tickets WHERE id = ?",
                                                                (ticket["id"],)).fetchone()),
                "from": target["slug"], "moved": False}
    if target["status"] != "open":
        raise AsError(PHASE_CLOSED, f"Phase {target['slug']!r} is closed; it cannot take tickets.",
                      data={"phase": target["slug"]})
    old = tx.conn.execute("SELECT slug FROM phases WHERE id = ?", (ticket["phase_id"],)).fetchone()["slug"]
    tx.conn.execute("UPDATE tickets SET phase_id = ?, updated_at = ? WHERE id = ?",
                    (target["id"], utcnow(), ticket["id"]))
    _ticket_event(tx.conn, ticket["id"], "ticket.phase_changed", "operator", ticket["status"], ticket["status"],
                  {"ticketId": ticket["id"], "key": ticket["key"], "from": old, "to": target["slug"]})
    return {"ticket": _ticket_json(tx.conn, tx.conn.execute("SELECT * FROM tickets WHERE id = ?",
                                                            (ticket["id"],)).fetchone()),
            "from": old, "moved": True}


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
    if ticket["assignee"] is not None:
        raise AsError(TICKET_BUSY, f"Ticket {ticket['key']} is claimed by an agent; its status cannot change.",
                      data={"key": ticket["key"], "assignee": ticket["assignee"]},
                      remediation="wait for the current run to finish, or use ticket retry to release a stuck claim")
    if ticket["status"] in config["terminal"] and not args.get("force"):
        raise AsError(TICKET_TRANSITION_INVALID, f"Ticket {ticket['key']} is in the terminal status "
                                                 f"{ticket['status']!r}; moving it needs --force.",
                      data={"key": ticket["key"], "from": ticket["status"], "to": to},
                      remediation="pass --force to move a finished ticket explicitly")
    if ticket["status"] == BLOCKED_STATUS:  # an operator's move out of blocked also starts a fresh round budget
        tx.conn.execute("UPDATE tickets SET return_status = NULL, blocked_reason = NULL, rounds_json = NULL "
                        "WHERE id = ?", (ticket["id"],))
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


# ---- rules check ------------------------------------------------------------------------------------------

def check_rules(workspace: str, config: dict) -> list:
    """The full check `board rules check` runs: the schema checks load_config already did, plus every role
    existing in roles.json, every workflow loading (bindable), and a path from the initial status to a
    done one. -> [{path, message}] (empty means the rules are sound)."""
    problems = []
    if not os.path.exists(os.path.join(workspace, CONFIG_DIR, "roles.json")):
        problems.append({"path": "roles.json", "message": "does not exist; the rules cannot name roles"})
        known_roles = set()
    else:
        try:
            known_roles = set((rolefiles.load_config(workspace) or {}).get("roles") or {})
        except AsError as e:
            problems.append({"path": "roles.json", "message": e.message})
            known_roles = set()
    definitions = {d["name"]: d for d in workflowdef.list_definitions(workspace, BUILTIN_DEFINITIONS_DIR)}
    for i, rule in enumerate(config["rules"]):
        path = f"rules[{i}]"
        if "action" in rule and rule["action"] not in RULE_ACTIONS:
            problems.append({"path": f"{path}.action",
                             "message": f"unknown action {rule['action']!r} (known: {', '.join(RULE_ACTIONS)})"})
        if "role" in rule and rule["role"] not in known_roles:
            problems.append({"path": f"{path}.role", "message": f"role {rule['role']!r} is not defined in "
                                                                f"{CONFIG_DIR}/roles.json"})
        if "workflow" in rule:
            definition = definitions.get(rule["workflow"])
            if definition is None:
                problems.append({"path": f"{path}.workflow",
                                 "message": f"workflow {rule['workflow']!r} does not exist in "
                                            f"{CONFIG_DIR}/workflows or the built-ins"})
            else:
                try:
                    loaded = workflowdef.load(workspace, rule["workflow"], BUILTIN_DEFINITIONS_DIR)
                    used = {st.role for st in loaded.stages if st.type == "agent"}
                    if "role" in rule and rule["role"] not in used:
                        problems.append({"path": f"{path}.workflow",
                                         "message": f"must use the rule's role {rule['role']!r} "
                                                    f"(it uses {sorted(used)})"})
                except AsError as e:
                    problems.append({"path": f"{path}.workflow", "message": f"cannot be bound: {e.message}"})
    if config["rules"]:
        edges = {}
        for rule in config["rules"]:
            targets = [rule["onPass"], rule["onFail"]] + ([rule["onBlocked"]] if "onBlocked" in rule else [])
            edges.setdefault(rule["when"]["status"], set()).update(t for t in targets if t)
        # tickets enter at the initial status (the operator moves them on) and at the agent status
        reachable, pending = set(), [config["initial"], config["agentStatus"]]
        while pending:
            current = pending.pop()
            if current in reachable:
                continue
            reachable.add(current)
            pending.extend(edges.get(current, ()))
        if not any(s["id"] in reachable for s in config["statuses"] if s["kind"] == "done"):
            problems.append({"path": "rules",
                             "message": f"no path from the initial status {config['initial']!r} to a done status"})
    return problems


# ---- outcome applier --------------------------------------------------------------------------------------

def apply_run_outcome(tx, workspace: str, args: dict, rule: dict = None) -> dict:
    """Apply a finished run to its ticket by the rule for the ticket's status (or the claiming rule the
    scheduler passes): move to onPass/onFail/onBlocked, count the round for that rule, block with a reason
    when maxRounds is hit, and release the claim. The ticket keeps the run id it was last applied for, so a
    late or replayed outcome is a no-op."""
    config = load_config(workspace)
    ticket = get_ticket(tx.conn, workspace, args["key"])
    run = tx.conn.execute("SELECT id, status FROM workflow_runs WHERE id = ?", (args["run"],)).fetchone()
    if run is None:
        raise AsError("NOT_FOUND", f"Workflow run {args['run']} does not exist.")
    if run["status"] not in FINISHED_RUN_STATES:
        raise AsError(TICKET_BUSY, f"Run {run['id']} is {run['status']}; only finished runs are applied.",
                      data={"key": ticket["key"], "run": run["id"]})
    if ticket["run_id"] == run["id"]:
        return {"applied": False, "ticket": _ticket_json(tx.conn, tx.conn.execute(
            "SELECT * FROM tickets WHERE id = ?", (ticket["id"],)).fetchone())}
    rule = rule or config["rulesByStatus"].get(ticket["status"])
    if rule is None:
        raise AsError(BOARD_RULE_MISSING, f"Status {ticket['status']!r} has no rule, so the run outcome "
                                          f"cannot be applied.", data={"key": ticket["key"],
                                                                       "status": ticket["status"]})
    outcome = RUN_OUTCOMES[run["status"]]
    rounds = json.loads(ticket["rounds_json"] or "{}")
    rule_status_id = rule["when"]["status"]
    rounds[rule_status_id] = rounds.get(rule_status_id, 0) + 1
    target, reason = None, None
    if outcome == "pass":
        target = rule["onPass"]
    elif outcome == "fail":
        target = rule["onFail"]
    elif "onBlocked" in rule:
        target = rule["onBlocked"]
    else:
        target, reason = BLOCKED_STATUS, f"RUN_BLOCKED:{run['id']}"
    if target != BLOCKED_STATUS and outcome != "pass" and rule.get("maxRounds") \
            and rounds[rule_status_id] >= rule["maxRounds"]:
        target, reason = BLOCKED_STATUS, f"ROUND_LIMIT:{rule_status_id}"
    now = utcnow()
    if target == BLOCKED_STATUS:
        # a blocked ticket returns to the queue it was claimed from (the rule's when status), not the
        # during status it sits in while worked
        values = (BLOCKED_STATUS, run["id"], json.dumps(rounds, sort_keys=True), rule["when"]["status"],
                  reason, now)
    else:
        values = (target, run["id"], json.dumps(rounds, sort_keys=True), None, None, now)
    tx.conn.execute("UPDATE tickets SET status = ?, run_id = ?, rounds_json = ?, return_status = ?, "
                    "blocked_reason = ?, updated_at = ?, active_run_id = NULL, assignee = NULL, "
                    "lease_until = NULL WHERE id = ?",
                    values + (ticket["id"],))
    if outcome != "pass":
        findings = _run_findings(tx.conn, run["id"])
        if findings:  # the next agent only sees the ticket, so a failed run's findings travel in its body
            append_body(tx, ticket["id"], f"## Findings from {rule_status_id}, round {rounds[rule_status_id]}\n"
                        + "\n".join(f"- {f}" for f in findings))
        if "onFailPriority" in rule and target != BLOCKED_STATUS:
            bump_priority(tx, ticket["id"], rule["onFailPriority"])
    _ticket_event(tx.conn, ticket["id"], "ticket.outcome_applied", "coordinator", ticket["status"], target,
                  {"ticketId": ticket["id"], "key": ticket["key"], "run": run["id"], "outcome": outcome,
                   "rule": rule_status_id, "rounds": rounds[rule_status_id], "to": target,
                   "reason": reason})
    return {"applied": True, "outcome": outcome, "rule": rule_status_id,
            "rounds": rounds[rule_status_id], "reason": reason,
            "ticket": _ticket_json(tx.conn, tx.conn.execute("SELECT * FROM tickets WHERE id = ?",
                                                            (ticket["id"],)).fetchone())}


def _run_findings(conn, run_id: str) -> list:
    """The findings of the last verdict a workflow run produced (stage attempts keep them as JSON)."""
    rows = conn.execute("SELECT verdict_json FROM stage_attempts WHERE workflow_run_id = ? AND "
                        "verdict_json IS NOT NULL ORDER BY updated_at DESC, attempt DESC", (run_id,)).fetchall()
    for row in rows:
        try:
            verdict = json.loads(row["verdict_json"]) if isinstance(row["verdict_json"], str) else row["verdict_json"]
        except ValueError:
            continue
        found = (verdict or {}).get("findings")
        if isinstance(found, list) and found:
            return [str(f)[:2000] for f in found][:20]
    return []


def append_body(tx, ticket_id: str, text: str) -> None:
    """Append a section to a ticket body, keeping the head (the original brief) when the cap is hit."""
    row = tx.conn.execute("SELECT body FROM tickets WHERE id = ?", (ticket_id,)).fetchone()
    body = ((row["body"] or "").rstrip() + "\n\n" if row and row["body"] else "") + text.strip()
    if len(body) > BODY_LIMIT:
        head = (row["body"] or "")[: BODY_LIMIT // 2]
        body = head + "\n\n[... older notes trimmed ...]\n\n" + text.strip()[: BODY_LIMIT // 2 - 100]
    tx.conn.execute("UPDATE tickets SET body = ?, updated_at = ? WHERE id = ?", (body, utcnow(), ticket_id))


def bump_priority(tx, ticket_id: str, value: int) -> None:
    """Lower numbers are claimed first; a failed ticket goes to the front of the queue it returns to."""
    tx.conn.execute("UPDATE tickets SET priority = ?, updated_at = ? WHERE id = ?", (value, utcnow(), ticket_id))


def mcp_ticket_update(tx, workspace: str, args: dict) -> dict:
    """An agent updates the body of the ticket its own assignment is working (replace or append). The
    assignment must be active, its member must have canAddTickets, and the ticket must be claimed by that
    agent, so an agent can only write to the ticket it was given."""
    row = tx.conn.execute(
        "SELECT a.id, a.agent_id, a.status, ag.can_add_tickets, ag.member_id FROM assignments a "
        "JOIN agents ag ON ag.id = a.agent_id WHERE a.id = ?", (args["assignment"],)).fetchone()
    if row is None or row["status"] not in ACTIVE_ASSIGNMENT_STATES or not row["can_add_tickets"]:
        raise AsError(FORBIDDEN, "The assignment is not active or its member may not update tickets "
                                 "(canAddTickets).", data={"assignment": args["assignment"]})
    ticket = get_ticket(tx.conn, workspace, args["key"])
    if ticket["assignee"] != row["agent_id"]:
        raise AsError(FORBIDDEN, f"Ticket {ticket['key']} is not the ticket this assignment is working.",
                      data={"key": ticket["key"]})
    text = args["body"].strip()
    if args.get("mode") == "append":
        append_body(tx, ticket["id"], text)
    else:
        tx.conn.execute("UPDATE tickets SET body = ?, updated_at = ? WHERE id = ?",
                        (text[:BODY_LIMIT], utcnow(), ticket["id"]))
    _ticket_event(tx.conn, ticket["id"], "ticket.updated", "agent", ticket["status"], ticket["status"],
                  {"ticketId": ticket["id"], "key": ticket["key"], "mode": args.get("mode") or "replace",
                   "memberId": row["member_id"] or row["agent_id"], "assignment": args["assignment"],
                   "chars": len(text)})
    return {"ticket": _ticket_json(tx.conn, tx.conn.execute("SELECT * FROM tickets WHERE id = ?",
                                                            (ticket["id"],)).fetchone())}


def ticket_unblock(tx, workspace: str, args: dict) -> dict:
    config = load_config(workspace)
    ticket = get_ticket(tx.conn, workspace, args["key"])
    if ticket["status"] != BLOCKED_STATUS:
        raise AsError(TICKET_TRANSITION_INVALID, f"Ticket {ticket['key']} is not blocked.",
                      data={"key": ticket["key"], "status": ticket["status"]})
    target = args.get("to") or ticket["return_status"] or config["initial"]
    if target not in config["byId"] or target in config["terminal"]:
        raise AsError(BOARD_STATUS_UNKNOWN, f"Status {target!r} is not a working status on this board.",
                      data={"key": ticket["key"], "status": target, "statuses": config_status_ids(config)})
    # an operator's decision starts a fresh round budget (the limit that blocked the ticket is not carried over)
    tx.conn.execute("UPDATE tickets SET status = ?, return_status = NULL, blocked_reason = NULL, "
                    "rounds_json = NULL, updated_at = ? WHERE id = ?", (target, utcnow(), ticket["id"]))
    _ticket_event(tx.conn, ticket["id"], "ticket.unblocked", "operator", BLOCKED_STATUS, target,
                  {"ticketId": ticket["id"], "key": ticket["key"], "to": target,
                   "reason": ticket["blocked_reason"], "roundsReset": True})
    return {"ticket": _ticket_json(tx.conn, tx.conn.execute("SELECT * FROM tickets WHERE id = ?",
                                                            (ticket["id"],)).fetchone())}


# ---- worktree registration (design contract §F) ------------------------------------------------------------

def registered_worktree(conn_or_tx, team_workspace: str, path: str) -> str:
    """A requested run workspace is accepted only when it is a worktree this board created and a claimed
    ticket (one a member holds) is registered at; every other path is WORKTREE_NOT_REGISTERED."""
    from . import worktrees
    canonical = os.path.realpath(path)
    conn = getattr(conn_or_tx, "conn", conn_or_tx)
    row = conn.execute("SELECT 1 FROM tickets WHERE workspace = ? AND worktree_path = ? "
                       "AND assignee IS NOT NULL LIMIT 1", (team_workspace, canonical)).fetchone()
    listed = any(item["path"] == canonical
                 for item in worktrees.list_registered(team_workspace))
    if row is None or not listed:
        raise AsError("WORKTREE_NOT_REGISTERED", "Workspace is not a registered live ticket worktree.",
                      data={"workspace": canonical})
    return canonical


def release_claim(tx, ticket: dict, reason: str, to_status=None) -> None:
    """Give a claim back without applying anything (a start failure, or lease recovery in S11)."""
    values = [utcnow(), ticket["id"]]
    sets = "assignee = NULL, lease_until = NULL, active_run_id = NULL, updated_at = ?"
    if to_status is not None and to_status != ticket["status"]:
        sets += ", status = ?"
        values.insert(1, to_status)
    tx.conn.execute(f"UPDATE tickets SET {sets} WHERE id = ?", values)
    _ticket_event(tx.conn, ticket["id"], "ticket.claim_released", "coordinator", ticket["status"],
                  to_status if to_status is not None else ticket["status"],
                  {"ticketId": ticket["id"], "key": ticket["key"], "reason": reason})


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
        "SELECT * FROM tickets WHERE id = ?", (ticket["id"],)).fetchone(), config),
        "dependsOn": deps, "dependents": dependents,
        "events": [{"id": e["id"], "at": e["at"], "actor": e["actor"], "name": e["name"],
                    "from": e["from_status"], "to": e["to_status"], "payload": json.loads(e["payload_json"])}
                   for e in events],
        "statuses": config_status_ids(config)}


def ticket_list(conn, workspace: str, status=None, phase=None) -> dict:
    config = load_config(workspace)
    if status is not None and status not in config["byId"] and status != BLOCKED_STATUS:
        raise AsError(BOARD_STATUS_UNKNOWN, f"Status {status!r} is not on this board.",
                      data={"status": status, "statuses": config_status_ids(config)})
    clauses, params = ["workspace = ?"], [workspace]
    if status is not None:
        clauses.append("status = ?")
        params.append(status)
    if phase is not None:
        clauses.append("phase_id = ?")
        params.append(get_phase(conn, workspace, phase)["id"])
    rows = conn.execute("SELECT * FROM tickets WHERE " + " AND ".join(clauses) +
                        " ORDER BY priority, created_at, key", params).fetchall()
    return {"workspace": workspace, "statuses": config_status_ids(config), "status": status, "phase": phase,
            "tickets": [_ticket_json(conn, r, config) for r in rows]}


def board_show(conn, workspace: str) -> dict:
    """The whole board: phases in position order (the current one marked), each with every configured
    status column and its tickets."""
    config = load_config(workspace)
    current = effective_current_phase(conn, workspace)
    rows = _ordered_phases(conn, workspace)
    if not rows:
        rows = [{"id": None, "slug": DEFAULT_PHASE_SLUG, "name": DEFAULT_PHASE_NAME, "description": None,
                 "position": 0, "status": "open"}]
    phases = []
    for row in rows:
        tickets = conn.execute("SELECT * FROM tickets WHERE phase_id = ? "
                               "ORDER BY priority, created_at, key", (row["id"],)).fetchall() if row["id"] else []
        by_status = {}
        for ticket in tickets:
            by_status.setdefault(ticket["status"], []).append(_ticket_json(conn, ticket, config))
        columns = [{"status": s["id"], "kind": s["kind"], "title": s["name"], "count": len(by_status.get(s["id"], [])),
                    "tickets": by_status.get(s["id"], [])} for s in config["statuses"]]
        if BLOCKED_STATUS in by_status:  # the reserved blocked column appears only when tickets are blocked
            columns.append({"status": BLOCKED_STATUS, "kind": None, "title": BLOCKED_STATUS,
                            "count": len(by_status[BLOCKED_STATUS]), "tickets": by_status[BLOCKED_STATUS]})
        phases.append(dict(_phase_row_json(row), current=row["id"] == current["id"],
                           ticketCount=len(tickets), columns=columns))
    return {"workspace": workspace, "currentPhase": current, "phases": phases}
