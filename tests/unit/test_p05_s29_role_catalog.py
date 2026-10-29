import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from backend.agent_studio import PROTOCOL, dispatch, rolecatalog, roles


class RoleCatalogTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ws = self.tmp.name
        self.base = os.path.join(self.ws, '.agent-studio')
        os.mkdir(self.base)

    def write(self, path, data):
        path = os.path.join(self.base, path)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'wb') as f:
            f.write(data)

    def catalog(self, specs):
        self.write('roles.json', json.dumps({'version': 1, 'roles': specs}).encode())
        return rolecatalog.list_roles(self.ws)

    def test_missing_and_empty_catalog(self):
        self.assertEqual(rolecatalog.list_roles(self.ws)['state'], 'missing')
        result = self.catalog({})
        data = Path(self.base, 'roles.json').read_bytes()
        self.assertEqual((result['state'], result['items'], result['problems']), ('ok', [], []))
        self.assertEqual((result['sha256'], result['bytes']), (hashlib.sha256(data).hexdigest(), len(data)))

    def test_projects_file_order_names_descriptions_and_available_skills(self):
        self.write('skills/z/SKILL.md', b'z')
        self.write('skills/a/SKILL.md', b'a')
        self.write('skills/Bad/SKILL.md', b'x')
        self.write('skills/no/other', b'x')
        os.symlink(os.path.join(self.base, 'skills/a'), os.path.join(self.base, 'skills/link'))
        self.write('roles/first.md', b'not implicitly selected')
        result = self.catalog({'first': {'description': 'x' * 2001}, 'second': {'name': ' Second '}})
        self.assertEqual(result['availableSkills'], ['a', 'z'])
        self.assertEqual(result['items'][0]['instructions']['state'], 'none')
        self.assertEqual([(i['id'], i['name']) for i in result['items']], [('first', 'first'), ('second', 'Second')])
        self.assertEqual(len(result['items'][0]['description']), 2000)
        self.assertEqual(result['items'][0]['problems'][0]['code'], 'description_too_long')

    def test_instruction_ok_missing_truncated_and_invalid_utf8_states(self):
        payloads = {'ok': b'hello', 'large': ('é' * 9000).encode(), 'bad': b'hello\xff'}
        for name, data in payloads.items():
            self.write('roles/' + name, data)
        result = self.catalog({n: {'instructions': 'roles/' + n} for n in ['ok', 'absent', 'large', 'bad']})
        instructions = [i['instructions'] for i in result['items']]
        self.assertEqual([i['state'] for i in instructions], ['ok', 'missing', 'truncated', 'invalid'])
        self.assertEqual(instructions[0]['text'], 'hello')
        self.assertLessEqual(len(instructions[2]['text'].encode()), roles.LIMITS['instructions'])
        self.assertIsNone(instructions[3]['text'])
        for item, name in zip([instructions[0], instructions[2], instructions[3]], ['ok', 'large', 'bad']):
            self.assertEqual((item['sha256'], item['bytes']), (hashlib.sha256(payloads[name]).hexdigest(), len(payloads[name])))

    def test_instruction_paths_and_symlinks_do_not_escape(self):
        outside = os.path.join(self.ws, 'secret')
        with open(outside, 'w') as f:
            f.write('secret content')
        os.symlink(outside, os.path.join(self.base, 'escape'))
        os.mkdir(os.path.join(self.base, 'directory'))
        self.write('unreadable', b'contents')
        real_open = os.open
        def fail(path, flags, *args, **kwargs):
            if path.endswith('unreadable'):
                raise PermissionError()
            return real_open(path, flags, *args, **kwargs)
        with mock.patch('backend.agent_studio.rolecatalog.os.open', side_effect=fail):
            result = self.catalog({str(i): {'instructions': p} for i, p in enumerate([outside, '../secret', 'escape', 'directory', 'unreadable', 'bad\x00path'])})
        self.assertTrue(all(i['instructions']['state'] == 'invalid' for i in result['items']))
        self.assertNotIn(outside, json.dumps(result))
        self.assertNotIn('secret content', json.dumps(result))

    def test_replaced_paths_cannot_escape_after_resolution(self):
        outside = Path(self.ws, 'secret')
        outside.write_text('outside secret')
        self.write('roles/safe', b'safe')
        self.write('roles.json', json.dumps({'version': 1, 'roles': {
            'worker': {'instructions': 'roles/safe'}}}).encode())
        original = rolecatalog._inside

        for target in ('roles.json', 'roles/safe'):
            with self.subTest(target=target):
                path = Path(self.base, target)
                saved = path.read_bytes()
                def swap(base, value):
                    resolved = original(base, value)
                    if value == target and not path.is_symlink():
                        path.unlink()
                        path.symlink_to(outside)
                    return resolved
                try:
                    with mock.patch.object(rolecatalog, '_inside', side_effect=swap), \
                         mock.patch.object(roles, 'context_for', return_value={'warnings': []}):
                        result = rolecatalog.list_roles(self.ws)
                    self.assertNotIn('outside secret', json.dumps(result))
                    self.assertNotIn(str(outside), json.dumps(result))
                    if target == 'roles.json':
                        self.assertEqual(result['state'], 'invalid')
                    else:
                        self.assertEqual(result['items'][0]['instructions']['state'], 'invalid')
                finally:
                    path.unlink()
                    path.write_bytes(saved)

    @unittest.skipUnless(hasattr(os, 'mkfifo'), 'requires FIFO support')
    def test_warning_resolution_rejects_replaced_files(self):
        outside = Path(self.ws, 'secret')
        outside.write_bytes(b'outside secret')
        for target in ('roles/safe', 'skills/safe/SKILL.md'):
            for replacement in ('fifo', 'symlink'):
                with self.subTest(target=target, replacement=replacement):
                    self.write(target, b'original')
                    self.write('roles.json', json.dumps({'version': 1, 'roles': {'worker': {
                        'instructions': 'roles/safe' if target.startswith('roles/') else '',
                        'skills': ['safe'] if target.startswith('skills/') else []}}}).encode())
                    path = Path(self.base, target)
                    original = rolecatalog._resolver_read
                    def replace(base, resolved, limit):
                        path.unlink()
                        if replacement == 'fifo':
                            os.mkfifo(path)
                        else:
                            path.symlink_to(outside)
                        return original(base, resolved, limit)
                    try:
                        with mock.patch.object(rolecatalog, '_resolver_read', side_effect=replace):
                            result = rolecatalog.list_roles(self.ws)
                        self.assertNotIn('outside secret', json.dumps(result))
                        self.assertNotIn(str(outside), json.dumps(result))
                        self.assertTrue(result['items'][0]['warnings'])
                    finally:
                        path.unlink()

    def test_ordered_skill_states_and_resolution_warnings(self):
        for name in ['a', 'b', 'c', 'd']:
            self.write('skills/' + name + '/SKILL.md', b'x' * roles.LIMITS['skill'])
        result = self.catalog({'worker': {'skills': ['b', 'missing', 'a', 'c', 'd']}})
        item = result['items'][0]
        self.assertEqual([s['id'] for s in item['skills']], ['b', 'missing', 'a', 'c', 'd'])
        self.assertEqual([s['state'] for s in item['skills']], ['ok', 'missing', 'ok', 'ok', 'ok'])
        self.assertEqual(item['warnings'], roles.context_for(self.ws, 'worker')['warnings'])
        self.assertTrue(any('exceed' in w for w in item['warnings']))

    def test_name_fallback_invalid_and_duplicate_problems(self):
        result = self.catalog({'one': {'name': 'Same'}, 'two': {'name': ' same '}, 'fallback': {},
                               'other': {'name': 'FALLBACK'}, 'bad': {'name': ''}, 'long': {'name': 'x' * 81}})
        self.assertEqual([i['name'] for i in result['items']], ['Same', 'same', 'fallback', 'FALLBACK', 'bad', 'long'])
        self.assertEqual([p['roleId'] for p in result['problems']], ['one', 'two', 'fallback', 'other'])
        self.assertIn("role 'two'", result['problems'][0]['message'])
        self.assertEqual([i['problems'][0]['code'] for i in result['items'][-2:]], ['invalid_name', 'invalid_name'])

    def test_invalid_root_is_unavailable_but_role_problems_are_inspectable(self):
        for raw in [b'\xff', b'{', b'[]', b'{"version":2,"roles":{}}', b'{"version":1,"roles":[]}']:
            with self.subTest(raw=raw):
                self.write('roles.json', raw)
                result = rolecatalog.list_roles(self.ws)
                self.assertEqual((result['state'], result['items'], result['bytes']), ('invalid', [], len(raw)))
                self.assertEqual(result['sha256'], hashlib.sha256(raw).hexdigest())
                self.assertTrue(result['problems'])
                self.assertTrue(all(p['path'] == 'roles.json' and p['roleId'] is None
                                    for p in result['problems']))
                self.assertEqual(Path(self.base, 'roles.json').read_bytes(), raw)
        result = self.catalog({'broken': 1, 'fields': {'description': 1, 'instructions': 3, 'skills': ['../x', 'a', 'a']}})
        self.assertEqual(result['state'], 'problems')
        self.assertEqual([i['id'] for i in result['items']], ['broken', 'fields'])
        self.assertGreaterEqual(len(result['items'][1]['problems']), 4)

    def test_exact_instruction_and_description_limits_are_not_truncated(self):
        data = b'x' * roles.LIMITS['instructions']
        description = 'd' * roles.LIMITS['description']
        self.write('roles/exact.md', data)
        result = self.catalog({'exact': {'instructions': 'roles/exact.md', 'description': description},
                               'empty': {'instructions': ''}})
        self.assertEqual(result['state'], 'ok')
        exact, empty = result['items']
        self.assertEqual(exact['description'], description)
        self.assertEqual(exact['instructions'], {
            'path': 'roles/exact.md', 'state': 'ok', 'text': data.decode(),
            'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)})
        self.assertEqual(exact['problems'], [])
        self.assertEqual(empty['instructions'], {
            'path': None, 'state': 'none', 'text': None, 'sha256': None, 'bytes': None})

    def test_deeply_nested_invalid_json_returns_raw_token(self):
        raw = b'[' * 2000 + b']' * 2000 + b'x'
        self.write('roles.json', raw)
        response = dispatch.handle_request(
            {'protocol': PROTOCOL, 'id': 'r', 'command': 'role.list', 'args': {'workspace': self.ws}}, True)
        self.assertTrue(response['ok'])
        result = response['data']
        self.assertEqual((result['state'], result['items']), ('invalid', []))
        self.assertEqual((result['sha256'], result['bytes']), (hashlib.sha256(raw).hexdigest(), len(raw)))
        self.assertEqual(result['problems'][0]['path'], 'roles.json')

    def test_catalog_symlink_escape_is_rejected_without_reading_target(self):
        outside = Path(self.ws, 'outside.json')
        outside.write_text(json.dumps({'version': 1, 'roles': {'x': {'description': 'outside secret'}}}))
        os.symlink(outside, Path(self.base, 'roles.json'))
        with mock.patch('builtins.open', side_effect=AssertionError('outside catalog read')):
            result = rolecatalog.list_roles(self.ws)
        self.assertEqual((result['state'], result['items'], result['sha256'], result['bytes']),
                         ('invalid', [], None, None))
        self.assertTrue(result['problems'])
        self.assertNotIn(str(outside), json.dumps(result))
        self.assertNotIn('outside secret', json.dumps(result))

    @unittest.skipUnless(hasattr(os, 'mkfifo'), 'requires FIFO support')
    def test_non_regular_catalog_is_invalid_without_blocking(self):
        catalog = Path(self.base, 'roles.json')
        for make in (os.mkfifo, os.mkdir):
            with self.subTest(kind=make.__name__):
                make(catalog)
                response = dispatch.handle_request(
                    {'protocol': PROTOCOL, 'id': 'r', 'command': 'role.list', 'args': {'workspace': self.ws}}, True)
                self.assertTrue(response['ok'])
                result = response['data']
                self.assertEqual((result['state'], result['items'], result['sha256'], result['bytes']),
                                 ('invalid', [], None, None))
                self.assertEqual([(p['path'], p['roleId'], p['code']) for p in result['problems']],
                                 [('roles.json', None, 'catalog_unreadable')])
                self.assertNotIn(self.ws, json.dumps(result['problems']))
                (catalog.rmdir if catalog.is_dir() else catalog.unlink)()

    def test_catalog_snapshot_is_used_for_validation_and_warnings(self):
        original = json.dumps({'version': 1, 'roles': {'worker': {'skills': []}}}).encode()
        changed = json.dumps({'version': 1, 'roles': {'worker': {'skills': ['missing']}}}).encode()
        self.write('roles.json', original)
        real_load = roles.load_config
        calls = []

        def change_then_load(workspace):
            calls.append(True)
            self.write('roles.json', changed)
            return real_load(workspace)

        with mock.patch.object(roles, 'load_config', side_effect=change_then_load):
            result = rolecatalog.list_roles(self.ws)
        self.assertGreaterEqual(len(calls), 2)
        self.assertEqual(result['sha256'], hashlib.sha256(original).hexdigest())
        self.assertEqual(result['items'][0]['skills'], [])
        self.assertEqual(result['items'][0]['warnings'], [])
        self.assertEqual(roles.load_config(self.ws)['roles']['worker']['skills'], ['missing'])

    def test_catalog_snapshot_keeps_original_missing_skill_warning_during_change(self):
        original = json.dumps({'version': 1, 'roles': {'worker': {'skills': ['missing']}}}).encode()
        changed = json.dumps({'version': 1, 'roles': {'worker': {'skills': []}}}).encode()
        self.write('roles.json', original)
        expected_warnings = roles.context_for(self.ws, 'worker')['warnings']
        real_load = roles.load_config

        def change_then_load(workspace):
            self.write('roles.json', changed)
            return real_load(workspace)

        with mock.patch.object(roles, 'load_config', side_effect=change_then_load):
            result = rolecatalog.list_roles(self.ws)
        self.assertEqual(result['sha256'], hashlib.sha256(original).hexdigest())
        self.assertEqual(result['items'][0]['skills'], [{'id': 'missing', 'state': 'missing'}])
        self.assertEqual(result['items'][0]['warnings'], expected_warnings)

    def test_configured_skills_require_confined_regular_files(self):
        self.write('skills/good/SKILL.md', b'good')
        outside = Path(self.ws, 'outside-skill')
        outside.write_bytes(b'outside secret')
        os.mkdir(Path(self.base, 'skills', 'escape'))
        os.symlink(outside, Path(self.base, 'skills', 'escape', 'SKILL.md'))
        os.mkdir(Path(self.base, 'skills', 'directory'))
        os.mkdir(Path(self.base, 'skills', 'directory', 'SKILL.md'))
        result = self.catalog({'worker': {'skills': ['escape', 'good', 'directory']}})
        item = result['items'][0]
        self.assertEqual(item['skills'], [{'id': 'escape', 'state': 'missing'},
                                         {'id': 'good', 'state': 'ok'},
                                         {'id': 'directory', 'state': 'missing'}])
        self.assertEqual(result['availableSkills'], ['good'])
        self.assertNotIn(str(outside), json.dumps(result))
        self.assertNotIn('outside secret', json.dumps(result))

    def test_role_list_dispatch_contract(self):
        def call(**args):
            return dispatch.handle_request({'protocol': PROTOCOL, 'id': 'r', 'command': 'role.list', 'args': args}, True)
        result = call(workspace=self.ws + '/.')
        self.assertEqual(result['data']['workspace'], os.path.realpath(self.ws))
        self.assertEqual(call()['error']['message'], "Missing required argument 'workspace'.")
        self.assertEqual(call(workspace=self.ws, z=1, a=1)['error']['message'], 'role.list got unknown argument(s): a, z.')
        error = call(workspace=os.path.dirname(self.ws))['error']
        self.assertEqual(error['code'], 'WORKSPACE_NOT_FOUND')

    def test_listing_is_read_only_and_context_is_unchanged(self):
        self.write('roles/worker.md', b'instructions')
        self.write('skills/a/SKILL.md', b'skill')
        self.catalog({'worker': {'description': 'work', 'instructions': 'roles/worker.md', 'skills': ['a', 'missing']}})
        def snapshot():
            return {os.path.relpath(os.path.join(root, f), self.ws): Path(root, f).read_bytes()
                    for root, dirs, files in os.walk(self.ws) for f in files}
        before, context = snapshot(), roles.context_for(self.ws, 'worker')
        self.catalog({'worker': {'name': 'Worker', 'description': 'work', 'instructions': 'roles/worker.md', 'skills': ['a', 'missing']}})
        self.assertEqual(context, roles.context_for(self.ws, 'worker'))
        self.catalog({'worker': {'description': 'work', 'instructions': 'roles/worker.md', 'skills': ['a', 'missing']}})
        entries = sorted(str(p.relative_to(self.ws)) for p in Path(self.ws).rglob('*'))
        one = rolecatalog.list_roles(self.ws)
        self.assertEqual(one, rolecatalog.list_roles(self.ws))
        request = {'protocol': PROTOCOL, 'id': 'r', 'command': 'role.list',
                   'args': {'workspace': self.ws}}
        for _ in range(2):
            response = dispatch.handle_request(request, True)
            self.assertTrue(response['ok'])
            self.assertEqual(response['data'], dict(one, workspace=os.path.realpath(self.ws)))
        self.assertEqual(before, snapshot())
        self.assertEqual(entries, sorted(str(p.relative_to(self.ws)) for p in Path(self.ws).rglob('*')))
        self.assertEqual(context, roles.context_for(self.ws, 'worker'))

    def test_missing_catalog_still_discovers_only_safe_immediate_skills(self):
        self.write('skills/good/SKILL.md', b'private skill contents')
        self.write('skills/outer/nested/SKILL.md', b'nested')
        self.write('skills/Upper/SKILL.md', b'invalid id')
        os.mkdir(os.path.join(self.base, 'skills', 'directory'))
        os.mkdir(os.path.join(self.base, 'skills', 'directory', 'SKILL.md'))
        outside = Path(self.ws, 'outside')
        outside.mkdir()
        (outside / 'SKILL.md').write_bytes(b'outside secret')
        os.symlink(outside, Path(self.base, 'skills', 'linked'))
        os.mkdir(Path(self.base, 'skills', 'escaped'))
        os.symlink(outside / 'SKILL.md', Path(self.base, 'skills', 'escaped', 'SKILL.md'))
        result = rolecatalog.list_roles(self.ws)
        self.assertEqual(result, {'state': 'missing', 'sha256': None, 'bytes': None,
                                  'items': [], 'problems': [], 'availableSkills': ['good']})
        self.assertNotIn('private skill contents', json.dumps(result))
        self.assertNotIn(str(outside), json.dumps(result))

    def test_skill_discovery_does_not_read_skill_contents(self):
        self.write('skills/a/SKILL.md', b'private skill contents')
        self.write('skills/z/SKILL.md', b'other contents')
        real_open = os.open

        def check_open(path, flags, *args, **kwargs):
            self.assertFalse(str(path).endswith('SKILL.md'), 'skill content read')
            return real_open(path, flags, *args, **kwargs)

        with mock.patch('builtins.open', side_effect=AssertionError('skill content read')), \
             mock.patch('backend.agent_studio.rolecatalog.os.open', side_effect=check_open):
            result = rolecatalog.list_roles(self.ws)
        self.assertEqual(result['availableSkills'], ['a', 'z'])
        self.assertNotIn('private skill contents', json.dumps(result))

    def test_skill_disappearing_during_directory_scan_is_safe(self):
        self.write('skills/vanishing/SKILL.md', b'content')
        self.write('roles.json', b'{"version":1,"roles":{}}')
        real_exists = rolecatalog._skill_exists

        def disappear(base, skill):
            Path(base, 'skills', skill, 'SKILL.md').unlink()
            return real_exists(base, skill)

        with mock.patch.object(rolecatalog, '_skill_exists', side_effect=disappear):
            result = rolecatalog.list_roles(self.ws)
        self.assertEqual(result['state'], 'ok')
        self.assertEqual(result['availableSkills'], [])
        self.assertNotIn(self.ws, json.dumps(result))

    def test_invalid_utf8_after_instruction_limit_is_not_replacement_decoded(self):
        data = b'a' * (roles.LIMITS['instructions'] + 5) + b'\xff'
        self.write('roles/late', data)
        item = self.catalog({'worker': {'instructions': 'roles/late'}})['items'][0]
        self.assertEqual(item['instructions'], {'path': 'roles/late', 'state': 'invalid',
                         'text': None, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)})
        self.assertTrue(item['warnings'])

    def test_truncation_preserves_complete_utf8_characters_and_full_token(self):
        limit = roles.LIMITS['instructions']
        data = b'a' * (limit - 1) + '€tail'.encode('utf-8')
        self.write('roles/multibyte', data)
        item = self.catalog({'worker': {'instructions': 'roles/multibyte'}})['items'][0]
        self.assertEqual(item['instructions'], {
            'path': 'roles/multibyte', 'state': 'truncated', 'text': 'a' * (limit - 1),
            'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)})
        self.assertTrue(any('truncated' in warning for warning in item['warnings']))

    def test_configured_role_does_not_use_conventional_path_but_absent_role_does(self):
        self.write('roles/worker.md', b'conventional instructions')
        self.write('roles/other.md', b'fallback instructions')
        result = self.catalog({'worker': {}})
        self.assertEqual(result['items'][0]['instructions'], {
            'path': None, 'state': 'none', 'text': None, 'sha256': None, 'bytes': None})
        self.assertNotIn('conventional instructions', roles.context_for(self.ws, 'worker')['text'])
        before = roles.context_for(self.ws, 'other')
        self.assertIn('fallback instructions', before['text'])
        rolecatalog.list_roles(self.ws)
        self.assertEqual(roles.context_for(self.ws, 'other'), before)

    def test_unreadable_skills_directory_is_empty_without_leaking_path(self):
        self.write('skills/visible/SKILL.md', b'content')
        with mock.patch('backend.agent_studio.rolecatalog.os.scandir', side_effect=PermissionError(self.base)):
            result = rolecatalog.list_roles(self.ws)
        self.assertEqual(result['availableSkills'], [])
        self.assertNotIn(self.base, json.dumps(result))

    def test_repairable_fields_are_reported_without_resolving_invalid_catalog(self):
        specs = {'broken': None, 'worker': {'name': 42, 'description': 9,
                 'instructions': 3, 'skills': ['../unsafe', 'missing', 'missing'],
                 'directTask': {'workspace': 'worktree'}, 'unknown': 'secret'}}
        self.write('roles.json', json.dumps({'version': 1, 'roles': specs}).encode())
        before = Path(self.base, 'roles.json').read_bytes()
        with mock.patch.object(roles, 'context_for', side_effect=AssertionError('invalid config resolved')):
            result = rolecatalog.list_roles(self.ws)
        self.assertEqual(result['state'], 'problems')
        broken, worker = result['items']
        self.assertEqual([broken['id'], worker['id']], ['broken', 'worker'])
        self.assertEqual(broken['problems'][0]['code'], 'invalid_role')
        self.assertEqual(worker['name'], 'worker')
        self.assertIsNone(worker['description'])
        self.assertEqual(worker['instructions']['state'], 'invalid')
        self.assertEqual(worker['skills'], [{'id': 'missing', 'state': 'missing'}] * 2)
        self.assertEqual({p['code'] for p in worker['problems']},
                         {'invalid_name', 'invalid_description', 'instructions_invalid', 'invalid_skill', 'duplicate_skill'})
        self.assertNotIn('../unsafe', json.dumps(result))
        self.assertNotIn('secret', json.dumps(result))
        self.assertEqual(before, Path(self.base, 'roles.json').read_bytes())

    def test_three_way_casefold_collision_reports_first_other_in_file_order(self):
        result = self.catalog({'first': {'name': 'Straße'}, 'second': {'name': 'STRASSE'},
                               'strasse': {}})
        self.assertEqual(result['state'], 'problems')
        self.assertEqual(result['problems'], [
            {'path': 'roles.first.name', 'roleId': 'first', 'code': 'duplicate_name',
             'message': "Display name 'Straße' is also used by role 'second' (case-insensitive)."},
            {'path': 'roles.second.name', 'roleId': 'second', 'code': 'duplicate_name',
             'message': "Display name 'STRASSE' is also used by role 'first' (case-insensitive)."},
            {'path': 'roles.strasse.name', 'roleId': 'strasse', 'code': 'duplicate_name',
             'message': "Display name 'strasse' is also used by role 'first' (case-insensitive)."}])
        self.assertEqual(roles.context_for(self.ws, 'first')['role'], 'first')

    def test_disappearing_instruction_and_skill_are_safe(self):
        self.write('roles/vanishing', b'content')
        self.write('skills/vanishing/SKILL.md', b'content')
        self.write('roles.json', json.dumps({'version': 1, 'roles': {'worker': {
            'instructions': 'roles/vanishing', 'skills': ['vanishing']}}}).encode())
        real_open = os.open
        def vanish(path, flags, *args, **kwargs):
            if path.endswith('vanishing'):
                raise FileNotFoundError(path)
            return real_open(path, flags, *args, **kwargs)
        with mock.patch.object(roles, 'context_for', side_effect=FileNotFoundError()), \
             mock.patch('backend.agent_studio.rolecatalog.os.open', side_effect=vanish), \
             mock.patch('backend.agent_studio.rolecatalog._skill_exists', return_value=False):
            result = rolecatalog.list_roles(self.ws)
        self.assertIn(result['items'][0]['instructions']['state'], ('missing', 'invalid'))
        self.assertEqual(result['items'][0]['skills'], [{'id': 'vanishing', 'state': 'missing'}])
        self.assertNotIn(self.ws, json.dumps(result))

    def test_dispatch_errors_and_exact_projection_shape(self):
        self.write('roles.json', b'{"version":1,"roles":{"worker":{"unknown":"hidden"}}}')
        def call(args):
            return dispatch.handle_request({'protocol': PROTOCOL, 'id': 'r', 'command': 'role.list', 'args': args}, True)
        data = call({'workspace': self.ws + '/.'})['data']
        self.assertEqual(set(data), {'state', 'sha256', 'bytes', 'items', 'problems', 'availableSkills', 'workspace'})
        self.assertEqual(set(data['items'][0]), {'id', 'name', 'description', 'instructions', 'skills', 'warnings', 'problems'})
        self.assertEqual(set(data['items'][0]['instructions']), {'path', 'state', 'text', 'sha256', 'bytes'})
        for args, code, message in [
            ({}, 'BAD_REQUEST', "Missing required argument 'workspace'."),
            ({'workspace': self.ws, 'z': 1, 'a': 1}, 'BAD_REQUEST', 'role.list got unknown argument(s): a, z.'),
            ({'workspace': os.path.dirname(self.ws)}, 'WORKSPACE_NOT_FOUND',
             f'{os.path.realpath(os.path.dirname(self.ws))} is not an Agent Studio workspace (no .agent-studio directory).')]:
            error = call(args)['error']
            self.assertEqual((error['code'], error['message']), (code, message))


if __name__ == '__main__':
    unittest.main()
