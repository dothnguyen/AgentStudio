"""Read-only queries: snapshot, events.after, and activity.recent.

Each runs in one read transaction (consistent WAL snapshot).
"""
from __future__ import annotations

import json
from typing import Optional

from . import schema
from .protocol import AsError, BAD_REQUEST
from .state import SCHEMA_VERSION, db_id, utcnow

CURSOR_INVALID = "CURSOR_INVALID"
SECTION_LIMIT = 1000
RECENT_ACTIVITY_DEFAULT_LIMIT = 15
RECENT_ACTIVITY_MAX_LIMIT = 20

RECENT_EVENT_NAMES = frozenset({
    "team.running",
    "team.stopped",
    "assignment.succeeded",
    "assignment.waiting_input",
    "assignment.failed",
    "workflow_run.succeeded",
    "workflow_run.failed",
    "workflow_run.paused",
})

RECENT_TICKET_EVENT_NAMES = frozenset({
    "ticket.moved",
    "ticket.outcome_applied",
    "ticket.merged",
})

RECENT_ACTIVITY_KINDS = ("team", "assignment", "workflow", "ticket")

# Event-name prefix in the `events` table for each non-ticket kind.
RECENT_EVENT_KIND_PREFIXES = {
    "team": "team.",
    "assignment": "assignment.",
    "workflow": "workflow_run.",
}

RECENT_ACTIVITY_KINDS_MESSAGE = ("Argument 'kinds' must be a non-empty list drawn from "
                                 "team, assignment, workflow, ticket.")

SECTIONS = (("teams", "team"), ("agents", "agent"), ("tasks", "task"), ("workflowRuns", "workflow_run"),
            ("stageAttempts", "stage_attempt"), ("assignments", "assignment"))


def _camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(p.capitalize() for p in rest)


def row_to_json(row) -> dict:
    out = {}
    for key in row.keys():
        value = row[key]
        if key.endswith("_json"):
            key = key[:-5]
            value = json.loads(value) if value is not None else None
        out[_camel(key)] = value
    return out


def _read(conn, fn):
    conn.execute("BEGIN")
    try:
        return fn()
    finally:
        conn.execute("COMMIT")


def head(conn) -> int:
    row = conn.execute("SELECT MAX(seq) FROM events").fetchone()
    return int(row[0] or 0)


def validate_activity_kinds(kinds) -> frozenset:
    if kinds is None:
        return frozenset(RECENT_ACTIVITY_KINDS)
    if not isinstance(kinds, list) or not kinds:
        raise AsError(BAD_REQUEST, RECENT_ACTIVITY_KINDS_MESSAGE)
    for kind in kinds:
        if not (isinstance(kind, str) and kind in RECENT_ACTIVITY_KINDS):
            raise AsError(BAD_REQUEST, RECENT_ACTIVITY_KINDS_MESSAGE)
    return frozenset(kinds)


