import sqlite3
import unittest

from tests.unit.test_p01_s04_migration import dump, schema, v5_database
from agent_studio import state


class TicketMigration(unittest.TestCase):
    def test_v6_upgrade_creates_ticket_tables_and_checks(self):
        import os
        import tempfile
        path = os.path.join(tempfile.mkdtemp(), "state.db")
        conn = v5_database(path)
        preserved = {table: dump(conn, table, cols) for table, cols in {
            "teams": "*", "agents": schema._AGENT_OLD_COLS, "tasks": "*", "workflow_runs": schema._WF_OLD_COLS,
            "stage_attempts": schema._SA_OLD_COLS, "assignments": "*",
        }.items()}
        # Reproduce the v6 release state without advancing through the current v7 migration.
        conn.execute("PRAGMA foreign_keys = OFF")
        conn.execute("BEGIN IMMEDIATE")
        for step in state.MIGRATIONS[6]:
            step(conn) if callable(step) else conn.execute(step)
        conn.execute("INSERT INTO schema_migrations VALUES (6, 'now')")
        conn.execute("COMMIT")
        conn.execute("PRAGMA foreign_keys = ON")
        self.assertEqual(state.migrate(conn, path), 8)
        names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        self.assertTrue({"tickets", "ticket_deps", "ticket_events", "board_state", "board_locks"} <= names)
        for table, rows in preserved.items():
            columns = {"agents": schema._AGENT_OLD_COLS, "workflow_runs": schema._WF_OLD_COLS,
                       "stage_attempts": schema._SA_OLD_COLS}.get(table, "*")
            self.assertEqual(dump(conn, table, columns), rows, table)
        good = ("00000000-0000-4000-8000-000000000000", "/w", "T-001", "story", "x", "refine", "n", "n")
        conn.execute("INSERT INTO tickets (id, workspace, key, kind, title, status, created_at, updated_at) "
                     "VALUES (?, ?, ?, ?, ?, ?, ?, ?)", good)
        with self.assertRaises(sqlite3.IntegrityError):
            conn.execute("INSERT INTO tickets (id, workspace, key, kind, title, status, created_at, updated_at) "
                         "VALUES ('20000000-0000-4000-8000-000000000000', '/w', 'T-002', 'bad', 'x', 'refine', 'n', 'n')")
        for column, value in (("status", "bad"), ("severity", "bad")):
            with self.assertRaises(sqlite3.IntegrityError, msg=column):
                conn.execute(f"UPDATE tickets SET {column} = ? WHERE id = ?", (value, good[0]))
        with self.assertRaises(sqlite3.IntegrityError):
            conn.execute("INSERT INTO tickets (id, workspace, key, kind, title, status, created_at, updated_at) "
                         "VALUES ('10000000-0000-4000-8000-000000000000', '/w', 'T-001', 'story', 'x', 'refine', 'n', 'n')")
        with self.assertRaises(sqlite3.IntegrityError):
            conn.execute("INSERT INTO ticket_deps VALUES (?, ?)", (good[0], good[0]))
        seq = conn.execute("INSERT INTO events (at, actor, name, entity, entity_id, payload_json) "
                           "VALUES ('n', 'coordinator', 'ticket.created', 'ticket', ?, '{}')", (good[0],)).lastrowid
        conn.execute("INSERT INTO ticket_events (ticket_id, event_seq, at, actor, name, payload_json) "
                     "VALUES (?, ?, 'n', 'coordinator', 'ticket.created', '{}')", (good[0], seq))
        with self.assertRaises(sqlite3.IntegrityError):
            conn.execute("UPDATE ticket_events SET name = 'ticket.moved'")
        self.assertEqual(conn.execute("PRAGMA foreign_key_check").fetchall(), [])
