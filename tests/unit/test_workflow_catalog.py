import os
import sqlite3
import unittest
import json
from unittest import mock

import tests.unit.test_board_workflows as fixtures
from agent_studio import workflowcatalog, workflowcli, mcpserver, workflowdef
from agent_studio.protocol import AsError


class WorkflowCatalogTests(unittest.TestCase):
    setUp = fixtures.BoardWorkflowTests.setUp
    write = fixtures.BoardWorkflowTests.write
    def test_title_save_show_and_board_workflows(self):
        from agent_studio import dispatch
        obj = dict(self.obj, title='  Custom workflow  ')
        args = {'workspace': self.ws, 'name': 'develop', 'definition': obj, 'expectedSha256': None}
        saved = dispatch.COMMANDS['boardworkflow.save'](args, {})
        shown = dispatch.COMMANDS['boardworkflow.show']({'workspace': self.ws, 'name': 'develop'}, {})
        self.assertEqual(saved['definition']['title'], 'Custom workflow')
        self.assertEqual(shown['definition']['title'], 'Custom workflow')
        self.assertEqual(dispatch.COMMANDS['board.workflows']({'workspace': self.ws}, {})['workflows'][0]['title'], 'Custom workflow')
        args.update(definition=dict(self.obj, title=' '), expectedSha256=saved['sha256'])
        with self.assertRaises(AsError) as error:
            dispatch.COMMANDS['boardworkflow.save'](args, {})
        self.assertEqual(error.exception.code, 'BOARD_WORKFLOW_INVALID')
        self.assertEqual(workflowcatalog.show(self.ws, 'develop')['definition']['title'], 'Custom workflow')

    def test_roundtrip_stale_and_invalid(self):
        saved = workflowcatalog.save(self.ws, 'develop', self.obj, None)
        shown = workflowcatalog.show(self.ws, 'develop')
        self.assertEqual(shown['sha256'], saved['sha256'])
        expected = json.loads(workflowdef.to_json(workflowdef.load(self.ws, 'develop')))
        self.assertEqual(shown['definition'], expected)
        with open(os.path.join(self.base, 'workflows', 'develop.json'), encoding='utf-8') as f:
            self.assertEqual(shown['text'], f.read())
        self.assertEqual(shown['problems'], [])
        with self.assertRaises(AsError) as error:
            workflowcatalog.save(self.ws, 'develop', self.obj, None)
        self.assertEqual(error.exception.code, 'CONFIG_CHANGED')
        bad = dict(self.obj, startsAt='missing')
        with self.assertRaises(AsError) as error:
            workflowcatalog.save(self.ws, 'develop', bad, saved['sha256'])
        self.assertEqual(error.exception.code, 'BOARD_WORKFLOW_INVALID')
        self.assertIn('startsAt', [p['path'] for p in error.exception.data['problems']])

    def test_prompt_metadata_show_update_and_stale_sha(self):
        saved = workflowcatalog.prompt_save(self.ws, 'task', 'hello {{task}}\nagain', None)
        shown = workflowcatalog.prompt_show(self.ws, 'task')
        self.assertEqual(shown['text'], 'hello {{task}}\nagain')
        self.assertEqual(shown['words'], 3)
        self.assertEqual(shown['sha256'], saved['sha256'])
        self.assertEqual(shown['users'], [])
        listed = workflowcatalog.prompt_list(self.ws)['prompts']
        self.assertEqual(len(listed), 1)
        self.assertEqual(listed[0], shown)
        with self.assertRaises(AsError) as error:
            workflowcatalog.prompt_save(self.ws, 'task', 'changed', '0' * 64)
        self.assertEqual(error.exception.code, 'CONFIG_CHANGED')
        updated = workflowcatalog.prompt_save(self.ws, 'task', 'changed text', saved['sha256'])
        self.assertEqual(updated['text'], 'changed text')
        self.assertNotEqual(updated['sha256'], saved['sha256'])

    def test_prompt_usage_and_placeholders(self):
        with self.assertRaises(AsError) as error:
            workflowcatalog.prompt_save(self.ws, 'task', '{{unknown}}', None)
        self.assertEqual(error.exception.code, 'PROMPT_INVALID')
        self.assertEqual(error.exception.data['problems'][0]['path'], 'text')
        prompt = workflowcatalog.prompt_save(self.ws, 'task', 'hello {{task}}', None)
        obj = dict(self.obj)
        obj['stages'] = [dict(self.obj['stages'][0])]
        obj['stages'][0].pop('prompt')
        obj['stages'][0]['promptFile'] = 'workflows/prompts/task.md'
        workflowcatalog.save(self.ws, 'develop', obj, None)
        self.assertEqual(workflowcatalog.prompt_list(self.ws)['prompts'][0]['users'][0]['step'], 'work')
        with self.assertRaises(AsError) as error:
            workflowcatalog.prompt_delete(self.ws, 'task', prompt['sha256'])
        self.assertEqual(error.exception.code, 'PROMPT_IN_USE')
        self.assertEqual(error.exception.data['users'], [{'workflow': 'develop', 'step': 'work'}])

    def test_workflow_in_use_refusal(self):
        saved = workflowcatalog.save(self.ws, 'develop', self.obj, None)
        conn = sqlite3.connect(':memory:')
        self.addCleanup(conn.close)
        conn.execute('CREATE TABLE tickets (key TEXT, workspace TEXT, workflow_status TEXT, active_run_id TEXT)')
        conn.execute('CREATE TABLE workflow_runs (id TEXT, definition_name TEXT)')
        conn.execute('INSERT INTO tickets VALUES (?, ?, ?, ?)', ('T-1', self.ws, 'working', None))
        with self.assertRaises(AsError) as error:
            workflowcatalog.delete(self.ws, 'develop', saved['sha256'], conn)
        self.assertEqual(error.exception.code, 'BOARD_WORKFLOW_IN_USE')
        conn.execute('DELETE FROM tickets')
        with self.assertRaises(AsError) as error:
            workflowcatalog.delete(self.ws, 'develop', '0' * 64, conn)
        self.assertEqual(error.exception.code, 'CONFIG_CHANGED')
        workflowcatalog.delete(self.ws, 'develop', saved['sha256'], conn)
        self.assertFalse(os.path.exists(os.path.join(self.base, 'workflows', 'develop.json')))

    def test_delete_refuses_ticket_in_while_running_status(self):
        saved = workflowcatalog.save(self.ws, 'develop', self.obj, None)
        conn = sqlite3.connect(':memory:')
        self.addCleanup(conn.close)
        conn.execute('CREATE TABLE tickets (key TEXT, workspace TEXT, workflow_status TEXT, active_run_id TEXT)')
        conn.execute('CREATE TABLE workflow_runs (id TEXT, definition_name TEXT)')
        conn.execute('INSERT INTO tickets VALUES (?, ?, ?, ?)', ('T-2', self.ws, 'working', None))
        with self.assertRaises(AsError) as error:
            workflowcatalog.delete(self.ws, 'develop', saved['sha256'], conn)
        self.assertEqual(error.exception.code, 'BOARD_WORKFLOW_IN_USE')
        self.assertTrue(os.path.exists(os.path.join(self.base, 'workflows', 'develop.json')))

    def test_prompt_delete_succeeds_when_unused(self):
        prompt = workflowcatalog.prompt_save(self.ws, 'unused', 'plain text', None)
        workflowcatalog.prompt_delete(self.ws, 'unused', prompt['sha256'])
        self.assertFalse(os.path.exists(os.path.join(self.base, 'workflows', 'prompts', 'unused.md')))

    def test_cli_commands_forward_content_and_sha(self):
        path = os.path.join(self.ws, 'input.json')
        with open(path, 'w') as f:
            json.dump(self.obj, f)
        with mock.patch.object(workflowcli, '_call', return_value={}) as call, mock.patch.object(workflowcli.cli, 'emit', return_value=0):
            for kind in ('board', 'prompt'):
                prefix = ['board', 'workflow'] if kind == 'board' else ['prompt']
                command = 'boardworkflow' if kind == 'board' else 'prompt'
                for action in ('list', 'show', 'save', 'delete'):
                    args = prefix + [action, '--workspace', self.ws]
                    if action != 'list':
                        args += ['example']
                    if action == 'save':
                        args += ['--file', path]
                        args += ['--expected-sha256', 'b' * 64]
                    if action == 'delete':
                        args += ['--expected-sha256', 'a' * 64]
                    self.assertEqual(workflowcli.run(args, False), 0)
                    self.assertEqual(call.call_args.args[0], command + '.' + action)
                    payload = call.call_args.args[1]
                    self.assertEqual(payload['workspace'], self.ws)
                    if action == 'save':
                        self.assertEqual(payload['definition' if kind == 'board' else 'text'], self.obj if kind == 'board' else json.dumps(self.obj))
                        self.assertEqual(payload['expectedSha256'], 'b' * 64)

    def test_mcp_read_tools_forward_workspace(self):
        for name, command in [('board_workflows', 'board.workflows'), ('prompt_list', 'prompt.list')]:
            self.assertIn(name, [tool['name'] for tool in mcpserver.TOOLS])
            self.assertIn(name, [tool['name'] for tool in mcpserver.OPERATOR_READ_TOOLS])
            with mock.patch.object(mcpserver, '_call', return_value={'items': []}) as call:
                self.assertEqual(mcpserver._tool_call(name, {}, 'a', 'g', self.ws, 1)['items'], [])
                self.assertEqual(call.call_args.args[:2], (command, {'workspace': self.ws}))
                with mock.patch.object(mcpserver, '_op_workspace', return_value=self.ws):
                    mcpserver._operator_tool_call(name, {}, {'session': 's', 'workspace': self.ws}, 1)
                self.assertEqual(call.call_args.args[:2], (command, {'workspace': self.ws}))

    def test_claimed_workflow_and_stale_prompt_delete_are_refused(self):
        saved = workflowcatalog.save(self.ws, 'develop', self.obj, None)
        conn = sqlite3.connect(':memory:')
        self.addCleanup(conn.close)
        conn.execute('CREATE TABLE tickets (key TEXT, workspace TEXT, workflow_status TEXT, active_run_id TEXT)')
        conn.execute('CREATE TABLE workflow_runs (id TEXT, definition_name TEXT)')
        conn.execute('INSERT INTO workflow_runs VALUES (?, ?)', ('run', 'develop'))
        conn.execute('INSERT INTO tickets VALUES (?, ?, ?, ?)', ('T-1', self.ws, 'ready', 'run'))
        with self.assertRaises(AsError) as error:
            workflowcatalog.delete(self.ws, 'develop', saved['sha256'], conn)
        self.assertEqual(error.exception.code, 'BOARD_WORKFLOW_IN_USE')
        prompt = workflowcatalog.prompt_save(self.ws, 'task', 'hello', None)
        with self.assertRaises(AsError) as error:
            workflowcatalog.prompt_delete(self.ws, 'task', '0' * 64)
        self.assertEqual(error.exception.code, 'CONFIG_CHANGED')
        workflowcatalog.prompt_delete(self.ws, 'task', prompt['sha256'])
