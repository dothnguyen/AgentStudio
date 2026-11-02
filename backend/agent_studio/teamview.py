"""Read-only Teams management projection (P05-S10): definitions + catalog + roles.json joined with runtime evidence by stable ids. Never reads tmux or pane output."""
from __future__ import annotations

import json
import sqlite3

from . import roles, teamdefs, teamstatus, textsafe
from .protocol import AsError
from .teams import ACTIVE

MAX_TEAMS = 50
MAX_MEMBERS = 16
MAX_TEXT = 200
MAX_ATTENTION_RUNS = 50
MAX_ATTENTION_COMMANDS = 25
MAX_BLOCKED_TICKETS = 25
MAX_REASON = 100
LIVE = ("starting", "running")


def _empty_attention():
    return {"runs": [], "commandRequests": [],
            "truncated": {"runs": False, "commandRequests": False}}


def _clip(value, limit=MAX_TEXT):
    return value[:limit] if isinstance(value, str) else None


def _roles_info(workspace):
    try:
        cfg = roles.load_config(workspace)
    except AsError as e:
        return None, {"state": "invalid", "message": e.message}
    if cfg is None:
        return None, {"state": "missing", "message": ".agent-studio/roles.json does not exist"}
    return cfg["roles"], {"state": "ok", "message": None}


def _catalog_info(workspace):
    try:
        return teamdefs._catalog(workspace), {"state": "ok", "message": None}
    except AsError as e:
        return None, {"state": "invalid", "message": e.message}


def _role_fields(role, roles_map):
    if roles_map is None:
        return {"roleDescription": None, "roleState": "unavailable"}
    if not isinstance(role, str) or role not in roles_map:
        return {"roleDescription": None, "roleState": "undefined"}
    entry = roles_map[role]
    desc = entry.get("description") if isinstance(entry, dict) else None
    return {"roleDescription": desc[:roles.LIMITS["description"]] if isinstance(desc, str) else None,
            "roleState": "defined"}


def _runtime_state(row, coordinator_running):
    if row is None:
        return "not_started"
    status = row["status"]
    if status in ("stopping", "stopped"):
        return "stopped"
    if status == "error":
        return "error"
    if status in LIVE and not coordinator_running:
        return "disconnected"
    return status


def _latest_runtime(conn, workspace, def_id):
    row = conn.execute("SELECT * FROM teams WHERE workspace = ? AND def_id = ? "
                       "ORDER BY created_at DESC, rowid DESC", (workspace, def_id)).fetchone()
    return dict(row) if row else None


def _runtime_agents(conn, team_id):
    rows = conn.execute(
        "SELECT id, team_id, member_id, display_name, role, provider_id, model, reasoning, availability, pane_state, "
        "configured_agents_json, active_catalog_agent, quota_holds_json, pending_agent, pending_assignment "
        "FROM agents WHERE team_id = ? ORDER BY ordinal", (team_id,)).fetchall()
    agents = []
    marks = ",".join("?" * len(ACTIVE))
    for row in rows:
        agent = dict(row)
        a = conn.execute(f"SELECT id, status, task_id FROM assignments WHERE agent_id = ? AND status IN ({marks}) "
                         "ORDER BY created_at DESC, rowid DESC LIMIT 1", (agent["id"],) + ACTIVE).fetchone()
        agent.update(configuredAgents=json.loads(agent["configured_agents_json"]) if agent["configured_agents_json"] is not None else None,
                     activeAgent=agent["active_catalog_agent"],
                     quotaHolds=json.loads(agent["quota_holds_json"]) if agent["quota_holds_json"] is not None else {},
                     pendingAgent=agent["pending_agent"], lastSwitch=teamstatus._last_switch(conn, agent),
                     assignment={"id": a["id"], "status": a["status"], "taskId": a["task_id"]} if a else None)
        agents.append(agent)
    return agents


