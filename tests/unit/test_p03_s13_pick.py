import unittest
from unittest import mock
import subprocess
import tempfile

from tests import helpers  # noqa: F401
from agent_studio import board_scheduler, tickets
from tests.unit.test_p03_s01_tickets import fresh


class SchedulerPickTests(unittest.TestCase):
    def setUp(self):
        self.conn, self.store = fresh()
        self.temp = tempfile.TemporaryDirectory(); self.workspace = self.temp.name
        subprocess.run(["git", "init", "-q", self.workspace], check=True)
        subprocess.run(["git", "-C", self.workspace, "checkout", "-qb", "main"], check=True)
        self.config = {"baseBranch": "main", "maxParallelDev": 2, "columns": {
            "unpack": {"role": "Owner"}, "triage": {"role": "Lead"}, "refine": {"role": "Lead"},
            "develop": {"role": "Developer"}, "test": {"role": "QA"}, "review": {"role": "Lead"}}}
        with self.store.transaction() as tx:
            team = tx.create("team", {"name": "t", "workspace": self.workspace})
            self.agent = tx.create("agent", {"team_id": team, "ordinal": 0, "provider_id": "fake",
                                                "role": "Developer", "display_name": "dev"})

    def tearDown(self):
        self.conn.close(); self.temp.cleanup()

    def _story(self, priority=100):
        with self.store.transaction() as tx:
            ticket = tickets.create(tx, self.workspace, "story", {"title": "story", "priority": priority})
            ticket = tickets.move(tx, ticket, "refining", "coordinator")
            return tickets.move(tx, ticket, "ready_dev", "coordinator")

    def _ticket(self, status, *, kind="story", priority=100, severity=None, created=None):
        with self.store.transaction() as tx:
            ticket = tickets.create(tx, self.workspace, kind, {"title": status, "priority": priority})
            tx.conn.execute("UPDATE tickets SET status = ?, severity = ?, created_at = COALESCE(?, created_at) WHERE id = ?",
                            (status, severity, created, ticket["id"]))
            return tickets.get(tx, self.workspace, ticket["key"])

    def _pick(self, agent=None):
        with self.store.transaction() as tx:
            return board_scheduler.pick(tx, self.workspace, tx.get("agent", agent or self.agent), self.config)

    def test_pick_orders_priority_and_writes_nothing(self):
        first = self._story(100)
        second = self._story(10)
        before = self.conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
        with self.store.transaction() as tx:
            picked, held = board_scheduler.pick(tx, self.workspace, tx.get("agent", self.agent), self.config)
        self.assertEqual(picked["key"], second["key"])
        self.assertEqual(held, [])
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM events").fetchone()[0], before)
        self.assertNotEqual(first["key"], picked["key"])

    def test_pick_skips_dependency_until_merged(self):
        prerequisite = self._story()
        dependent = self._story()
        with self.store.transaction() as tx:
            prerequisite = tickets.block(tx, prerequisite, "coordinator", "waiting")
            tickets.add_deps(tx, dependent, [prerequisite["key"]])
            picked, _ = board_scheduler.pick(tx, self.workspace, tx.get("agent", self.agent), self.config)
        self.assertIsNone(picked)

    def test_lead_tries_review_before_triage_before_refine(self):
        with self.store.transaction() as tx:
            lead = tx.create("agent", {"team_id": self.agent and tx.get("agent", self.agent)["team_id"], "ordinal": 1,
                                        "provider_id": "fake", "role": "Lead", "display_name": "lead"})
        review = self._ticket("ready_review")
        triage = self._ticket("triage", kind="bug")
        self._ticket("refine")
        picked, held = self._pick(lead)
        self.assertEqual((picked["key"], held), (review["key"], []))
        with self.store.transaction() as tx:
            tx.conn.execute("UPDATE tickets SET status = 'blocked', return_status = 'ready_review' WHERE id = ?", (review["id"],))
        with mock.patch("agent_studio.board_scheduler.worktrees.is_clean", return_value=True), \
             mock.patch("agent_studio.board_scheduler.gitws.run") as git:
            git.return_value.returncode, git.return_value.stdout = 0, b"main\n"
            self.assertEqual(self._pick(lead)[0]["key"], triage["key"])

    def test_develop_ranks_blocker_rework_bugs_then_story(self):
        story = self._ticket("ready_dev", priority=1)
        minor = self._ticket("ready_dev", kind="bug", severity="minor", priority=2)
        major = self._ticket("ready_dev", kind="bug", severity="major", priority=1)
        rework = self._ticket("changes_requested", priority=99)
        blocker = self._ticket("ready_dev", kind="bug", severity="blocker", priority=99)
        self.assertEqual(self._pick()[0]["key"], blocker["key"])
        with self.store.transaction() as tx:
            tx.conn.execute("UPDATE tickets SET status = 'blocked', return_status = 'ready_dev' WHERE id IN (?, ?)", (blocker["id"], rework["id"]))
        self.assertEqual(self._pick()[0]["key"], major["key"])
        with self.store.transaction() as tx: tx.conn.execute("UPDATE tickets SET status = 'blocked', return_status = 'ready_dev' WHERE id = ?", (major["id"],))
        self.assertEqual(self._pick()[0]["key"], minor["key"])
        self.assertNotEqual(story["key"], minor["key"])

    def test_dependency_becomes_eligible_after_merge(self):
        prerequisite = self._ticket("ready_dev")
        dependent = self._ticket("ready_dev")
        with self.store.transaction() as tx:
            tickets.add_deps(tx, dependent, [prerequisite["key"]])
            tx.conn.execute("UPDATE tickets SET status = 'blocked', return_status = 'ready_dev' WHERE id = ?", (prerequisite["id"],))
        self.assertIsNone(self._pick()[0])
        with self.store.transaction() as tx: tx.conn.execute("UPDATE tickets SET status = 'merged', return_status = NULL WHERE id = ?", (prerequisite["id"],))
        self.assertEqual(self._pick()[0]["key"], dependent["key"])

    def test_develop_cap_allows_one_blocker_but_not_second(self):
        story = self._ticket("ready_dev")
        blocker = self._ticket("ready_dev", kind="bug", severity="blocker")
        self._ticket("in_dev"); self._ticket("in_dev")
        self.assertEqual(self._pick()[0]["key"], blocker["key"])
        with self.store.transaction() as tx:
            tx.conn.execute("UPDATE tickets SET status = 'blocked', return_status = 'ready_dev' WHERE id = ?", (blocker["id"],))
        self.assertIsNone(self._pick()[0])
        with self.store.transaction() as tx:
            tx.conn.execute("UPDATE tickets SET status = 'in_dev', severity = 'blocker' WHERE id = ?", (story["id"],))
        self._ticket("ready_dev", kind="bug", severity="blocker")
        self.assertIsNone(self._pick()[0])

    def test_main_hold_reasons_do_not_prevent_review(self):
        with self.store.transaction() as tx:
            lead = tx.create("agent", {"team_id": tx.get("agent", self.agent)["team_id"], "ordinal": 1,
                                        "provider_id": "fake", "role": "Lead", "display_name": "lead"})
        review = self._ticket("ready_review")
        self._ticket("refine")
        cases = (("MAIN_CHECKOUT_BUSY", True, b"main\n", "triaging"),
                 ("MAIN_CHECKOUT_BUSY", True, b"main\n", "lock"),
                 ("MAIN_CHECKOUT_DIRTY", False, b"main\n", None),
                 ("MAIN_CHECKOUT_WRONG_BRANCH", True, b"other\n", None))
        for reason, clean, branch, busy in cases:
            with self.subTest(reason=reason), mock.patch("agent_studio.board_scheduler.worktrees.is_clean", return_value=clean), \
                 mock.patch("agent_studio.board_scheduler.gitws.run") as git:
                git.return_value.returncode, git.return_value.stdout = 0, branch
                if busy == "triaging": self._ticket("triaging", kind="bug")
                if busy == "lock": self.conn.execute("INSERT INTO board_locks VALUES (?, 'merge', NULL, 'now')", (self.workspace,))
                picked, held = self._pick(lead)
                self.assertEqual(picked["key"], review["key"])
                self.assertIn({"column": "refine", "reason": reason}, held)
                self.conn.execute("DELETE FROM board_locks")
                self.conn.execute("UPDATE tickets SET status = 'blocked', return_status = 'triage' WHERE status = 'triaging'")

    def test_review_starvation_and_priority_oldest(self):
        with self.store.transaction() as tx:
            lead = tx.create("agent", {"team_id": tx.get("agent", self.agent)["team_id"], "ordinal": 1,
                                        "provider_id": "fake", "role": "Lead", "display_name": "lead"})
        review = self._ticket("ready_review")
        refine = self._ticket("refine")
        with self.store.transaction() as tx:
            for _ in range(1):
                seq = tx.note("ticket", review["id"], "ticket.claimed", {"agentId": lead})
                tx.conn.execute("INSERT INTO ticket_events (ticket_id,event_seq,at,actor,name,from_status,to_status,payload_json) VALUES (?,?, 'n','coordinator','ticket.claimed','ready_review','in_review',?)", (review["id"], seq, '{"agentId":"' + lead + '"}'))
        with mock.patch("agent_studio.board_scheduler.worktrees.is_clean", return_value=True), mock.patch("agent_studio.board_scheduler.gitws.run") as git:
            git.return_value.returncode, git.return_value.stdout = 0, b"main\n"
            self.assertEqual(self._pick(lead)[0]["key"], review["key"])
            with self.store.transaction() as tx:
                seq = tx.note("ticket", review["id"], "ticket.claimed", {"agentId": lead})
                tx.conn.execute("INSERT INTO ticket_events (ticket_id,event_seq,at,actor,name,from_status,to_status,payload_json) VALUES (?,?, 'n','coordinator','ticket.claimed','ready_review','in_review',?)", (review["id"], seq, '{"agentId":"' + lead + '"}'))
            self.assertEqual(self._pick(lead)[0]["key"], refine["key"])
        older = self._ticket("ready_dev", priority=5, created="2020-01-01T00:00:00Z")
        newer = self._ticket("ready_dev", priority=5, created="2021-01-01T00:00:00Z")
        self.assertEqual(self._pick()[0]["key"], older["key"])
        with self.store.transaction() as tx:
            tx.conn.execute("UPDATE tickets SET status = 'blocked', return_status = 'ready_dev' WHERE id = ?", (older["id"],))
        self.assertEqual(self._pick()[0]["key"], newer["key"])
        with self.store.transaction() as tx:
            tx.conn.execute("UPDATE tickets SET status = 'blocked', return_status = 'ready_dev' WHERE id = ?", (newer["id"],))
        old = self._ticket("ready_dev", priority=20, created="2020-01-01T00:00:00Z")
        urgent = self._ticket("ready_dev", priority=10)
        before = self.conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
        self.assertEqual(self._pick()[0]["key"], urgent["key"])
        with self.store.transaction() as tx: tx.conn.execute("UPDATE tickets SET status = 'blocked', return_status = 'ready_dev' WHERE id = ?", (urgent["id"],))
        self.assertEqual(self._pick()[0]["key"], old["key"])
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM events").fetchone()[0], before)

