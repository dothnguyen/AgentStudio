"""Workflow stages follow insertion order even if the wall clock moves backwards."""
import unittest

from tests.helpers import fresh
from agent_studio import queries, workflow


class WorkflowOrderTests(unittest.TestCase):
    def setUp(self):
        self.conn, self.store = fresh()
        self.addCleanup(self.conn.close)
        with self.store.transaction() as tx:
            team = tx.create("team", {"name": "team", "workspace": "/tmp/workspace"})
            agent = tx.create("agent", {"team_id": team, "ordinal": 0, "provider_id": "fake",
                                        "role": "Developer", "display_name": "developer"})
            task = tx.create("task", {"team_id": team, "origin": "workflow", "workspace": "/tmp/workspace", "goal": "g"})
            self.run = tx.create("workflow_run", {"team_id": team, "task_id": task, "workflow": "definition"})
            self.first = tx.create("stage_attempt", {"team_id": team, "workflow_run_id": self.run,
                                                    "stage": "develop", "attempt": 1})
            self.second = tx.create("stage_attempt", {"team_id": team, "workflow_run_id": self.run,
                                                     "stage": "qa", "attempt": 1})
            self.a1 = tx.create("assignment", {"team_id": team, "task_id": task, "agent_id": agent,
                                               "attempt": 1, "policy": "read_only", "provider_id": "fake"})
            self.a2 = tx.create("assignment", {"team_id": team, "task_id": task, "agent_id": agent,
                                               "attempt": 2, "policy": "read_only", "provider_id": "fake"})
            tx.conn.execute("UPDATE stage_attempts SET created_at = ? WHERE id = ?", ("2030-01-02T00:00:00Z", self.first))
            tx.conn.execute("UPDATE stage_attempts SET created_at = ? WHERE id = ?", ("2030-01-01T00:00:00Z", self.second))
            tx.conn.execute("UPDATE assignments SET created_at = ? WHERE id = ?", ("2030-01-02T00:00:00Z", self.a1))
            tx.conn.execute("UPDATE assignments SET created_at = ? WHERE id = ?", ("2030-01-01T00:00:00Z", self.a2))

    def test_detail_preserves_insertion_sequence(self):
        result = queries.workflow_detail(self.conn, self.run)
        self.assertEqual([s["id"] for s in result["stageAttempts"]], [self.first, self.second])
        self.assertEqual([a["id"] for a in result["assignments"]], [self.a1, self.a2])

    def test_current_attempt_is_latest_inserted(self):
        with self.store.transaction() as tx:
            self.assertEqual(workflow._current_attempt(tx, self.run)["id"], self.second)
