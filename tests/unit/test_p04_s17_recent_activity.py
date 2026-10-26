"""P04-S17: bounded, workspace-scoped, payload-free recent activity."""
import json
import os
import tempfile
import unittest
from unittest import mock

from tests import helpers  # noqa: F401  (puts backend on sys.path)
from tests.helpers import fresh
from agent_studio import dispatch, queries, state, store as store_mod
from agent_studio.protocol import AsError, BAD_REQUEST, WORKSPACE_NOT_FOUND


SENTINEL = "SECRET prompt text do-not-leak"


class RecentActivityTests(unittest.TestCase):
    def setUp(self):
        self.conn, self.store = fresh()
        self.workspace = os.path.realpath(tempfile.mkdtemp(prefix="as-activity-"))
        self.other_workspace = os.path.realpath(tempfile.mkdtemp(prefix="as-activity-other-"))

    def _base_entities(self, workspace=None, name="Alpha", secret="ordinary"):
        workspace = workspace or self.workspace
        with self.store.transaction() as tx:
            team = tx.create("team", {"name": name, "workspace": workspace})
            agent = tx.create("agent", {"team_id": team, "ordinal": 0, "provider_id": "fake",
                                         "role": "developer", "display_name": "Agent"})
            task = tx.create("task", {"team_id": team, "origin": "direct", "workspace": workspace,
                                       "goal": secret})
            assignment = tx.create("assignment", {
                "team_id": team, "task_id": task, "agent_id": agent, "attempt": 1,
                "policy": "read_only", "provider_id": "fake", "result_json": {"report": secret},
                "diagnostic_code": secret,
            })
            workflow = tx.create("workflow_run", {"team_id": team, "task_id": task,
                                                    "workflow": "test"})
        return {"team": team, "assignment": assignment, "workflow_run": workflow}

    def _global_event(self, ids, entity, name, at, payload=None):
        with mock.patch.object(store_mod, "utcnow", return_value=at):
            with self.store.transaction() as tx:
                tx.note(entity, ids[entity], name, payload or {})

    def _ticket(self, workspace, key, title="title", body="body"):
        now = "2026-01-01T00:00:00.000Z"
        phase_id = store_mod.new_id()
        ticket_id = store_mod.new_id()
        self.conn.execute(
            "INSERT INTO phases (id, workspace, slug, name, position, status, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, 0, 'open', ?, ?)",
            (phase_id, workspace, f"phase-{key.lower()}", "Phase", now, now),
        )
        self.conn.execute(
            "INSERT INTO tickets (id, workspace, key, title, body, phase_id, status, priority, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, 'open', 100, ?, ?)",
            (ticket_id, workspace, key, title, body, phase_id, now, now),
        )
        return ticket_id

    def _ticket_event(self, ticket_id, name, at, from_status=None, to_status=None, payload=None):
        cur = self.conn.execute(
            "INSERT INTO ticket_events (ticket_id, at, actor, name, from_status, to_status, payload_json) "
            "VALUES (?, ?, 'coordinator', ?, ?, ?, ?)",
            (ticket_id, at, name, from_status, to_status, json.dumps(payload or {})),
        )
        return cur.lastrowid

    def test_recent_activity_is_workspace_scoped_newest_first_bounded_and_stable(self):
        ids = self._base_entities()
        other = self._base_entities(self.other_workspace, "Other")
        ticket = self._ticket(self.workspace, "T-001")
        other_ticket = self._ticket(self.other_workspace, "T-002")
        tie = "2026-02-01T10:00:00.000Z"
        self._ticket_event(ticket, "ticket.moved", tie, "open", "done")
        self._global_event(ids, "team", "team.running", tie)
        self._global_event(ids, "assignment", "assignment.succeeded", "2026-02-01T09:00:00.000Z")
        self._global_event(other, "team", "team.running", "2026-02-02T00:00:00.000Z")
        self._ticket_event(other_ticket, "ticket.merged", "2026-02-03T00:00:00.000Z")

        for limit in (1, 3, 20):
            first = queries.recent_activity(self.conn, self.workspace, limit)
            second = queries.recent_activity(self.conn, self.workspace, limit)
            self.assertLessEqual(len(first["entries"]), limit)
            self.assertEqual([e["id"] for e in first["entries"]], [e["id"] for e in second["entries"]])
            self.assertEqual([e["at"] for e in first["entries"]],
                             sorted((e["at"] for e in first["entries"]), reverse=True))
            self.assertEqual(len({e["id"] for e in first["entries"]}), len(first["entries"]))
        entries = queries.recent_activity(self.conn, self.workspace, 20)["entries"]
        full_result = queries.recent_activity(self.conn, self.workspace, 20)
        self.assertEqual(full_result["head"], self.conn.execute("SELECT MAX(seq) FROM events").fetchone()[0])
        self.assertEqual(full_result["workspace"], self.workspace)
        self.assertEqual(full_result["dbId"], state.db_id(self.conn))
        self.assertTrue(any(e["id"].startswith("event:") for e in entries))
        self.assertTrue(any(e["id"].startswith("ticket-event:") for e in entries))
        tied = [e for e in entries if e["at"] == tie]
        self.assertEqual([e["id"].split(":")[0] for e in tied], ["event", "ticket-event"])
        self.assertNotIn("Other", json.dumps(entries))
        self.assertNotIn("T-002", json.dumps(entries))

    def test_recent_activity_projects_exact_safe_shape_without_payloads(self):
        ids = self._base_entities(secret=SENTINEL)
        global_cases = [
            ("team", "team.running", "Team Alpha started"),
            ("team", "team.stopped", "Team Alpha stopped"),
            ("assignment", "assignment.succeeded", "Assignment completed"),
            ("assignment", "assignment.waiting_input", "Assignment needs attention"),
            ("assignment", "assignment.failed", "Assignment failed"),
            ("workflow_run", "workflow_run.succeeded", "Workflow finished"),
            ("workflow_run", "workflow_run.failed", "Workflow failed"),
            ("workflow_run", "workflow_run.paused", "Workflow needs attention"),
        ]
        for number, (entity, name, _) in enumerate(global_cases):
            self._global_event(ids, entity, name, f"2026-03-01T00:00:{number:02d}.000Z",
                               {"prompt": SENTINEL, "report": SENTINEL, "data": SENTINEL})
        ticket = self._ticket(self.workspace, "T-SECRET", SENTINEL, SENTINEL)
        self._ticket_event(ticket, "ticket.moved", "2026-03-01T00:01:00.000Z", "open", "doing",
                           {"payload": SENTINEL})
        self._ticket_event(ticket, "ticket.outcome_applied", "2026-03-01T00:01:01.000Z", "doing", "done",
                           {"prompt": SENTINEL})
        self._ticket_event(ticket, "ticket.merged", "2026-03-01T00:01:02.000Z", "done", "done",
                           {"report": SENTINEL})

        result = queries.recent_activity(self.conn, self.workspace, 20)
        serialized = json.dumps(result)
        self.assertNotIn(SENTINEL, serialized)
        self.assertNotIn('"payload"', serialized)
        self.assertNotIn('"data"', serialized)
        expected = {name: summary for _, name, summary in global_cases}
        expected.update({
            "ticket.moved": "Ticket T-SECRET moved from open to doing",
            "ticket.outcome_applied": "Ticket T-SECRET moved from doing to done",
            "ticket.merged": "Ticket T-SECRET merged",
        })
        self.assertEqual({e["name"]: e["summary"] for e in result["entries"]}, expected)
        expected_kinds = {
            "team.running": ("team", "team", ids["team"], "Alpha"),
            "team.stopped": ("team", "team", ids["team"], "Alpha"),
            "assignment.succeeded": ("assignment", "assignment", ids["assignment"], None),
            "assignment.waiting_input": ("assignment", "assignment", ids["assignment"], None),
            "assignment.failed": ("assignment", "assignment", ids["assignment"], None),
            "workflow_run.succeeded": ("workflow", "workflow", ids["workflow_run"], None),
            "workflow_run.failed": ("workflow", "workflow", ids["workflow_run"], None),
            "workflow_run.paused": ("workflow", "workflow", ids["workflow_run"], None),
            "ticket.moved": ("ticket", "ticket", ticket, "T-SECRET"),
            "ticket.outcome_applied": ("ticket", "ticket", ticket, "T-SECRET"),
            "ticket.merged": ("ticket", "ticket", ticket, "T-SECRET"),
        }
        for entry in result["entries"]:
            self.assertEqual(set(entry), {"id", "at", "kind", "name", "summary", "subject"})
            subject_keys = {"type", "id", "label"} if entry["kind"] in ("team", "ticket") else {"type", "id"}
            self.assertEqual(set(entry["subject"]), subject_keys)
            kind, subject_type, subject_id, label = expected_kinds[entry["name"]]
            self.assertEqual(entry["kind"], kind)
            self.assertEqual(entry["subject"]["type"], subject_type)
            self.assertEqual(entry["subject"]["id"], subject_id)
            if label is not None:
                self.assertEqual(entry["subject"]["label"], label)

    def test_recent_activity_excludes_non_allowlisted_and_noop_ticket_events(self):
        ids = self._base_entities()
        ticket = self._ticket(self.workspace, "T-003")
        self._global_event(ids, "assignment", "assignment.progress", "2026-04-01T00:00:00.000Z")
        self._ticket_event(ticket, "ticket.updated", "2026-04-01T00:00:01.000Z")
        self._ticket_event(ticket, "ticket.outcome_applied", "2026-04-01T00:00:02.000Z", "open", "open")
        self._global_event(ids, "assignment", "assignment.failed", "2026-04-01T00:00:03.000Z")
        self.assertEqual([e["name"] for e in queries.recent_activity(self.conn, self.workspace)["entries"]],
                         ["assignment.failed"])

        empty_conn, _ = fresh()
        empty = queries.recent_activity(empty_conn, self.workspace)
        self.assertEqual(empty["entries"], [])
        self.assertEqual(empty["head"], 0)
        self.assertEqual(empty["workspace"], self.workspace)
        self.assertEqual(empty["dbId"], state.db_id(empty_conn))

    def test_recent_activity_is_read_only(self):
        ids = self._base_entities()
        self._global_event(ids, "team", "team.running", "2026-05-01T00:00:00.000Z")
        ticket = self._ticket(self.workspace, "T-004")
        self._ticket_event(ticket, "ticket.moved", "2026-05-01T00:00:01.000Z", "open", "done")
        tables = [row[0] for row in self.conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        counts = {table: self.conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in tables}
        events = [tuple(row) for row in self.conn.execute("SELECT * FROM events ORDER BY seq")]
        ticket_events = [tuple(row) for row in self.conn.execute("SELECT * FROM ticket_events ORDER BY id")]
        queries.recent_activity(self.conn, self.workspace)
        queries.recent_activity(self.conn, self.workspace)
        self.assertEqual({table: self.conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                          for table in tables}, counts)
        self.assertEqual([tuple(row) for row in self.conn.execute("SELECT * FROM events ORDER BY seq")], events)
        self.assertEqual([tuple(row) for row in self.conn.execute("SELECT * FROM ticket_events ORDER BY id")],
                         ticket_events)

    def test_activity_recent_dispatch_validates_workspace_and_limit(self):
        self.assertIs(dispatch.COMMANDS["activity.recent"], dispatch._activity_recent)
        reader = mock.Mock()
        reader.close = mock.Mock()
        with mock.patch.object(dispatch, "_reader", return_value=reader), \
                mock.patch.object(queries, "recent_activity", return_value={"entries": []}) as recent:
            dispatch.COMMANDS["activity.recent"]({"workspace": self.workspace}, {})
            recent.assert_called_with(reader, self.workspace, limit=15)
            dispatch.COMMANDS["activity.recent"]({"workspace": self.workspace, "limit": 20}, {})
            recent.assert_called_with(reader, self.workspace, limit=20)

        message = "Argument 'limit' must be an integer between 1 and 20."
        for limit in (0, 21, True, "15"):
            with mock.patch.object(dispatch, "_reader", side_effect=AssertionError("reader opened")):
                with self.assertRaises(AsError) as caught:
                    dispatch.COMMANDS["activity.recent"]({"workspace": self.workspace, "limit": limit}, {})
            self.assertEqual((caught.exception.code, caught.exception.message), (BAD_REQUEST, message))
        invalid_workspaces = ({}, {"workspace": ""}, {"workspace": "relative"},
                              {"workspace": os.path.join(self.workspace, "missing")})
        for args in invalid_workspaces:
            with mock.patch.object(dispatch, "_reader", side_effect=AssertionError("reader opened")), \
                    mock.patch.object(queries, "recent_activity") as recent:
                with self.assertRaises(AsError) as caught:
                    dispatch.COMMANDS["activity.recent"](args, {})
                recent.assert_not_called()
            expected_code = BAD_REQUEST if "workspace" not in args or args["workspace"] == "" else WORKSPACE_NOT_FOUND
            self.assertEqual(caught.exception.code, expected_code)


if __name__ == "__main__":
    unittest.main()
