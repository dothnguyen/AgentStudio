import contextlib
import io
import json
import os
import tempfile
import unittest

from backend.agent_studio import PROTOCOL, boardmodel, cli, dispatch
from tests.unit.test_board_config_v3 import config


class BoardUpgradeCommandTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.workspace = self.tmp.name
        self.folder = os.path.join(self.workspace, '.agent-studio')
        os.mkdir(self.folder)
        self.path = os.path.join(self.folder, 'board.json')
        self.raw = {'version': 2, 'statuses': [
            {'id': 'backlog', 'kind': 'initial'}, {'id': 'done', 'kind': 'done'}], 'rules': []}
        self.original = json.dumps(self.raw).encode()
        with open(self.path, 'wb') as f:
            f.write(self.original)

    def call(self, **args):
        return dispatch.handle_request({'protocol': PROTOCOL, 'command': 'board.upgrade',
                                        'args': {'workspace': self.workspace, **args}}, require_id=False)

    def test_upgrade_writes_backup_and_persisted_mapping(self):
        response = self.call()
        self.assertTrue(response['ok'], response)
        result = response['data']
        self.assertTrue(result['upgraded'])
        with open(result['backup'], 'rb') as f:
            self.assertEqual(f.read(), self.original)
        with open(self.path, encoding='utf-8') as f:
            written = json.load(f)
        with open(self.path, encoding='utf-8') as f:
            persisted_text = f.read()
        self.assertEqual(written['version'], 3)
        self.assertEqual(written['upgradedFrom'], result['idMap'])
        self.assertEqual(persisted_text, json.dumps(written, indent=2, ensure_ascii=False) + '\n')
        self.assertRegex(os.path.basename(result['backup']), r'^board-\d{8}T\d{12}Z\.json$')
        self.assertEqual(boardmodel.load_config(self.workspace)['upgradedFrom'], result['idMap'])
        self.assertEqual(self.call()['data'], {'upgraded': False})

    def test_dry_run_does_not_write(self):
        result = self.call(dryRun=True)['data']
        self.assertTrue(result['upgraded'])
        self.assertEqual(result['idMap']['backlog'], 'none')
        self.assertIsNone(result['backup'])
        with open(self.path, 'rb') as f:
            self.assertEqual(f.read(), self.original)
        self.assertFalse(os.path.exists(os.path.join(self.folder, 'backups')))

    def test_v3_is_unchanged_and_invalid_dry_run_rejected(self):
        with open(self.path, 'w', encoding='utf-8') as f:
            json.dump(config(), f)
        with open(self.path, 'rb') as f:
            before = f.read()
        self.assertEqual(self.call()['data'], {'upgraded': False})
        self.assertFalse(self.call(dryRun='yes')['ok'])
        with open(self.path, 'rb') as f:
            self.assertEqual(f.read(), before)

    def test_cli_prints_mapping_for_dry_run(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            rc = cli.main(['board', 'upgrade', '--workspace', self.workspace, '--dry-run'])
        self.assertEqual(rc, 0)
        self.assertIn('backlog -> none', output.getvalue())
        self.assertFalse(os.path.exists(os.path.join(self.folder, 'backups')))

    def test_cli_persists_upgrade_and_prints_mapping(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            rc = cli.main(['board', 'upgrade', '--workspace', self.workspace])
        self.assertEqual(rc, 0)
        self.assertIn('backlog -> none', output.getvalue())
        with open(self.path, encoding='utf-8') as f:
            self.assertEqual(json.load(f)['version'], 3)
        self.assertEqual(len(os.listdir(os.path.join(self.folder, 'backups'))), 1)
