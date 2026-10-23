import unittest

from tests import helpers  # noqa: F401
from agent_studio import coordinator, dispatch
from agent_studio.protocol import AsError
from tests.unit.test_p03_s01_tickets import fresh


class BoardResumeTests(unittest.TestCase):
    def setUp(self):
        self.conn, self.store = fresh()
        with self.store.transaction() as tx:
            self.team = tx.create("team", {"name": "t", "workspace": "/one"})
            tx.transition("team", self.team, "running")
            self.agent = tx.create("agent", {"team_id": self.team, "ordinal": 0, "provider_id": "fake", "role": "QA", "display_name": "qa"})
            tx.transition("agent", self.agent, "idle")
            self.foreign_team = tx.create("team", {"name": "other", "workspace": "/two"})
            tx.transition("team", self.foreign_team, "running")
            self.foreign = tx.create("agent", {"team_id": self.foreign_team, "ordinal": 0, "provider_id": "fake", "role": "QA", "display_name": "other"})

    def test_validation_requires_exactly_one_scope(self):
        for args in ({"workspace": "/one"}, {"workspace": "/one", "all": True, "agentId": self.agent}):
            with self.subTest(args=args), self.assertRaises(AsError) as caught:
                dispatch._validate_board_resume(args)
            self.assertEqual(caught.exception.code, "BAD_REQUEST")

    def test_foreign_agent_refused_and_idle_agent_skipped_without_event(self):
        with self.store.transaction() as tx:
            with self.assertRaises(AsError) as caught:
                coordinator._handle_board_resume({"workspace": "/one", "all": False, "agentId": self.foreign}, tx, {})
            self.assertEqual(caught.exception.code, "AGENT_NOT_IN_TEAM")
        with self.store.transaction() as tx:
            self.assertEqual(coordinator._handle_board_resume({"workspace": "/one", "all": False, "agentId": self.agent}, tx, {}), {"resumed": []})
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM events WHERE name = 'board.resumed'").fetchone()[0], 0)

    def test_limited_agent_resumes_and_clears_reset(self):
        with self.store.transaction() as tx:
            tx.transition("agent", self.agent, "busy")
            tx.transition("agent", self.agent, "limit_reached", set_values={"limit_reset_at": "2030-01-01T15:00:00Z"})
            got = coordinator._handle_board_resume({"workspace": "/one", "all": False, "agentId": self.agent}, tx, {})
        self.assertEqual(got, {"resumed": [self.agent]})
        self.assertEqual(tuple(self.conn.execute("SELECT availability, limit_reset_at FROM agents WHERE id = ?", (self.agent,)).fetchone()), ("idle", None))
