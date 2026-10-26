"""Read-only status of the runtime team started from a team definition (P04-S03). Imports no board module."""
from __future__ import annotations

from . import teamdefs
from .protocol import AsError
from .schema import AGENT_STATES
from .teams import ACTIVE


def team_status(conn, team_id, workspace, def_id) -> dict:
    if team_id is not None:
        row = conn.execute("SELECT * FROM teams WHERE id = ?", (team_id,)).fetchone()
        if row is None:
            raise AsError("NOT_FOUND", f"Team {team_id} does not exist.")
    else:
        row = conn.execute("SELECT * FROM teams WHERE workspace = ? AND def_id = ? "
                           "ORDER BY created_at DESC, rowid DESC", (workspace, def_id)).fetchone()
    if row is None:
        return {"team": None, "members": []}
    team = dict(row)
    members = []
    marks = ",".join("?" * len(ACTIVE))
    for g in conn.execute("SELECT * FROM agents WHERE team_id = ? ORDER BY ordinal", (team["id"],)).fetchall():
        a = conn.execute(f"SELECT id, status, task_id FROM assignments WHERE agent_id = ? AND status IN ({marks}) "
                         "ORDER BY created_at DESC, rowid DESC", (g["id"],) + ACTIVE).fetchone()
        members.append({"memberId": g["member_id"], "name": g["display_name"], "role": g["role"],
                        "provider": g["provider_id"], "agentId": g["id"], "availability": g["availability"],
                        "paneState": g["pane_state"],
                        "assignment": {"id": a["id"], "status": a["status"], "taskId": a["task_id"]} if a else None})
    return {"team": {"id": team["id"], "teamDefId": team["def_id"], "name": team["name"], "status": team["status"],
                     "workspace": team["workspace"]}, "members": members}


def workspace_teams(conn, workspace: str) -> dict:
    ids = teamdefs.list_ids(workspace)
    entries = []
    for definition_id in ids[:50]:
        try:
            definition = teamdefs.load(workspace, definition_id)
        except AsError as e:
            entries.append({"id": definition_id, "name": None, "members": 0,
                            "problems": [{"path": "$", "message":
                                          f"could not load team definition: {e.code}"}],
                            "runtime": None})
            continue

        definition_members = definition.get("members")
        entry = {"id": definition_id,
                 "name": definition.get("name") if isinstance(definition.get("name"), str) else None,
                 "members": len(definition_members) if isinstance(definition_members, list) else 0}
        problems = teamdefs.validate(workspace, definition, definition_id)
        if problems:
            entry["problems"] = problems

        status = team_status(conn, None, workspace, definition_id)
        runtime_team = status["team"]
        if runtime_team is None:
            entry["runtime"] = None
        else:
            availability = {state: 0 for state in AGENT_STATES}
            active_assignments = 0
            for member in status["members"]:
                availability[member["availability"]] += 1
                if member["assignment"] is not None:
                    active_assignments += 1
            entry["runtime"] = {"teamId": runtime_team["id"], "status": runtime_team["status"],
                                "memberCount": len(status["members"]), "availability": availability,
                                "activeAssignments": active_assignments}
        entries.append(entry)
    return {"workspace": workspace, "teams": entries, "truncated": len(ids) > 50}
