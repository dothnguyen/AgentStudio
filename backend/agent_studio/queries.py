"""Read-only queries: snapshot and events.after. Each runs in one read transaction (consistent WAL snapshot)."""
from __future__ import annotations

import json
from typing import Optional

from . import schema
from .protocol import AsError
from .state import SCHEMA_VERSION, db_id, utcnow

CURSOR_INVALID = "CURSOR_INVALID"
SECTION_LIMIT = 1000

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
