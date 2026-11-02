"""Legacy workflow status conversion is atomic and repeatable."""
import json

from tests.unit.test_p04_s07_board_model import BoardCase
from tests.unit.test_board_config_v3 import config
from agent_studio import boardmodel
from agent_studio.protocol import AsError


class WorkflowBackfillTests(BoardCase):
    def add(self, *args, status=None, **kwargs):
        ticket = super().add(*args, **kwargs)
        if status is not None:
            self.conn.execute("UPDATE tickets SET status = ?, workflow_status = NULL WHERE id = ?",
                              (status, ticket['id']))
        return ticket

    def test_legacy_statuses_claim_history_and_repeat(self):
        self.write_config({"version": 2, "statuses": [
            {"id": "backlog", "kind": "initial"}, {"id": "dev-ready"},
            {"id": "qa-ready"}, {"id": "done", "kind": "done"},
            {"id": "close", "kind": "closed"}], "rules": []})
        cases = [("backlog", "none", "backlog"), ("dev-ready", "dev-ready", "todo"),
                 ("qa-ready", "qa-ready", "in-progress"), ("blocked", "blocked", "in-progress"),
                 ("done", "merged", "done"), ("close", "closed", "closed")]
        tickets = []
        for old, _, _ in cases:
            ticket = self.add(title=old, status=old)
            tickets.append(ticket)
        self.conn.execute("UPDATE tickets SET return_status = 'backlog' WHERE id = ?", (tickets[3]['id'],))
        for ticket in (tickets[0], tickets[2], tickets[4], tickets[5]):
            boardmodel._ticket_event(self.conn, ticket['id'], 'ticket.claimed', 'coordinator', None, None, {})
        with self.store.transaction() as tx:
            boardmodel.backfill_workflow(tx, self.ws)
        for ticket, (old, workflow, column) in zip(tickets, cases):
            row = boardmodel.get_ticket(self.conn, self.ws, ticket['key'])
            self.assertEqual((row['workflow_status'], row['status']), (workflow, column))
            events = [e for e in self.events(ticket['key']) if e['name'] == 'ticket.migrated']
            self.assertEqual(len(events), 1)
            self.assertEqual(json.loads(events[0]['payload_json']),
                             {'fromStatus': old, 'workflowStatus': workflow, 'column': column})
        self.assertEqual(boardmodel.get_ticket(self.conn, self.ws, tickets[3]['key'])['return_status'], 'none')
        statements = []
        self.conn.set_trace_callback(statements.append)
        with self.store.transaction() as tx:
            boardmodel.backfill_workflow(tx, self.ws)
        self.conn.set_trace_callback(None)
        queries = [s for s in statements if s.startswith('SELECT')]
        self.assertEqual(len(queries), 1)
        self.assertIn('EXISTS', queries[0])
        self.assertEqual(self.count('ticket_events', "name = 'ticket.migrated'"), len(cases))

    def test_v3_identity_and_failure_rolls_back_all_tickets(self):
        self.write_config(config())
        good = self.add(status='ready')
        bad = self.add(status='unknown')
        with self.assertRaises(AsError):
            with self.store.transaction() as tx:
                boardmodel.backfill_workflow(tx, self.ws)
        self.assertIsNone(boardmodel.get_ticket(self.conn, self.ws, good['key'])['workflow_status'])
        self.assertEqual(self.count('ticket_events', "name = 'ticket.migrated'"), 0)
        self.conn.execute("UPDATE tickets SET status = 'done' WHERE id = ?", (bad['id'],))
        with self.store.transaction() as tx:
            boardmodel.backfill_workflow(tx, self.ws)
        self.assertEqual(boardmodel.get_ticket(self.conn, self.ws, good['key'])['workflow_status'], 'ready')

    def test_backfilled_blocked_ticket_can_be_unblocked(self):
        self.write_config({"version": 2, "statuses": [
            {"id": "backlog", "kind": "initial"}, {"id": "done", "kind": "done"}], "rules": []})
        ticket = self.add(status='blocked')
        self.conn.execute("UPDATE tickets SET return_status = 'backlog', blocked_reason = 'test' WHERE id = ?",
                          (ticket['id'],))
        with self.store.transaction() as tx:
            boardmodel.backfill_workflow(tx, self.ws)
            result = boardmodel.ticket_unblock(tx, self.ws, {'key': ticket['key']})['ticket']
        self.assertEqual((result['workflowStatus'], result['status']), ('none', 'backlog'))
        self.assertIsNone(result['blockedReason'])

    def test_backfilled_ticket_move_and_board_queries_use_workflow_status(self):
        self.write_config(config())
        ticket = self.add(status='ready')
        with self.store.transaction() as tx:
            boardmodel.backfill_workflow(tx, self.ws)
            result = boardmodel.ticket_move(tx, self.ws, {'key': ticket['key'], 'to': 'done'})
        self.assertEqual((result['ticket']['workflowStatus'], result['ticket']['status']), ('done', 'done'))
        with self.assertRaises(AsError):
            with self.store.transaction() as tx:
                boardmodel.ticket_move(tx, self.ws, {'key': ticket['key'], 'to': 'todo'})
        self.assertEqual(len(boardmodel.ticket_list(self.conn, self.ws, status='done')['tickets']), 1)
        board = boardmodel.board_show(self.conn, self.ws)
        self.assertEqual(sum(sum(p['columns'].values()) for p in board['phases']), 1)
