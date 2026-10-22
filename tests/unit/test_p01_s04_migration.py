"""P01-S04: schema v6 rebuilds workflow_runs and stage_attempts without losing rows or foreign keys."""
import os
import sqlite3
import tempfile
import unittest

from tests import helpers  # noqa: F401
from agent_studio import schema, state

T, A, K, W, S1, S2, AS1, AS2, TK2 = (f"{c}" * 8 + "-0000-4000-8000-" + f"{c}" * 12 for c in "abcdefghi")
NOW = "2026-10-22T00:00:00.000Z"


def v5_database(path):
    """A database exactly as the previous release left it (migrations 1-5), with P00 data in it."""
    conn = state.connect(path, role="coordinator", create=True)
    conn.execute("BEGIN IMMEDIATE")
    conn.execute("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)")
    for v in range(1, 6):
        for step in state.MIGRATIONS[v]:
            step(conn) if callable(step) else conn.execute(step)
        conn.execute("INSERT INTO schema_migrations VALUES (?, ?)", (v, NOW))
    ins = lambda sql, *a: conn.execute(sql, a)
    ins("INSERT INTO teams (id, name, workspace, status, created_at, updated_at) VALUES (?, 't', '/w', 'running', ?, ?)",
        T, NOW, NOW)
    ins("INSERT INTO agents (id, team_id, ordinal, provider_id, role, display_name, availability, pane_state, "
        "created_at, updated_at) VALUES (?, ?, 0, 'fake', 'developer', 'Dev', 'idle', 'alive', ?, ?)", A, T, NOW, NOW)
    for tid in (K, TK2):
        ins("INSERT INTO tasks (id, team_id, origin, workspace, goal, status, created_at, updated_at) "
            "VALUES (?, ?, 'workflow', '/w', 'goal', 'running', ?, ?)", tid, T, NOW, NOW)
    ins("INSERT INTO workflow_runs (id, team_id, task_id, workflow, status, current_stage, retry_count, retry_budget, "
        "base_commit, transition_reason, created_at, updated_at, developer_agent_id, reviewer_agent_id, "
        "current_agent_id, config_json, last_finding, deadline_at) VALUES (?, ?, ?, 'developer_reviewer', 'running', "
        "'reviewer', 1, 1, 'abc', 'why', ?, ?, ?, ?, ?, '{\"x\":1}', 'finding', '2030-01-01T00:00:00.000Z')",
        W, T, K, NOW, NOW, A, A, A)
    for sid, stage, attempt, asg in ((S1, "developer", 1, AS1), (S2, "reviewer", 1, AS2)):
        ins("INSERT INTO stage_attempts (id, team_id, workflow_run_id, stage, attempt, status, outcome, "
            "artifacts_json, created_at, updated_at, agent_id, phase, validation_json, verdict_json, diff_json, "
            "prompt_path) VALUES (?, ?, ?, ?, ?, 'completed', 'o', '[1]', ?, ?, ?, 'done', '{\"v\":1}', '{\"w\":2}', "
            "'{\"d\":3}', '/p')", sid, T, W, stage, attempt, NOW, NOW, A)
        ins("INSERT INTO assignments (id, team_id, task_id, agent_id, stage_attempt_id, attempt, policy, provider_id, "
            "status, created_at, updated_at, request_json) VALUES (?, ?, ?, ?, ?, 1, 'read_only', 'fake', "
            "'succeeded', ?, ?, '{}')", asg, T, K, A, sid, NOW, NOW)
        ins("UPDATE stage_attempts SET assignment_id = ? WHERE id = ?", asg, sid)
    conn.execute("COMMIT")
    return conn


def ex(conn, sql, *args):
    return conn.execute(sql, args)


def dump(conn, table, cols):
    return [tuple(r) for r in conn.execute(f"SELECT {cols} FROM {table} ORDER BY id").fetchall()]


