import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from backend.agent_studio import PROTOCOL, dispatch, roles
from backend.agent_studio.protocol import AsError


class RoleMutationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ws = self.tmp.name
        self.base = Path(self.ws, '.agent-studio')
        self.base.mkdir()
        self.path = self.base / 'roles.json'
        self.doc = {'version': 1, 'extra': {'keep': 1}, 'roles': {
            'worker': {'name': 'Worker', 'instructions': 'roles/worker.md', 'directTask': {'workspace': 'main'}, 'custom': 5},
            'other': {'skills': []}}}
        self.write(self.doc)
        for name in ('board.json', 'team.json', 'workflow.json'):
            (self.base / name).write_bytes(b'reference data')

    def write(self, doc):
        self.path.write_text(json.dumps(doc), encoding='utf-8')

    def snapshot(self):
        return {str(p.relative_to(self.base)): p.read_bytes() for p in self.base.rglob('*') if p.is_file()}

    def test_create_derives_id_appends_role_and_does_not_create_instruction_path(self):
        out = roles.create_role(self.ws, {'name': ' Release Manager '})
        self.assertEqual(out['role'], {'id': 'release-manager', 'name': 'Release Manager', 'description': None, 'skills': []})
        doc = json.loads(self.path.read_text())
        self.assertEqual(list(doc['roles']), ['worker', 'other', 'release-manager'])
        self.assertEqual(doc['roles']['release-manager'], {'name': 'Release Manager', 'skills': []})
        self.assertFalse((self.base / 'roles/release-manager.md').exists())

    def test_create_with_explicit_id_preserves_top_level_and_reference_files(self):
        before = self.snapshot()
        roles.create_role(self.ws, {'id': 'custom', 'name': 'Custom'})
        self.assertEqual(json.loads(self.path.read_text())['extra'], self.doc['extra'])
        for key in ('board.json', 'team.json', 'workflow.json'):
            self.assertEqual(self.snapshot()[key], before[key])

    def test_update_name_description_and_skills_keeps_stable_id_and_unknown_fields(self):
        before = self.snapshot()
        out = roles.update_role(self.ws, 'worker', {'name': ' New ', 'description': ' Builds ', 'skills': ['one']})
        doc = json.loads(self.path.read_text())
        self.assertEqual(list(doc['roles']), ['worker', 'other'])
        self.assertEqual(doc['roles']['other'], self.doc['roles']['other'])
        self.assertEqual(doc['roles']['worker'], dict(self.doc['roles']['worker'], name='New', description='Builds', skills=['one']))
        self.assertEqual(out['role']['id'], 'worker')
        for key in ('board.json', 'team.json', 'workflow.json'):
            self.assertEqual(self.snapshot()[key], before[key])

    def test_update_null_name_and_description_removes_only_those_fields(self):
        self.doc['roles']['worker']['description'] = 'old'
        self.write(self.doc)
        out = roles.update_role(self.ws, 'worker', {'name': None, 'description': None})
        self.assertEqual(out['role']['name'], 'worker')
        spec = json.loads(self.path.read_text())['roles']['worker']
        self.assertNotIn('name', spec)
        self.assertNotIn('description', spec)
        self.assertEqual(spec['custom'], 5)

    def test_missing_skills_are_saved_in_order_and_return_warnings(self):
        skill = self.base / 'skills/present/SKILL.md'
        skill.parent.mkdir(parents=True)
        skill.write_text('skill')
        out = roles.update_role(self.ws, 'worker', {'skills': ['missing', 'present', 'absent']})
        self.assertEqual(out['role']['skills'], ['missing', 'present', 'absent'])
        self.assertEqual(out['warnings'], ["skill 'missing' not found at .agent-studio/skills/missing/SKILL.md", "skill 'absent' not found at .agent-studio/skills/absent/SKILL.md"])
        self.assertIn('skill', roles.context_for(self.ws, 'worker')['text'])

    def test_noop_returns_changed_false_without_replacing_file(self):
        before, stat = self.path.read_bytes(), self.path.stat()
        with mock.patch.object(roles.os, 'replace') as replace:
            out = roles.update_role(self.ws, 'worker', {'name': ' Worker '})
        replace.assert_not_called()
        self.assertFalse(out['changed'])
        self.assertEqual(out['sha256'], hashlib.sha256(before).hexdigest())
        self.assertEqual((self.path.read_bytes(), self.path.stat().st_ino, self.path.stat().st_mtime_ns), (before, stat.st_ino, stat.st_mtime_ns))

    def test_duplicate_legacy_name_can_be_repaired_without_rewriting_peers(self):
        self.doc['roles']['other']['name'] = ' worker '
        self.write(self.doc)
        roles.update_role(self.ws, 'worker', {'name': 'New'})
        self.assertEqual(json.loads(self.path.read_text())['roles']['other'], self.doc['roles']['other'])

    def test_unrelated_legacy_duplicate_pair_is_preserved_during_target_repair(self):
        self.doc['roles'].update({'a': {'name': 'Duplicate'}, 'b': {'name': ' duplicate '}})
        self.write(self.doc)
        roles.update_role(self.ws, 'worker', {'name': 'Unique'})
        self.assertEqual(json.loads(self.path.read_text())['roles']['a'], self.doc['roles']['a'])
        before = self.snapshot()
        with self.assertRaises(AsError):
            roles.update_role(self.ws, 'worker', {'name': 'DUPLICATE'})
        self.assertEqual(self.snapshot(), before)

    def test_invalid_create_and_update_leave_every_file_unchanged(self):
        cases = [(True, x, 'ROLES_CONFIG_INVALID') for x in [ {}, {'name': ''}, {'name': 'x'*81}, {'name':'ok','id':'BAD'}, {'name':'ok','description': ''}, {'name':'ok','description': 1}, {'name':'ok','description':'x'*2001}, {'name':'ok','skills': None}, {'name':'ok','skills':[1]}, {'name':'ok','skills':['BAD']}, {'name':'ok','skills':['a','a']}, {'id':'new','name':'other'}, {'name':'ok','extra':1}]]
        cases += [(True, {'name':'ok', 'id':'worker'}, 'ROLE_EXISTS')]
        cases += [(False, x, 'ROLES_CONFIG_INVALID') for x in [{}, {'id':'new'}, {'name':'other'}, {'skills':['a','a']}, {'description':''}]]
        for create, value, code in cases:
            with self.subTest(value=value):
                before = self.snapshot()
                with self.assertRaises(AsError) as cm:
                    (roles.create_role(self.ws, value) if create else roles.update_role(self.ws, 'worker', value))
                self.assertEqual(cm.exception.code, code)
                if code == 'ROLES_CONFIG_INVALID':
                    self.assertTrue(cm.exception.data['problems'][0]['path'])
                    self.assertTrue(cm.exception.data['problems'][0]['message'])
                self.assertEqual(self.snapshot(), before)
        with self.assertRaises(AsError) as cm:
            roles.update_role(self.ws, 'absent', {'name':'x'})
        self.assertEqual(cm.exception.code, 'ROLE_NOT_FOUND')
        for bad in (b'{', b'{"version":2}'):
            self.path.write_bytes(bad)
            before = self.snapshot()
            with self.assertRaises(AsError):
                roles.create_role(self.ws, {'name':'x'})
            self.assertEqual(self.snapshot(), before)

    def test_stale_sha_returns_current_sha_and_writes_nothing(self):
        for missing in (False, True):
            if missing:
                self.path.unlink()
            before = self.snapshot()
            with self.assertRaises(AsError) as cm:
                roles.create_role(self.ws, {'name':'new'}, '0'*64)
            self.assertEqual(cm.exception.code, 'CONFIG_CHANGED')
            self.assertEqual(cm.exception.data['sha256'], None if missing else hashlib.sha256(before['roles.json']).hexdigest())
            self.assertEqual(self.snapshot(), before)

    def test_atomic_replace_failure_cleans_temp_and_preserves_original(self):
        before = self.snapshot()
        with mock.patch.object(roles.os, 'replace', side_effect=OSError('failure')):
            with self.assertRaises(OSError):
                roles.create_role(self.ws, {'name': 'New'})
        self.assertEqual(self.snapshot(), before)

    def test_dispatch_create_canonical_update_and_legacy_update(self):
        def call(command, **args):
            return dispatch.handle_request({'protocol': PROTOCOL, 'command': command, 'args': {'workspace': self.ws, **args}}, False)
        self.assertTrue(call('role.create', role={'name':'New'})['ok'])
        self.assertTrue(call('role.update', roleId='new', changes={'name':'Renamed'})['ok'])
        result = call('role.update', role='worker', description=' Hello ')
        self.assertEqual(result['data']['role'], {'id':'worker', 'description':'Hello'})
        for args in ({'roleId':'new', 'changes':{}, 'role':'worker'}, {'roleId':'new','changes':{}}, {'role':{}, 'unexpected':1}, {'role':{}, 'expectedSha256':'bad'}):
            response = call('role.create' if 'unexpected' in args or 'expectedSha256' in args else 'role.update', **args)
            self.assertEqual(response['error']['code'], 'BAD_REQUEST')

    def test_validation_reports_specific_paths_and_collision_messages(self):
        cases = [
            (True, {'name': ' '}, 'role.name'),
            (True, {'name': 'ok', 'id': 'Bad'}, 'role.id'),
            (True, {'name': 'ok', 'description': 'x' * 2001}, 'role.description'),
            (True, {'name': 'ok', 'skills': ['a', 'a']}, 'role.skills[1]'),
            (False, {'id': 'new'}, 'changes.id'),
            (False, {'description': 42}, 'changes.description'),
            (False, {'skills': ['BAD']}, 'changes.skills[0]'),
        ]
        for create, value, path in cases:
            with self.subTest(value=value):
                before = self.snapshot()
                with self.assertRaises(AsError) as cm:
                    if create:
                        roles.create_role(self.ws, value)
                    else:
                        roles.update_role(self.ws, 'worker', value)
                self.assertEqual(cm.exception.code, 'ROLES_CONFIG_INVALID')
                self.assertEqual(cm.exception.data['problems'][0]['path'], path)
                self.assertTrue(cm.exception.data['problems'][0]['message'])
                self.assertEqual(self.snapshot(), before)
        for create in (True, False):
            with self.subTest(create=create):
                before = self.snapshot()
                with self.assertRaises(AsError) as cm:
                    if create:
                        roles.create_role(self.ws, {'id': 'new', 'name': ' OTHER '})
                    else:
                        roles.update_role(self.ws, 'worker', {'name': ' OTHER '})
                self.assertEqual(cm.exception.data['problems'], [{'path': ('role' if create else 'changes') + '.name', 'message': "display name conflicts with role 'other' (case-insensitive after trimming)"}])
                self.assertEqual(self.snapshot(), before)

    def test_saved_description_and_skill_are_used_by_later_context(self):
        skill = self.base / 'skills/example/SKILL.md'
        skill.parent.mkdir(parents=True)
        skill.write_text('example skill content', encoding='utf-8')
        roles.update_role(self.ws, 'worker', {'description': 'Updated description', 'skills': ['example']})
        context = roles.context_for(self.ws, 'worker')
        self.assertIn('Description: Updated description', context['text'])
        self.assertIn('example skill content', context['text'])
        self.assertEqual(skill.read_text(encoding='utf-8'), 'example skill content')

    def test_existing_catalog_problems_reject_create_and_update_without_writes(self):
        for spec in ({'skills': ['a', 'a']}, {'name': ''}, {'description': 'x' * 2001}, {'instructions': '../outside'}):
            for create in (True, False):
                with self.subTest(spec=spec, create=create):
                    doc = dict(self.doc, roles=dict(self.doc['roles'], broken=spec))
                    self.write(doc)
                    before = self.snapshot()
                    with self.assertRaises(AsError) as cm:
                        if create:
                            roles.create_role(self.ws, {'name': 'New'})
                        else:
                            roles.update_role(self.ws, 'worker', {'description': 'new'})
                    self.assertEqual(cm.exception.code, 'ROLES_CONFIG_INVALID')
                    self.assertEqual(self.snapshot(), before)

    def test_dispatch_rejects_bad_envelopes_before_writing(self):
        cases = [
            ('role.create', {}, "Missing required argument 'role'."),
            ('role.create', {'role': [],}, 'role must be an object.'),
            ('role.create', {'role': {}, 'extra': 1}, 'role.create got unknown argument(s): extra.'),
            ('role.update', {'roleId': 'worker', 'changes': {}, 'role': 'worker'}, 'role.update must use either {roleId, changes} or legacy {role, description}, not both.'),
            ('role.update', {'roleId': 'worker', 'changes': []}, 'changes must be a non-empty object.'),
            ('role.update', {'roleId': 'worker', 'changes': {}}, 'changes must be a non-empty object.'),
            ('role.update', {'roleId': 'worker', 'changes': {'name': 'New'}, 'expectedSha256': 'bad'}, 'expectedSha256 must be a lowercase hex sha256.'),
        ]
        for command, args, message in cases:
            with self.subTest(command=command, args=args):
                before = self.snapshot()
                response = dispatch.handle_request({'protocol': PROTOCOL, 'command': command, 'args': {'workspace': self.ws, **args}}, False)
                self.assertEqual(response['error']['code'], 'BAD_REQUEST')
                self.assertEqual(response['error']['message'], message)
                self.assertEqual(self.snapshot(), before)

    def test_legacy_mixed_case_id_remains_addressable(self):
        self.doc['roles']['TeamLead'] = {'description': 'old'}
        self.write(self.doc)
        response = dispatch.handle_request({'protocol': PROTOCOL, 'command': 'role.update', 'args': {
            'workspace': self.ws, 'role': 'TeamLead', 'description': 'new'}}, False)
        self.assertTrue(response['ok'])
        self.assertEqual(response['data']['role'], {'id': 'TeamLead', 'description': 'new'})
        self.assertIn('TeamLead', json.loads(self.path.read_text())['roles'])

    def test_create_missing_catalog_returns_canonical_result(self):
        self.path.unlink()
        result = roles.create_role(self.ws, {'name': ' New Role ', 'description': None, 'skills': []})
        data = self.path.read_bytes()
        self.assertEqual(json.loads(data), {'version': 1, 'roles': {'new-role': {'name': 'New Role', 'skills': []}}})
        self.assertEqual(result, {'workspace': self.ws, 'file': 'roles.json', 'sha256': hashlib.sha256(data).hexdigest(),
                                  'role': {'id': 'new-role', 'name': 'New Role', 'description': None, 'skills': []},
                                  'changed': True, 'warnings': []})

    def test_stale_update_reports_exact_error_without_writes(self):
        before = self.snapshot()
        with self.assertRaises(AsError) as cm:
            roles.update_role(self.ws, 'worker', {'name': 'New'}, '0' * 64)
        self.assertEqual(cm.exception.code, 'CONFIG_CHANGED')
        self.assertEqual(cm.exception.message, '.agent-studio/roles.json changed since it was read; reload and retry.')
        self.assertEqual(cm.exception.data, {'sha256': hashlib.sha256(before['roles.json']).hexdigest()})
        self.assertEqual(self.snapshot(), before)
