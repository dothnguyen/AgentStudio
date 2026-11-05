"""Ticket creation accepts only the column/workflow pairs the active board configuration offers."""
import unittest

from tests.unit.test_board_config_v3 import config
from tests.unit.test_p04_s07_board_model import BoardCase
from agent_studio import dispatch
from agent_studio.protocol import AsError


class TicketCreationColumnTests(BoardCase):
    def setUp(self):
        super().setUp()
        self.write_config(config())

    def test_creation_honours_every_configured_column_and_status(self):
        cases = [
            ("backlog", "backlog"),
            ("todo", "ready"),
            ("in-progress", "ready"),
            ("done", "done"),
            ("closed", "closed"),
        ]
        for index, (column, workflow_status) in enumerate(cases):
            with self.subTest(column=column, workflowStatus=workflow_status):
                ticket = self.add(f"ticket-{index}", status=column, workflowStatus=workflow_status)
                self.assertEqual((ticket["status"], ticket["workflowStatus"]), (column, workflow_status))

    def test_creation_without_a_column_keeps_the_initial_backlog_default(self):
        ticket = self.add("default column")
        self.assertEqual((ticket["status"], ticket["workflowStatus"]), ("backlog", "backlog"))

    def test_creation_rejects_an_unknown_column_or_status_before_writing(self):
        before = self.count("tickets")
        with self.assertRaises(AsError) as caught:
            self.add("bad column", status="nowhere", workflowStatus="ready")
        self.assertEqual(caught.exception.code, "BOARD_STATUS_UNKNOWN")
        with self.assertRaises(AsError) as caught:
            self.add("bad status", status="todo", workflowStatus="missing")
        self.assertEqual(caught.exception.code, "BOARD_STATUS_UNKNOWN")
        self.assertEqual(self.count("tickets"), before)

    def test_creation_rejects_mismatched_column_and_status_without_writing(self):
        pairs = [
            ("todo", "backlog"),
            ("backlog", "ready"),
            ("done", "ready"),
            ("closed", "done"),
            ("in-progress", "working"),
        ]
        before = self.count("tickets")
        for column, workflow_status in pairs:
            with self.subTest(column=column, workflowStatus=workflow_status):
                with self.assertRaises(AsError) as caught:
                    self.add("mismatch", status=column, workflowStatus=workflow_status)
                self.assertEqual(caught.exception.code, "TICKET_TRANSITION_INVALID")
        self.assertEqual(self.count("tickets"), before)


class TicketCreationValidationTests(BoardCase):
    def test_dispatch_accepts_optional_column_and_workflow_status(self):
        clean = dispatch._validate_ticket_add({
            "workspace": self.ws, "title": "Write it", "status": "todo", "workflowStatus": "ready",
        })
        self.assertEqual(clean, {
            "workspace": self.ws, "title": "Write it", "priority": 100,
            "status": "todo", "workflowStatus": "ready",
        })

    def test_dispatch_rejects_an_unknown_column(self):
        with self.assertRaises(AsError) as caught:
            dispatch._validate_ticket_add({
                "workspace": self.ws, "title": "Write it", "status": "nowhere",
            })
        self.assertEqual(caught.exception.code, "BAD_REQUEST")

    def test_dispatch_rejects_empty_or_oversized_workflow_status(self):
        for status in ("", "x" * 65):
            with self.subTest(status=status):
                with self.assertRaises(AsError):
                    dispatch._validate_ticket_add({
                        "workspace": self.ws, "title": "Write it", "workflowStatus": status,
                    })


if __name__ == "__main__":
    unittest.main()
