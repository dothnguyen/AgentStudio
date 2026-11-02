"""Boards A: ``ticket.list`` summary mode (no bodies, dependency keys) without changing the default output."""
import unittest
from unittest import mock

from tests import helpers  # noqa: F401  (puts backend on sys.path)
from agent_studio import boardmodel, dispatch, mcpserver
from agent_studio.protocol import AsError
from tests.unit.test_p04_s07_board_model import BoardCase

SUMMARY_FIELDS = {"key", "title", "status", "priority", "phase", "phaseName", "assignee", "branch", "rounds",
                  "blockedReason", "returnStatus", "activity", "updatedAt", "dependsOn", "openDependsOn"}


class _Reader:
    """A reader connection whose close() is a no-op, so a test can reuse its own connection."""

    def __init__(self, conn):
        self._conn = conn

    def __getattr__(self, name):
        return getattr(self._conn, name)

    def close(self):
        pass


class TicketListSummary(BoardCase):
    def add_phase(self, slug, name):
        with self.store.transaction() as tx:
            return boardmodel.phase_add(tx, self.ws, {"id": slug, "name": name})

    def test_summary_omits_body_and_reports_done_and_open_dependencies(self):
        self.add("dependent", body="full brief")
        self.add("done dependency")
        self.add("open dependency")
        self.depend("T-001", on=["T-002", "T-003"])
        self.move("T-002", "done")

        listed = boardmodel.ticket_list(self.conn, self.ws, summary=True)
        by_key = {ticket["key"]: ticket for ticket in listed["tickets"]}

        self.assertNotIn("body", by_key["T-001"])
        self.assertNotIn("body", by_key["T-002"])
        self.assertEqual(by_key["T-001"]["dependsOn"], ["T-002", "T-003"])
        self.assertEqual(by_key["T-001"]["openDependsOn"], ["T-003"])
        self.assertEqual(by_key["T-002"]["dependsOn"], [])
        self.assertEqual(by_key["T-002"]["openDependsOn"], [])
        self.assertTrue(SUMMARY_FIELDS.issubset(by_key["T-001"]))

    def test_default_output_keeps_body_and_adds_no_dependency_keys(self):
        self.add("dependent", body="full brief")
        self.add("dependency")
        self.depend("T-001", on=["T-002"])

        listed = boardmodel.ticket_list(self.conn, self.ws)
        explicit = boardmodel.ticket_list(self.conn, self.ws, summary=False)

        self.assertEqual(listed, explicit)
        for ticket in listed["tickets"]:
            self.assertIn("body", ticket)
            self.assertNotIn("dependsOn", ticket)
            self.assertNotIn("openDependsOn", ticket)
        self.assertEqual(listed["tickets"][0]["body"], "full brief")

    def test_phase_filter_and_summary_work_together(self):
        self.add_phase("alpha", "Alpha")
        self.add("default one", body="x")
        self.add("alpha one", phase="alpha", body="y")
        self.add("alpha two", phase="alpha", body="z")

        listed = boardmodel.ticket_list(self.conn, self.ws, phase="alpha", summary=True)

        self.assertEqual([ticket["key"] for ticket in listed["tickets"]], ["T-002", "T-003"])
        self.assertFalse(any("body" in ticket for ticket in listed["tickets"]))

    def test_dispatch_passes_phase_and_summary(self):
        self.add_phase("alpha", "Alpha")
        self.add("default one", body="x")
        self.add("alpha one", phase="alpha", body="y")

        with mock.patch.object(dispatch, "_reader", return_value=_Reader(self.conn)):
            data = dispatch._ticket_list({"workspace": self.ws, "phase": "alpha", "summary": True}, {})

        self.assertEqual([ticket["key"] for ticket in data["tickets"]], ["T-002"])
        self.assertNotIn("body", data["tickets"][0])

    def test_dispatch_validates_summary_as_a_boolean(self):
        self.assertTrue(dispatch._validate_ticket_list({"workspace": self.ws, "summary": True})["summary"])
        self.assertNotIn("summary", dispatch._validate_ticket_list({"workspace": self.ws}))
        with self.assertRaises(AsError) as caught:
            dispatch._validate_ticket_list({"workspace": self.ws, "summary": "yes"})
        self.assertEqual(caught.exception.code, "BAD_REQUEST")


class OperatorTicketListSummary(unittest.TestCase):
    def test_operator_tool_passes_the_summary_flag(self):
        seen = {}

        def fake(req, require_id=False):
            seen.update(req)
            return {"ok": True, "data": {"tickets": []}}

        operator = {"workspace": "", "allowWrites": False, "session": "s1"}
        request = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                   "params": {"name": "ticket_list", "arguments": {"phase": "alpha", "summary": True}}}
        with mock.patch.object(mcpserver.dispatch, "handle_request", fake), \
                mock.patch.object(mcpserver.wsmod, "resolve", return_value={"path": "/w"}):
            result = mcpserver.handle(request, "", "", operator=operator)

        self.assertFalse(result["result"]["isError"])
        self.assertEqual(seen["args"], {"phase": "alpha", "summary": True, "workspace": "/w"})


if __name__ == "__main__":
    unittest.main()
