"""P04-S08: phases as database records — commands, the protected default, the current-phase pointer,
tickets in phases, and the phase-grouped board."""
import unittest

from tests import helpers  # noqa: F401  (puts backend on sys.path)
from agent_studio import boardmodel
from agent_studio.protocol import AsError
from tests.unit.test_p04_s07_board_model import CONFIG_A, BoardCase


class PhaseCase(BoardCase):
    def phase(self, action, phase="default", **extra):
        with self.store.transaction() as tx:
            fn = {"add": boardmodel.phase_add, "edit": boardmodel.phase_edit, "close": boardmodel.phase_close,
                  "reopen": boardmodel.phase_reopen, "remove": boardmodel.phase_remove,
                  "set-current": boardmodel.phase_set_current,
                  "clear-current": boardmodel.phase_clear_current}[action]
            args = dict(extra)
            if action not in ("add", "clear-current"):
                args["phase"] = phase
            return fn(tx, self.ws, args)

    def code(self, action, phase="default", **extra):
        with self.assertRaises(AsError) as caught:
            self.phase(action, phase, **extra)
        return caught.exception

    def phase_events(self):
        return [(r["name"], r["entity"], r["payload_json"]) for r in self.conn.execute(
            "SELECT name, entity, payload_json FROM events WHERE entity = 'phase' ORDER BY seq")]

    def pointer(self):
        return self.conn.execute("SELECT current_phase_id FROM board_state WHERE workspace = ?",
                                 (self.ws,)).fetchone()[0]

    def phase_id(self, slug):
        return self.conn.execute("SELECT id FROM phases WHERE workspace = ? AND slug = ?",
                                 (self.ws, slug)).fetchone()[0]


class PhaseCommands(PhaseCase):
    def test_new_board_has_only_the_default_phase_and_it_is_current(self):
        self.add("first")  # any write creates the board
        listed = boardmodel.phase_list(self.conn, self.ws)
        self.assertEqual([(p["slug"], p["position"], p["status"], p["current"], p["ticketCount"]) for p in
                          listed["phases"]], [("default", 0, "open", True, 1)])
        self.assertEqual(listed["currentPhase"]["slug"], "default")
        self.assertEqual([name for name, _e, _p in self.phase_events()], ["phase.created"])

    def test_add_appends_and_inserts_with_renumbering(self):
        self.add("first")
        added = self.phase("add", id="build-out", name="Build out")["phase"]
        self.assertEqual((added["slug"], added["position"]), ("build-out", 1))
        with self.assertRaises(AsError) as caught:
            self.phase("add", id="build-out", name="Again")
        self.assertEqual(caught.exception.code, "PHASE_EXISTS")
        self.phase("add", id="hardening", name="Hardening", before="default")
        self.phase("add", id="polish", name="Polish", description="final touches")
        order = [(p["slug"], p["position"]) for p in boardmodel.phase_list(self.conn, self.ws)["phases"]]
        self.assertEqual(order, [("hardening", 0), ("default", 1), ("build-out", 2), ("polish", 3)])
        shown = boardmodel.phase_detail(self.conn, self.ws, "polish")
        self.assertEqual(shown["phase"]["description"], "final touches")
        with self.assertRaises(AsError) as caught:
            self.phase("add", id="x", name="X", before="nope")
        self.assertEqual(caught.exception.code, "PHASE_NOT_FOUND")

    def test_edit_changes_name_and_description(self):
        self.add("first")
        edited = self.phase("edit", name="Main line", description="the default flow")["phase"]
        self.assertEqual((edited["name"], edited["description"]), ("Main line", "the default flow"))
        with self.assertRaises(AsError) as caught:
            self.phase("edit")
        self.assertEqual(caught.exception.code, "BAD_REQUEST")
        with self.assertRaises(AsError) as caught:
            self.phase("edit", phase="nope", name="X")
        self.assertEqual(caught.exception.code, "PHASE_NOT_FOUND")

    def test_close_reopen_and_events(self):
        self.phase("add", id="legacy", name="Legacy")
        closed = self.phase("close", "legacy")
        self.assertEqual(closed["phase"]["status"], "closed")
        self.assertFalse(closed["clearedCurrent"])
        self.phase("close", "legacy")  # already closed: no-op, no event
        reopened = self.phase("reopen", "legacy")
        self.assertEqual(reopened["phase"]["status"], "open")
        self.phase("reopen", "legacy")  # already open: no-op, no event
        self.assertEqual([name for name, _e, _p in self.phase_events()],
                         ["phase.created", "phase.created", "phase.closed", "phase.reopened"])

    def test_default_phase_is_protected(self):
        self.add("first")
        for action in ("close", "remove"):
            caught = self.code(action)
            self.assertEqual(caught.code, "PHASE_PROTECTED", action)
        self.assertEqual(len(boardmodel.phase_list(self.conn, self.ws)["phases"]), 1)

    def test_remove_empty_and_non_empty_phases(self):
        self.phase("add", id="one", name="One")
        self.phase("add", id="two", name="Two")
        removed = self.phase("remove", "one")
        self.assertEqual((removed["removed"], removed["movedTickets"]), ("one", []))
        self.add("a")
        self.phase("add", id="two-tickets", name="Two tickets")
        self.conn.execute("UPDATE tickets SET phase_id = ? WHERE key = 'T-001'", (self.phase_id("two-tickets"),))
        caught = self.code("remove", "two-tickets")
        self.assertEqual(caught.code, "PHASE_NOT_EMPTY")
        self.assertIn("--move-to", caught.remediation)
        self.assertEqual(self.conn.execute("SELECT slug FROM phases WHERE slug = 'two-tickets'").fetchone()[0],
                         "two-tickets")  # nothing written
        caught = self.code("remove", "two-tickets", moveTo="nope")
        self.assertEqual(caught.code, "PHASE_NOT_FOUND")
        self.phase("close", "two")  # a closed target cannot receive tickets
        caught = self.code("remove", "two-tickets", moveTo="two")
        self.assertEqual(caught.code, "PHASE_CLOSED")
        caught = self.code("remove", "two-tickets", moveTo="two-tickets")
        self.assertEqual(caught.code, "BAD_REQUEST")
        removed = self.phase("remove", "two-tickets", moveTo="default")
        self.assertEqual((removed["movedTickets"], removed["moveTo"]), (["T-001"], "default"))
        self.assertEqual(self.conn.execute("SELECT phase_id FROM tickets WHERE key = 'T-001'").fetchone()[0],
                         self.phase_id("default"))
        self.assertIsNone(self.conn.execute("SELECT id FROM phases WHERE slug = 'two-tickets'").fetchone())