def _work(conn, workspace, agent_id):
    marks = ",".join("?" * len(ACTIVE))
    a = conn.execute("SELECT a.id, a.status, a.task_id, t.goal FROM assignments a JOIN tasks t ON t.id = a.task_id "
                     f"WHERE a.agent_id = ? AND a.status IN ({marks}) ORDER BY a.created_at DESC, a.rowid DESC "
                     "LIMIT 1", (agent_id,) + ACTIVE).fetchone()
    run = conn.execute("SELECT id FROM workflow_runs WHERE task_id = ?", (a["task_id"],)).fetchone() if a else None
    tk = conn.execute("SELECT key, title, status, workflow_status, active_run_id FROM tickets WHERE workspace = ? AND assignee = ? "
                      "ORDER BY updated_at DESC LIMIT 1", (workspace, agent_id)).fetchone()
    if a is None and tk is None:
        return {"state": "none"}
    out = {"state": "working",
            "assignment": None if a is None else {
                "id": a["id"], "status": a["status"], "taskId": a["task_id"],
                "goal": textsafe.one_line(a["goal"] or "", MAX_TEXT),
                "workflowRunId": run["id"] if run else None},
            "ticket": None if tk is None else {
                "key": tk["key"], "title": textsafe.one_line(tk["title"] or "", MAX_TEXT),
                "status": tk["status"], "workflowStatus": tk["workflow_status"] or tk["status"],
                "workflowRunId": tk["active_run_id"]}}
    run_id = (tk["active_run_id"] if tk is not None else None) or (run["id"] if run else None)
    if run_id:   # P06: the member's run is parked while the coordinator runs delegated commands for it
        try:
            reqs = conn.execute("SELECT command_id, status FROM command_requests WHERE workflow_run_id = ? "
                                "AND status IN ('requested', 'approved', 'running') ORDER BY ordinal",
                                (run_id,)).fetchall()
        except sqlite3.Error:  # a reader opened before the schema-18 migration has no command_requests table
            reqs = []
        if reqs:
            out["delegation"] = {"commands": [r["command_id"] for r in reqs],
                                 "state": ("running" if any(r["status"] == "running" for r in reqs) else
                                           "awaiting_approval" if all(r["status"] == "requested" for r in reqs)
                                           else "queued")}
    return out


_RUN_ATTENTION_SQL = """
SELECT * FROM (
    SELECT w.id AS run_id, w.team_id AS team_id, w.status AS status, w.current_stage AS stage,
           ag.member_id AS member_id,
           (SELECT key FROM tickets WHERE active_run_id = w.id ORDER BY updated_at DESC, rowid DESC LIMIT 1) AS ticket_key,
           a.id AS assignment_id, a.status AS assignment_status, a.diagnostic_code AS diagnostic_code,
           sa.phase AS phase,
           ROW_NUMBER() OVER (PARTITION BY w.team_id ORDER BY w.updated_at DESC, w.rowid DESC) AS rn
    FROM workflow_runs w
    LEFT JOIN stage_attempts sa ON sa.id = (
        SELECT id FROM stage_attempts WHERE workflow_run_id = w.id ORDER BY rowid DESC LIMIT 1)
    LEFT JOIN agents ag ON ag.id = sa.agent_id
    LEFT JOIN assignments a ON a.id = (
        SELECT id FROM assignments WHERE task_id = w.task_id ORDER BY created_at DESC, rowid DESC LIMIT 1)
    WHERE w.team_id IN ({marks}) AND w.status IN ('queued', 'running', 'paused')
) WHERE rn <= ?
ORDER BY team_id, rn
"""

_COMMAND_ATTENTION_SQL = """
SELECT * FROM (
    SELECT c.id AS id, c.team_id AS team_id, c.command_id AS command, c.status AS status, c.reason AS reason,
           c.workflow_run_id AS workflow_run_id, ag.member_id AS member_id,
           ROW_NUMBER() OVER (PARTITION BY c.team_id ORDER BY c.created_at DESC, c.rowid DESC) AS rn
    FROM command_requests c
    LEFT JOIN stage_attempts sa ON sa.id = (
        SELECT id FROM stage_attempts WHERE workflow_run_id = c.workflow_run_id ORDER BY rowid DESC LIMIT 1)
    LEFT JOIN agents ag ON ag.id = sa.agent_id
    WHERE c.team_id IN ({marks}) AND c.status IN ('requested', 'approved', 'running')
) WHERE rn <= ?
ORDER BY team_id, rn
"""

