"""The workflow status column is added to fresh and version 18 databases."""
import os
import tempfile
import unittest

from tests import helpers  # noqa: F401
from agent_studio import state


class WorkflowStatusMigration(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = os.path.join(self.directory.name, "state.db")
        self.conn = state.connect(self.path, role="coordinator", create=True)
        self.addCleanup(self.conn.close)

    def assert_workflow_schema(self):
        columns = {row[1]: row for row in self.conn.execute("PRAGMA table_info(tickets)")}
        self.assertEqual(columns["workflow_status"][2:5], ("TEXT", 0, None))
        indexes = {row[1] for row in self.conn.execute("PRAGMA index_list(tickets)")}
        self.assertIn("tickets_by_workspace_workflow", indexes)
        self.assertEqual([row[2] for row in self.conn.execute(
            "PRAGMA index_info(tickets_by_workspace_workflow)")], ["workspace", "workflow_status"])

    def test_fresh_database_has_nullable_workflow_status_and_index(self):
        self.assertEqual(state.migrate(self.conn, self.path), 20)
        self.assert_workflow_schema()

    def test_version_18_ticket_is_preserved_with_null_workflow_status(self):
        self.conn.execute("PRAGMA foreign_keys = OFF")
        self.conn.execute("BEGIN IMMEDIATE")
        self.conn.execute("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)")
        for version in range(1, 19):
            for step in state.MIGRATIONS[version]:
                step(self.conn) if callable(step) else self.conn.execute(step)
            self.conn.execute("INSERT INTO schema_migrations VALUES (?, ?)", (version, "now"))
        self.conn.execute("INSERT INTO phases (id, workspace, slug, name, position, status, created_at, updated_at) "
                          "VALUES (?, '/w', 'p', 'Phase', 0, 'open', 'now', 'now')",
                          ("aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa",))
        self.conn.execute("INSERT INTO tickets (id, workspace, key, title, phase_id, status, created_at, updated_at) "
                          "VALUES (?, '/w', 'T-1', 'Existing', ?, 'ready', 'now', 'now')",
                          ("bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb", "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa"))
        self.conn.execute("COMMIT")
        self.assertEqual(state.current_version(self.conn), 18)

        self.assertEqual(state.migrate(self.conn, self.path), 20)
        self.assert_workflow_schema()
        row = self.conn.execute("SELECT key, title, status, workflow_status FROM tickets").fetchone()
        self.assertEqual(tuple(row), ("T-1", "Existing", "ready", None))
        self.assertEqual(self.conn.execute("PRAGMA foreign_key_check").fetchall(), [])
