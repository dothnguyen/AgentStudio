"""Boards A: ``ticket.show`` dependency links and the truncated-event flag."""
import unittest

from tests import helpers  # noqa: F401  (puts backend on sys.path)
from agent_studio import boardmodel
from tests.unit.test_p04_s07_board_model import BoardCase


class TicketShowLinks(BoardCase):
    def ticket_id(self, key):
        return self.conn.execute("SELECT id FROM tickets WHERE workspace = ? AND key = ?",
                                 (self.ws, key)).fetchone()["id"]

    def add_phase(self, slug, name):
        with self.store.transaction() as tx:
            return boardmodel.phase_add(tx, self.ws, {"id": slug, "name": name})

    def test_links_return_title_status_and_phase_for_dependencies_and_dependents(self):
        self.add_phase("alpha", "Alpha")
        self.add("dependent")                      # T-001
        self.add("dependency", phase="alpha")      # T-002
        self.add("blocker of dependent")           # T-003
        self.depend("T-001", on=["T-002"])
        self.depend("T-003", on=["T-001"])
        self.move("T-002", "wip")

        detail = boardmodel.ticket_detail(self.conn, self.ws, "T-001")

        self.assertEqual(detail["dependsOn"], ["T-002"])  # key lists stay backward compatible
        self.assertEqual(detail["dependents"], ["T-003"])
        self.assertEqual(detail["links"], {
            "dependsOn": [{"key": "T-002", "title": "dependency", "status": "wip", "phase": "alpha"}],
            "dependents": [{"key": "T-003", "title": "blocker of dependent", "status": "open",
                            "phase": "default"}],
        })

    def test_no_links_are_empty_lists(self):
        self.add("alone")

        detail = boardmodel.ticket_detail(self.conn, self.ws, "T-001")

        self.assertEqual(detail["links"], {"dependsOn": [], "dependents": []})

    def test_missing_dependency_does_not_raise_and_has_null_fields(self):
        self.add("dependent")  # T-001
        missing = "e" * 8 + "-0000-4000-8000-" + "e" * 12
        self.conn.execute("PRAGMA foreign_keys = OFF")  # test-only corruption: point at a missing ticket
        self.conn.execute("INSERT INTO ticket_deps (ticket_id, blocked_by_ticket_id) VALUES (?, ?)",
                          (self.ticket_id("T-001"), missing))
        self.conn.execute("PRAGMA foreign_keys = ON")

        detail = boardmodel.ticket_detail(self.conn, self.ws, "T-001")

        self.assertEqual(detail["dependsOn"], [])  # the existing key list is unchanged
        self.assertEqual(detail["links"]["dependsOn"],
                         [{"key": missing, "title": None, "status": None, "phase": None}])

    def test_events_truncated_is_false_at_the_limit_and_true_past_it(self):
        self.add("many events")
        ticket_id = self.ticket_id("T-001")

        at_limit = boardmodel.ticket_detail(self.conn, self.ws, "T-001")
        self.assertFalse(at_limit["eventsTruncated"])
        for _ in range(boardmodel.EVENTS_SHOWN - 1):  # ticket.created already counts as one event
            boardmodel._ticket_event(self.conn, ticket_id, "ticket.note", "operator", "open", "open", {})
        at_limit = boardmodel.ticket_detail(self.conn, self.ws, "T-001")
        self.assertEqual(len(at_limit["events"]), boardmodel.EVENTS_SHOWN)
        self.assertFalse(at_limit["eventsTruncated"])

        boardmodel._ticket_event(self.conn, ticket_id, "ticket.note", "operator", "open", "open", {})
        over_limit = boardmodel.ticket_detail(self.conn, self.ws, "T-001")
        self.assertEqual(len(over_limit["events"]), boardmodel.EVENTS_SHOWN)
        self.assertTrue(over_limit["eventsTruncated"])


if __name__ == "__main__":
    unittest.main()
