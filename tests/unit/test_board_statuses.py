"""Status usage and edits are backed by board and ticket state."""
import hashlib
import json
import os
from unittest.mock import patch

import tests.helpers  # noqa: F401
from agent_studio import boardstatuses, dispatch, statuscli
from agent_studio.protocol import AsError
from tests.unit.test_p04_s07_board_model import BoardCase
from tests.unit.test_board_config_v3 import config


class StatusTests(BoardCase):
    def setUp(self):
        super().setUp()
        raw = config()
        raw['version'] = 4
        raw.pop('rules')
        raw['workflowStatuses'].append({'id': 'spare'})
        self.write_config(raw)
        os.makedirs(os.path.join(self.ws, '.agent-studio', 'workflows'), exist_ok=True)
        with open(os.path.join(self.ws, '.agent-studio', 'roles.json'), 'w') as f:
            json.dump({'version': 1, 'roles': {'Developer': {}}}, f)
        obj = {'version': 2, 'startsAt': 'ready', 'whileRunning': 'working', 'role': 'Developer',
               'createdTickets': 'spare', 'end': {'pass': 'done', 'fail': 'ready'},
               'stages': [{'id': 'work', 'role': 'Developer', 'permission': 'read_only', 'prompt': 'work', 'next': {'done': '$succeed'}}]}
        with open(os.path.join(self.ws, '.agent-studio', 'workflows', 'develop.json'), 'w') as f:
            json.dump(obj, f)

    def listed(self):
        return boardstatuses.list_statuses(self.ws, self.conn)

    def edit(self, action, **args):
        return boardstatuses.change(self.ws, self.conn, action, args, self.listed()['sha256'])

    def test_types_users_and_counts(self):
        self.add('ticket')
        listed = self.listed()
        statuses = {s['id']: s for s in listed['statuses']}
        self.assertEqual([statuses[x]['type'] for x in ('backlog', 'ready', 'working', 'done', 'closed', 'merge-ready')],
                         ['start', 'startsWorkflow', 'whileRunning', 'done', 'closed', 'unused'])
        self.assertEqual([statuses[x]['kind'] for x in ('backlog', 'ready', 'working', 'done', 'closed', 'merge-ready')],
                         ['initial', None, None, 'done', 'closed', None])
        self.assertEqual(statuses['backlog']['ticketCount'], 1)
        self.assertIn({'workflow': 'develop', 'title': 'Develop', 'how': 'createdTickets'}, statuses['spare']['usedBy'])
        with open(os.path.join(self.ws, '.agent-studio', 'board.json'), 'rb') as f:
            self.assertEqual(listed['sha256'], hashlib.sha256(f.read()).hexdigest())

    def test_name_presence_distinguishes_missing_name_from_name_equal_to_id(self):
        self.edit('rename', id='spare', name='spare')
        statuses = {s['id']: s for s in self.listed()['statuses']}
        self.assertTrue(statuses['spare']['hasName'])
        raw = config()
        raw['version'] = 4
        raw.pop('rules')
        raw['workflowStatuses'].append({'id': 'spare'})
        self.write_config(raw)
        statuses = {s['id']: s for s in self.listed()['statuses']}
        self.assertEqual(statuses['spare']['name'], 'spare')
        self.assertFalse(statuses['spare']['hasName'])

    def test_all_workflow_reference_paths_are_reported_as_users(self):
        path = os.path.join(self.ws, '.agent-studio', 'workflows', 'develop.json')
        with open(path) as f:
            workflow = json.load(f)
        workflow['end'] = {
            'pass': 'done',
            'fail': {'status': 'ready', 'releaseCreatedTickets': {'from': 'spare', 'to': 'merge-ready'}},
            'blocked': {'status': 'ready', 'returnTo': 'working'},
        }
        workflow['limits'] = {'failuresInARow': {'count': 2, 'status': 'spare'}}
        with open(path, 'w') as f:
            json.dump(workflow, f)

        statuses = {s['id']: s for s in self.listed()['statuses']}
        self.assertEqual(statuses['ready']['usedBy'], [
            {'workflow': 'develop', 'title': 'Develop', 'how': 'startsAt'},
            {'workflow': 'develop', 'title': 'Develop', 'how': 'end.blocked.status'},
            {'workflow': 'develop', 'title': 'Develop', 'how': 'end.fail.status'},
        ])
        self.assertEqual(statuses['working']['usedBy'], [
            {'workflow': 'develop', 'title': 'Develop', 'how': 'whileRunning'},
            {'workflow': 'develop', 'title': 'Develop', 'how': 'end.blocked.returnTo'},
        ])
        self.assertEqual(statuses['spare']['usedBy'], [
            {'workflow': 'develop', 'title': 'Develop', 'how': 'createdTickets'},
            {'workflow': 'develop', 'title': 'Develop', 'how': 'end.fail.releaseCreatedTickets.from'},
            {'workflow': 'develop', 'title': 'Develop', 'how': 'limits.failuresInARow.status'},
        ])
        self.assertIn({'workflow': 'develop', 'title': 'Develop',
                       'how': 'end.fail.releaseCreatedTickets.to'}, statuses['merge-ready']['usedBy'])

    def test_add_rename_reorder_remove_and_stale_sha(self):
        old = self.listed()['sha256']
        self.edit('add', id='new-status', name='New', kind='none')
        with self.assertRaises(AsError) as error:
            boardstatuses.change(self.ws, self.conn, 'rename', {'id': 'new-status', 'name': 'x'}, old)
        self.assertEqual(error.exception.code, 'CONFIG_CHANGED')
        self.edit('rename', id='new-status', name='Renamed')
        ids = [s['id'] for s in self.listed()['statuses']][::-1]
        self.edit('reorder', ids=ids)
        self.assertEqual([s['id'] for s in self.listed()['statuses']], ids)
        self.edit('remove', id='new-status')
        self.edit('add', id='another-done', name='Done again', kind='done')
        self.assertEqual(self.listed()['statuses'][-1]['kind'], 'done')

    def test_refusals_for_usage_protected_and_invalid_input(self):
        self.add('ticket')
        for ident in ('backlog', 'closed', 'ready', 'spare'):
            with self.subTest(ident=ident), self.assertRaises(AsError) as error:
                self.edit('remove', id=ident)
            self.assertEqual(error.exception.code, 'STATUS_IN_USE')
            self.assertIn('usedBy', error.exception.data)
            self.assertIn('ticketCount', error.exception.data)
        self.assertEqual(next(s for s in self.listed()['statuses'] if s['id'] == 'backlog')['ticketCount'], 1)
        for action, args in [('add', {'id': 'Bad_ID', 'name': 'Bad', 'kind': 'none'}),
                             ('add', {'id': 'ready', 'name': 'Dup', 'kind': 'none'}),
                             ('add', {'id': 'x', 'name': '', 'kind': 'none'}),
                             ('add', {'id': 'x', 'name': 'X', 'kind': 'initial'}),
                             ('rename', {'id': 'missing', 'name': 'X'}),
                             ('reorder', {'ids': ['ready', 'ready']})]:
            with self.subTest(action=action, args=args), self.assertRaises(AsError):
                self.edit(action, **args)

    def test_ticket_usage_blocks_otherwise_unused_status(self):
        ticket = self.add('ticket')
        self.conn.execute('UPDATE tickets SET workflow_status = ? WHERE id = ?', ('merge-ready', ticket['id']))
        with self.assertRaises(AsError) as error:
            self.edit('remove', id='merge-ready')
        self.assertEqual(error.exception.code, 'STATUS_IN_USE')
        self.assertEqual(error.exception.data['ticketCount'], 1)
        self.assertEqual(error.exception.data['usedBy'], [])

    def test_legacy_ticket_status_is_counted_and_blocks_removal(self):
        ticket = self.add('legacy ticket')
        self.legacy_status(ticket['key'], 'merge-ready')
        status = next(s for s in self.listed()['statuses'] if s['id'] == 'merge-ready')
        self.assertEqual(status['ticketCount'], 1)
        with self.assertRaises(AsError) as error:
            self.edit('remove', id='merge-ready')
        self.assertEqual(error.exception.code, 'STATUS_IN_USE')
        self.assertEqual(error.exception.data, {'usedBy': [], 'ticketCount': 1})

    def test_initial_and_closed_statuses_cannot_be_removed_without_other_usage(self):
        for ident in ('backlog', 'closed'):
            with self.subTest(ident=ident), self.assertRaises(AsError) as error:
                self.edit('remove', id=ident)
            self.assertEqual(error.exception.code, 'STATUS_IN_USE')
            self.assertEqual(error.exception.data, {'usedBy': [], 'ticketCount': 0})

    def test_all_cli_actions_route(self):
        cases = [(['list'], 'board.statuses'),
                 (['rename', 'x', 'X', '--expected-sha256', 'a' * 64], 'status.rename'),
                 (['remove', 'x', '--expected-sha256', 'a' * 64], 'status.remove'),
                 (['reorder', 'x', 'y', '--expected-sha256', 'a' * 64], 'status.reorder')]
        with patch('agent_studio.statuscli._call', return_value={}) as call, patch('agent_studio.cli.emit', return_value=0):
            for argv, command in cases:
                statuscli.run(['board', 'status'] + argv + ['--workspace', self.ws], False)
                self.assertEqual(call.call_args.args[0], command)

    def test_dispatch_requires_sha_and_cli_routes_commands(self):
        with self.assertRaises(AsError):
            dispatch.COMMANDS['status.remove']({'workspace': self.ws, 'id': 'spare'}, {})
        with patch('agent_studio.statuscli._call', return_value={}) as call, patch('agent_studio.cli.emit', return_value=0):
            statuscli.run(['board', 'status', 'add', 'fresh', 'Fresh', '--kind', 'none', '--expected-sha256', 'a' * 64, '--workspace', self.ws], False)
            self.assertEqual(call.call_args.args[0], 'status.add')
            self.assertEqual(call.call_args.args[1]['name'], 'Fresh')
