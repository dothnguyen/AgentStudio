"""Durable ticket state transitions owned by the coordinator."""
from __future__ import annotations

import json
import os
import re

from . import schema
from .protocol import (AsError, INTERNAL, TICKET_BUSY, TICKET_DEPENDENCY_CYCLE,
                       TICKET_NOT_FOUND, TICKET_TRANSITION_INVALID, WORKTREE_NOT_REGISTERED)
from .protocol import STORY_PATH_INVALID
from .state import utcnow

TRANSITIONS = schema.TICKET_TRANSITIONS
TICKET_KINDS = schema.TICKET_KINDS
TICKET_SEVERITIES = schema.TICKET_SEVERITIES
TICKET_STATES = schema.TICKET_STATES
TICKET_TERMINAL = schema.TICKET_TERMINAL
TICKET_WORKING = schema.TICKET_WORKING
TICKET_OPERATOR_TARGETS = schema.TICKET_OPERATOR_TARGETS
KIND_STATUSES = schema.KIND_STATUSES


def check_workspace_path(workspace, rel):
    """Return a safe, normalized story path relative to *workspace*."""
    def invalid(reason):
        raise AsError(STORY_PATH_INVALID, "Story path is invalid.", data={"path": rel, "reason": reason})
    if not isinstance(rel, str) or not rel or os.path.isabs(rel) or "\\" in rel:
        invalid("path must be a relative POSIX path")
    if ".." in rel.split("/"):
        invalid("path must not contain '..'")
    root = os.path.realpath(workspace)
    target = os.path.realpath(os.path.join(root, rel))
    try:
        if os.path.commonpath((root, target)) != root:
            invalid("path escapes the workspace")
    except ValueError:
        invalid("path escapes the workspace")
    if not os.path.isfile(target):
        invalid("path must name an existing regular file")
    if not target.endswith(".md"):
        invalid("path must end in .md")
    return os.path.relpath(target, root).replace(os.sep, "/")


def parse_depends(text):
    for line in text.splitlines():
        if line.startswith("Depends on:"):
            return list(dict.fromkeys(re.findall(r"P\d{2}-S\d{2}", line)))
    return []


def resolve_depends(tx, workspace, ids):
    resolved, unresolved = [], []
    for story_id in ids:
        rows = [row for row in tx.conn.execute(
            "SELECT key, story_path FROM tickets WHERE workspace = ? AND kind = 'story' "
            "AND status != 'cancelled' AND story_path IS NOT NULL", (workspace,)).fetchall()
                if os.path.splitext(os.path.basename(row["story_path"]))[0] == story_id
                or os.path.splitext(os.path.basename(row["story_path"]))[0].startswith(story_id + "-")]
        if len(rows) == 1:
            resolved.append(rows[0][0])
        else:
            unresolved.append(story_id)
    return {"resolved": resolved, "unresolved": unresolved}


def story_title(text, stem):
    for line in text.splitlines():
        if line.startswith("# "):
            return line[2:].strip()[:200]
    return stem


def _error(code, message, data=None):
    raise AsError(code, message, data=data)


def _actor(actor):
    if actor not in ("coordinator", "operator"):
        _error(INTERNAL, "Unknown ticket actor.")


def get(tx, workspace, key):
    row = tx.conn.execute("SELECT * FROM tickets WHERE workspace = ? AND key = ?", (workspace, key)).fetchone()
    if row is None:
        _error(TICKET_NOT_FOUND, "Ticket does not exist.", {"key": key})
    return dict(row)


def registered_worktree(tx, team_workspace, path, *, state_dir=None):
    """Return a live ticket's registered worktree, or reject every other path."""
    from . import worktrees
    canonical = os.path.realpath(path)
    team_workspace = os.path.realpath(team_workspace)
    row = tx.conn.execute(
        "SELECT 1 FROM tickets WHERE workspace = ? AND worktree_path = ? AND status NOT IN "
        f"({','.join('?' * len(TICKET_TERMINAL))}) LIMIT 1",
        (team_workspace, canonical) + tuple(TICKET_TERMINAL)).fetchone()
    listed = any(item["path"] == canonical
                 for item in worktrees.list_registered(team_workspace, state_dir=state_dir))
    if row is None or not listed:
        raise AsError(WORKTREE_NOT_REGISTERED, "Workspace is not a registered live ticket worktree.",
                      data={"workspace": canonical})
    return canonical


