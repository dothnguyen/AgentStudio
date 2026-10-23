import json
import unittest
from unittest import mock

from tests import helpers  # noqa: F401
from agent_studio import board_scheduler, tickets
from tests.unit.test_p03_s01_tickets import fresh


class SchedulerTickTests(unittest.TestCase):
    def test_no_board_state_does_not_write_events(self):
        conn, store = fresh()
        try:
            before = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
            board_scheduler.tick(store, {"stateDir": "/tmp", "debug": True})
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM events").fetchone()[0], before)
        finally:
            conn.close()

    def setUp(self):
        self.conn, self.store = fresh()
        self.workspace = "/tick"
        self.config = {"baseBranch": "main", "maxParallelDev": 2, "columns": {
            "unpack": {"role": "Owner"}, "triage": {"role": "Lead"}, "refine": {"role": "Lead"},
            "develop": {"role": "Developer"}, "test": {"role": "QA"}, "review": {"role": "Lead"}}}
        with self.store.transaction() as tx:
            self.team = tx.create("team", {"name": "team", "workspace": self.workspace})
            tx.transition("team", self.team, "running")
            self.lead = tx.create("agent", {"team_id": self.team, "ordinal": 0, "provider_id": "fake", "role": "Lead", "display_name": "lead"})
            self.dev = tx.create("agent", {"team_id": self.team, "ordinal": 1, "provider_id": "fake", "role": "Developer", "display_name": "dev"})
            self.qa = tx.create("agent", {"team_id": self.team, "ordinal": 2, "provider_id": "fake", "role": "QA", "display_name": "qa"})
            tx.conn.execute("UPDATE agents SET availability = 'idle' WHERE team_id = ?", (self.team,))

    def tearDown(self): self.conn.close()

    def state(self, status="running"):
        self.conn.execute("INSERT INTO board_state (workspace,status,reason,config_json,updated_at) VALUES (?,?,NULL,?,'n')",
                          (self.workspace, status, json.dumps(self.config)))

    def ticket(self, status, kind="story"):
        with self.store.transaction() as tx:
            row = tickets.create(tx, self.workspace, kind, {"title": status})
            tx.conn.execute("UPDATE tickets SET status = ? WHERE id = ?", (status, row["id"]))
            return row

    def test_paused_and_busy_agents_are_not_offered_work(self):
        self.state("paused"); self.ticket("ready_dev")
        with mock.patch("agent_studio.board_scheduler.board.claim_and_start") as start:
            board_scheduler.tick(self.store, {"stateDir": "/tmp"})
        start.assert_not_called()
        self.conn.execute("UPDATE board_state SET status = 'running'")
        with self.store.transaction() as tx:
            tx.conn.execute("UPDATE agents SET availability = 'busy' WHERE id = ?", (self.dev,))
        with mock.patch("agent_studio.board_scheduler.board.claim_and_start") as start:
            board_scheduler.tick(self.store, {"stateDir": "/tmp"})
        start.assert_not_called()

    def test_idle_agent_with_active_assignment_is_not_offered_work(self):
        self.state(); self.ticket("ready_dev")
        with mock.patch("agent_studio.board_scheduler.tasks._active_for_agent",
                        side_effect=lambda tx, agent_id: {"id": "a", "status": "running"} if agent_id == self.dev else None), \
                mock.patch("agent_studio.board_scheduler.board.claim_and_start") as start:
            board_scheduler.tick(self.store, {"stateDir": "/tmp"})
        start.assert_not_called()

    def test_idle_agent_assigned_a_working_ticket_is_not_offered_work(self):
        self.state(); self.ticket("ready_dev"); working = self.ticket("in_dev")
        with self.store.transaction() as tx:
            tx.conn.execute("UPDATE tickets SET assignee_agent_id = ? WHERE id = ?", (self.dev, working["id"]))
        with mock.patch("agent_studio.board_scheduler.board.claim_and_start") as start:
            board_scheduler.tick(self.store, {"stateDir": "/tmp"})
        start.assert_not_called()

    def test_twenty_ticks_with_empty_queues_write_no_events(self):
        self.state()
        before = self.conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
        for _ in range(20): board_scheduler.tick(self.store, {"stateDir": "/tmp"})
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM events").fetchone()[0], before)

    def test_twenty_ticks_with_unmerged_dependency_and_held_refine_write_no_events(self):
        self.state()
        blocker = self.ticket("in_dev"); dependent = self.ticket("ready_dev"); self.ticket("refine")
        with self.store.transaction() as tx:
            tx.conn.execute("INSERT INTO ticket_deps (ticket_id, blocked_by_ticket_id) VALUES (?, ?)",
                            (dependent["id"], blocker["id"]))
        with mock.patch("agent_studio.board_scheduler.board.claim_and_start") as start, \
                mock.patch("agent_studio.board_scheduler.worktrees.is_clean", return_value=False):
            board_scheduler.tick(self.store, {"stateDir": "/tmp"})
            before = self.conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
            for _ in range(20): board_scheduler.tick(self.store, {"stateDir": "/tmp"})
        start.assert_not_called()
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM events").fetchone()[0], before)

    def test_limited_developer_skipped_while_lead_and_qa_claim(self):
        self.state(); review = self.ticket("ready_review"); test = self.ticket("ready_test"); self.ticket("ready_dev")
        with self.store.transaction() as tx: tx.conn.execute("UPDATE agents SET availability = 'limit_reached' WHERE id = ?", (self.dev,))
        with mock.patch("agent_studio.board_scheduler.board.claim_and_start") as start:
            board_scheduler.tick(self.store, {"stateDir": "/tmp"})
        self.assertEqual([(call.args[2], call.args[3]) for call in start.call_args_list],
                         [(review["key"], self.lead), (test["key"], self.qa)])

    def test_claim_and_start_receives_the_frozen_config(self):
        self.state(); self.ticket("ready_dev")
        with mock.patch("agent_studio.board_scheduler.board.claim_and_start") as start:
            board_scheduler.tick(self.store, {"stateDir": "/tmp"})
        self.assertIsNotNone(start.call_args.kwargs.get("config"))

    def test_start_error_blocks_ticket_and_next_agent_served(self):
        self.state(); first = self.ticket("ready_review"); second = self.ticket("ready_test")
        from agent_studio.protocol import AsError
        with mock.patch("agent_studio.board_scheduler.board.claim_and_start", side_effect=[AsError("BROKEN", "no"), None]) as start:
            board_scheduler.tick(self.store, {"stateDir": "/tmp"})
        self.assertEqual(start.call_count, 2)
        row = self.conn.execute("SELECT status, blocked_reason FROM tickets WHERE id = ?", (first["id"],)).fetchone()
        self.assertEqual(tuple(row), ("blocked", "START_FAILED:BROKEN"))
        self.assertEqual(start.call_args_list[1].args[2], second["key"])

    def test_held_events_dedupe_and_idle_ticks_do_not_busy_loop(self):
        self.state(); self.ticket("refine")
        with mock.patch("agent_studio.board_scheduler.worktrees.is_clean", return_value=False):
            board_scheduler.tick(self.store, {"stateDir": "/tmp"}); board_scheduler.tick(self.store, {"stateDir": "/tmp"})
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM events WHERE name = 'board.held'").fetchone()[0], 1)
        with mock.patch("agent_studio.board_scheduler.worktrees.is_clean", return_value=True), mock.patch("agent_studio.board_scheduler.gitws.run") as git:
            git.return_value.returncode, git.return_value.stdout = 0, b"wrong\n"
            board_scheduler.tick(self.store, {"stateDir": "/tmp"})
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM events WHERE name = 'board.held'").fetchone()[0], 2)
        before = self.conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
        with mock.patch("agent_studio.board_scheduler.worktrees.is_clean", return_value=True), mock.patch("agent_studio.board_scheduler.gitws.run") as git:
            git.return_value.returncode, git.return_value.stdout = 0, b"wrong\n"
            for _ in range(20): board_scheduler.tick(self.store, {"stateDir": "/tmp"})
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM events").fetchone()[0], before)


