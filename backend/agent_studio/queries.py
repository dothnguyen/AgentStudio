"""Read-only queries: snapshot and events.after. Each runs in one read transaction (consistent WAL snapshot)."""
from __future__ import annotations

import json
import os
from types import SimpleNamespace
from typing import Optional

from . import board, board_config, board_scheduler, schema
from .protocol import AsError, BOARD_CONFIG_INVALID, TICKET_NOT_FOUND
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


def ticket_detail(conn, workspace: str, key: str) -> dict:
    def run():
        ticket = conn.execute("SELECT * FROM tickets WHERE workspace = ? AND key = ?", (workspace, key)).fetchone()
        if ticket is None:
            raise AsError(TICKET_NOT_FOUND, "Ticket does not exist.", data={"key": key})
        deps = conn.execute("SELECT t.key FROM ticket_deps d JOIN tickets t ON t.id = d.blocked_by_ticket_id "
                            "WHERE d.ticket_id = ? ORDER BY t.key", (ticket["id"],)).fetchall()
        dependents = conn.execute("SELECT t.key FROM ticket_deps d JOIN tickets t ON t.id = d.ticket_id "
                                  "WHERE d.blocked_by_ticket_id = ? ORDER BY t.key", (ticket["id"],)).fetchall()
        events = conn.execute("SELECT * FROM (SELECT * FROM ticket_events WHERE ticket_id = ? ORDER BY id DESC LIMIT 50) "
                              "ORDER BY id", (ticket["id"],)).fetchall()
        return {"dbId": db_id(conn), "cursor": head(conn), "ticket": row_to_json(ticket),
                "dependsOn": [r[0] for r in deps], "dependents": [r[0] for r in dependents],
                "events": [row_to_json(r) for r in events]}
    return _read(conn, run)


def ticket_list(conn, workspace: str, status=None, kind=None) -> dict:
    def run():
        clauses, params = ["workspace = ?"], [workspace]
        if status is not None:
            clauses.append("status = ?")
            params.append(status)
        if kind is not None:
            clauses.append("kind = ?")
            params.append(kind)
        rows = conn.execute("SELECT * FROM tickets WHERE " + " AND ".join(clauses) +
                            " ORDER BY priority, created_at, key", params).fetchall()
        return {"dbId": db_id(conn), "cursor": head(conn), "tickets": [row_to_json(r) for r in rows]}
    return _read(conn, run)


TERMINAL_SHOWN = 10


def _board_row(conn, workspace):
    row = conn.execute("SELECT status, reason FROM board_state WHERE workspace = ?", (workspace,)).fetchone()
    return {"status": row["status"], "reason": row["reason"]} if row else {"status": "stopped", "reason": None}


def _board_team(conn, workspace):
    return conn.execute("SELECT * FROM teams WHERE workspace = ? AND status NOT IN ('stopped', 'error') "
                        "ORDER BY created_at, id LIMIT 1", (workspace,)).fetchone()


def _board_agents(conn, team):
    if team is None:
        return []
    rows = conn.execute("SELECT * FROM agents WHERE team_id = ? ORDER BY ordinal", (team["id"],)).fetchall()
    return [{"agentId": r["id"], "name": r["display_name"], "role": r["role"], "availability": r["availability"],
             "limitResetAt": r["limit_reset_at"]} for r in rows]


def _board_held(conn, workspace):
    """Live holds for the workspace; [] when the directory, board.json or git cannot be read."""
    if not os.path.isdir(workspace):
        return []
    tx = SimpleNamespace(conn=conn)
    try:
        row = conn.execute("SELECT config_json FROM board_state WHERE workspace = ?", (workspace,)).fetchone()
        config = json.loads(row[0]) if row and row[0] else board_config.current(tx, workspace, None)
        held = list(board_scheduler.holds(tx, workspace, config))
        if conn.execute("SELECT 1 FROM tickets WHERE workspace = ? AND status = 'ready_merge' LIMIT 1",
                        (workspace,)).fetchone():
            reason = board.merge_hold(tx, workspace, config)
            if reason:
                held.append({"column": "merge", "reason": reason})
        return held
    except AsError as error:
        if error.code == BOARD_CONFIG_INVALID:
            return []
        raise
    except Exception:
        return []