def record_worktree(tx, ticket, created):
    """Persist the coordinator-created worktree and its durable ticket event."""
    ticket = get(tx, ticket["workspace"], ticket["key"])
    payload = {"branch": created["branch"], "path": created["path"], "baseCommit": created["baseCommit"]}
    seq = tx.update("ticket", ticket["id"],
                    {"branch": created["branch"], "worktree_path": created["path"],
                     "base_commit": created["baseCommit"]},
                    "ticket.worktree_created", payload)
    out = tx.get("ticket", ticket["id"])
    _ticket_event(tx, out, seq, "ticket.worktree_created", "coordinator", out["status"], out["status"], payload)
    return out


def next_key(tx, workspace):
    numbers = [int(r[0][2:]) for r in tx.conn.execute(
        "SELECT key FROM tickets WHERE workspace = ? AND key GLOB 'T-[0-9]*'", (workspace,))
               if r[0][2:].isdigit()]
    return f"T-{max(numbers, default=0) + 1:03d}"


def _ticket_event(tx, ticket, seq, name, actor, from_status, to_status, payload):
    tx.conn.execute("INSERT INTO ticket_events (ticket_id, event_seq, at, actor, name, from_status, to_status, payload_json) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (ticket["id"], seq, utcnow(), actor, name, from_status, to_status,
                     json.dumps(payload, ensure_ascii=True, sort_keys=True, separators=(",", ":"))))


def _invalid(ticket, to, actor):
    _error(TICKET_TRANSITION_INVALID, "Ticket transition is not allowed.",
           {"key": ticket["key"], "from": ticket["status"], "to": to, "actor": actor})


def _busy(tx, ticket, actor):
    if actor != "operator" or not ticket["run_id"]:
        return
    row = tx.conn.execute("SELECT status FROM workflow_runs WHERE id = ?", (ticket["run_id"],)).fetchone()
    if row is not None and row[0] in ("queued", "running", "paused"):
        _error(TICKET_BUSY, "Ticket has an active run.", {"key": ticket["key"], "runId": ticket["run_id"]})


def create(tx, workspace, kind, fields, hold=False):
    if kind not in schema.TICKET_KINDS or (kind == "bug" and hold):
        _error(TICKET_TRANSITION_INVALID, "Ticket kind cannot be created in that state.")
    values = dict(fields, workspace=workspace, key=next_key(tx, workspace), kind=kind)
    # Let the store retain its established unknown-column check before any write.
    from .store import _check_columns, new_id
    _check_columns(schema.ENTITIES["ticket"], values)
    status = "backlog" if hold else {"feature": "ready_unpack", "story": "refine", "bug": "triage"}[kind]
    ident = new_id()
    payload = {"ticketId": ident, "key": values["key"], "kind": kind, "status": status}
    tx.create("ticket", values, state=status, event="ticket.created", payload=payload, entity_id=ident)
    ticket = tx.get("ticket", ident)
    _ticket_event(tx, ticket, tx.events[-1], "ticket.created", "coordinator", None, status, payload)
    return ticket


def _transition(tx, ticket, to, actor, reason=None, values=None):
    payload = {"ticketId": ticket["id"], "key": ticket["key"], "from": ticket["status"], "to": to,
               "by": actor, "reason": reason}
    seq = tx.transition("ticket", ticket["id"], to, event="ticket.moved", payload=payload, set_values=values)
    out = tx.get("ticket", ticket["id"])
    _ticket_event(tx, out, seq, "ticket.moved", actor, ticket["status"], to, payload)
    return out


def move(tx, ticket, to, actor, reason=None):
    _actor(actor)
    ticket = get(tx, ticket["workspace"], ticket["key"])
    if to == "blocked":
        return block(tx, ticket, actor, reason)
    if to == "cancelled":
        return cancel(tx, ticket, actor, reason)
    if ((ticket["status"], to, actor) not in TRANSITIONS or to not in KIND_STATUSES[ticket["kind"]]
            or ticket["status"] not in KIND_STATUSES[ticket["kind"]]):
        _invalid(ticket, to, actor)
    _busy(tx, ticket, actor)
    values = {"return_status": None, "blocked_reason": None} if ticket["status"] == "blocked" else None
    return _transition(tx, ticket, to, actor, reason, values)