_BLOCKED_TICKETS_SQL = """
SELECT t.key, t.title, t.blocked_reason, t.return_status, t.updated_at, ag.member_id
FROM tickets t
LEFT JOIN workflow_runs w ON w.id = t.run_id
LEFT JOIN stage_attempts sa ON sa.id = (
    SELECT id FROM stage_attempts WHERE workflow_run_id = w.id ORDER BY rowid DESC LIMIT 1)
LEFT JOIN agents ag ON ag.id = sa.agent_id
WHERE t.workspace = ? AND COALESCE(t.workflow_status, t.status) = 'blocked'
ORDER BY t.updated_at DESC, t.rowid DESC
LIMIT ?
"""


def _one_line_or_none(value, limit):
    return textsafe.one_line(value, limit) if isinstance(value, str) else None


def _attention_run(row):
    return {"workflowRunId": row["run_id"], "status": row["status"], "stage": _str(row["stage"]),
            "memberId": _str(row["member_id"]), "ticketKey": _str(row["ticket_key"]),
            "assignmentId": _str(row["assignment_id"]), "assignmentStatus": _str(row["assignment_status"]),
            "diagnosticCode": _str(row["diagnostic_code"]), "delegating": row["phase"] == "delegating"}


def _attention_command(row):
    return {"id": row["id"], "command": row["command"], "status": row["status"],
            "reason": _one_line_or_none(row["reason"], MAX_REASON),
            "workflowRunId": row["workflow_run_id"], "memberId": _str(row["member_id"])}


def _blocked_ticket(row):
    return {"key": row["key"], "title": textsafe.one_line(row["title"] or "", MAX_TEXT),
            "reason": _one_line_or_none(row["blocked_reason"], MAX_REASON),
            "returnStatus": _str(row["return_status"]), "memberId": _str(row["member_id"]),
            "updatedAt": row["updated_at"]}


def _attention(conn, workspace, team_ids):
    """Workspace attention evidence in at most three queries (runs, delegated commands, blocked tickets).
    Returns ({team_id: attention}, blockedTickets, blockedTicketsTruncated, failed)."""
    attention = {team_id: _empty_attention() for team_id in team_ids}
    blocked, blocked_truncated, failed = [], False, False
    if conn is None:
        return attention, blocked, blocked_truncated, failed
    if team_ids:
        marks = ",".join("?" * len(team_ids))
        try:
            rows = conn.execute(_RUN_ATTENTION_SQL.format(marks=marks),
                                tuple(team_ids) + (MAX_ATTENTION_RUNS + 1,)).fetchall()
            counts = {}
            for row in rows:
                counts[row["team_id"]] = counts.get(row["team_id"], 0) + 1
            for row in rows:
                if counts[row["team_id"]] > MAX_ATTENTION_RUNS and row["rn"] == MAX_ATTENTION_RUNS + 1:
                    continue
                attention[row["team_id"]]["runs"].append(_attention_run(row))
            for team_id, count in counts.items():
                attention[team_id]["truncated"]["runs"] = count > MAX_ATTENTION_RUNS
        except sqlite3.Error:
            failed = True
            for team_id in team_ids:
                attention[team_id]["runs"] = []
                attention[team_id]["truncated"]["runs"] = False
        try:
            rows = conn.execute(_COMMAND_ATTENTION_SQL.format(marks=marks),
                                tuple(team_ids) + (MAX_ATTENTION_COMMANDS + 1,)).fetchall()
            counts = {}
            for row in rows:
                counts[row["team_id"]] = counts.get(row["team_id"], 0) + 1
            for row in rows:
                if counts[row["team_id"]] > MAX_ATTENTION_COMMANDS and row["rn"] == MAX_ATTENTION_COMMANDS + 1:
                    continue
                attention[row["team_id"]]["commandRequests"].append(_attention_command(row))
            for team_id, count in counts.items():
                attention[team_id]["truncated"]["commandRequests"] = count > MAX_ATTENTION_COMMANDS
        except sqlite3.Error as e:
            # schema 18 added command_requests; a reader opened before that migration simply has no table.
            if "no such table" not in str(e).lower():
                failed = True
            for team_id in team_ids:
                attention[team_id]["commandRequests"] = []
                attention[team_id]["truncated"]["commandRequests"] = False
    try:
        rows = conn.execute(_BLOCKED_TICKETS_SQL, (workspace, MAX_BLOCKED_TICKETS + 1)).fetchall()
        blocked_truncated = len(rows) > MAX_BLOCKED_TICKETS
        blocked = [_blocked_ticket(row) for row in rows[:MAX_BLOCKED_TICKETS]]
    except sqlite3.Error:
        failed = True
        blocked, blocked_truncated = [], False
    return attention, blocked, blocked_truncated, failed


