import contextlib
import io
import json
import os
import tempfile
import shutil
from pathlib import Path
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
        self.assertTrue(self.call()['data']['upgraded'])
        self.assertEqual(self.call()['data'], {'upgraded': False})

    def test_dry_run_does_not_write(self):
        result = self.call(dryRun=True)['data']
        self.assertTrue(result['upgraded'])
        self.assertEqual(result['idMap']['backlog'], 'none')
        self.assertIsNone(result['backup'])
        with open(self.path, 'rb') as f:
            self.assertEqual(f.read(), self.original)
        self.assertFalse(os.path.exists(os.path.join(self.folder, 'backups')))

    def test_v4_is_unchanged_and_invalid_dry_run_rejected(self):
        with open(self.path, 'w', encoding='utf-8') as f:
            raw = config()
            raw["version"] = 4
            raw.pop("rules")
            json.dump(raw, f)
        with open(self.path, 'rb') as f:
            before = f.read()
        self.assertEqual(self.call()['data'], {'upgraded': False})
        self.assertFalse(self.call(dryRun='yes')['ok'])
        with open(self.path, 'rb') as f:
            self.assertEqual(f.read(), before)

    def test_repository_board_upgrade_backups_names_and_idempotence(self):
        source = Path(__file__).resolve().parents[2] / '.agent-studio'
        shutil.copytree(source, self.folder, dirs_exist_ok=True, ignore=shutil.ignore_patterns('backups'))
        before = {p.name: p.read_bytes() for p in (Path(self.folder) / 'workflows').glob('board-*')}
        board_before = Path(self.path).read_bytes()
        dry = self.call(dryRun=True)
        self.assertTrue(dry['ok'], dry)
        self.assertEqual(len(dry['data']['files']), 11)
        self.assertEqual(set(dry['data']['files']), {
            '.agent-studio/workflows/merge-merge-ready.json',
            '.agent-studio/workflows/merge-plan-merge-ready.json',
            '.agent-studio/workflows/board-resolve-merge.yaml',
            '.agent-studio/workflows/board-resolve-merge-plan-merge-conflict.json',
            '.agent-studio/workflows/board-review.yaml',
            '.agent-studio/workflows/board-qa.yaml',
            '.agent-studio/workflows/board-senior-develop.yaml',
            '.agent-studio/workflows/board-develop.yaml',
            '.agent-studio/workflows/board-refine.yaml',
            '.agent-studio/workflows/board-unpack.yaml',
            '.agent-studio/board.json',
        })
        self.assertEqual(Path(self.path).read_bytes(), board_before)
        self.assertEqual(before, {p.name: p.read_bytes() for p in (Path(self.folder) / 'workflows').glob('board-*')})
        self.assertFalse((Path(self.folder) / 'backups').exists())
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(cli.main(['board', 'upgrade', '--workspace', self.workspace, '--dry-run']), 0)
        self.assertIn('.agent-studio/workflows/merge-merge-ready.json', output.getvalue())
        result = self.call()
        self.assertTrue(result['ok'], result)
        data = result['data']
        self.assertEqual(data['files'], dry['data']['files'])
        self.assertIn('.agent-studio/workflows/board-resolve-merge-plan-merge-conflict.json', data['files'])
        self.assertIn('.agent-studio/workflows/merge-merge-ready.json', data['files'])
        self.assertEqual(Path(data['backup']).read_bytes(), board_before)
        for name, content in before.items():
            self.assertIn(content, [Path(p).read_bytes() for p in data['backups']])
        overwritten_backup = next(Path(p) for p in data['backups']
                                  if Path(p).name.startswith('board-resolve-merge.yaml-'))
        self.assertEqual(overwritten_backup.read_bytes(), before['board-resolve-merge.yaml'])
        develop = (Path(self.folder) / 'workflows' / 'board-develop.yaml').read_text()
        self.assertIn('workflows/prompts/board-develop.md', develop)
        self.assertNotIn('You are the developer', develop)
        board = json.loads(Path(self.path).read_text())
        self.assertEqual(board['version'], 4)
        self.assertNotIn('rules', board)
        self.assertEqual(boardmodel.load_config(self.workspace)['todoEntry'], board['todoEntry'])
        self.assertEqual(self.call()['data'], {'upgraded': False})

    def test_unsupported_action_leaves_files_untouched(self):
        raw = config()
        raw['rules'][1]['action'] = 'unknown'
        Path(self.path).write_text(json.dumps(raw))
        before = Path(self.path).read_bytes()
        result = self.call()
        self.assertFalse(result['ok'])
        self.assertEqual(Path(self.path).read_bytes(), before)
        self.assertFalse((Path(self.folder) / 'backups').exists())

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
