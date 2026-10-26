"""P04-S16: compact, read-only summary of the effective current board phase."""
import json
import os

from tests import helpers  # noqa: F401  (puts backend on sys.path)
from agent_studio import boardmodel, dispatch
from agent_studio.protocol import AsError
from tests.unit.test_p04_s07_board_model import CONFIG_A, CONFIG_B, BoardCase


class BoardSummaryTests(BoardCase):
    def add_phase(self, slug="phase-05", name="Phase 05", current=False):
        with self.store.transaction() as tx:
            boardmodel.phase_add(tx, self.ws, {"id": slug, "name": name})
            if current:
                boardmodel.phase_set_current(tx, self.ws, {"phase": slug})

    def set_ticket(self, key, status=None, assignee=None, created_at=None):
        sets, values = [], []
        for field, value in (("status", status), ("assignee", assignee), ("created_at", created_at)):
            if value is not None:
                sets.append(f"{field} = ?")
                values.append(value)
        values.append(key)
        self.conn.execute(f"UPDATE tickets SET {', '.join(sets)} WHERE key = ?", values)

    def make_agent(self, name="developer", role="Developer"):
        with self.store.transaction() as tx:
            team = tx.create("team", {"name": "summary", "workspace": self.ws})
            return tx.create("agent", {"team_id": team, "ordinal": 0, "provider_id": "fake",
                                       "role": role, "display_name": name})

    def test_custom_status_counts_totals_and_current_phase_only(self):
        config = json.loads(json.dumps(CONFIG_B))
        names = {"todo": "Ideas", "doing": "In progress", "review": "Review ready",
                 "done": "Shipped", "dropped": "Won't do"}
        for status in config["statuses"]:
            status["name"] = names[status["id"]]
        self.write_config(config)
        self.add("other phase", priority=1)
        self.add_phase(current=True)
        pending = self.add("pending", phase="phase-05", priority=6)
        assigned = self.add("assigned", phase="phase-05", priority=2)
        blocked = self.add("blocked", phase="phase-05", priority=3)
        done = self.add("done", phase="phase-05", priority=4)
        closed = self.add("closed", phase="phase-05", priority=5)
        agent = self.make_agent()
        self.set_ticket(assigned["key"], status="doing", assignee=agent)
        self.set_ticket(blocked["key"], status="blocked")
        self.set_ticket(done["key"], status="done")
        self.set_ticket(closed["key"], status="dropped")

        summary = boardmodel.board_summary(self.conn, self.ws)

        self.assertEqual(summary["currentPhase"], {"slug": "phase-05", "name": "Phase 05", "status": "open"})
        self.assertEqual(summary["columns"], [
            {"status": "todo", "kind": "initial", "title": "Ideas", "count": 1},
            {"status": "doing", "kind": None, "title": "In progress", "count": 1},
            {"status": "review", "kind": None, "title": "Review ready", "count": 0},
            {"status": "done", "kind": "done", "title": "Shipped", "count": 1},
            {"status": "dropped", "kind": "closed", "title": "Won't do", "count": 1},
            {"status": "blocked", "kind": None, "title": "blocked", "count": 1},
        ])
        self.assertEqual(summary["totals"], {"active": 1, "blocked": 1, "done": 2})
        self.assertEqual([ticket["key"] for ticket in summary["tickets"]], [assigned["key"], blocked["key"]])
        self.assertNotIn("T-001", [ticket["key"] for ticket in summary["tickets"]])

    def test_empty_board_is_zero_and_does_not_materialize_default_phase(self):
        summary = boardmodel.board_summary(self.conn, self.ws)
        self.assertEqual(summary, {
            "workspace": self.ws,
            "currentPhase": {"slug": "default", "name": "Default", "status": "open"},
            "columns": [
                {"status": "open", "kind": "initial", "title": "open", "count": 0},
                {"status": "wip", "kind": None, "title": "wip", "count": 0},
                {"status": "finished", "kind": "done", "title": "finished", "count": 0},
            ],
            "totals": {"active": 0, "blocked": 0, "done": 0},
            "tickets": [],
        })
        self.assertEqual((self.count("board_state"), self.count("phases")), (0, 0))

    def test_missing_and_invalid_config_raise_board_config_invalid(self):
        path = os.path.join(self.ws, ".agent-studio", "board.json")
        os.remove(path)
        with self.assertRaises(AsError) as missing:
            boardmodel.board_summary(self.conn, self.ws)
        self.assertEqual(missing.exception.code, "BOARD_CONFIG_INVALID")
        with open(path, "w", encoding="utf-8") as config_file:
            config_file.write("{broken")
        with self.assertRaises(AsError) as invalid:
            boardmodel.board_summary(self.conn, self.ws)
        self.assertEqual(invalid.exception.code, "BOARD_CONFIG_INVALID")

    def test_ticket_candidates_are_combined_ordered_bounded_and_compact(self):
        self.write_config(CONFIG_B)
        self.add("pending high", priority=0)
        blocked = self.add("blocked", priority=2, body="secret blocked body")
        assigned = self.add("assigned", priority=2, body="secret assigned body")
        later = self.add("later assigned", priority=2)
        terminal = self.add("terminal high", priority=0)
        agent = self.make_agent(name="developer", role="Developer")
        self.set_ticket(blocked["key"], status="blocked", created_at="2026-01-01T00:00:00Z")
        self.set_ticket(assigned["key"], status="doing", assignee=agent, created_at="2026-01-01T00:00:00Z")
        self.set_ticket(later["key"], status="review", assignee=agent, created_at="2026-01-01T00:00:02Z")
        self.set_ticket(terminal["key"], status="done")
        # Force reverse insertion order so the final tie-break is proven to be key, not row order.
        self.conn.execute("UPDATE tickets SET key = ? WHERE key = ?", ("T-020", blocked["key"]))
        self.conn.execute("UPDATE tickets SET key = ? WHERE key = ?", ("T-010", assigned["key"]))

        tickets = boardmodel.board_summary(self.conn, self.ws, limit=2)["tickets"]

        self.assertEqual([ticket["key"] for ticket in tickets], ["T-010", "T-020"])
        allowed = {"key", "title", "status", "priority", "phase", "activity"}
        self.assertTrue(all(set(ticket) == allowed for ticket in tickets))
        self.assertEqual(tickets, [
            {"key": "T-010", "title": "assigned", "status": "doing", "priority": 2,
             "phase": "default", "activity": {"state": "working", "agent": "developer",
                                                   "role": "Developer"}},
            {"key": "T-020", "title": "blocked", "status": "blocked", "priority": 2,
             "phase": "default", "activity": {"state": "blocked"}},
        ])
        forbidden = {"body", "events", "dependsOn", "created_at", "updated_at", "assignee", "note",
                     "run", "leaseUntil", "workflow", "waitingFor"}
        self.assertTrue(all(forbidden.isdisjoint(ticket) and forbidden.isdisjoint(ticket["activity"])
                            for ticket in tickets))

    def test_bounded_tickets_skip_assigned_terminal_candidates(self):
        self.write_config(CONFIG_B)
        terminal = self.add("assigned terminal", priority=0)
        working = self.add("working", priority=1)
        agent = self.make_agent()
        self.set_ticket(terminal["key"], status="done", assignee=agent)
        self.set_ticket(working["key"], status="doing", assignee=agent)

        tickets = boardmodel.board_summary(self.conn, self.ws, limit=1)["tickets"]

        self.assertEqual([ticket["key"] for ticket in tickets], [working["key"]])

    def test_blocked_column_is_omitted_when_empty(self):
        self.add("open")
        columns = boardmodel.board_summary(self.conn, self.ws)["columns"]
        self.assertEqual([column["status"] for column in columns], ["open", "wip", "finished"])
        self.assertEqual([column["count"] for column in columns], [1, 0, 0])

    def test_dispatch_registration_default_and_limit_validation(self):
        self.assertIs(dispatch.COMMANDS["board.summary"], dispatch._board_summary)
        self.assertEqual(dispatch._validate_board_summary({"workspace": self.ws})["limit"], 5)
        for limit in (1, 10):
            self.assertEqual(dispatch._validate_board_summary({"workspace": self.ws, "limit": limit})["limit"],
                             limit)
        for limit in (0, 11, True, "2"):
            with self.subTest(limit=limit), self.assertRaises(AsError) as caught:
                dispatch._validate_board_summary({"workspace": self.ws, "limit": limit})
            self.assertEqual(caught.exception.code, "BAD_REQUEST")
            self.assertEqual(caught.exception.message,
                             "Argument 'limit' must be an integer between 1 and 10.")

    def test_summary_is_read_only(self):
        self.add("one")
        tables = ("board_state", "phases", "tickets", "ticket_events", "events")
        before = {table: [tuple(row) for row in self.conn.execute(f"SELECT * FROM {table}")]
                  for table in tables}
        changes = self.conn.total_changes

        boardmodel.board_summary(self.conn, self.ws)

        after = {table: [tuple(row) for row in self.conn.execute(f"SELECT * FROM {table}")]
                 for table in tables}
        self.assertEqual(after, before)
        self.assertEqual(self.conn.total_changes, changes)


if __name__ == "__main__":
    import unittest
    unittest.main()