def _str(value):
    return value if isinstance(value, str) else None


def _agent_options(member, catalog):
    if member is not None and "agents" in member:
        mode, ids = "ordered_catalog", member["agents"]
        ids = ids if isinstance(ids, list) else []
    elif member is not None and "agent" in member:
        mode, ids = "single_catalog", [member["agent"]]
    else:
        mode, ids = "inline", []
    options = []
    for agent_id in ids:
        entry = (catalog or {}).get(agent_id) if isinstance(agent_id, str) else None
        exists = isinstance(agent_id, str) and catalog is not None and agent_id in catalog
        entry = entry if isinstance(entry, dict) else {}
        options.append({"id": agent_id, **{key: _clip(entry.get(key)) for key in
                       ("name", "provider", "model", "reasoning", "description")},
                        "state": "ok" if exists else "missing"})
    return mode, options, ids[0] if ids else None


def _member(cfg_member, agent_row, roles_map, catalog, team_state, conn, workspace):
    agent_mode, agent_options, default_agent = _agent_options(cfg_member, catalog)
    if cfg_member is not None:
        r = teamdefs.resolve_member(cfg_member, catalog or {})
        source, agent_def = r["source"], r["agent"]
        if source == "catalog":
            state = "unavailable" if catalog is None else ("ok" if agent_def in catalog else "missing")
        else:
            state = None
        ok = source == "inline" or state == "ok"
        member_id, name, role = r["id"], r["name"], r["role"]
        provider, model, reasoning = ((r["provider"], r["model"], r["reasoning"]) if ok else (None, None, None))
    else:
        source, agent_def, state = "runtime", None, None
        member_id, name, role = agent_row["member_id"], agent_row["display_name"], agent_row["role"]
        provider = model = reasoning = None
    live = team_state in LIVE
    runtime = None
    if agent_row is not None:
        runtime = {"agentId": agent_row["id"], "availability": agent_row["availability"],
                   "paneState": agent_row["pane_state"],
                   **{key: agent_row[key] for key in ("configuredAgents", "activeAgent", "quotaHolds", "pendingAgent", "lastSwitch", "assignment")},
                   "provider": agent_row["provider_id"],
                   "model": agent_row["model"], "reasoning": agent_row["reasoning"], "stale": not live}
    if live and agent_row is not None:
        presence, work = agent_row["availability"], _work(conn, workspace, agent_row["id"])
    elif live:
        presence, work = "not_in_runtime", {"state": "unavailable", "reason": "not_in_runtime"}
    else:
        presence, work = team_state, {"state": "unavailable", "reason": team_state}
    return {"memberId": _str(member_id), "name": _clip(name), "role": _str(role),
            **_role_fields(role, roles_map),
            "source": source, "agentDefId": _str(agent_def), "agentDefState": state,
            "agentMode": agent_mode, "agentOptions": agent_options, "defaultAgent": default_agent,
            "provider": _str(provider), "model": _str(model), "reasoning": _str(reasoning),
            "runtime": runtime, "presence": presence, "work": work}