def recent_activity(conn, workspace: str, limit: int = RECENT_ACTIVITY_DEFAULT_LIMIT, kinds=None) -> dict:
    def run():
        if isinstance(limit, bool) or not isinstance(limit, int) or not (1 <= limit <= RECENT_ACTIVITY_MAX_LIMIT):
            raise AsError(BAD_REQUEST, "Argument 'limit' must be an integer between 1 and 20.")

        selected = validate_activity_kinds(kinds)
        top = head(conn)
        event_names = sorted(name for name in RECENT_EVENT_NAMES
                             if any(name.startswith(RECENT_EVENT_KIND_PREFIXES[k]) for k in selected if k != "ticket"))
        event_rows = [] if not event_names else conn.execute(
            f"""SELECT e.seq, e.at, e.name, e.team_id, e.assignment_id, e.workflow_run_id,
                       t.name AS team_name
                FROM events e
                JOIN teams t ON t.id = e.team_id
                WHERE t.workspace = ? AND e.name IN ({', '.join('?' * len(event_names))})
                ORDER BY e.at DESC, e.seq DESC
                LIMIT ?""",
            [workspace, *event_names, limit],
        ).fetchall()

        ticket_event_names = sorted(RECENT_TICKET_EVENT_NAMES)
        ticket_rows = [] if "ticket" not in selected else conn.execute(
            f"""SELECT te.id, te.at, te.name, te.from_status, te.to_status,
                       ti.id AS ticket_id, ti.key AS ticket_key
                FROM ticket_events te
                JOIN tickets ti ON ti.id = te.ticket_id
                WHERE ti.workspace = ?
                  AND te.name IN ({', '.join('?' * len(ticket_event_names))})
                  AND (te.name = 'ticket.merged'
                       OR (te.from_status IS NOT NULL AND te.to_status IS NOT NULL
                           AND te.from_status <> te.to_status))
                ORDER BY te.at DESC, te.id DESC
                LIMIT ?""",
            [workspace, *ticket_event_names, limit],
        ).fetchall()

        entries = []
        for row in event_rows:
            name = row["name"]
            if name.startswith("team."):
                kind = "team"
                subject = {"type": kind, "id": row["team_id"], "label": row["team_name"]}
                summary = f"Team {row['team_name']} {'started' if name == 'team.running' else 'stopped'}"
            elif name.startswith("assignment."):
                kind = "assignment"
                subject = {"type": kind, "id": row["assignment_id"]}
                summary = {
                    "assignment.succeeded": "Assignment completed",
                    "assignment.waiting_input": "Assignment needs attention",
                    "assignment.failed": "Assignment failed",
                }[name]
            else:
                kind = "workflow"
                subject = {"type": kind, "id": row["workflow_run_id"]}
                summary = {
                    "workflow_run.succeeded": "Workflow finished",
                    "workflow_run.failed": "Workflow failed",
                    "workflow_run.paused": "Workflow needs attention",
                }[name]
            entries.append((row["at"], 1, row["seq"], {
                "id": f"event:{row['seq']}", "at": row["at"], "kind": kind, "name": name,
                "summary": summary, "subject": subject,
            }))

        for row in ticket_rows:
            name = row["name"]
            summary = (f"Ticket {row['ticket_key']} merged" if name == "ticket.merged" else
                       f"Ticket {row['ticket_key']} moved from {row['from_status']} to {row['to_status']}")
            entries.append((row["at"], 0, row["id"], {
                "id": f"ticket-event:{row['id']}", "at": row["at"], "kind": "ticket", "name": name,
                "summary": summary,
                "subject": {"type": "ticket", "id": row["ticket_id"], "label": row["ticket_key"]},
            }))

        entries.sort(key=lambda entry: entry[:3], reverse=True)
        return {"workspace": workspace, "dbId": db_id(conn), "head": top,
                "entries": [entry[3] for entry in entries[:limit]]}

    return _read(conn, run)


def snapshot(conn, team_id: Optional[str] = None, include_stopped: bool = False) -> dict:
    def run():
        out = {"dbId": db_id(conn), "schemaVersion": SCHEMA_VERSION, "cursor": head(conn), "generatedAt": utcnow(),
               "truncated": {}}
        if team_id:
            team_filter, params = "id = ?", [team_id]
        elif include_stopped:
            team_filter, params = "1 = 1", []
        else:
            team_filter, params = "status != 'stopped'", []
        team_ids_sql = f"SELECT id FROM teams WHERE {team_filter}"
        for section, entity in SECTIONS:
            table = schema.ENTITIES[entity].table
            where = team_filter if entity == "team" else f"team_id IN ({team_ids_sql})"
            rows = conn.execute(f"SELECT * FROM {table} WHERE {where} ORDER BY created_at DESC, id LIMIT ?",
                                params + [SECTION_LIMIT + 1]).fetchall()
            if len(rows) > SECTION_LIMIT:
                out["truncated"][section] = True
                rows = rows[:SECTION_LIMIT]
            out[section] = [row_to_json(r) for r in reversed(rows)]
        return out
    return _read(conn, run)


def event_to_json(row) -> dict:
    out = {"seq": row["seq"], "at": row["at"], "name": row["name"], "actor": row["actor"], "entity": row["entity"],
           "entityId": row["entity_id"]}
    for col in schema.EVENT_REF_COLS + ("command_seq", "report_id"):
        if row[col] is not None:
            out[_camel(col)] = row[col]
    if row["from_state"] is not None:
        out["from"] = row["from_state"]
    if row["to_state"] is not None:
        out["to"] = row["to_state"]
    out["data"] = json.loads(row["payload_json"])
    return out


