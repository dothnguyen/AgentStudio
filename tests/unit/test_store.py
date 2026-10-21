"""P00-S02: transactions, transitions, append-only journal, write authority, reports, and queries."""
import os
import re
import sqlite3
import tempfile
import unittest
from unittest import mock

from tests import helpers  # noqa: F401
from agent_studio import coordinator, inbox, queries, reports, schema, state, store as store_mod
from agent_studio.protocol import AsError
from agent_studio.store import Store

PKG = os.path.join(helpers.BACKEND, "agent_studio")


def fresh(path=None):
    path = path or os.path.join(tempfile.mkdtemp(), "state.db")
    conn = state.connect(path, role="coordinator", create=True)
    state.migrate(conn, path)
    return path, conn, Store(conn)


def count(conn, table):
    return conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]


def seed(st):
    with st.transaction() as tx:
        team = tx.create("team", {"name": "t", "workspace": "/w"})
        agent = tx.create("agent", {"team_id": team, "ordinal": 0, "provider_id": "fake", "role": "dev",
                                    "display_name": "a0"})
        task = tx.create("task", {"team_id": team, "origin": "direct", "workspace": "/w", "goal": "g"})
        asg = tx.create("assignment", {"team_id": team, "task_id": task, "agent_id": agent, "attempt": 1,
                                       "policy": "read_only", "provider_id": "fake"})
    return team, agent, task, asg


class Migrations(unittest.TestCase):
    def test_upgrade_from_v1_keeps_commands(self):
        path = os.path.join(tempfile.mkdtemp(), "state.db")
        conn = state.connect(path, role="coordinator", create=True)
        conn.execute("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)")
        for stmt in state.MIGRATIONS[1]:
            conn.execute(stmt)
        conn.execute("INSERT INTO schema_migrations VALUES (1, 'then')")
        inbox.insert_or_get(conn, "old-command-1", "debug.echo", {"text": "x"})
        state.migrate(conn, path)
        self.assertEqual(state.current_version(conn), state.SCHEMA_VERSION)
        self.assertEqual(count(conn, "commands"), 1)
        self.assertRegex(state.db_id(conn), store_mod.UUID_RE)

    def test_db_id_stable_across_reopen(self):
        path, conn, _ = fresh()
        first = state.db_id(conn)
        conn.close()
        conn2 = state.connect(path, role="coordinator")
        state.migrate(conn2, path)
        self.assertEqual(state.db_id(conn2), first)


