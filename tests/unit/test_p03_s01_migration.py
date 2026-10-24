"""P04-S06/S07: migration 10 drops the P03 software-board tables (children first); migration 11 re-creates
the generic board tables (no status CHECK, phases as data) on every database, fresh or upgraded."""
import os
import shutil
import tempfile
import unittest

from tests import helpers  # noqa: F401
from agent_studio import state
from tests.unit.test_p01_s04_migration import dump

NOW = "2030-01-01T00:00:00.000Z"
TEAM = "a" * 8 + "-0000-4000-8000-" + "a" * 12
AGENT = "b" * 8 + "-0000-4000-8000-" + "b" * 12
T1 = "c" * 8 + "-0000-4000-8000-" + "c" * 12
T2 = "d" * 8 + "-0000-4000-8000-" + "d" * 12
P03_ONLY = {"board_locks"}          # dropped by v10 and never created again
REUSED = {"tickets", "ticket_deps", "ticket_events", "board_state"}  # re-created by v11 with a new shape
BOARD_TABLES = P03_ONLY | REUSED


def v9_database(path):
    """A database exactly as version 9 left it: engine rows plus one row in every P03 board table."""
    conn = state.connect(path, role="coordinator", create=True)
    conn.execute("BEGIN IMMEDIATE")
    conn.execute("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)")
    for version in range(1, 10):
        for step in state.MIGRATIONS[version]:
            step(conn) if callable(step) else conn.execute(step)
        conn.execute("INSERT INTO schema_migrations VALUES (?, ?)", (version, NOW))
    conn.execute("INSERT INTO teams (id, name, workspace, status, created_at, updated_at) "
                 "VALUES (?, 't', '/w', 'running', ?, ?)", (TEAM, NOW, NOW))
    conn.execute("INSERT INTO agents (id, team_id, ordinal, provider_id, role, display_name, availability, pane_state, "
                 "created_at, updated_at) VALUES (?, ?, 0, 'fake', 'developer', 'Dev', 'idle', 'alive', ?, ?)",
                 (AGENT, TEAM, NOW, NOW))
    for ident, key in ((T1, "T-001"), (T2, "T-002")):
        conn.execute("INSERT INTO tickets (id, workspace, key, kind, title, status, priority, created_at, updated_at) "
                     "VALUES (?, '/w', ?, 'story', 'x', 'refine', 100, ?, ?)", (ident, key, NOW, NOW))
    conn.execute("INSERT INTO ticket_deps (ticket_id, blocked_by_ticket_id) VALUES (?, ?)", (T1, T2))
    conn.execute("INSERT INTO board_state (workspace, status, reason, config_json, review_streak, updated_at) "
                 "VALUES ('/w', 'running', NULL, '{}', 0, ?)", (NOW,))
    conn.execute("INSERT INTO board_locks (workspace, name, ticket_id, created_at) VALUES ('/w', 'develop', ?, ?)",
                 (T1, NOW))
    seq = conn.execute("INSERT INTO events (at, actor, name, entity, entity_id, payload_json) "
                       "VALUES (?, 'coordinator', 'ticket.created', 'ticket', ?, '{}')", (NOW, T1)).lastrowid
    conn.execute("INSERT INTO ticket_events (ticket_id, event_seq, at, actor, name, payload_json) "
                 "VALUES (?, ?, ?, 'coordinator', 'ticket.created', '{}')", (T1, seq, NOW))
    conn.execute("COMMIT")
    return conn


def tables(conn):
    return {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}


def columns(conn, table):
    return {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}


class BoardTableDrop(unittest.TestCase):
    def test_v9_database_with_board_rows_migrates_to_the_current_version(self):
        path = os.path.join(tempfile.mkdtemp(), "state.db")
        conn = v9_database(path)
        agent_cols = "id, team_id, ordinal, provider_id, role, display_name, availability, created_at"
        preserved = {"teams": dump(conn, "teams", "*"), "agents": dump(conn, "agents", agent_cols)}
        events_before = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
        self.assertEqual(state.current_version(conn), 9)

        self.assertEqual(state.migrate(conn, path), state.SCHEMA_VERSION)

        # v10 dropped the P03 board (its data is not migrated); v11/v12 created the generic tables in their
        # place. run_id and blocked_reason returned in v12 with new meaning; these P03 columns are gone.
        self.assertFalse(P03_ONLY & tables(conn))
        self.assertTrue(REUSED <= tables(conn))
        self.assertIn("phases", tables(conn))
        p03_columns = {"kind", "story_path", "severity", "dev_rounds", "merged_commit", "assignee_agent_id"}
        self.assertFalse(p03_columns & columns(conn, "tickets"))
        self.assertTrue({"phase_id", "created_by_member", "rounds_json"} <= columns(conn, "tickets"))
        self.assertEqual(dump(conn, "teams", "*"), preserved["teams"])
        self.assertEqual(dump(conn, "agents", agent_cols), preserved["agents"])
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM events").fetchone()[0], events_before)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM tickets").fetchone()[0], 0)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM board_state").fetchone()[0], 0)
        self.assertEqual(conn.execute("PRAGMA foreign_key_check").fetchall(), [])
        self.assertEqual(conn.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        self.assertEqual(state.current_version(conn), state.SCHEMA_VERSION)
        state.check_schema(conn)

    def test_fresh_database_has_the_same_schema_and_no_p03_artifacts(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, True)
        old = v9_database(os.path.join(d, "old.db"))
        state.migrate(old, os.path.join(d, "old.db"))
        fresh = state.connect(os.path.join(d, "new.db"), role="coordinator", create=True)
        state.migrate(fresh, os.path.join(d, "new.db"))

        def schema(conn):
            return sorted((r[0], r[1]) for r in conn.execute(
                "SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"))

        self.assertEqual(schema(fresh), schema(old))
        self.assertFalse(P03_ONLY & tables(fresh))
        self.assertTrue(REUSED <= tables(fresh))
        self.assertEqual(state.migrate(old, os.path.join(d, "old.db")), state.SCHEMA_VERSION)  # twice is a no-op


if __name__ == "__main__":
    unittest.main()