class Migration6(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "state.db")

    def test_version_is_6(self):
        self.assertEqual(state.SCHEMA_VERSION, 6)

    def test_p00_database_migrates_with_every_row_and_foreign_key_intact(self):
        conn = v5_database(self.path)
        old_wf = dump(conn, "workflow_runs", schema._WF_OLD_COLS)
        old_sa = dump(conn, "stage_attempts", schema._SA_OLD_COLS)
        old_as = dump(conn, "assignments", "id, stage_attempt_id, task_id, agent_id, policy, status")
        self.assertEqual((len(old_wf), len(old_sa), len(old_as)), (1, 2, 2))
        self.assertEqual(state.migrate(conn, self.path), 6)
        self.assertEqual(dump(conn, "workflow_runs", schema._WF_OLD_COLS), old_wf)
        self.assertEqual(dump(conn, "stage_attempts", schema._SA_OLD_COLS), old_sa)
        self.assertEqual(dump(conn, "assignments", "id, stage_attempt_id, task_id, agent_id, policy, status"), old_as)
        self.assertEqual(conn.execute("PRAGMA foreign_key_check").fetchall(), [])
        self.assertEqual(conn.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        row = conn.execute("SELECT * FROM workflow_runs").fetchone()
        self.assertEqual((row["definition_name"], row["definition_json"], row["definition_sha256"],
                          row["bindings_json"], row["step_count"]), (None, None, None, None, 0))
        sa = conn.execute("SELECT stage_type, visit FROM stage_attempts").fetchall()
        self.assertEqual([tuple(r) for r in sa], [(None, None)] * 2)
        state.check_schema(conn)

    def test_references_still_point_at_the_rebuilt_tables(self):
        conn = v5_database(self.path)
        state.migrate(conn, self.path)
        refs = lambda t: {(r["table"], r["from"]) for r in conn.execute(f"PRAGMA foreign_key_list({t})")}
        self.assertIn(("stage_attempts", "stage_attempt_id"), refs("assignments"))
        self.assertIn(("workflow_runs", "workflow_run_id"), refs("stage_attempts"))
        self.assertIn(("tasks", "task_id"), refs("workflow_runs"))
        names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        self.assertFalse({n for n in names if n.endswith("_new")})
        idx = {r[1] for r in conn.execute("PRAGMA index_list(workflow_runs)")}
        self.assertIn("workflow_runs_by_status", idx)

    def test_foreign_keys_still_enforced(self):
        conn = v5_database(self.path)
        state.migrate(conn, self.path)
        with self.assertRaises(sqlite3.IntegrityError):
            ex(conn, "INSERT INTO stage_attempts (id, team_id, workflow_run_id, stage, attempt, status, "
                         "created_at, updated_at) VALUES (?, ?, ?, 'develop', 1, 'active', ?, ?)",
                         "z" * 8 + S1[8:], T, "y" * 8 + W[8:], NOW, NOW)

    def test_stage_ids_outside_the_p00_set_and_retry_overrun_are_accepted(self):
        conn = v5_database(self.path)
        state.migrate(conn, self.path)
        conn.execute("UPDATE workflow_runs SET current_stage = 'develop', retry_count = 5, retry_budget = 0, "
                     "definition_name = 'x', step_count = 3")
        ex(conn, "INSERT INTO stage_attempts (id, team_id, workflow_run_id, stage, attempt, status, "
                     "created_at, updated_at, stage_type, visit) VALUES (?, ?, ?, 'qa_review', 1, 'active', ?, ?, "
                     "'agent', 2)", "z" * 8 + S1[8:], T, W, NOW, NOW)
        self.assertEqual(conn.execute("SELECT current_stage FROM workflow_runs").fetchone()[0], "develop")

    def test_remaining_checks_still_apply(self):
        conn = v5_database(self.path)
        state.migrate(conn, self.path)
        for sql in ("UPDATE workflow_runs SET retry_count = -1", "UPDATE workflow_runs SET step_count = -1",
                    "UPDATE workflow_runs SET status = 'bogus'", "UPDATE stage_attempts SET attempt = 0",
                    "UPDATE stage_attempts SET status = 'bogus'"):
            with self.assertRaises(sqlite3.IntegrityError, msg=sql):
                conn.execute(sql)
        with self.assertRaises(sqlite3.IntegrityError):    # UNIQUE (workflow_run_id, stage, attempt)
            ex(conn, "INSERT INTO stage_attempts (id, team_id, workflow_run_id, stage, attempt, status, "
                         "created_at, updated_at) VALUES (?, ?, ?, 'developer', 1, 'active', ?, ?)",
                         "z" * 8 + S1[8:], T, W, NOW, NOW)

    def test_migrating_twice_and_an_empty_database(self):
        conn = v5_database(self.path)
        state.migrate(conn, self.path)
        state.migrate(conn, self.path)
        self.assertEqual(conn.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0], 6)
        fresh = state.connect(os.path.join(self.dir, "fresh.db"), role="coordinator", create=True)
        self.assertEqual(state.migrate(fresh, os.path.join(self.dir, "fresh.db")), 6)

    def test_a_failed_foreign_key_check_rolls_the_whole_migration_back(self):
        conn = v5_database(self.path)
        conn.execute("PRAGMA foreign_keys = OFF")
        ex(conn, "UPDATE assignments SET stage_attempt_id = ? WHERE id = ?", "q" * 8 + S1[8:], AS1)
        conn.execute("PRAGMA foreign_keys = ON")
        with self.assertRaises(RuntimeError):
            state.migrate(conn, self.path)
        self.assertEqual(conn.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0], 5)
        cols = [r["name"] for r in conn.execute("PRAGMA table_info(workflow_runs)")]
        self.assertNotIn("definition_json", cols)

    def test_entity_columns_include_the_new_ones(self):
        self.assertTrue({"definition_name", "definition_json", "definition_sha256", "bindings_json", "step_count"}
                        <= set(schema.ENTITIES["workflow_run"].columns))
        self.assertTrue({"stage_type", "visit"} <= set(schema.ENTITIES["stage_attempt"].columns))


if __name__ == "__main__":
    unittest.main()