def events_after(conn, cursor: int, limit: int = 200, team_id: Optional[str] = None,
                 expected_db_id: Optional[str] = None) -> dict:
    def run():
        current_db = db_id(conn)
        top = head(conn)
        if expected_db_id is not None and expected_db_id != current_db:
            raise AsError(CURSOR_INVALID, "The cursor belongs to a different database; take a new snapshot.",
                          data={"dbId": current_db, "head": top})
        if cursor > top:
            raise AsError(CURSOR_INVALID, f"Cursor {cursor} is ahead of the journal head {top}; take a new snapshot.",
                          data={"dbId": current_db, "head": top})
        if team_id:
            rows = conn.execute("SELECT * FROM events WHERE seq > ? AND team_id = ? ORDER BY seq LIMIT ?",
                                (cursor, team_id, limit)).fetchall()
        else:
            rows = conn.execute("SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?", (cursor, limit)).fetchall()
        has_more = len(rows) == limit
        next_cursor = rows[-1]["seq"] if has_more else top
        return {"dbId": current_db, "events": [event_to_json(r) for r in rows], "nextCursor": next_cursor,
                "head": top, "hasMore": has_more}
    return _read(conn, run)


def task_detail(conn, task_id: str) -> dict:
    """One task with its assignments and its event history (read-only, one consistent read)."""
    def run():
        row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        if row is None:
            raise AsError("NOT_FOUND", f"Task {task_id} does not exist.")
        assignments = conn.execute("SELECT * FROM assignments WHERE task_id = ? ORDER BY created_at, id",
                                   (task_id,)).fetchall()
        ids = [a["id"] for a in assignments]
        events = conn.execute(
            f"SELECT * FROM events WHERE task_id = ? OR assignment_id IN ({','.join('?' * len(ids)) or 'NULL'}) "
            f"ORDER BY seq LIMIT 1000", [task_id] + ids).fetchall()
        return {"dbId": db_id(conn), "cursor": head(conn), "task": row_to_json(row),
                "assignments": [row_to_json(a) for a in assignments], "events": [event_to_json(e) for e in events]}
    return _read(conn, run)


def workflow_detail(conn, wf_id: str) -> dict:
    """One workflow run with its stage attempts, task, assignments, and event history."""
    def run():
        wf = conn.execute("SELECT * FROM workflow_runs WHERE id = ?", (wf_id,)).fetchone()
        if wf is None:
            raise AsError("NOT_FOUND", f"Workflow run {wf_id} does not exist.")
        stages = conn.execute("SELECT * FROM stage_attempts WHERE workflow_run_id = ? ORDER BY created_at, rowid",
                              (wf_id,)).fetchall()
        task = conn.execute("SELECT * FROM tasks WHERE id = ?", (wf["task_id"],)).fetchone()
        assignments = conn.execute("SELECT * FROM assignments WHERE task_id = ? ORDER BY created_at, rowid",
                                   (wf["task_id"],)).fetchall()
        events = conn.execute("SELECT * FROM events WHERE workflow_run_id = ? OR task_id = ? ORDER BY seq LIMIT 2000",
                              (wf_id, wf["task_id"])).fetchall()
        out = {"dbId": db_id(conn), "cursor": head(conn), "workflowRun": row_to_json(wf),
               "stageAttempts": [row_to_json(r) for r in stages], "task": row_to_json(task),
               "assignments": [row_to_json(a) for a in assignments], "events": [event_to_json(e) for e in events]}
        out["visits"] = visits_per_stage(out["stageAttempts"])
        out["route"] = route_text(out["events"], out["workflowRun"].get("currentStage"))
        return out
    return _read(conn, run)


def visits_per_stage(attempts: list) -> dict:
    """{stage: number of visits}, in the order the stages were first entered."""
    out: dict = {}
    for a in attempts:
        out[a["stage"]] = max(out.get(a["stage"], 0), a.get("visit") or 1)
    return out


def route_text(events: list, current: Optional[str] = None) -> str:
    """The path a run took, e.g. `develop → qa (fail) → develop → qa (pass) → final (pass) → $succeed`. A verdict
    outcome is shown after the stage that gave it; `done` is not."""
    routed = [e["data"] for e in events if e["name"] == "workflow_run.routed"]
    if not routed:
        return current or ""
    parts = []
    for r in routed:
        label = f" ({r['outcome']})" if r["outcome"] in ("pass", "fail") else ""
        parts.append(r["fromStage"] + label)
    parts.append(routed[-1]["toStage"])
    return " → ".join(parts)
