"""Operator moves set the column and a valid workflow status together."""
import json

from tests.unit.test_p04_s07_board_model import BoardCase
from tests.unit.test_board_config_v3 import config
from agent_studio import boardmodel, dispatch
from agent_studio.protocol import AsError


class TicketMoveColumnTests(BoardCase):
    def setUp(self):
        super().setUp()
        raw = config()
        raw['workflowStatuses'].append({'id': 'other-done', 'kind': 'done'})
        self.write_config(raw)
        self.ticket = self.add(status='backlog')
        with self.store.transaction() as tx:
            boardmodel.backfill_workflow(tx, self.ws)

    def move_to(self, column, **kwargs):
        return self.move(self.ticket['key'], column, **kwargs)['ticket']

    def rejected(self, column, code='TICKET_TRANSITION_INVALID', **kwargs):
        before = self.count('ticket_events')
        with self.assertRaises(AsError) as caught:
            self.move_to(column, **kwargs)
        self.assertEqual(caught.exception.code, code)
        self.assertEqual(self.count('ticket_events'), before)
        return caught.exception

    def test_todo_default_explicit_and_invalid_entries(self):
        self.rejected('todo', workflowStatus='merge-ready')
        self.rejected('todo', workflowStatus='working')
        ticket = self.move_to('todo', reason='start')
        self.assertEqual((ticket['status'], ticket['workflowStatus']), ('todo', 'ready'))
        moved, changed = self.events(self.ticket['key'])[-2:]
        self.assertEqual((moved['name'], moved['from_status'], moved['to_status']),
                         ('ticket.moved', 'backlog', 'todo'))
        self.assertEqual(json.loads(moved['payload_json'])['reason'], 'start')
        self.assertEqual((changed['name'], changed['from_status'], changed['to_status']),
                         ('ticket.workflow_changed', 'backlog', 'ready'))
        self.move_to('backlog')
        self.assertEqual(self.move_to('todo', workflowStatus='ready')['workflowStatus'], 'ready')

    def test_in_progress_requires_rule_waiting_status(self):
        self.rejected('in-progress')
        for status in ('working', 'merging', 'unknown', 'done'):
            self.rejected('in-progress', workflowStatus=status)
        ticket = self.move_to('in-progress', workflowStatus='merge-ready')
        self.assertEqual((ticket['status'], ticket['workflowStatus']), ('in-progress', 'merge-ready'))
        self.assertIsNone(ticket['assignee'])
        self.assertEqual(json.loads(self.events(self.ticket['key'])[-1]['payload_json'])['toColumn'], 'in-progress')

    def test_backlog_resets_rounds_and_blocking_from_todo_and_in_progress(self):
        for column in ('todo', 'in-progress'):
            with self.subTest(column=column):
                self.move_to(column, **({'workflowStatus': 'ready'} if column == 'in-progress' else {}))
                self.conn.execute('UPDATE tickets SET rounds_json = ?, blocked_reason = ?, return_status = ? WHERE id = ?',
                                  ('{"x": 1}', 'blocked', 'ready', self.ticket['id']))
                ticket = self.move_to('backlog')
                self.assertEqual((ticket['status'], ticket['workflowStatus']), ('backlog', 'backlog'))
                row = boardmodel.get_ticket(self.conn, self.ws, self.ticket['key'])
                self.assertEqual((row['rounds_json'], row['blocked_reason'], row['return_status']), (None, None, None))

    def test_done_selection_closed_and_force_restrictions(self):
        self.rejected('done', workflowStatus='ready')
        self.assertEqual(self.move_to('done')['workflowStatus'], 'done')
        self.rejected('todo')
        self.rejected('closed', force=True)
        self.rejected('in-progress', force=True, workflowStatus='ready')
        self.assertEqual(self.move_to('todo', force=True)['workflowStatus'], 'ready')
        self.assertEqual(self.move_to('done', workflowStatus='other-done')['workflowStatus'], 'other-done')
        self.assertEqual(self.move_to('backlog', force=True)['workflowStatus'], 'backlog')
        self.assertEqual(self.move_to('closed')['workflowStatus'], 'closed')
        self.rejected('backlog')
        self.rejected('done', force=True)
        self.move_to('backlog', force=True)
        self.assertTrue(json.loads(self.events(self.ticket['key'])[-2]['payload_json'])['force'])

    def test_closed_ticket_requires_force_and_records_column_move(self):
        self.move_to('closed')
        self.rejected('todo')
        ticket = self.move_to('todo', force=True, reason='reopen for edits')
        self.assertEqual((ticket['status'], ticket['workflowStatus']), ('todo', 'ready'))
        moved, changed = self.events(self.ticket['key'])[-2:]
        payload = json.loads(moved['payload_json'])
        self.assertEqual((moved['name'], moved['from_status'], moved['to_status']),
                         ('ticket.moved', 'closed', 'todo'))
        self.assertEqual((payload['from'], payload['to'], payload['reason'], payload['force']),
                         ('closed', 'todo', 'reopen for edits', True))
        self.assertEqual((changed['name'], changed['from_status'], changed['to_status']),
                         ('ticket.workflow_changed', 'closed', 'ready'))

    def test_force_only_reopens_finished_tickets_to_todo_or_backlog(self):
        self.move_to('done')
        # Force is an explicit reopen flag. It must not permit moving between
        # finished columns or moving a finished ticket back into active work.
        self.rejected('closed', force=True)
        self.rejected('in-progress', force=True, workflowStatus='merge-ready')
        self.assertEqual(self.move_to('todo', force=True)['status'], 'todo')

    def test_unknown_column_busy_and_missing_closed_status(self):
        exc = self.rejected('unknown', code='BOARD_STATUS_UNKNOWN')
        self.assertEqual(exc.data['statuses'], list(boardmodel.KANBAN_COLUMNS))
        self.conn.execute('UPDATE tickets SET assignee = ? WHERE id = ?', ('busy', self.ticket['id']))
        self.rejected('todo', code='TICKET_BUSY')
        self.conn.execute('UPDATE tickets SET assignee = NULL WHERE id = ?', (self.ticket['id'],))
        raw = config()
        raw['workflowStatuses'] = [s for s in raw['workflowStatuses'] if s['id'] != 'closed']
        self.write_config(raw)
        self.rejected('closed')

    def test_dispatch_preserves_workflow_status(self):
        args = dispatch._validate_ticket_move({'workspace': self.ws, 'key': self.ticket['key'],
                                               'to': 'todo', 'workflowStatus': 'ready'})
        self.assertEqual(args['workflowStatus'], 'ready')
        with self.assertRaises(AsError):
            dispatch._validate_ticket_move({'workspace': self.ws, 'key': self.ticket['key'],
                                            'to': 'todo', 'workflowStatus': ''})