def block(tx, ticket, actor, reason):
    _actor(actor)
    ticket = get(tx, ticket["workspace"], ticket["key"])
    if ticket["status"] in TICKET_TERMINAL or ticket["status"] == "blocked":
        _invalid(ticket, "blocked", actor)
    _busy(tx, ticket, actor)
    restore = TICKET_WORKING.get(ticket["status"], (ticket["status"],))[0]
    return _transition(tx, ticket, "blocked", actor, reason,
                       {"return_status": restore, "blocked_reason": reason})


def unblock(tx, ticket, actor):
    _actor(actor)
    ticket = get(tx, ticket["workspace"], ticket["key"])
    if ticket["status"] != "blocked":
        _invalid(ticket, ticket["status"], actor)
    _busy(tx, ticket, actor)
    return _transition(tx, ticket, ticket["return_status"], actor, None,
                       {"return_status": None, "blocked_reason": None})


def cancel(tx, ticket, actor, reason=None):
    _actor(actor)
    ticket = get(tx, ticket["workspace"], ticket["key"])
    if ticket["status"] in TICKET_TERMINAL:
        _invalid(ticket, "cancelled", actor)
    values = {"return_status": None, "blocked_reason": None} if ticket["status"] == "blocked" else None
    return _transition(tx, ticket, "cancelled", actor, reason, values)


def _blockers(tx, ticket_id):
    return [r[0] for r in tx.conn.execute("SELECT blocked_by_ticket_id FROM ticket_deps WHERE ticket_id = ?", (ticket_id,))]


def _cycle(tx, start, target):
    pending, seen = [target], set()
    while pending:
        current = pending.pop()
        if current == start:
            return True
        if current not in seen:
            seen.add(current)
            pending.extend(_blockers(tx, current))
    return False


def _depends(tx, ticket, keys, remove):
    requested = [get(tx, ticket["workspace"], key) for key in keys]
    existing = set(_blockers(tx, ticket["id"]))
    changed = []
    if not remove:
        for other in requested:
            if other["id"] == ticket["id"] or _cycle(tx, ticket["id"], other["id"]):
                _error(TICKET_DEPENDENCY_CYCLE, "Ticket dependency would form a cycle.",
                       {"key": ticket["key"], "cycle": list(keys)})
            if other["id"] not in existing:
                changed.append(other["id"])
                existing.add(other["id"])
    else:
        changed = []
        for other in requested:
            if other["id"] in existing:
                changed.append(other["id"])
                existing.remove(other["id"])
    if not changed:
        return
    if remove:
        tx.conn.executemany("DELETE FROM ticket_deps WHERE ticket_id = ? AND blocked_by_ticket_id = ?",
                            [(ticket["id"], ident) for ident in changed])
    else:
        tx.conn.executemany("INSERT INTO ticket_deps (ticket_id, blocked_by_ticket_id) VALUES (?, ?)",
                            [(ticket["id"], ident) for ident in changed])
    names = [r[0] for r in tx.conn.execute("SELECT key FROM tickets WHERE id IN "
        "(SELECT blocked_by_ticket_id FROM ticket_deps WHERE ticket_id = ?) ORDER BY key", (ticket["id"],))]
    payload = {"ticketId": ticket["id"], "key": ticket["key"], "on": names}
    seq = tx.note("ticket", ticket["id"], "ticket.depends", payload)
    _ticket_event(tx, ticket, seq, "ticket.depends", "coordinator", ticket["status"], ticket["status"], payload)


def add_deps(tx, ticket, keys):
    _depends(tx, get(tx, ticket["workspace"], ticket["key"]), keys, False)


def remove_deps(tx, ticket, keys):
    _depends(tx, get(tx, ticket["workspace"], ticket["key"]), keys, True)


def deps_merged(tx, ticket):
    return tx.conn.execute("SELECT COUNT(*) FROM ticket_deps d JOIN tickets t ON t.id = d.blocked_by_ticket_id "
                           "WHERE d.ticket_id = ? AND t.status != 'merged'", (ticket["id"],)).fetchone()[0] == 0