def _board_ticket(conn, r, names):
    open_deps = [x[0] for x in conn.execute(
        "SELECT t.key FROM ticket_deps d JOIN tickets t ON t.id = d.blocked_by_ticket_id "
        "WHERE d.ticket_id = ? AND t.status != 'merged' ORDER BY t.key", (r["id"],))]
    return {"key": r["key"], "kind": r["kind"], "title": r["title"], "priority": r["priority"], "severity": r["severity"],
            "assignee": names.get(r["assignee_agent_id"]), "runId": r["run_id"],
            "rounds": {"dev": r["dev_rounds"], "test": r["test_rounds"], "review": r["review_rounds"]},
            "blockedReason": r["blocked_reason"], "depsOpen": open_deps}


def _board_columns(conn, workspace):
    names = {r["id"]: r["display_name"] for r in conn.execute("SELECT id, display_name FROM agents")}
    columns = []
    for status in schema.TICKET_STATES:
        count = conn.execute("SELECT COUNT(*) FROM tickets WHERE workspace = ? AND status = ?",
                             (workspace, status)).fetchone()[0]
        if status in schema.TICKET_TERMINAL:
            order, limit = "updated_at DESC, key", f" LIMIT {TERMINAL_SHOWN}"
        else:
            order, limit = "priority, created_at, key", ""
        rows = conn.execute(f"SELECT * FROM tickets WHERE workspace = ? AND status = ? ORDER BY {order}{limit}",
                            (workspace, status)).fetchall()
        columns.append({"status": status, "count": count, "tickets": [_board_ticket(conn, r, names) for r in rows]})
    return columns


def board_show(conn, workspace: str) -> dict:
    def run():
        team = _board_team(conn, workspace)
        return {"dbId": db_id(conn), "cursor": head(conn), "workspace": workspace, "board": _board_row(conn, workspace),
                "columns": _board_columns(conn, workspace), "agents": _board_agents(conn, team),
                "held": _board_held(conn, workspace)}
    return _read(conn, run)


def board_list(conn) -> dict:
    def run():
        paths = sorted({r[0] for r in conn.execute("SELECT workspace FROM tickets UNION SELECT workspace FROM board_state")})
        boards = []
        for workspace in paths:
            exists = os.path.isdir(workspace)
            state = _board_row(conn, workspace)
            if not exists:
                state = {"status": "unavailable", "reason": None}
            team = _board_team(conn, workspace)
            agents = _board_agents(conn, team)
            counts = {r[0]: r[1] for r in conn.execute(
                "SELECT status, COUNT(*) FROM tickets WHERE workspace = ? GROUP BY status", (workspace,))}
            boards.append({
                "workspace": workspace, "name": os.path.basename(workspace.rstrip("/")) or workspace,
                "status": state["status"], "reason": state["reason"],
                "team": {"teamId": team["id"], "status": team["status"]} if team else None,
                "counts": {s: counts[s] for s in schema.TICKET_STATES if s in counts},
                "agents": {"total": len(agents), **{key: sum(1 for a in agents if a["availability"] == value)
                                                    for key, value in (("idle", "idle"), ("busy", "busy"),
                                                                       ("limitReached", "limit_reached"))}},
                "limits": [{"agent": a["name"], "role": a["role"], "resetAt": a["limitResetAt"]}
                           for a in agents if a["availability"] == "limit_reached"],
                "held": _board_held(conn, workspace) if exists else []})
        return {"dbId": db_id(conn), "cursor": head(conn), "boards": boards}
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