class Transitions(unittest.TestCase):
    def setUp(self):
        self.path, self.conn, self.st = fresh()
        self.team, self.agent, self.task, self.asg = seed(self.st)

    def test_one_event_per_change(self):
        self.assertEqual(count(self.conn, "events"), 4)
        with self.st.transaction() as tx:
            tx.transition("agent", self.agent, "idle")
            tx.transition("task", self.task, "assigned")
            tx.update("agent", self.agent, {"pane_state": "alive"}, "agent.pane_alive")
        self.assertEqual(count(self.conn, "events"), 7)
        ev = self.conn.execute("SELECT * FROM events WHERE name = 'task.assigned'").fetchone()
        self.assertEqual((ev["from_state"], ev["to_state"], ev["task_id"], ev["team_id"]),
                         ("queued", "assigned", self.task, self.team))

    def test_assignment_event_carries_refs(self):
        ev = self.conn.execute("SELECT * FROM events WHERE entity = 'assignment'").fetchone()
        self.assertEqual((ev["assignment_id"], ev["task_id"], ev["agent_id"], ev["team_id"]),
                         (self.asg, self.task, self.agent, self.team))

    def assertInvalid(self, entity, entity_id, to, **kw):
        before_events = count(self.conn, "events")
        with self.assertRaises(AsError) as cm:
            with self.st.transaction() as tx:
                tx.transition(entity, entity_id, to, **kw)
        self.assertEqual(cm.exception.code, "INVALID_TRANSITION")
        self.assertEqual(count(self.conn, "events"), before_events)

    def test_invalid_transitions(self):
        self.assertInvalid("task", self.task, "succeeded")           # queued -> succeeded
        self.assertInvalid("assignment", self.asg, "succeeded")      # queued -> succeeded
        self.assertInvalid("assignment", self.asg, "running")        # must be claimed first
        self.assertInvalid("agent", self.agent, "busy")              # starting -> busy
        self.assertInvalid("team", self.team, "stopped")             # starting -> stopped
        self.assertInvalid("assignment", self.asg, "claimed", expect=["running"])

    def test_claimed_cannot_jump_to_succeeded_and_reconciling_path(self):
        with self.st.transaction() as tx:
            tx.transition("assignment", self.asg, "claimed")
        self.assertInvalid("assignment", self.asg, "succeeded")
        with self.st.transaction() as tx:
            tx.transition("assignment", self.asg, "reconciling")
            tx.transition("assignment", self.asg, "failed")

    def test_terminal_states_are_final(self):
        for e in schema.ENTITIES.values():
            for term in e.terminal:
                self.assertFalse(e.transitions.get(term), (e.name, term))
        self.assertEqual(schema.ENTITIES["agent"].terminal, frozenset())
        with self.st.transaction() as tx:
            tx.transition("task", self.task, "cancelled")
        for to in ("queued", "running", "succeeded"):
            self.assertInvalid("task", self.task, to)

    def test_workflow_paused_and_resumed(self):
        with self.st.transaction() as tx:
            wf = tx.create("workflow_run", {"team_id": self.team, "task_id": self.task, "workflow": "dev_review"})
            tx.transition("workflow_run", wf, "running", set_values={"current_stage": "developer"})
            tx.transition("workflow_run", wf, "paused", set_values={"transition_reason": "waiting_input"})
            tx.transition("workflow_run", wf, "running")
            tx.transition("workflow_run", wf, "failed")
        self.assertInvalid("workflow_run", wf, "running")

    def test_create_only_in_initial_state(self):
        with self.assertRaises(AsError) as cm:
            with self.st.transaction() as tx:
                tx.create("task", {"team_id": self.team, "origin": "direct", "workspace": "/w", "goal": "g"},
                          state="succeeded")
        self.assertEqual(cm.exception.code, "INVALID_TRANSITION")

    def test_agent_availability_independent_of_task_outcome(self):
        with self.st.transaction() as tx:
            tx.transition("agent", self.agent, "idle")
            tx.transition("agent", self.agent, "busy")
            tx.transition("task", self.task, "assigned")
            tx.transition("task", self.task, "running")
            tx.transition("task", self.task, "succeeded")
            tx.transition("agent", self.agent, "idle")
            tx.update("agent", self.agent, {"pane_state": "dead"}, "agent.pane_dead")
            tx.transition("agent", self.agent, "offline")
        task = self.conn.execute("SELECT status FROM tasks WHERE id = ?", (self.task,)).fetchone()[0]
        self.assertEqual(task, "succeeded")

    def test_fault_between_row_update_and_event_rolls_back_both(self):
        before = count(self.conn, "events")
        with mock.patch.object(store_mod.Tx, "_event", side_effect=RuntimeError("injected fault")):
            with self.assertRaises(RuntimeError):
                with self.st.transaction() as tx:
                    tx.transition("task", self.task, "assigned")
        self.assertEqual(self.conn.execute("SELECT status FROM tasks WHERE id = ?", (self.task,)).fetchone()[0], "queued")
        self.assertEqual(count(self.conn, "events"), before)

    def test_whole_transaction_rolls_back_on_later_failure(self):
        before = count(self.conn, "events")
        with self.assertRaises(AsError):
            with self.st.transaction() as tx:
                tx.transition("task", self.task, "assigned")
                tx.transition("task", self.task, "succeeded")  # invalid: assigned -> succeeded
        self.assertEqual(self.conn.execute("SELECT status FROM tasks WHERE id = ?", (self.task,)).fetchone()[0], "queued")
        self.assertEqual(count(self.conn, "events"), before)

    def test_unknown_columns_and_bad_enums_rejected(self):
        with self.assertRaises(AsError):
            with self.st.transaction() as tx:
                tx.update("task", self.task, {"status": "succeeded"}, "task.hack")
        with self.assertRaises(sqlite3.IntegrityError):
            with self.st.transaction() as tx:
                tx.create("agent", {"team_id": self.team, "ordinal": 1, "provider_id": "gpt-cli", "role": "x",
                                    "display_name": "x"})
        with self.assertRaises(sqlite3.IntegrityError):
            with self.st.transaction() as tx:
                tx.create("assignment", {"team_id": self.team, "task_id": self.task, "agent_id": store_mod.new_id(),
                                         "attempt": 1, "policy": "read_only", "provider_id": "fake"})

    def test_process_identity_columns_set_together(self):
        with self.assertRaises(sqlite3.IntegrityError):
            with self.st.transaction() as tx:
                tx.update("assignment", self.asg, {"process_pid": 123}, "assignment.process")
        with self.st.transaction() as tx:
            tx.update("assignment", self.asg, {"process_pid": 123, "process_start_time": 456,
                                               "process_boot_id": "b"}, "assignment.process")

    def test_journal_is_append_only(self):
        for sql in ("UPDATE events SET name = 'x'", "DELETE FROM events"):
            with self.assertRaises(sqlite3.DatabaseError):
                self.conn.execute(sql)
        self.assertEqual(count(self.conn, "events"), 4)


