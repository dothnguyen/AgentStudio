"""Read-only Teams management projection (P05-S10): definitions + catalog + roles.json joined with runtime evidence by stable ids. Never reads tmux or pane output."""
from __future__ import annotations

from . import roles, teamdefs, textsafe
from .protocol import AsError
from .teams import ACTIVE

MAX_TEAMS = 50
MAX_MEMBERS = 16
MAX_TEXT = 200
LIVE = ("starting", "running")


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
    return [dict(r) for r in conn.execute(
        "SELECT id, member_id, display_name, role, provider_id, model, reasoning, availability, pane_state "
        "FROM agents WHERE team_id = ? ORDER BY ordinal", (team_id,)).fetchall()]


def _work(conn, workspace, agent_id):
    marks = ",".join("?" * len(ACTIVE))
    a = conn.execute("SELECT a.id, a.status, a.task_id, t.goal FROM assignments a JOIN tasks t ON t.id = a.task_id "
                     f"WHERE a.agent_id = ? AND a.status IN ({marks}) ORDER BY a.created_at DESC, a.rowid DESC "
                     "LIMIT 1", (agent_id,) + ACTIVE).fetchone()
    run = conn.execute("SELECT id FROM workflow_runs WHERE task_id = ?", (a["task_id"],)).fetchone() if a else None
    tk = conn.execute("SELECT key, title, status, active_run_id FROM tickets WHERE workspace = ? AND assignee = ? "
                      "ORDER BY updated_at DESC LIMIT 1", (workspace, agent_id)).fetchone()
    if a is None and tk is None:
        return {"state": "none"}
    return {"state": "working",
            "assignment": None if a is None else {
                "id": a["id"], "status": a["status"], "taskId": a["task_id"],
                "goal": textsafe.one_line(a["goal"] or "", MAX_TEXT),
                "workflowRunId": run["id"] if run else None},
            "ticket": None if tk is None else {
                "key": tk["key"], "title": textsafe.one_line(tk["title"] or "", MAX_TEXT),
                "status": tk["status"], "workflowRunId": tk["active_run_id"]}}


def _str(value):
    return value if isinstance(value, str) else None


def _member(cfg_member, agent_row, roles_map, catalog, team_state, conn, workspace):
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
                   "paneState": agent_row["pane_state"], "provider": agent_row["provider_id"],
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
            "provider": _str(provider), "model": _str(model), "reasoning": _str(reasoning),
            "runtime": runtime, "presence": presence, "work": work}


def _team_entry(conn, workspace, def_id, definition, load_error, runtime_row, roles_map, catalog,
                coordinator_running, runtime_error):
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
            "members": out, "membersTruncated": total > MAX_MEMBERS}


def overview(conn, workspace, coordinator_running, runtime_error):
    roles_map, roles_status = _roles_info(workspace)
    catalog, catalog_status = _catalog_info(workspace)
    ids = teamdefs.list_ids(workspace)
    teams = []
    for def_id in ids[:MAX_TEAMS]:
        definition, error = None, None
        try:
            definition = teamdefs.load(workspace, def_id)
        except AsError as e:
            error = e
        row = _latest_runtime(conn, workspace, def_id) if conn is not None else None
        teams.append(_team_entry(conn, workspace, def_id, definition, error, row, roles_map, catalog,
                                 coordinator_running, runtime_error))
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
            if len(teams) >= MAX_TEAMS:
                dropped += 1
                continue
            teams.append(_team_entry(conn, workspace, row["def_id"], None, None, row, roles_map, catalog,
                                     coordinator_running, runtime_error))
    partial = (runtime_error is not None or roles_status["state"] != "ok" or catalog_status["state"] != "ok"
               or any(t["definition"]["state"] in ("unreadable", "missing") for t in teams))
    return {"workspace": workspace, "coordinator": {"running": bool(coordinator_running)},
            "runtimeState": {"available": runtime_error is None, "error": runtime_error},
            "roles": roles_status, "catalog": catalog_status, "teams": teams,
            "truncated": len(ids) > MAX_TEAMS or dropped > 0, "partial": partial}
