"""Read-only status of the runtime team started from a team definition (P04-S03). Imports no board module."""
from __future__ import annotations

import json

from . import teamdefs
from .protocol import AsError
from .schema import AGENT_STATES
from .teams import ACTIVE


def _last_switch(conn, agent: dict) -> dict | None:
    event = conn.execute("SELECT * FROM events WHERE team_id = ? AND entity = 'agent' AND entity_id = ? AND name IN "
                         "('agent.switch_requested', 'agent.option_switched', 'agent.switch_failed') "
                         "ORDER BY seq DESC LIMIT 1", (agent["team_id"], agent["id"])).fetchone()
    if event is None:
        return None
    payload = json.loads(event["payload_json"])
    name = event["name"]
    state = {"agent.switch_requested": "pending", "agent.option_switched": "completed",
             "agent.switch_failed": "failed"}[name]
    requested, assignment = payload.get("toAgent"), payload.get("assignmentId")
    if state == "pending" and agent.get("pending_agent") is not None:
        requested, assignment = agent["pending_agent"], agent["pending_assignment"]
    if state == "failed" and (requested is None or assignment is None):
        prior = conn.execute("SELECT payload_json FROM events WHERE team_id = ? AND entity = 'agent' AND entity_id = ? "
                             "AND name = 'agent.switch_requested' AND seq < ? ORDER BY seq DESC LIMIT 1",
                             (agent["team_id"], agent["id"], event["seq"])).fetchone()
        if prior:
            previous = json.loads(prior["payload_json"])
            requested = requested if requested is not None else previous.get("toAgent")
            assignment = assignment if assignment is not None else previous.get("assignmentId")
    return {"state": state, "requestedAgent": requested, "assignmentId": assignment,
            "code": payload.get("code") if state == "failed" else None,
            "message": payload.get("message") if state == "failed" else None, "at": event["at"]}


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
        g = dict(g)
        a = conn.execute(f"SELECT id, status, task_id FROM assignments WHERE agent_id = ? AND status IN ({marks}) "
                         "ORDER BY created_at DESC, rowid DESC", (g["id"],) + ACTIVE).fetchone()
        members.append({"memberId": g["member_id"], "name": g["display_name"], "role": g["role"],
                        "provider": g["provider_id"], "agentId": g["id"], "availability": g["availability"],
                        "activeAgent": g["active_catalog_agent"],
                        "configuredAgents": json.loads(g["configured_agents_json"]) if g["configured_agents_json"] is not None else None,
                        "lastSwitch": _last_switch(conn, g),
                        "quotaHolds": json.loads(g["quota_holds_json"] or "{}"),
                        "pendingAgent": g["pending_agent"],
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
