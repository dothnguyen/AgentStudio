import unittest
import json
import os
from unittest.mock import patch

from tests.unit import test_p05_s10_team_overview as fixture
from agent_studio import PROTOCOL, dispatch
from agent_studio.protocol import AsError


class RoleListDispatchTests(unittest.TestCase):
    setUp = fixture.TeamOverviewTests.setUp
    _restore = fixture.TeamOverviewTests._restore
    write = fixture.TeamOverviewTests.write
    put_team = fixture.TeamOverviewTests.put_team
    seed_runtime = fixture.TeamOverviewTests.seed_runtime

    def call(self, **args):
        return dispatch.handle_request({'protocol': PROTOCOL, 'id': 'r', 'command': 'role.list', 'args': args}, True)

    def test_role_list_returns_catalog_plus_saved_and_live_usage(self):
        self.write('board.json', {'version': 2, 'statuses': [{'id': 'todo', 'kind': 'initial'},
                   {'id': 'done', 'kind': 'done'}], 'rules': [{'when': {'status': 'todo'},
                   'role': 'developer', 'workflow': 'first', 'onPass': 'done', 'onFail': 'todo'}]})
        folder = os.path.join(self.ws, '.agent-studio', 'workflows')
        os.makedirs(folder)
        definition = {'version': 1, 'stages': [{'id': 'work', 'role': 'developer',
                      'permission': 'read_only', 'prompt': '{{task}}', 'next': {'done': '$succeed'}}]}
        with open(os.path.join(folder, 'first.json'), 'w') as f:
            json.dump(definition, f)
        with open(os.path.join(folder, 'second.yaml'), 'w') as f:
            f.write("version: 1\nstages:\n- id: work\n  role: developer\n  permission: read_only\n  prompt: '{{task}}'\n  next: {done: '$succeed'}\n")
        self.put_team('core', [fixture.DEV])
        self.put_team('other', [dict(id='other', name='Other', role='developer')])
        self.seed_runtime('core')
        with patch.object(dispatch.coordinator, 'running_info', return_value=None):
            response = self.call(workspace=self.ws)
        self.assertTrue(response['ok'])
        data = response['data']
        self.assertEqual(data['workspace'], self.ws)
        self.assertIn('sha256', data)
        usage = data['items'][0]['usage']
        self.assertEqual((usage['count'], usage['liveRuntime']['state'], usage['partial']), (5, 'disconnected', False))
        self.assertIsNotNone(usage['members'][0]['live'])
        self.assertEqual(usage['boardRules'], [{'index': 0, 'status': 'todo', 'workflow': 'first',
                                                'path': 'rules[0].role'}])
        self.assertEqual(usage['workflows'], [
            {'name': 'first', 'path': '.agent-studio/workflows/first.json', 'stageId': 'work'},
            {'name': 'second', 'path': '.agent-studio/workflows/second.yaml', 'stageId': 'work'}])
        self.assertEqual(set(usage), {'members', 'boardRules', 'workflows', 'legacyRoster', 'liveRuntime',
                                      'problems', 'count', 'blocking', 'partial', 'truncated'})

    def test_role_list_survives_reader_failure_with_partial_usage(self):
        self.put_team('core', [fixture.DEV])
        with patch.object(dispatch.coordinator, 'running_info', return_value=None), \
             patch.object(dispatch, '_reader', side_effect=AsError('BACKEND_UNAVAILABLE', 'state unavailable')):
            response = self.call(workspace=self.ws)
        self.assertTrue(response['ok'])
        usage = response['data']['items'][0]['usage']
        self.assertEqual((usage['count'], usage['liveRuntime']['state'], usage['partial'], usage['blocking']),
                         (1, 'unavailable', True, True))

    def test_role_list_rejects_unknown_arguments(self):
        response = self.call(workspace=self.ws, extra=True)
        self.assertEqual((response['error']['code'], response['error']['message']),
                         ('BAD_REQUEST', 'role.list got unknown argument(s): extra.'))
