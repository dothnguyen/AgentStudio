"""The P03-S15 board fixture: one ticket per status, 12 merged, one open dependency, one limited agent.

Tickets are created by the caller (unit: tickets.create, integration: ticket.create) in `ticket_texts()` order;
`apply()` then sets statuses, rounds and so on with direct SQL, as the S13 integration tests do.
"""
from tests import helpers  # noqa: F401  (puts backend/ on sys.path)
from agent_studio import schema

LIMIT_RESET_AT = "2026-05-01T14:05:00Z"
TEAM_ID = "11111111-0000-4000-8000-000000000001"
AGENTS = (("Lead", "lead", "idle"), ("Developer", "dev-1", "busy"), ("QA", "qa-1", "limit_reached"))
EXTRA_MERGED = 11


def ticket_texts():
    return [f"Ticket in {status}" for status in schema.TICKET_STATES] + [f"Extra merged {n}" for n in range(1, EXTRA_MERGED + 1)]


def keys():
    return [f"T-{n:03d}" for n in range(1, len(ticket_texts()) + 1)]


def apply(conn, workspace, agent_ids=None):
    """Returns {name: agent id}."""
    by_key = dict(zip(keys(), schema.TICKET_STATES + ("merged",) * EXTRA_MERGED))
    for index, (key, status) in enumerate(by_key.items()):
        fields = {"status": status, "priority": 100, "updated_at": f"2026-01-01T00:00:{index:02d}Z"}
        if status == "blocked":
            fields.update(return_status="ready_dev", blocked_reason="ROUND_LIMIT:review")
        sets = ", ".join(f"{name} = ?" for name in fields)
        conn.execute(f"UPDATE tickets SET {sets} WHERE workspace = ? AND key = ?", (*fields.values(), workspace, key))
    conn.execute("INSERT INTO teams (id, name, workspace, status, created_at, updated_at) VALUES (?, 'team', ?, 'running', "
                 "'2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')", (TEAM_ID, workspace))
    ids = {}
    for ordinal, (role, name, availability) in enumerate(AGENTS):
        ids[name] = f"22222222-0000-4000-8000-00000000000{ordinal + 1}"
        conn.execute("INSERT INTO agents (id, team_id, ordinal, provider_id, role, display_name, availability, pane_state, "
                     "created_at, updated_at, limit_reset_at) VALUES (?, ?, ?, 'fake', ?, ?, ?, 'unknown', "
                     "'2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ?)",
                     (ids[name], TEAM_ID, ordinal, role, name, availability,
                      LIMIT_RESET_AT if availability == "limit_reached" else None))
    def ticket(status):
        return conn.execute("SELECT id FROM tickets WHERE workspace = ? AND title = ?",
                            (workspace, f"Ticket in {status}")).fetchone()[0]
    conn.execute("UPDATE tickets SET assignee_agent_id = ?, dev_rounds = 2, test_rounds = 1 WHERE id = ?", (ids["dev-1"], ticket("in_dev")))
    conn.execute("UPDATE tickets SET assignee_agent_id = ?, test_rounds = 1 WHERE id = ?", (ids["qa-1"], ticket("in_test")))
    conn.execute("UPDATE tickets SET review_rounds = 1 WHERE id = ?", (ticket("in_review"),))
    merged_extra = conn.execute("SELECT id FROM tickets WHERE workspace = ? AND title = 'Extra merged 1'", (workspace,)).fetchone()[0]
    for blocker in (ticket("in_dev"), merged_extra):
        conn.execute("INSERT INTO ticket_deps (ticket_id, blocked_by_ticket_id) VALUES (?, ?)", (ticket("ready_dev"), blocker))
    conn.execute("INSERT INTO board_state (workspace, status, reason, config_json, updated_at) VALUES (?, 'running', NULL, NULL, "
                 "'2026-01-01T00:00:00Z')", (workspace,))
    return ids


def normalise(data, workspace, agent_ids):
    """Strip what differs between runs: dbId, cursor, workspace, run IDs and agent IDs."""
    names = {value: key for key, value in agent_ids.items()}
    out = dict(data, dbId="DB", cursor=0, workspace="/work/api")
    out["columns"] = [dict(c, tickets=[dict(t, runId=None if t["runId"] is None else "RUN") for t in c["tickets"]])
                      for c in data["columns"]]
    out["agents"] = [dict(a, agentId="AGENT-" + names.get(a["agentId"], a["agentId"])) for a in data["agents"]]
    return out