class WriteAuthority(unittest.TestCase):
    def setUp(self):
        self.path, self.conn, self.st = fresh()
        self.team, self.agent, self.task, self.asg = seed(self.st)

    def denied(self, conn, sql, params=()):
        with self.assertRaises(sqlite3.DatabaseError):
            conn.execute(sql, params)

    def test_client_may_only_insert_commands(self):
        c = state.connect(self.path, role="client")
        inbox.insert_or_get(c, "client-key-1", "debug.echo", {"text": "x"})
        seq = c.execute("SELECT seq FROM commands").fetchone()[0]
        self.denied(c, "UPDATE commands SET status = 'done', response_json = '{}' WHERE seq = ?", (seq,))
        self.denied(c, "DELETE FROM commands")
        self.denied(c, "INSERT INTO events (at, actor, name, entity, entity_id, payload_json) "
                       "VALUES ('x', 'coordinator', 'a.b', 'task', 'x', '{}')")
        self.denied(c, "UPDATE tasks SET status = 'succeeded'")
        self.denied(c, "INSERT INTO worker_reports (assignment_id, report_seq, kind, payload_json, payload_hash, "
                       "received_at) VALUES (?, 0, 'final', '{}', 'h', 'x')", (self.asg,))
        self.denied(c, "CREATE TABLE evil (x)")
        self.denied(c, "PRAGMA foreign_keys = OFF")
        with self.assertRaises(AsError):
            Store(c)

    def test_runner_may_only_insert_reports(self):
        r = state.connect(self.path, role="runner")
        reports.submit(r, self.asg, 0, "start", {"pid": 1})
        self.denied(r, "UPDATE assignments SET status = 'succeeded'")
        self.denied(r, "INSERT INTO commands (idempotency_key, command, payload_hash, args_json, status, created_at) "
                       "VALUES ('runner-key-1', 'x', 'h', '{}', 'pending', 'now')")
        self.denied(r, "INSERT INTO report_applications (report_id, applied_at, outcome) VALUES (1, 'x', 'y')")
        self.denied(r, "DELETE FROM worker_reports")

    def test_reader_cannot_write(self):
        rd = state.connect(self.path, role="reader")
        self.denied(rd, "INSERT INTO commands (idempotency_key, command, payload_hash, args_json, status, created_at) "
                        "VALUES ('reader-key-1', 'x', 'h', '{}', 'pending', 'now')")
        self.denied(rd, "UPDATE tasks SET goal = 'x'")
        queries.snapshot(rd)

    def test_only_coordinator_creates_or_migrates(self):
        with self.assertRaises(ValueError):
            state.connect(self.path, role="client", create=True)
        with self.assertRaises(ValueError):
            state.migrate(state.connect(self.path, role="client"), self.path)

    def test_source_connections_use_their_role(self):
        """Fails if a client/runner/reader code path opens a coordinator (or other unexpected) connection."""
        allowed = {"coordinator.py": {"coordinator"}, "client.py": {"client"}, "dispatch.py": {"reader"},
                   "runner.py": {"runner"}, "watch.py": {"reader"}}  # tests/ harnesses are outside the package
        found = {}
        for name in os.listdir(PKG):
            if not name.endswith(".py"):
                continue
            with open(os.path.join(PKG, name), encoding="utf-8") as f:
                src = f.read()
            for m in re.finditer(r"state\.connect\(([^\n]*)", src):
                role = re.search(r'role="(\w+)"', m.group(1))
                found.setdefault(name, set()).add(role.group(1) if role else "<missing>")
        for name, roles in found.items():
            self.assertIn(name, allowed, f"{name} opens a database connection; add it to the role map deliberately")
            self.assertLessEqual(roles, allowed[name], name)