def _team_entry(conn, workspace, def_id, definition, load_error, runtime_row, roles_map, catalog,
                coordinator_running, runtime_error, attention=None):
    team_state = "unavailable" if runtime_error else _runtime_state(runtime_row, coordinator_running)
    if load_error is not None:
        block = {"state": "unreadable", "problems": [
            {"path": "$", "message": f"could not load team definition: {load_error.code}"}]}
    elif definition is None:
        block = {"state": "missing", "problems": []}
    else:
        problems = teamdefs.validate(workspace, definition, def_id)
        block = {"state": "problems" if problems else "valid", "problems": problems}
    agents = _runtime_agents(conn, runtime_row["id"]) if conn is not None and runtime_row else []
    by_member = {}
    leftovers = []
    for ag in agents:
        if ag["member_id"] is not None and ag["member_id"] not in by_member:
            by_member[ag["member_id"]] = ag
        else:
            leftovers.append(ag)
    members = []
    cfg_members = definition.get("members") if definition else None
    for m in cfg_members if isinstance(cfg_members, list) else []:
        if isinstance(m, dict):
            members.append((m, by_member.pop(m.get("id"), None)))
    rest = sorted(list(by_member.values()) + leftovers, key=lambda a: agents.index(a))
    members += [(None, ag) for ag in rest]
    total = len(members)
    out = [_member(m, ag, roles_map, catalog, team_state, conn, workspace) for m, ag in members[:MAX_MEMBERS]]
    if definition:
        name = _clip(definition.get("name"))
    else:
        name = _clip(runtime_row["name"]) if runtime_row else None
    return {"id": def_id, "name": name, "definition": block,
            "runtime": {"state": team_state, "teamId": runtime_row["id"] if runtime_row else None,
                        "status": runtime_row["status"] if runtime_row else None},
            "members": out, "membersTruncated": total > MAX_MEMBERS,
            "attention": attention if attention is not None else _empty_attention()}


def overview(conn, workspace, coordinator_running, runtime_error):
    roles_map, roles_status = _roles_info(workspace)
    catalog, catalog_status = _catalog_info(workspace)
    ids = teamdefs.list_ids(workspace)
    entries = []
    for def_id in ids[:MAX_TEAMS]:
        definition, error = None, None
        try:
            definition = teamdefs.load(workspace, def_id)
        except AsError as e:
            error = e
        row = _latest_runtime(conn, workspace, def_id) if conn is not None else None
        entries.append((def_id, definition, error, row))
    dropped = 0
    if conn is not None:
        known = set(ids)
        rows = conn.execute("SELECT * FROM teams WHERE workspace = ? AND status IN "
                            "('starting','running','stopping','error') ORDER BY created_at DESC, rowid DESC",
                            (workspace,)).fetchall()
        for row in rows:
            row = dict(row)
            if row["def_id"] is not None and row["def_id"] in known:
                continue
            if len(entries) >= MAX_TEAMS:
                dropped += 1
                continue
            entries.append((row["def_id"], None, None, row))
    running_ids = [] if runtime_error is not None else [
        row["id"] for (_, _, _, row) in entries if row is not None and row["status"] == "running"]
    attention, blocked, blocked_truncated, attention_failed = _attention(conn, workspace, running_ids)
    teams = []
    for def_id, definition, error, row in entries:
        entry_attention = attention.get(row["id"]) if row is not None else None
        teams.append(_team_entry(conn, workspace, def_id, definition, error, row, roles_map, catalog,
                                 coordinator_running, runtime_error, entry_attention))
    partial = (runtime_error is not None or roles_status["state"] != "ok" or catalog_status["state"] != "ok"
               or attention_failed
               or any(t["definition"]["state"] in ("unreadable", "missing") for t in teams))
    return {"workspace": workspace, "coordinator": {"running": bool(coordinator_running)},
            "runtimeState": {"available": runtime_error is None, "error": runtime_error},
            "roles": roles_status, "catalog": catalog_status, "teams": teams,
            "blockedTickets": blocked, "blockedTicketsTruncated": blocked_truncated,
            "truncated": len(ids) > MAX_TEAMS or dropped > 0, "partial": partial}
