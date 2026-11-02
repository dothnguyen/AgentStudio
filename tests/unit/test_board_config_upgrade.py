"""In-memory conversion of legacy board configuration."""
import copy
import json
import os
import tempfile
import unittest

from backend.agent_studio import boardmodel
from tests.unit.test_board_config_v3 import config


class BoardConfigUpgradeTests(unittest.TestCase):
    def test_required_renames_displace_existing_ids_and_rewrite_references(self):
        raw = {'version': 2, 'statuses': [
            {'id': 'backlog', 'kind': 'initial'}, {'id': 'none'}, {'id': 'none-2'},
            {'id': 'done', 'kind': 'done'}, {'id': 'merged'},
            {'id': 'close', 'kind': 'closed'}, {'id': 'closed'}],
            'agentTicketStatus': 'none', 'rules': [
                {'when': {'status': 'none'}, 'role': 'x', 'workflow': 'x',
                 'onPass': 'merged', 'onFail': 'backlog', 'onBlocked': 'closed'}]}
        upgraded, mapping = boardmodel.upgrade_config(raw)
        self.assertEqual(mapping, {'backlog': 'none', 'none': 'none-3', 'none-2': 'none-2',
                                   'done': 'merged', 'merged': 'merged-2',
                                   'close': 'closed', 'closed': 'closed-2'})
        rule = upgraded['rules'][0]
        self.assertEqual((rule['when']['status'], rule['onPass'], rule['onFail'], rule['onBlocked']),
                         ('none-3', 'merged-2', 'none', 'closed-2'))
        self.assertEqual(upgraded['agentTicketStatus'], 'none-3')
        with tempfile.TemporaryDirectory() as workspace:
            os.mkdir(os.path.join(workspace, '.agent-studio'))
            with open(os.path.join(workspace, '.agent-studio', 'board.json'), 'w', encoding='utf-8') as f:
                json.dump(raw, f)
            loaded = boardmodel.load_config(workspace)
        self.assertEqual(loaded['upgradedFrom'], mapping)
        self.assertEqual(len(loaded['byId']), len(upgraded['workflowStatuses']))

    def test_existing_generated_status_is_reused_when_loading(self):
        raw = {'version': 2, 'statuses': [{'id': 'start', 'kind': 'initial'},
               {'id': 'deving', 'name': 'In development'}, {'id': 'dev-ready'},
               {'id': 'done', 'kind': 'done'}], 'rules': [
                   {'when': {'status': 'dev-ready'}, 'role': 'x', 'workflow': 'x',
                    'onPass': 'done', 'onFail': 'start'}]}
        with tempfile.TemporaryDirectory() as workspace:
            os.mkdir(os.path.join(workspace, '.agent-studio'))
            with open(os.path.join(workspace, '.agent-studio', 'board.json'), 'w', encoding='utf-8') as f:
                json.dump(raw, f)
            loaded = boardmodel.load_config(workspace)
        upgraded, mapping = boardmodel.upgrade_config(raw)
        statuses = upgraded['workflowStatuses']
        self.assertEqual([s['id'] for s in statuses], ['none', 'dev-ready', 'deving', 'merged'])
        self.assertEqual(statuses[2]['name'], 'In development')
        self.assertEqual(loaded['rulesByStatus']['dev-ready']['during'], 'deving')
        self.assertEqual(loaded['upgradedFrom'], mapping)

    def test_generated_status_avoids_rule_and_terminal_statuses(self):
        raw = {'version': 2, 'statuses': [{'id': 'start', 'kind': 'initial'},
               {'id': 'dev-ready'}, {'id': 'deving'}, {'id': 'deving-2', 'kind': 'done'}],
               'rules': [
                   {'when': {'status': 'dev-ready'}, 'role': 'x', 'workflow': 'x',
                    'onPass': 'deving-2', 'onFail': 'start'},
                   {'when': {'status': 'deving'}, 'role': 'x', 'workflow': 'x',
                    'onPass': 'deving-2', 'onFail': 'start'}]}
        upgraded, _ = boardmodel.upgrade_config(raw)
        self.assertEqual(upgraded['rules'][0]['during'], 'deving-3')
        boardmodel.parse_config(upgraded)

    def test_board_without_agent_rules_has_no_todo_default(self):
        raw = {'version': 2, 'statuses': [{'id': 'start', 'kind': 'initial'},
                                          {'id': 'done', 'kind': 'done'}], 'rules': []}
        upgraded, _ = boardmodel.upgrade_config(raw)
        parsed = boardmodel.parse_config(upgraded)
        self.assertEqual(parsed['todoEntry'], [])
        self.assertIsNone(parsed['todoDefault'])

    def test_repository_board_upgrades_and_loads_without_writing(self):
        path = os.path.join(os.path.dirname(__file__), '..', '..', '.agent-studio', 'board.json')
        with open(path, encoding='utf-8') as f:
            raw = json.load(f)
        before = copy.deepcopy(raw)
        upgraded, mapping = boardmodel.upgrade_config(raw)
        parsed = boardmodel.parse_config(upgraded)
        self.assertEqual(raw, before)
        self.assertEqual(mapping, {s['id']: {'backlog': 'none', 'done': 'merged', 'close': 'closed'}.get(s['id'], s['id']) for s in raw['statuses']})
        self.assertEqual(parsed['todoDefault'], 'dev-ready')
        self.assertEqual(parsed['rulesByStatus']['plan-merge-ready']['onPassCreatedTickets']['from'], 'none')
        self.assertEqual(parsed['rulesByStatus']['merge-ready']['onPass'], 'merged')
        with tempfile.TemporaryDirectory() as workspace:
            os.mkdir(os.path.join(workspace, '.agent-studio'))
            filename = os.path.join(workspace, '.agent-studio', 'board.json')
            with open(filename, 'w', encoding='utf-8') as f:
                json.dump(raw, f)
            loaded = boardmodel.load_config(workspace)
            with open(filename, encoding='utf-8') as f:
                self.assertEqual(json.load(f), before)
        self.assertEqual(loaded['upgradedFrom'], mapping)
        self.assertEqual(loaded['version'], 3)

    def test_all_references_and_existing_during_are_rewritten(self):
        raw = {'version': 2, 'statuses': [{'id': 'start', 'kind': 'initial'}, {'id': 'ready'},
               {'id': 'active'}, {'id': 'done', 'kind': 'done'}, {'id': 'close', 'kind': 'closed'}],
               'agentTicketStatus': 'start', 'rules': [
                   {'when': {'status': 'ready'}, 'role': 'x', 'workflow': 'x', 'during': 'active',
                    'onPass': 'done', 'onFail': 'start', 'onBlocked': 'close',
                    'createdTicketStatus': 'start', 'onFailureLimit': {'count': 1, 'status': 'close'}}]}
        upgraded, _ = boardmodel.upgrade_config(raw)
        rule = upgraded['rules'][0]
        self.assertEqual([rule[k] for k in ('onPass', 'onFail', 'onBlocked', 'createdTicketStatus', 'during')],
                         ['merged', 'none', 'closed', 'none', 'active'])
        self.assertEqual(rule['onFailureLimit']['status'], 'closed')
        self.assertEqual(upgraded['agentTicketStatus'], 'none')
        self.assertEqual(upgraded['todoDefault'], 'ready')
        boardmodel.parse_config(upgraded)

    def test_generated_statuses_follow_when_and_v3_is_unchanged(self):
        raw = {'version': 2, 'statuses': [{'id': 'start', 'kind': 'initial'}, {'id': 'custom'},
               {'id': 'done', 'kind': 'done'}], 'rules': [
                   {'when': {'status': 'custom'}, 'role': 'x', 'workflow': 'x', 'onPass': 'done', 'onFail': 'start'}]}
        upgraded, _ = boardmodel.upgrade_config(raw)
        self.assertEqual([s['id'] for s in upgraded['workflowStatuses']], ['none', 'custom', 'custom-active', 'merged'])
        self.assertEqual(boardmodel.upgrade_config(upgraded), (upgraded, {}))
        self.assertEqual(boardmodel.upgrade_config(config()), (config(), {}))
        boardmodel.parse_config(upgraded)

    def test_renames_statuses_and_rewrites_all_embedded_references(self):
        raw = {'version': 2, 'statuses': [
            {'id': 'start', 'kind': 'initial'}, {'id': 'done', 'kind': 'done'},
            {'id': 'close', 'kind': 'closed'}, {'id': 'keep'}],
            'agentTicketStatus': 'start', 'rules': [
                {'when': {'status': 'start'}, 'role': 'x', 'workflow': 'x',
                 'onPass': 'done', 'onFail': 'close', 'onBlocked': 'start',
                 'onFailureLimit': {'count': 2, 'status': 'done'},
                 'createdTicketStatus': 'close',
                 'onPassCreatedTickets': {'from': 'start', 'to': 'done'}}]}
        upgraded, id_map = boardmodel.upgrade_config(raw)
        self.assertEqual(id_map, {'start': 'none', 'done': 'merged', 'close': 'closed', 'keep': 'keep'})
        rule = upgraded['rules'][0]
        self.assertEqual(rule['when']['status'], 'none')
        self.assertEqual((rule['onPass'], rule['onFail'], rule['onBlocked']),
                         ('merged', 'closed', 'none'))
        self.assertEqual(rule['onFailureLimit']['status'], 'merged')
        self.assertEqual(rule['createdTicketStatus'], 'closed')
        self.assertEqual(rule['onPassCreatedTickets'], {'from': 'none', 'to': 'merged'})
        self.assertEqual(upgraded['agentTicketStatus'], 'none')

    def test_active_status_names_and_todo_defaults_follow_rule_order(self):
        starts = ['unpack-ready', 'refine-ready', 'dev-ready', 'qa-ready',
                  'review-ready', 'need-escalate', 'merge-conflict',
                  'plan-merge-conflict', 'custom-ready']
        statuses = [{'id': 'none', 'kind': 'initial'}] + [{'id': item} for item in starts]
        rules = [{'when': {'status': item}, 'role': 'x', 'workflow': 'x',
                  'onPass': 'none', 'onFail': 'none'} for item in starts]
        raw = {'version': 2, 'statuses': statuses, 'rules': rules}
        upgraded, _ = boardmodel.upgrade_config(raw)
        generated = ['unpacking', 'refining', 'deving', 'qa-ing', 'reviewing',
                     'escalating', 'fixing-conflict', 'fixing-plan-conflict',
                     'custom-ready-active']
        self.assertEqual(upgraded['todoEntry'], starts)
        self.assertEqual(upgraded['todoDefault'], 'dev-ready')
        got = {item['id'] for item in upgraded['workflowStatuses']}
        self.assertTrue(set(generated).issubset(got))
        ids = [item['id'] for item in upgraded['workflowStatuses']]
        for start, active in zip(starts, generated):
            self.assertEqual(ids.index(active), ids.index(start) + 1)

        fallback, _ = boardmodel.upgrade_config({
            'version': 2, 'statuses': [{'id': 'none', 'kind': 'initial'}, {'id': 'custom'}],
            'rules': [{'when': {'status': 'custom'}, 'role': 'x', 'workflow': 'x',
                       'onPass': 'none', 'onFail': 'none'}]})
        self.assertEqual(fallback['todoDefault'], 'custom')

    def test_merge_actions_get_generated_during_status_and_v3_load_has_no_upgrade_marker(self):
        raw = {'version': 2, 'statuses': [{'id': 'none', 'kind': 'initial'},
                                           {'id': 'merge-ready'}, {'id': 'plan-merge-ready'},
                                           {'id': 'done', 'kind': 'done'}],
               'rules': [
                   {'when': {'status': 'merge-ready'}, 'action': 'merge',
                    'onPass': 'done', 'onFail': 'none'},
                   {'when': {'status': 'plan-merge-ready'}, 'action': 'merge',
                    'onPass': 'done', 'onFail': 'none'}]}
        upgraded, _ = boardmodel.upgrade_config(raw)
        self.assertEqual([rule['during'] for rule in upgraded['rules']], ['merging', 'plan-merging'])
        ids = [status['id'] for status in upgraded['workflowStatuses']]
        self.assertEqual(ids[ids.index('merge-ready') + 1], 'merging')
        self.assertEqual(ids[ids.index('plan-merge-ready') + 1], 'plan-merging')
        self.assertEqual(upgraded['todoEntry'], [])
        boardmodel.parse_config(upgraded)
        with tempfile.TemporaryDirectory() as workspace:
            folder = os.path.join(workspace, '.agent-studio')
            os.mkdir(folder)
            with open(os.path.join(folder, 'board.json'), 'w', encoding='utf-8') as f:
                json.dump(config(), f)
            loaded = boardmodel.load_config(workspace)
        self.assertNotIn('upgradedFrom', loaded)