class Reports(unittest.TestCase):
    def setUp(self):
        self.path, self.conn, self.st = fresh()
        self.team, self.agent, self.task, self.asg = seed(self.st)
        self.runner = state.connect(self.path, role="runner")

    def test_duplicate_identical_report_is_noop(self):
        a = reports.submit(self.runner, self.asg, 0, "start", {"pid": 7})
        b = reports.submit(self.runner, self.asg, 0, "start", {"pid": 7})
        self.assertEqual(a, b)
        self.assertEqual(count(self.conn, "worker_reports"), 1)
        with self.assertRaises(AsError) as cm:
            reports.submit(self.runner, self.asg, 0, "start", {"pid": 8})
        self.assertEqual(cm.exception.code, "REPORT_CONFLICT")

    def test_unknown_assignment(self):
        with self.assertRaises(AsError) as cm:
            reports.submit(self.runner, store_mod.new_id(), 0, "final", {})
        self.assertEqual(cm.exception.code, "NOT_FOUND")

    def test_apply_once(self):
        reports.submit(self.runner, self.asg, 0, "start", {})
        reports.submit(self.runner, self.asg, 1, "final", {"status": "succeeded"})
        before = count(self.conn, "events")
        self.assertEqual(reports.apply_pending(self.st), 2)
        self.assertEqual(reports.apply_pending(self.st), 0)
        self.assertEqual(count(self.conn, "events"), before + 2)
        ev = self.conn.execute("SELECT * FROM events ORDER BY seq DESC LIMIT 1").fetchone()
        self.assertEqual((ev["actor"], ev["assignment_id"], ev["name"]), ("runner", self.asg, "assignment.report_received"))
        self.assertIsNotNone(ev["report_id"])

    def test_late_report_cannot_change_terminal_assignment(self):
        with self.st.transaction() as tx:
            tx.transition("assignment", self.asg, "cancelled")

        def finish(tx, report):
            return "applied", tx.transition("assignment", report["assignment_id"], "succeeded")

        reports.submit(self.runner, self.asg, 5, "final", {"status": "succeeded"})
        before = count(self.conn, "events")
        self.assertEqual(reports.apply_pending(self.st, handler=finish), 1)
        self.assertEqual(reports.apply_pending(self.st, handler=finish), 0)
        status = self.conn.execute("SELECT status FROM assignments WHERE id = ?", (self.asg,)).fetchone()[0]
        self.assertEqual(status, "cancelled")
        # S07: the rejection itself is visible as exactly one event; no state changed
        self.assertEqual(count(self.conn, "events"), before + 1)
        last = self.conn.execute("SELECT name, to_state FROM events ORDER BY seq DESC LIMIT 1").fetchone()
        self.assertEqual(tuple(last), ("assignment.report_rejected", "cancelled"))
        outcome = self.conn.execute("SELECT outcome FROM report_applications").fetchone()[0]
        self.assertEqual(outcome, "rejected:INVALID_TRANSITION")


