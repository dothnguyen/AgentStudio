import json
import os
from unittest import mock

from tests.unit import test_p05_s10_team_overview as fixture
from agent_studio import rolecatalog


class RoleReferenceTests(fixture.TeamOverviewTests):
    def setUp(self):
        super().setUp()
        self.write('board.json', {'version': 2, 'statuses': [{'id': 'todo', 'kind': 'initial'},
                   {'id': 'done', 'kind': 'done'}], 'rules': []})

    def usage(self, conn=True, running=True):
        catalog = rolecatalog.list_roles(self.ws)
        return rolecatalog.attach_usage(catalog, self.ws, self.conn if conn else None, running,
                                        None if conn else {'code': 'BACKEND_UNAVAILABLE', 'message': 'state unavailable'})['items'][0]['usage']

    def test_two_saved_teams_with_duplicate_member_names_keep_stable_members(self):
        self.put_team('a', [dict(id='one', name='Same', role='developer')])
        self.put_team('b', [dict(id='two', name='Same', role='developer')])
        u = self.usage()
        self.assertEqual([(m['teamDefId'], m['memberId']) for m in u['members']], [('a', 'one'), ('b', 'two')])
        self.assertEqual((u['count'], u['blocking'], u['partial']), (2, True, False))

    def test_saved_and_live_member_merge_with_active_assignment(self):
        self.put_team('core', [fixture.DEV])
        team, agents = self.seed_runtime('core')
        assignment, _ = self.seed_assignment(team, agents['dev'], 'work', run=False)
        task = self.conn.execute('SELECT task_id FROM assignments WHERE id=?', (assignment,)).fetchone()[0]
        u = self.usage()
        self.assertEqual(u['count'], 1)
        self.assertEqual(u['members'][0]['live']['assignment'], {'id': assignment, 'status': 'queued', 'taskId': task})

    def test_runtime_only_member_blocks_and_stopped_runtime_does_not(self):
        self.seed_runtime('missing')
        self.seed_runtime('old', status='stopped')
        u = self.usage()
        self.assertEqual(u['count'], 1)
        self.assertIsNone(u['members'][0]['saved'])
        self.assertTrue(u['blocking'])

    def test_board_rule_and_json_and_yaml_workspace_stages_are_indexed(self):
        board = {'version': 2, 'statuses': [{'id': 'todo', 'kind': 'initial'}, {'id': 'done', 'kind': 'done'}],
                 'rules': [{'when': {'status': 'todo'}, 'role': 'developer', 'workflow': 'builtin',
                            'onPass': 'done', 'onFail': 'todo'}]}
        self.write('board.json', board)
        folder = os.path.join(self.ws, '.agent-studio', 'workflows')
        os.makedirs(folder)
        definition = {'version': 1, 'stages': [{'id': 'work', 'role': 'developer', 'permission': 'read_only',
                      'prompt': '{{task}}', 'next': {'done': '$succeed'}}]}
        with open(os.path.join(folder, 'first.json'), 'w') as f:
            json.dump(definition, f)
        with open(os.path.join(folder, 'second.yaml'), 'w') as f:
            f.write("version: 1\nstages:\n- id: work\n  role: developer\n  permission: read_only\n  prompt: '{{task}}'\n  next: {done: '$succeed'}\n")
        u = self.usage()
        self.assertEqual(u['boardRules'], [{'index': 0, 'status': 'todo', 'workflow': 'builtin', 'path': 'rules[0].role'}])
        self.assertEqual([(w['name'], w['stageId']) for w in u['workflows']], [('first', 'work'), ('second', 'work')])
        self.assertEqual([w['path'] for w in u['workflows']],
                         ['.agent-studio/workflows/first.json', '.agent-studio/workflows/second.yaml'])
        self.assertEqual(u['count'], 3)

    def test_builtin_workflow_roles_are_not_indexed(self):
        from agent_studio import workflowdef
        builtin = os.path.join(self.root, 'builtin')
        os.makedirs(builtin)
        with open(os.path.join(builtin, 'example.json'), 'w') as f:
            json.dump({'version': 1, 'stages': [{'id': 'work', 'role': 'developer',
                       'permission': 'read_only', 'prompt': '{{task}}',
                       'next': {'done': '$succeed'}}]}, f)
        self.assertEqual(workflowdef.list_definitions(self.ws, builtin_dir=builtin)[0]['roles'], ['developer'])
        self.write('board.json', {'version': 2, 'statuses': [{'id': 'todo', 'kind': 'initial'},
                   {'id': 'done', 'kind': 'done'}], 'rules': [{'when': {'status': 'todo'},
                   'role': 'developer', 'workflow': 'example', 'onPass': 'done', 'onFail': 'todo'}]})
        with mock.patch.object(workflowdef, 'list_definitions', wraps=workflowdef.list_definitions) as listing:
            u = self.usage()
        self.assertEqual(u['workflows'], [])
        self.assertEqual((len(u['boardRules']), u['count'], u['blocking']), (1, 1, True))
        self.assertTrue(all(call.kwargs.get('builtin_dir') is None for call in listing.call_args_list))

    def test_invalid_sources_are_partial_and_fail_closed(self):
        cases = [('teams/a.json', '{', 'teams'), ('team.json', '{', 'legacyRoster'),
                 ('board.json', '{', 'board'), ('workflows/bad.json', '{', 'workflows'),
                 ('workflows/bad.yaml', 'stages: [', 'workflows')]
        for path, content, source in cases:
            with self.subTest(source=path):
                target = os.path.join(self.ws, '.agent-studio', path)
                os.makedirs(os.path.dirname(target), exist_ok=True)
                previous = open(target).read() if os.path.exists(target) else None
                with open(target, 'w') as f:
                    f.write(content)
                u = self.usage()
                self.assertTrue(u['partial'] and u['blocking'])
                self.assertEqual(u['count'], 0)
                self.assertIn(source, [p['source'] for p in u['problems']])
                if previous is None:
                    os.remove(target)
                else:
                    with open(target, 'w') as f:
                        f.write(previous)

    def test_runtime_unavailable_preserves_saved_usage_and_fails_closed(self):
        self.put_team('core', [fixture.DEV])
        u = self.usage(False)
        self.assertEqual((u['count'], u['liveRuntime']['state'], u['partial'], u['blocking']), (1, 'unavailable', True, True))
        self.assertEqual(u['problems'][0]['code'], 'BACKEND_UNAVAILABLE')

    def test_legacy_roster_directory_is_partial_and_blocks(self):
        os.mkdir(os.path.join(self.ws, '.agent-studio', 'team.json'))
        u = self.usage()
        self.assertEqual((u['count'], u['partial'], u['blocking']), (0, True, True))
        problem = next(p for p in u['problems'] if p['source'] == 'legacyRoster')
        self.assertEqual(problem['path'], '.agent-studio/team.json')
        self.assertEqual(problem['code'], 'ROLES_CONFIG_INVALID')

    def test_disconnected_runtime_is_distinct_and_still_scanned(self):
        self.seed_runtime('core')
        u = self.usage(running=False)
        self.assertEqual((u['liveRuntime']['state'], u['count'], u['partial']), ('disconnected', 1, False))

    def test_labels_and_projection_are_bounded_without_weakening_blocking(self):
        self.put_team('core', [dict(id=str(i), name='x\n' + 'y' * 300, role='developer') for i in range(501)])
        u = self.usage()
        self.assertEqual((u['count'], len(u['members']), u['truncated'], u['blocking']), (501, 500, True, True))
        self.assertLessEqual(len(u['members'][0]['memberName']), 200)
        self.assertNotIn('\n', u['members'][0]['memberName'])

    def test_legacy_roster_and_multiple_members_are_distinct_references(self):
        self.put_team('core', [fixture.DEV, dict(fixture.DEV, id='dev2')])
        self.write('team.json', {'version': 1, 'agents': [
            {'displayName': 'Legacy Dev', 'role': 'developer'}, {'role': 'developer'}]})
        u = self.usage()
        self.assertEqual(u['count'], 4)
        self.assertEqual(u['legacyRoster'], [
            {'memberIndex': 0, 'memberId': 'legacy-dev', 'memberName': 'Legacy Dev',
             'path': '.agent-studio/team.json'},
            {'memberIndex': 1, 'memberId': 'developer-2', 'memberName': 'developer-2',
             'path': '.agent-studio/team.json'}])

    def test_missing_member_id_is_a_problem_and_does_not_merge_by_name(self):
        self.put_team('core', [{'name': 'Agent 0', 'role': 'developer'}])
        self.seed_runtime('core')
        u = self.usage()
        self.assertTrue(u['partial'])
        self.assertTrue(u['blocking'])
        self.assertIn('teams', [p['source'] for p in u['problems']])
        self.assertEqual(len(u['members']), 1)
        self.assertIsNone(u['members'][0]['saved'])

    def test_missing_board_and_source_errors_are_sanitized(self):
        os.remove(os.path.join(self.ws, '.agent-studio', 'board.json'))
        u = self.usage()
        self.assertEqual((u['count'], u['partial'], u['blocking']), (0, True, True))
        problem = next(p for p in u['problems'] if p['source'] == 'board')
        self.assertEqual(problem['code'], 'BOARD_CONFIG_INVALID')
        self.assertNotIn(self.ws, problem['message'])
        self.assertIn('<workspace>', problem['message'])

    def test_completed_assignment_is_not_live_evidence(self):
        team, agents = self.seed_runtime('core')
        self.seed_assignment(team, agents['dev'], 'done', run=False,
                             statuses=('claimed', 'running', 'succeeded'))
        self.assertIsNone(self.usage()['members'][0]['live']['assignment'])

    def test_attach_usage_preserves_catalog_and_does_not_mutate_it(self):
        catalog = rolecatalog.list_roles(self.ws)
        before = json.loads(json.dumps(catalog))
        result = rolecatalog.attach_usage(catalog, self.ws, self.conn, True, None)
        self.assertEqual(catalog, before)
        self.assertEqual({k: v for k, v in result.items() if k != 'items'},
                         {k: v for k, v in before.items() if k != 'items'})
        self.assertEqual([{k: v for k, v in item.items() if k != 'usage'} for item in result['items']],
                         before['items'])
