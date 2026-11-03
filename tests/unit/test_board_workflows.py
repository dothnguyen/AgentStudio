"""Board workflow indexing and cross-definition validation."""
import json
import os
import tempfile
import unittest

import tests.helpers  # noqa: F401
from agent_studio import boardmodel, boardworkflows, dispatch
from tests.unit.test_board_config_v3 import config


class BoardWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ws = self.tmp.name
        self.base = os.path.join(self.ws, '.agent-studio')
        os.makedirs(os.path.join(self.base, 'workflows'))
        self.write('board.json', config())
        self.write('roles.json', {'version': 1, 'roles': {'Developer': {}}})
        self.cfg = boardmodel.load_config(self.ws)
        self.obj = {'version': 2, 'startsAt': 'ready', 'whileRunning': 'working',
                    'role': 'Developer', 'createdTickets': 'backlog',
                    'end': {'pass': {'status': 'done', 'releaseCreatedTickets': {'from': 'backlog', 'to': 'ready'}},
                            'fail': 'ready', 'blocked': {'status': 'closed', 'returnTo': 'ready'}},
                    'limits': {'failuresInARow': {'count': 2, 'status': 'ready'}},
                    'stages': [{'id': 'work', 'role': 'Developer', 'permission': 'read_only',
                                'prompt': 'work', 'next': {'done': '$succeed'}}]}

    def write(self, path, obj):
        with open(os.path.join(self.base, path), 'w') as f:
            json.dump(obj, f)

    def index(self):
        return boardworkflows.load(self.ws, self.cfg)

    def test_valid_index_and_dispatch_shape(self):
        self.write('workflows/develop.json', self.obj)
        self.write('workflows/other.json', {'version': 2})
        result = self.index()
        self.assertEqual(result['problems'], [])
        wf = result['workflows'][0]
        self.assertEqual(result['byStart'], {'ready': wf})
        self.assertEqual(result['byRunning'], {'working': wf})
        self.assertEqual((wf['name'], wf['startsAt'], wf['whileRunning'], wf['role']),
                         ('develop', 'ready', 'working', 'Developer'))
        self.assertEqual(wf['steps'], [{'id': 'work', 'kind': 'work'}])
        self.assertEqual(wf['end'], self.obj['end'])
        self.assertEqual(wf['limits'], self.obj['limits'])
        self.assertEqual(dispatch.COMMANDS['board.workflows']({'workspace': self.ws}, {}),
                         {'workflows': [wf], 'problems': []})

    def test_definition_without_starts_at_is_ignored_and_agentless_needs_no_role(self):
        agentless = dict(self.obj, role=None,
                         stages=[{'id': 'check', 'type': 'validation', 'next': {'pass': '$succeed', 'fail': '$fail'}}])
        agentless.pop('role')
        self.write('workflows/agentless.json', agentless)
        self.write('workflows/not-board.json', {'version': 2})
        result = self.index()
        self.assertEqual(result['problems'], [])
        self.assertEqual([wf['name'] for wf in result['workflows']], ['agentless'])
        self.assertIsNone(result['workflows'][0]['role'])

    def test_unknown_references_and_missing_role_report_paths(self):
        self.obj.update(startsAt='missing', whileRunning='absent', role='Unknown', createdTickets='unknown')
        self.obj['end'] = {'pass': {'status': 'lost', 'releaseCreatedTickets': {'from': 'foo', 'to': 'bar'}},
                           'fail': 'gone', 'blocked': {'status': 'void', 'returnTo': 'away'}}
        self.obj['limits']['failuresInARow']['status'] = 'bad'
        self.write('workflows/develop.json', self.obj)
        paths = {p['path'] for p in self.index()['problems']}
        self.assertEqual(paths, {'startsAt', 'whileRunning', 'role', 'createdTickets', 'end.pass.status',
                                 'end.pass.releaseCreatedTickets.from', 'end.pass.releaseCreatedTickets.to',
                                 'end.fail', 'end.blocked.status', 'end.blocked.returnTo',
                                 'limits.failuresInARow.status'})
        del self.obj['role']
        self.write('workflows/develop.json', self.obj)
        self.assertIn('requires a role', next(p['message'] for p in self.index()['problems'] if p['path'] == 'role'))

    def test_duplicate_and_kind_constraints_and_broken_file(self):
        self.obj.update(startsAt='done', whileRunning='closed')
        self.write('workflows/a.json', self.obj)
        self.write('workflows/b.json', self.obj)
        self.obj.update(startsAt='merge-ready', whileRunning='done')
        self.write('workflows/c.json', self.obj)
        with open(os.path.join(self.base, 'workflows', 'broken.json'), 'w') as f:
            f.write('{')
        problems = self.index()['problems']
        pairs = [(p['workflow'], p['path']) for p in problems]
        for pair in [('a', 'startsAt'), ('a', 'whileRunning'), ('b', 'startsAt'),
                     ('b', 'whileRunning'), ('c', 'whileRunning'), ('broken', '$')]:
            self.assertIn(pair, pairs)
        self.assertTrue(any('also a workflow start' in p['message'] for p in problems))

    def test_initial_start_and_kinded_running_status_are_rejected(self):
        self.obj.update(startsAt='backlog', whileRunning='done')
        self.write('workflows/develop.json', self.obj)
        problems = {(p['path'], p['message']) for p in self.index()['problems']}
        self.assertTrue(any(path == 'startsAt' and 'no kind' in message
                            for path, message in problems))
        self.assertTrue(any(path == 'whileRunning' and 'no kind' in message
                            for path, message in problems))