class CurrentPhase(PhaseCase):
    def test_pointer_rules_and_fallback_to_default(self):
        self.add("first")
        self.phase("add", id="next", name="Next")
        self.assertEqual(boardmodel.effective_current_phase(self.conn, self.ws)["slug"], "default")
        set_result = self.phase("set-current", "next")
        self.assertEqual((set_result["currentPhase"]["slug"], set_result["changed"]), ("next", True))
        self.assertEqual(boardmodel.effective_current_phase(self.conn, self.ws)["slug"], "next")
        self.assertEqual(self.phase("set-current", "next")["changed"], False)  # no-op, no event
        cleared = self.phase("clear-current")
        self.assertEqual((cleared["currentPhase"]["slug"], cleared["changed"]), ("default", True))
        self.assertEqual(self.phase("clear-current")["changed"], False)
        self.assertEqual(boardmodel.effective_current_phase(self.conn, self.ws)["slug"], "default")
        with self.assertRaises(AsError) as caught:
            self.phase("set-current", "nope")
        self.assertEqual(caught.exception.code, "PHASE_NOT_FOUND")
        self.phase("close", "next")
        caught = self.code("set-current", "next")
        self.assertEqual(caught.code, "PHASE_CLOSED")
        names = [name for name, _e, _p in self.phase_events()]
        self.assertEqual(names, ["phase.created", "phase.created", "phase.set_current", "phase.clear_current",
                                 "phase.closed"])

    def test_closing_the_current_phase_falls_back_and_clears_the_pointer(self):
        self.add("first")
        self.phase("add", id="beta", name="Beta")
        self.phase("set-current", "beta")
        closed = self.phase("close", "beta")
        self.assertTrue(closed["clearedCurrent"])
        self.assertIsNone(self.pointer())
        self.assertEqual(boardmodel.effective_current_phase(self.conn, self.ws)["slug"], "default")

    def test_stale_pointer_falls_back_to_default(self):
        self.add("first")
        self.phase("add", id="gone", name="Gone")
        self.phase("set-current", "gone")
        self.conn.execute("PRAGMA foreign_keys = OFF")  # test-only corruption: point at a missing phase
        self.conn.execute("UPDATE board_state SET current_phase_id = ? WHERE workspace = ?",
                          ("e" * 8 + "-0000-4000-8000-" + "e" * 12, self.ws))
        self.conn.execute("PRAGMA foreign_keys = ON")
        self.assertEqual(boardmodel.effective_current_phase(self.conn, self.ws)["slug"], "default")

    def test_ticket_in_scope(self):
        self.add("in-default")
        self.phase("add", id="other", name="Other")
        self.add("in-other", phase="other")
        current = boardmodel.effective_current_phase(self.conn, self.ws)
        rows = {r["key"]: dict(r) for r in self.conn.execute("SELECT * FROM tickets")}
        self.assertTrue(boardmodel.ticket_in_scope(rows["T-001"], current))
        self.assertFalse(boardmodel.ticket_in_scope(rows["T-002"], current))
        self.phase("set-current", "other")
        current = boardmodel.effective_current_phase(self.conn, self.ws)
        self.assertFalse(boardmodel.ticket_in_scope(rows["T-001"], current))
        self.assertTrue(boardmodel.ticket_in_scope(rows["T-002"], current))

    def test_changing_the_current_phase_leaves_a_claimed_ticket_alone(self):
        self.add("claimed")
        self.phase("add", id="next", name="Next")
        agent_id = "f" * 8 + "-0000-4000-8000-" + "f" * 12
        self.conn.execute("UPDATE tickets SET assignee = ? WHERE key = 'T-001'", (agent_id,))
        before = self.conn.execute("SELECT phase_id, assignee FROM tickets WHERE key = 'T-001'").fetchone()
        self.phase("set-current", "next")
        after = self.conn.execute("SELECT phase_id, assignee FROM tickets WHERE key = 'T-001'").fetchone()
        self.assertEqual(tuple(before), tuple(after))
        with self.assertRaises(AsError) as caught:
            with self.store.transaction() as tx:
                boardmodel.ticket_phase(tx, self.ws, {"key": "T-001", "phase": "next"})
        self.assertEqual(caught.exception.code, "TICKET_BUSY")


