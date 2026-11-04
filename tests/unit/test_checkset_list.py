import json
import os
import tempfile
import unittest
from unittest import mock

import tests.helpers  # noqa: F401
from agent_studio import cli, delegation, dispatch, mcpserver
from agent_studio.protocol import PROTOCOL


class ChecksetListTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ws = self.tmp.name
        os.mkdir(os.path.join(self.ws, '.agent-studio'))
        with open(os.path.join(self.ws, '.agent-studio', 'workspace.json'), 'w', encoding='utf-8') as f:
            json.dump({'id': 'test', 'name': 'Test'}, f)

    def write(self, value):
        with open(os.path.join(self.ws, delegation.CONFIG_REL), 'w', encoding='utf-8') as f:
            json.dump(value, f)

    def listing(self):
        return dispatch._checkset_list({'workspace': self.ws}, None)

    def test_registered_read_command_returns_catalog(self):
        self.write({'version': 1, 'commands': {'test': {'description': 'Run tests', 'argv': ['true']}},
                    'checkSets': {'ci': {'run': [{'command': 'test', 'when': ['**']}],
                                          'reuseIfTested': True}}})
        response = dispatch.handle_request({'protocol': PROTOCOL, 'id': 'read-1',
                                            'command': 'checkset.list',
                                            'args': {'workspace': self.ws}}, True)
        self.assertTrue(response['ok'])
        self.assertEqual(response['data'], self.listing())

    def test_shape_and_defaults(self):
        self.write({'version': 1, 'commands': {'test': {'description': 'Run tests', 'argv': ['true']}},
                    'checkSets': {'ci': {'run': [{'command': 'test', 'when': ['**']}],
                                          'otherwise': 'test', 'reuseIfTested': True},
                                  'quick': {'run': [{'command': 'test', 'when': ['*.py']}]}}})
        self.assertEqual(self.listing(), {'checkSets': [
            {'id': 'ci', 'run': [{'command': 'test', 'when': ['**']}], 'otherwise': 'test', 'reuseIfTested': True},
            {'id': 'quick', 'run': [{'command': 'test', 'when': ['*.py']}], 'otherwise': None, 'reuseIfTested': False}],
            'commands': [{'id': 'test', 'description': 'Run tests'}], 'problems': []})

    def test_missing_catalog_and_no_check_sets(self):
        self.assertEqual(self.listing(), {'checkSets': [], 'commands': [], 'problems': []})
        self.write({'version': 1, 'commands': {}})
        self.assertEqual(self.listing(), {'checkSets': [], 'commands': [], 'problems': []})

    def test_invalid_catalog_reports_validation_problem(self):
        self.write({'version': 1, 'commands': {}, 'checkSets': {'bad': {'run': []}}})
        with self.assertRaises(Exception) as error:
            delegation.load_config(self.ws)
        result = self.listing()
        self.assertEqual(result, {'checkSets': [], 'commands': [], 'problems': [
            {'path': error.exception.data['path'], 'message': error.exception.message}]})
        with open(os.path.join(self.ws, delegation.CONFIG_REL), 'w') as f:
            f.write('{')
        self.assertEqual(self.listing()['problems'][0]['path'], delegation.CONFIG_REL)

    def test_cli_and_mcp_forward_read_command(self):
        request = cli._human_request(['checkset', 'list', '--workspace', self.ws])
        self.assertEqual((request['command'], request['args']), ('checkset.list', {'workspace': self.ws}))
        self.assertIn('checkset_list', [t['name'] for t in mcpserver.TOOLS])
        self.assertIn('checkset_list', [t['name'] for t in mcpserver.OPERATOR_READ_TOOLS])
        result = {'checkSets': [], 'commands': [], 'problems': [{'path': 'x', 'message': 'bad'}]}
        with mock.patch.object(mcpserver, '_call', return_value=result) as call:
            self.assertEqual(mcpserver._tool_call('checkset_list', {}, 'a', 'g', self.ws, 1)['problems'], result['problems'])
            self.assertEqual(call.call_args.args[:2], ('checkset.list', {'workspace': self.ws}))
            with mock.patch.object(mcpserver, '_op_workspace', return_value=self.ws):
                self.assertEqual(mcpserver._operator_tool_call('checkset_list', {}, {'session': 's'}, 1)['problems'], result['problems'])
            self.assertEqual(call.call_args.args[:2], ('checkset.list', {'workspace': self.ws}))

    def test_mcp_returns_full_checkset_catalog_and_problems(self):
        def assert_mcp(expected):
            results = [mcpserver._tool_call('checkset_list', {}, 'a', 'g', self.ws, 1),
                       mcpserver._operator_tool_call('checkset_list', {},
                                                     {'session': 's', 'workspace': self.ws}, 1)]
            for result in results:
                self.assertEqual({key: result[key] for key in expected}, expected)
                self.assertEqual(json.loads(result['content'][0]['text']), expected)

        self.write({'version': 1, 'commands': {'test': {'description': 'Run tests', 'argv': ['true']}},
                    'checkSets': {'ci': {'run': [{'command': 'test', 'when': ['**']}],
                                         'otherwise': 'test', 'reuseIfTested': True},
                                  'quick': {'run': [{'command': 'test', 'when': ['*.py']}]}}})
        assert_mcp({'checkSets': [
            {'id': 'ci', 'run': [{'command': 'test', 'when': ['**']}],
             'otherwise': 'test', 'reuseIfTested': True},
            {'id': 'quick', 'run': [{'command': 'test', 'when': ['*.py']}],
             'otherwise': None, 'reuseIfTested': False}],
            'commands': [{'id': 'test', 'description': 'Run tests'}], 'problems': []})

        self.write({'version': 1, 'commands': {'test': {'description': 'Run tests', 'argv': ['true']}}})
        assert_mcp({'checkSets': [], 'commands': [{'id': 'test', 'description': 'Run tests'}], 'problems': []})

        self.write({'version': 1, 'commands': {}, 'checkSets': {'bad': {'run': []}}})
        assert_mcp({'checkSets': [], 'commands': [], 'problems': [
            {'path': 'checkSets.bad.run',
             'message': '.agent-studio/commands.json: checkSets.bad.run: must be a non-empty list'}]})
