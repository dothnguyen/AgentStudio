import os
import tempfile
import unittest

from tests import helpers  # noqa: F401
from agent_studio import queries, state, tickets
from agent_studio.protocol import AsError
from agent_studio.store import Store


def fresh():
    path = os.path.join(tempfile.mkdtemp(), "state.db")
    conn = state.connect(path, role="coordinator", create=True)
    state.migrate(conn, path)
    return conn, Store(conn)


def make(tx, workspace="/one", kind="story", **fields):
    return tickets.create(tx, workspace, kind, {"title": fields.get("title", "a")}, fields.get("hold", False))


class Tickets(unittest.TestCase):
    def setUp(self):
        self.conn, self.store = fresh()

    def test_create_uses_kind_entries_and_workspace_sequence(self):
        with self.store.transaction() as tx:
            feature = make(tx, kind="feature")
            story = make(tx)
            bug = make(tx, kind="bug")
            held = make(tx, kind="story", hold=True)
            other = make(tx, workspace="/two")
        self.assertEqual((feature["status"], story["status"], bug["status"], held["status"]),
                         ("ready_unpack", "refine", "triage", "backlog"))
        self.assertEqual((feature["key"], story["key"], bug["key"], held["key"], other["key"]),
                         ("T-001", "T-002", "T-003", "T-004", "T-001"))
        with self.assertRaises(AsError) as cm:
            with self.store.transaction() as tx:
                make(tx, kind="bug", hold=True)
        self.assertEqual(cm.exception.code, "TICKET_TRANSITION_INVALID")

    def test_dependencies_cycles_workspaces_and_merged(self):
        with self.store.transaction() as tx:
            a, b, c = make(tx), make(tx), make(tx)
            tickets.add_deps(tx, a, [b["key"]])
            tickets.add_deps(tx, b, [c["key"]])
            self.assertFalse(tickets.deps_merged(tx, a))
            with self.assertRaises(AsError) as cm:
                tickets.add_deps(tx, c, [a["key"]])
            self.assertEqual(cm.exception.code, "TICKET_DEPENDENCY_CYCLE")
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM ticket_deps").fetchone()[0], 2)
        with self.store.transaction() as tx:
            with self.assertRaises(AsError) as cm:
                tickets.add_deps(tx, a, ["T-999"])
            self.assertEqual(cm.exception.code, "TICKET_NOT_FOUND")
            with self.assertRaises(AsError) as cm:
                tickets.add_deps(tx, a, [a["key"]])
            self.assertEqual(cm.exception.code, "TICKET_DEPENDENCY_CYCLE")
            # A dependent with no dependencies is immediately satisfied.
            self.assertTrue(tickets.deps_merged(tx, c))
            tickets.move(tx, c, "refining", "coordinator")
            tickets.move(tx, c, "ready_dev", "coordinator")
            tickets.move(tx, c, "in_dev", "coordinator")
            tickets.move(tx, c, "ready_test", "coordinator")
            tickets.move(tx, c, "in_test", "coordinator")
            tickets.move(tx, c, "ready_review", "coordinator")
            tickets.move(tx, c, "in_review", "coordinator")
            tickets.move(tx, c, "ready_merge", "coordinator")
            tickets.move(tx, c, "merged", "coordinator")
            self.assertTrue(tickets.deps_merged(tx, b))

    def test_duplicate_dependency_keys_change_each_edge_once(self):
        with self.store.transaction() as tx:
            a, b = make(tx), make(tx)
            tickets.add_deps(tx, a, [b["key"], b["key"]])
            tickets.remove_deps(tx, a, [b["key"], b["key"]])
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM ticket_deps").fetchone()[0], 0)

    def test_events_are_paired_and_dependency_noop_is_silent(self):
        with self.store.transaction() as tx:
            a, b = make(tx), make(tx)
            before = self.conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
            ticket_events_before = self.conn.execute("SELECT COUNT(*) FROM ticket_events").fetchone()[0]
            tickets.add_deps(tx, a, [b["key"]])
            tickets.add_deps(tx, a, [b["key"]])
            events_after_deps = self.conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
            ticket_events_after_deps = self.conn.execute(
                "SELECT COUNT(*) FROM ticket_events").fetchone()[0]
            with self.assertRaises(AsError) as cm:
                tickets.move(tx, a, "in_dev", "operator")
            self.assertEqual(cm.exception.code, "TICKET_TRANSITION_INVALID")
            self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM events").fetchone()[0], events_after_deps)
            self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM ticket_events").fetchone()[0],
                             ticket_events_after_deps)
        events = queries.events_after(self.conn, before)["events"]
        self.assertEqual(len(events), 1)
        self.assertEqual((events[0]["name"], events[0]["entity"], events[0]["entityId"]),
                         ("ticket.depends", "ticket", a["id"]))
        row = self.conn.execute("SELECT event_seq, name FROM ticket_events ORDER BY id DESC LIMIT 1").fetchone()
        self.assertEqual((row["event_seq"], row["name"]), (events[0]["seq"], "ticket.depends"))
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM ticket_events").fetchone()[0],
                         ticket_events_before + 1)

    def test_each_write_has_one_matching_ticket_event(self):
        with self.store.transaction() as tx:
            before = self.conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
            a = make(tx)
            b = make(tx)
            a = tickets.move(tx, a, "refining", "coordinator")
            a = tickets.block(tx, a, "coordinator", "wait")
            a = tickets.unblock(tx, a, "coordinator")
            a = tickets.cancel(tx, a, "operator", "stop")
            tickets.add_deps(tx, b, [a["key"]])
            tickets.remove_deps(tx, b, [a["key"]])
        events = queries.events_after(self.conn, before)["events"]
        self.assertEqual([event["name"] for event in events], [
            "ticket.created", "ticket.created", "ticket.moved", "ticket.moved", "ticket.moved",
            "ticket.moved", "ticket.depends", "ticket.depends",
        ])
        pairs = self.conn.execute("SELECT event_seq, name, ticket_id FROM ticket_events WHERE event_seq > ? ORDER BY event_seq",
                                  (before,)).fetchall()
        self.assertEqual([(row["event_seq"], row["name"], row["ticket_id"]) for row in pairs],
                         [(event["seq"], event["name"], event["entityId"]) for event in events])
        self.assertTrue(all(event["entity"] == "ticket" for event in events))
