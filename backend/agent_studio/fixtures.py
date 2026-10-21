"""Debug-only fixture data (no tmux), created through the real transaction helper so it produces real events."""
from __future__ import annotations

from .store import Tx


def create_fixture_team(tx: Tx, agents: int, workspace: str) -> dict:
    # The team stays `starting`: it has no tmux session, so claiming `running` would be untrue (and the pane
    # monitor would rightly flag it as a lost session).
    team = tx.create("team", {"name": f"fixture team ({agents} agents)", "workspace": workspace})
    agent_ids = []
    for i in range(agents):
        a = tx.create("agent", {"team_id": team, "ordinal": i, "provider_id": "fake", "role": f"role-{i}",
                                "display_name": f"fake-{i}"})
        tx.transition("agent", a, "idle")
        agent_ids.append(a)
    task = tx.create("task", {"team_id": team, "origin": "direct", "workspace": workspace, "goal": "fixture task"})
    assignment = tx.create("assignment", {"team_id": team, "task_id": task, "agent_id": agent_ids[0], "attempt": 1,
                                          "policy": "read_only", "provider_id": "fake"})
    tx.transition("task", task, "assigned")
    return {"teamId": team, "agentIds": agent_ids, "taskId": task, "assignmentId": assignment,
            "eventSeqs": list(tx.events)}
