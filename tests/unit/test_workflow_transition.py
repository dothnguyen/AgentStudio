"""Workflow-to-column derivation and atomic transition recording."""
import json
import unittest

from tests import helpers  # noqa: F401
from tests.unit.test_board_config_v3 import config
from tests.unit.test_p04_s07_board_model import BoardCase
from agent_studio import boardmodel
from agent_studio.protocol import AsError


class ColumnTests(unittest.TestCase):
    def test_columns_follow_status_kind_claim_and_current_column(self):
        parsed = boardmodel.parse_config(config())
        cases = [
            ("done", "backlog", True, "backlog"),
            ("todo", "done", True, "done"),
            ("todo", "closed", True, "closed"),
            ("todo", "working", True, "in-progress"),
            ("todo", "working", False, "todo"),
            ("in-progress", "working", False, "in-progress"),
            ("done", "blocked", True, "done"),
            ("in-progress", "blocked", False, "in-progress"),
            ("in-progress", "ready", False, "in-progress"),
            ("backlog", "ready", False, "todo"),
            ("done", "ready", True, "todo"),
        ]
        for current, target, claimed, expected in cases:
            with self.subTest(current=current, target=target, claimed=claimed):
                self.assertEqual(boardmodel.column_for(parsed, current, target, claimed), expected)

    def test_unknown_target_is_rejected(self):
        with self.assertRaises(AsError) as caught:
            boardmodel.column_for(boardmodel.parse_config(config()), "todo", "missing", False)
        self.assertEqual(caught.exception.code, "BOARD_STATUS_UNKNOWN")


class WorkflowTransitionTests(BoardCase):
    def test_transition_updates_both_fields_and_records_one_event(self):
        created = self.add()
        self.conn.execute("UPDATE tickets SET status = ?, workflow_status = ?, updated_at = ? WHERE id = ?",
                          ("todo", "ready", "old", created["id"]))
        ticket = boardmodel.get_ticket(self.conn, self.ws, created["key"])
        with self.store.transaction() as tx:
            boardmodel.set_workflow(tx, ticket, "working", "agent", "started", boardmodel.parse_config(config()), True)
        updated = boardmodel.get_ticket(self.conn, self.ws, created["key"])
        self.assertEqual((updated["workflow_status"], updated["status"]), ("working", "in-progress"))
        self.assertNotEqual(updated["updated_at"], "old")
        events = self.events(created["key"])
        self.assertEqual(len(events), 2)
        workflow_events = [event for event in events if event["name"] == "ticket.workflow_changed"]
        self.assertEqual(len(workflow_events), 1)
        event = workflow_events[0]
        self.assertEqual((event["name"], event["actor"], event["from_status"], event["to_status"]),
                         ("ticket.workflow_changed", "agent", "ready", "working"))
        self.assertEqual(json.loads(event["payload_json"]),
                         {"ticketId": created["id"], "key": created["key"], "from": "ready", "to": "working",
                          "fromColumn": "todo", "toColumn": "in-progress", "reason": "started"})

    def test_unknown_target_does_not_modify_ticket_or_write_event(self):
        created = self.add()
        ticket = boardmodel.get_ticket(self.conn, self.ws, created["key"])
        with self.store.transaction() as tx:
            with self.assertRaises(AsError) as caught:
                boardmodel.set_workflow(tx, ticket, "missing", "operator", None, boardmodel.parse_config(config()))
        self.assertEqual(caught.exception.code, "BOARD_STATUS_UNKNOWN")
        self.assertEqual(caught.exception.data["key"], ticket["key"])
        self.assertEqual(boardmodel.get_ticket(self.conn, self.ws, ticket["key"]), ticket)
        self.assertEqual(len(self.events(ticket["key"])), 1)
