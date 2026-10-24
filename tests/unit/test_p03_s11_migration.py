import os
import tempfile
import unittest

from tests import helpers  # noqa: F401
from agent_studio import schema, state
from tests.unit.test_p01_s04_migration import dump
from tests.helpers import fresh


NOW = "2030-01-01T00:00:00.000Z"
V7_AVAILABILITIES = ("starting", "idle", "busy", "waiting_input", "offline", "error")


def v7_database(path):
    """Build the persisted v7 layout, including its pre-limit agents CHECK."""
    conn = state.connect(path, role="coordinator", create=True)
    conn.execute("BEGIN IMMEDIATE")
    conn.execute("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)")
    for version in range(1, 8):
        for step in state.MIGRATIONS[version]:
            step(conn) if callable(step) else conn.execute(step)
        conn.execute("INSERT INTO schema_migrations VALUES (?, ?)", (version, NOW))
    # The current source has the v8 state constant, while a database written by v7 did not.
    conn.execute("PRAGMA foreign_keys = OFF")
    conn.execute("DROP TABLE agents")
    conn.execute("""CREATE TABLE agents (
        id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        provider_id TEXT NOT NULL, role TEXT NOT NULL, display_name TEXT NOT NULL,
        availability TEXT NOT NULL CHECK (availability IN ('starting','idle','busy','waiting_input','offline','error')),
        pane_state TEXT NOT NULL DEFAULT 'unknown' CHECK (pane_state IN ('unknown','alive','dead')),
        pane_id TEXT, pane_pid INTEGER, pane_start_time INTEGER, pane_boot_id TEXT, capabilities_json TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, model TEXT, reasoning TEXT,
        UNIQUE (team_id, ordinal),
        CHECK ((pane_pid IS NULL) = (pane_start_time IS NULL) AND (pane_pid IS NULL) = (pane_boot_id IS NULL)))""")
    conn.execute("CREATE INDEX agents_by_team ON agents (team_id, ordinal)")
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("COMMIT")
    return conn


class UsageLimitMigrationTests(unittest.TestCase):
    def test_v7_agents_keep_every_column_and_gain_null_limit_reset(self):
        path = os.path.join(tempfile.mkdtemp(), "state.db")
        conn = v7_database(path)
        conn.execute("INSERT INTO teams (id, name, workspace, status, created_at, updated_at) VALUES (?, 't', '/one', 'running', ?, ?)",
                     ("a" * 8 + "-0000-4000-8000-" + "a" * 12, NOW, NOW))
        team_id = "a" * 8 + "-0000-4000-8000-" + "a" * 12
        for ordinal, availability in enumerate(V7_AVAILABILITIES):
            agent_id = f"{ordinal + 1:08d}-0000-4000-8000-" + "b" * 12
            conn.execute("INSERT INTO agents (id, team_id, ordinal, provider_id, role, display_name, availability, "
                         "pane_state, pane_id, capabilities_json, created_at, updated_at, model, reasoning) "
                         "VALUES (?, ?, ?, 'fake', ?, ?, ?, 'alive', ?, ?, ?, ?, ?, ?)",
                         (agent_id, team_id, ordinal, f"role-{ordinal}", f"agent-{ordinal}", availability,
                          f"pane-{ordinal}", f'{{"n":{ordinal}}}', NOW, NOW, f"model-{ordinal}", f"reason-{ordinal}"))
        old = dump(conn, "agents", schema._AGENT_OLD_COLS)

        self.assertEqual(state.current_version(conn), 7)
        self.assertEqual(state.migrate(conn, path), 11)
        self.assertEqual(dump(conn, "agents", schema._AGENT_OLD_COLS), old)
        self.assertEqual([tuple(row) for row in conn.execute("SELECT limit_reset_at FROM agents ORDER BY ordinal")],
                         [(None,)] * 6)
        conn.execute("UPDATE agents SET availability = 'limit_reached' WHERE ordinal = 0")
        self.assertEqual(conn.execute("SELECT availability FROM agents WHERE ordinal = 0").fetchone()[0], "limit_reached")
        self.assertEqual(conn.execute("PRAGMA foreign_key_check").fetchall(), [])
        self.assertEqual(state.current_version(conn), 11)

    def test_agents_have_v8_limit_column_and_exact_new_transitions(self):
        conn, store = fresh()
        with store.transaction() as tx:
            team = tx.create("team", {"name": "t", "workspace": "/one"})
            agent = tx.create("agent", {"team_id": team, "ordinal": 0, "provider_id": "fake", "role": "QA", "display_name": "qa"})
            tx.transition("agent", agent, "idle")
            tx.transition("agent", agent, "busy")
            tx.transition("agent", agent, "limit_reached", set_values={"limit_reset_at": "2030-01-01T15:00:00Z"})
        row = conn.execute("SELECT availability, limit_reset_at FROM agents WHERE id = ?", (agent,)).fetchone()
        self.assertEqual(tuple(row), ("limit_reached", "2030-01-01T15:00:00Z"))
        self.assertEqual(conn.execute("PRAGMA foreign_key_check").fetchall(), [])
        self.assertEqual(schema.ENTITIES["agent"].transitions["busy"] - {"idle", "waiting_input", "offline", "error"}, {"limit_reached"})
        self.assertEqual(schema.ENTITIES["agent"].transitions["waiting_input"] - {"busy", "idle", "offline", "error"}, {"limit_reached"})
        self.assertEqual(schema.ENTITIES["agent"].transitions["limit_reached"], frozenset({"idle", "offline", "error"}))
