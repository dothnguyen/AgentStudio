import json
import unittest
from unittest import mock

from tests import helpers  # noqa: F401
from agent_studio import board, board_config, schema, tickets
from agent_studio.protocol import AsError
from tests.unit.test_p03_s01_tickets import fresh, make


class OutcomeTableTests(unittest.TestCase):
    @staticmethod
    def _agent(tx):
        team = tx.create("team", {"name": "outcome-test", "workspace": "/one"})
        return tx.create("agent", {"team_id": team, "ordinal": 0, "provider_id": "fake", "role": "QA",
                                   "display_name": "qa", "pane_state": "alive"})

    @staticmethod
    def _run(tx):
        team = tx.create("team", {"name": "outcome-run-test", "workspace": "/one"})
        task = tx.create("task", {"team_id": team, "origin": "direct", "workspace": "/one", "goal": "g"})
        return tx.create("workflow_run", {"team_id": team, "task_id": task, "workflow": "w"})

    def test_table_decisions_cover_each_row(self):
        cases = (
            ("refine", "succeeded", "pass", "ready_dev", None),
            ("refine", "failed", "fail", "blocked", "VERDICT_FAIL:refine"),
            ("develop", "succeeded", None, "ready_test", None),
            ("develop", "failed", None, "ready_dev", None),
            ("test", "succeeded", "pass", "ready_review", None),
            ("test", "failed", "fail", "fail_test", None),
            ("review", "succeeded", "pass", "ready_merge", None),
            ("review", "failed", "fail", "changes_requested", None),
        )
        for name, status, verdict, target, reason in cases:
            with self.subTest(name=name, status=status, verdict=verdict):
                got = board.decide(schema.BOARD_OUTCOMES[name], status, verdict,
                                   {"dev_rounds": 0, "test_rounds": 0, "review_rounds": 0},
                                   {"dev": 2, "test": 2, "review": 2})
                self.assertEqual((got["to"], got["reason"]), (target, reason))

    def test_cancelled_releases_and_limit_is_strictly_over(self):
        entry = schema.BOARD_OUTCOMES["test"]
        released = board.decide(entry, "cancelled", None, {"test_rounds": 0}, {"test": 1})
        allowed = board.decide(entry, "failed", "fail", {"test_rounds": 0}, {"test": 1})
        blocked = board.decide(entry, "failed", "fail", {"test_rounds": 1}, {"test": 1})
        self.assertEqual(released["to"], "release")
        self.assertEqual((allowed["to"], allowed["counter"]), ("fail_test", {"test_rounds": 1}))
        self.assertEqual((blocked["to"], blocked["reason"], blocked["counter"]),
                         ("blocked", "ROUND_LIMIT:test", {"test_rounds": 2}))

    def test_findings_are_bounded_to_json_limit(self):
        values = board._bounded(["x" * 2000] * 50)
        self.assertLessEqual(len(json.dumps(values, ensure_ascii=True).encode("utf-8")), 16 * 1024)
        self.assertTrue(all(len(value) <= 2000 for value in values))

    def test_block_rejects_invalid_return_status_override(self):
        _conn, store = fresh()
        with store.transaction() as tx:
            ticket = make(tx)
            with self.assertRaises(AsError) as caught:
                tickets.block(tx, ticket, "coordinator", "why", "in_dev")
            self.assertEqual(caught.exception.code, "TICKET_TRANSITION_INVALID")

    def test_failed_clean_branch_records_no_changes(self):
        tx = mock.Mock()
        ticket = {"id": "ticket", "status": "in_dev", "workspace": "/workspace",
                  "worktree_path": "/worktree", "dev_rounds": 0, "test_rounds": 0, "review_rounds": 0}
        run = {"id": "run", "status": "failed", "team_id": "team"}
        config = {"roundLimits": {"dev": 3, "test": 3, "review": 3}}
        with mock.patch.object(board, "_roles_for", return_value=set()), \
             mock.patch.object(board_config, "current", return_value=config), \
             mock.patch.object(board, "_verdict", return_value={}), \
             mock.patch.object(board.workflow, "_latest_result", return_value={}), \
             mock.patch.object(board.workflow, "_validation_text", return_value="validation failure"), \
             mock.patch.object(board.worktrees, "is_clean", return_value=True), \
             mock.patch.object(board, "_write_outcome", return_value=ticket) as written:
            board._apply(tx, ticket, run, {})
        outcome, findings = written.call_args.args[4:6]
        self.assertEqual((outcome["to"], outcome["counter"], findings),
                         ("ready_dev", {"dev_rounds": 1}, ["NO_CHANGES"]))

    def test_cancelled_outcome_releases_claim_after_returning_to_queue(self):
        tx = mock.Mock()
        ticket = {"id": "ticket", "status": "in_dev", "assignee_agent_id": "agent", "lease_until": "later"}
        moved = dict(ticket, status="ready_dev")
        updates = []
        tx.get.side_effect = lambda _entity, _id: moved
        tx.update.side_effect = lambda *_args: updates.append(_args)
        outcome = {"to": "release", "reason": None, "counter": None, "findingsFrom": None}
        with mock.patch.object(board, "_queue", return_value="ready_dev"), \
             mock.patch.object(tickets, "move", return_value=moved), \
             mock.patch.object(board, "_note", return_value=moved), \
             mock.patch.object(board, "_finish", return_value=moved), \
             mock.patch.object(board, "_verdict", return_value={}):
            board._write_outcome(tx, ticket, {"id": "run", "status": "cancelled"}, "column", outcome, [])
        self.assertIn(("ticket", "ticket", {"assignee_agent_id": None, "lease_until": None,
                                                "applied_run_id": "run"}, "ticket.outcome_marked", {}), updates)

    def test_cancelled_terminal_ticket_only_records_cancelled_run_outcome(self):
        conn, store = fresh()
        with store.transaction() as tx:
            ticket = make(tx)
            agent = self._agent(tx)
            run = self._run(tx)
            tx.update("ticket", ticket["id"], {"assignee_agent_id": agent, "lease_until": "later"},
                      "ticket.claimed", {})
            ticket = tickets.cancel(tx, tx.get("ticket", ticket["id"]), "operator")
            outcome = {"to": "release", "reason": None, "counter": None, "findingsFrom": None}
            with mock.patch.object(board, "_verdict", return_value={}):
                board._write_outcome(tx, ticket, {"id": run, "status": "cancelled"}, "refine", outcome, [])
        row = conn.execute("SELECT status, assignee_agent_id, lease_until, applied_run_id FROM tickets WHERE id = ?",
                           (ticket["id"],)).fetchone()
        self.assertEqual(tuple(row), ("cancelled", agent, "later", run))
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM ticket_events WHERE ticket_id = ? AND name = 'ticket.outcome_applied'",
                                      (ticket["id"],)).fetchone()[0], 1)

    def test_unsupported_outcome_clears_claim_when_blocked(self):
        conn, store = fresh()
        with store.transaction() as tx:
            ticket = make(tx)
            for status in ("refining", "ready_dev", "in_dev"):
                ticket = tickets.move(tx, ticket, status, "coordinator")
            tx.update("ticket", ticket["id"], {"assignee_agent_id": self._agent(tx), "lease_until": "later"},
                      "ticket.claimed", {})
            ticket = tx.get("ticket", ticket["id"])
            run = self._run(tx)
            with mock.patch.object(schema, "BOARD_OUTCOMES", {}):
                board._apply(tx, ticket, {"id": run, "status": "succeeded"}, {})
        row = conn.execute("SELECT status, blocked_reason, assignee_agent_id, lease_until, applied_run_id "
                           "FROM tickets WHERE id = ?", (ticket["id"],)).fetchone()
        self.assertEqual(tuple(row), ("blocked", "OUTCOME_UNSUPPORTED:develop", None, None, run))

    def test_outcome_error_releases_claim_and_records_applied_outcome(self):
        tx = mock.Mock()
        ticket = {"id": "ticket", "run_id": "run", "status": "refining", "workspace": "/workspace",
                  "key": "T-001", "assignee_agent_id": "agent", "lease_until": "later"}
        blocked = dict(ticket, status="blocked")
        run = {"id": "run", "status": "succeeded"}
        tx.get.return_value = blocked
        with mock.patch.object(board, "_queue", return_value="refine"), \
             mock.patch.object(tickets, "block", return_value=blocked), \
             mock.patch.object(board, "_finish", return_value=blocked) as finished:
            board._outcome_error(tx, ticket, run, AsError("MAIN_CHECKOUT_WRONG_BRANCH", "wrong branch"))
        self.assertIn(mock.call("ticket", "ticket", {"assignee_agent_id": None, "lease_until": None,
                                                         "applied_run_id": "run",
                                                         "blocked_reason": "MAIN_CHECKOUT_WRONG_BRANCH"},
                                "ticket.outcome_marked", {}), tx.update.call_args_list)
        finished.assert_called_once_with(tx, blocked, run, "refine", None, "blocked", "MAIN_CHECKOUT_WRONG_BRANCH")

    def test_outcome_error_on_terminal_ticket_only_records_outcome(self):
        conn, store = fresh()
        with store.transaction() as tx:
            ticket = make(tx)
            agent = self._agent(tx)
            run = self._run(tx)
            tx.update("ticket", ticket["id"], {"run_id": run, "assignee_agent_id": agent,
                                                  "lease_until": "later", "blocked_reason": "operator_reason"},
                      "ticket.claimed", {})
            ticket = tx.get("ticket", ticket["id"])
            ticket = tickets.move(tx, ticket, "refining", "coordinator")
            seq = tx.update("ticket", ticket["id"], {"run_id": run}, "ticket.run_started",
                            {"runId": run})
            ticket = tx.get("ticket", ticket["id"])
            tickets._ticket_event(tx, ticket, seq, "ticket.run_started", "coordinator", "refining", "refining",
                                  {"runId": run})
            ticket = tickets.cancel(tx, tx.get("ticket", ticket["id"]), "operator")
            tx.transition("workflow_run", run, "cancelled")
        with mock.patch.object(board_config, "current", side_effect=AsError("BOARD_CONFIG_INVALID", "invalid config")):
            self.assertEqual(board.apply_outcomes(store, {}), 0)
        row = conn.execute("SELECT status, assignee_agent_id, lease_until, blocked_reason, applied_run_id "
                           "FROM tickets WHERE id = ?", (ticket["id"],)).fetchone()
        self.assertEqual(tuple(row), ("cancelled", agent, "later", "operator_reason", run))
        event = conn.execute("SELECT payload_json FROM ticket_events WHERE ticket_id = ? "
                             "AND name = 'ticket.outcome_applied'", (ticket["id"],)).fetchone()
        self.assertEqual(json.loads(event[0])["reason"], "BOARD_CONFIG_INVALID")