class TwoBoardTickTests(unittest.TestCase):
    def setUp(self):
        self.conn, self.store = fresh()
        self.config = {"baseBranch": "main", "maxParallelDev": 1, "columns": {
            "unpack": {"role": "Owner"}, "triage": {"role": "Lead"}, "refine": {"role": "Lead"},
            "develop": {"role": "Developer"}, "test": {"role": "QA"}, "review": {"role": "Lead"}}}
        self.ws = {}
        for name in ("/a", "/b"):
            with self.store.transaction() as tx:
                team = tx.create("team", {"name": name, "workspace": name})
                tx.transition("team", team, "running")
                lead = tx.create("agent", {"team_id": team, "ordinal": 0, "provider_id": "fake", "role": "Lead", "display_name": "lead"})
                dev = tx.create("agent", {"team_id": team, "ordinal": 1, "provider_id": "fake", "role": "Developer", "display_name": "dev"})
                tx.conn.execute("UPDATE agents SET availability = 'idle' WHERE team_id = ?", (team,))
            self.conn.execute("INSERT INTO board_state (workspace,status,reason,config_json,updated_at) VALUES (?,'running',NULL,?,'n')",
                              (name, json.dumps(self.config)))
            self.ws[name] = {"team": team, "lead": lead, "dev": dev}

    def tearDown(self): self.conn.close()

    def ticket(self, workspace, status):
        with self.store.transaction() as tx:
            row = tickets.create(tx, workspace, "story", {"title": status})
            tx.conn.execute("UPDATE tickets SET status = ? WHERE id = ?", (status, row["id"]))
            return row

    def run_tick(self, start=None):
        with mock.patch("agent_studio.board_scheduler.board.claim_and_start", **(start or {})) as mocked:
            board_scheduler.tick(self.store, {"stateDir": "/tmp"})
        return mocked

    def test_overlapping_ticket_keys_are_claimed_per_workspace(self):
        a = self.ticket("/a", "ready_dev"); b = self.ticket("/b", "ready_dev")
        self.assertEqual(a["key"], b["key"])
        start = self.run_tick()
        self.assertEqual(sorted((c.args[1], c.args[2], c.args[3]) for c in start.call_args_list),
                         sorted([("/a", a["key"], self.ws["/a"]["dev"]), ("/b", b["key"], self.ws["/b"]["dev"])]))

    def test_pausing_one_board_does_not_stop_the_other(self):
        self.ticket("/a", "ready_dev"); self.ticket("/b", "ready_dev")
        self.conn.execute("UPDATE board_state SET status = 'paused' WHERE workspace = '/a'")
        start = self.run_tick()
        self.assertEqual([c.args[1] for c in start.call_args_list], ["/b"])

    def test_start_failure_blocks_only_that_boards_ticket(self):
        from agent_studio.protocol import AsError
        a = self.ticket("/a", "ready_dev"); b = self.ticket("/b", "ready_dev")
        start = self.run_tick({"side_effect": [AsError("BROKEN", "no"), None]})
        self.assertEqual(start.call_count, 2)
        status = {r[0]: r[1] for r in self.conn.execute("SELECT workspace, status FROM tickets")}
        self.assertEqual(status, {"/a": "blocked", "/b": "ready_dev"})

    def test_error_serving_one_board_is_logged_and_next_board_served(self):
        self.ticket("/a", "ready_dev"); b = self.ticket("/b", "ready_dev")
        real = board_scheduler.pick
        def pick(tx, workspace, agent, config):
            if workspace == "/a": raise RuntimeError("boom")
            return real(tx, workspace, agent, config)
        with mock.patch("agent_studio.board_scheduler.pick", side_effect=pick), \
                mock.patch("agent_studio.board_scheduler.sys.stderr") as err:
            start = self.run_tick()
        self.assertEqual([(c.args[1], c.args[2]) for c in start.call_args_list], [("/b", b["key"])])
        logged = "".join(c.args[0] for c in err.write.call_args_list)
        self.assertIn("/a", logged); self.assertIn("boom", logged)

    def test_hold_error_on_one_board_does_not_skip_the_other(self):
        self.ticket("/a", "refine"); self.ticket("/a", "ready_dev"); b = self.ticket("/b", "ready_dev")
        def clean(workspace):
            if workspace == "/a": raise RuntimeError("git gone")
            return True
        with mock.patch("agent_studio.board_scheduler.worktrees.is_clean", side_effect=clean), \
                mock.patch("agent_studio.board_scheduler.sys.stderr"):
            start = self.run_tick()
        self.assertEqual([c.args[1] for c in start.call_args_list], ["/b"])

    def test_merge_lock_and_dev_cap_are_independent_per_board(self):
        refine_a = self.ticket("/a", "refine"); refine_b = self.ticket("/b", "refine")
        self.ticket("/a", "in_dev"); self.ticket("/a", "ready_dev")
        self.ticket("/b", "ready_dev")
        with self.store.transaction() as tx:
            tx.conn.execute("INSERT INTO board_locks (workspace, name, ticket_id, created_at) VALUES ('/a', 'merge', ?, 'n')", (refine_a["id"],))
            tx.conn.execute("UPDATE tickets SET assignee_agent_id = NULL")
        with mock.patch("agent_studio.board_scheduler.worktrees.is_clean", return_value=True), \
                mock.patch("agent_studio.board_scheduler.gitws.run") as git:
            git.return_value.returncode, git.return_value.stdout = 0, b"main\n"
            start = self.run_tick()
        picked = [(c.args[1], c.args[2]) for c in start.call_args_list]
        self.assertIn(("/b", refine_b["key"]), picked)
        self.assertFalse([p for p in picked if p[0] == "/a"])

    def test_picks_use_frozen_config_not_current_board_json(self):
        a = self.ticket("/a", "ready_dev")
        with mock.patch("agent_studio.board_scheduler.board_config.current", side_effect=AssertionError("reloaded")):
            start = self.run_tick()
        self.assertIn(("/a", a["key"]), [(c.args[1], c.args[2]) for c in start.call_args_list])