class TicketsInPhases(PhaseCase):
    def test_add_and_move_between_phases(self):
        self.phase("add", id="alpha", name="Alpha")
        self.phase("add", id="beta", name="Beta")
        landed = self.add("no phase")
        self.assertEqual(landed["phase"], "default")
        placed = self.add("placed", phase="alpha")
        self.assertEqual(placed["phase"], "alpha")
        with self.assertRaises(AsError) as caught:
            self.add("lost", phase="nope")
        self.assertEqual(caught.exception.code, "PHASE_NOT_FOUND")
        self.phase("close", "beta")
        with self.assertRaises(AsError) as caught:
            self.add("closed target", phase="beta")
        self.assertEqual(caught.exception.code, "PHASE_CLOSED")
        with self.store.transaction() as tx:
            moved = boardmodel.ticket_phase(tx, self.ws, {"key": "T-002", "phase": "alpha"})
        self.assertFalse(moved["moved"])  # same-phase move is a no-op
        with self.store.transaction() as tx:
            moved = boardmodel.ticket_phase(tx, self.ws, {"key": "T-001", "phase": "alpha"})
        self.assertEqual((moved["from"], moved["ticket"]["phase"], moved["moved"]), ("default", "alpha", True))
        names = [e["name"] for e in self.events("T-001")]
        self.assertEqual(names, ["ticket.created", "ticket.phase_changed"])
        with self.assertRaises(AsError) as caught:
            with self.store.transaction() as tx:
                boardmodel.ticket_phase(tx, self.ws, {"key": "T-001", "phase": "beta"})
        self.assertEqual(caught.exception.code, "PHASE_CLOSED")

    def test_list_filters_by_phase_and_board_show_groups(self):
        self.phase("add", id="alpha", name="Alpha")
        self.add("one")
        self.add("two", phase="alpha")
        self.add("three", phase="alpha")
        self.move("T-003", "finished")
        listed = boardmodel.ticket_list(self.conn, self.ws, phase="alpha")
        self.assertEqual([t["key"] for t in listed["tickets"]], ["T-002", "T-003"])
        with self.assertRaises(AsError) as caught:
            boardmodel.ticket_list(self.conn, self.ws, phase="nope")
        self.assertEqual(caught.exception.code, "PHASE_NOT_FOUND")
        self.phase("set-current", "alpha")
        shown = boardmodel.board_show(self.conn, self.ws)
        self.assertEqual([(p["slug"], p["current"], p["ticketCount"]) for p in shown["phases"]],
                         [("default", False, 1), ("alpha", True, 2)])
        alpha = shown["phases"][1]
        self.assertEqual([(c["status"], c["count"]) for c in alpha["columns"]],
                         [("open", 1), ("wip", 0), ("finished", 1)])
        self.assertEqual([t["key"] for c in alpha["columns"] for t in c["tickets"]], ["T-002", "T-003"])


if __name__ == "__main__":
    unittest.main()