class AtomicCommands(unittest.TestCase):
    def test_failed_handler_leaves_no_partial_state(self):
        path, conn, st = fresh()
        client_conn = state.connect(path, role="client")
        seq = inbox.insert_or_get(client_conn, "atomic-key-1", "test.half", {})

        def half(args, tx, ctx):
            tx.create("team", {"name": "half", "workspace": "/w"})
            raise AsError("BOOM", "fails after a write")

        with mock.patch.dict(coordinator.HANDLERS, {"test.half": half}):
            coordinator.process_pending(st, {"debug": True})
        self.assertEqual(count(conn, "teams"), 0)
        self.assertEqual(count(conn, "events"), 0)
        resp = inbox.wait_response(conn, seq, 0)
        self.assertEqual(resp["error"]["code"], "BOOM")

    def test_success_commits_state_events_and_receipt_together(self):
        path, conn, st = fresh()
        client_conn = state.connect(path, role="client")
        seq = inbox.insert_or_get(client_conn, "atomic-key-2", "debug.fixture", {"agents": 2, "workspace": "/w"})
        coordinator.process_pending(st, {"debug": True})
        resp = inbox.wait_response(conn, seq, 0)
        self.assertTrue(resp["ok"])
        self.assertEqual(count(conn, "events"), len(resp["data"]["eventSeqs"]))
        cmd_seqs = {r[0] for r in conn.execute("SELECT DISTINCT command_seq FROM events")}
        self.assertEqual(cmd_seqs, {seq})


class Queries(unittest.TestCase):
    def setUp(self):
        self.path, self.conn, self.st = fresh()
        self.team, self.agent, self.task, self.asg = seed(self.st)
        self.rd = state.connect(self.path, role="reader")

    def test_snapshot_sections_and_cursor(self):
        snap = queries.snapshot(self.rd)
        self.assertEqual(snap["cursor"], 4)
        self.assertEqual(snap["dbId"], state.db_id(self.conn))
        self.assertEqual([len(snap[s]) for s in ("teams", "agents", "tasks", "assignments", "workflowRuns")],
                         [1, 1, 1, 1, 0])
        a = snap["assignments"][0]
        self.assertEqual((a["id"], a["taskId"], a["agentId"], a["status"], a["policy"]),
                         (self.asg, self.task, self.agent, "queued", "read_only"))

    def test_stopped_teams_hidden_unless_requested(self):
        with self.st.transaction() as tx:
            tx.transition("team", self.team, "stopping")
            tx.transition("team", self.team, "stopped")
        self.assertEqual(queries.snapshot(self.rd)["teams"], [])
        self.assertEqual(len(queries.snapshot(self.rd, include_stopped=True)["teams"]), 1)
        self.assertEqual(len(queries.snapshot(self.rd, team_id=self.team)["agents"]), 1)

    def test_events_paging_and_filters(self):
        page = queries.events_after(self.rd, 0, limit=3)
        self.assertEqual([e["seq"] for e in page["events"]], [1, 2, 3])
        self.assertTrue(page["hasMore"])
        page2 = queries.events_after(self.rd, page["nextCursor"], limit=3)
        self.assertEqual([e["seq"] for e in page2["events"]], [4])
        self.assertFalse(page2["hasMore"])
        self.assertEqual(page2["nextCursor"], 4)
        other = queries.events_after(self.rd, 0, team_id=store_mod.new_id())
        self.assertEqual(other["events"], [])
        self.assertEqual(other["nextCursor"], 4)

    def test_cursor_invalid(self):
        with self.assertRaises(AsError) as cm:
            queries.events_after(self.rd, 99)
        self.assertEqual(cm.exception.code, "CURSOR_INVALID")
        with self.assertRaises(AsError) as cm:
            queries.events_after(self.rd, 0, expected_db_id=store_mod.new_id())
        self.assertEqual(cm.exception.code, "CURSOR_INVALID")


if __name__ == "__main__":
    unittest.main()
