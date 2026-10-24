"""Read-only status of the runtime team started from a team definition (P04-S03). Imports no board module."""
from __future__ import annotations

from .protocol import AsError
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
