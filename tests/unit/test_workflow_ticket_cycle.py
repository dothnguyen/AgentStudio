"""Exercise the upgraded repository board through scheduler ticks with fake runs."""
import json
import os
import shutil
import subprocess
from unittest.mock import patch

from tests import helpers  # noqa: F401
from agent_studio import boardmodel, boardsched
from agent_studio.protocol import AsError
from tests.unit.test_p04_s10_scheduler import SchedCase


class TicketCycle(SchedCase):
    def setUp(self):
        super().setUp()
        source = os.path.join(os.path.dirname(__file__), '..', '..', '.agent-studio', 'board.json')
        with open(source, encoding='utf-8') as f:
            config = json.load(f)
        self.assertEqual(config['version'], 3)
        config['baseBranch'] = subprocess.check_output(
            ['git', '-C', self.ws, 'symbolic-ref', '--short', 'HEAD'], text=True).strip()
        self.write_board(config)
        self.addCleanup(shutil.rmtree, self.ctx['stateDir'], True)
        with self.store.transaction() as tx:
            for ordinal, role in enumerate(('Developer', 'QA', 'Reviewer', 'SeniorDeveloper'), 1):
                agent = tx.create('agent', {'team_id': self.team, 'ordinal': ordinal, 'provider_id': 'fake',
                                            'role': role, 'display_name': role, 'pane_state': 'alive'})
                tx.transition('agent', agent, 'idle')
        self.start_patch = patch.object(boardsched, '_start', side_effect=self.fake_start)
        self.start_patch.start()
        self.addCleanup(self.start_patch.stop)

    def fake_start(self, tx, args, ctx):
        task = tx.create('task', {'team_id': self.team, 'origin': 'workflow', 'workspace': self.ws, 'goal': 'test'})
        tx.transition('task', task, 'assigned')
        tx.transition('task', task, 'running')
        run = tx.create('workflow_run', {'team_id': self.team, 'task_id': task, 'workflow': args['definition']})
        tx.transition('workflow_run', run, 'running')
        return {'workflowRunId': run}

    def pair(self, key, column, workflow):
        row = self.ticket(key)
        self.assertEqual((row['status'], row['workflow_status']), (column, workflow))
        return row

    def run_tick(self, running=True):
        self.conn.execute('UPDATE board_state SET run_status = ? WHERE workspace = ?',
                          ('running' if running else 'stopped', self.ws))
        result = self.tick()
        self.assertEqual(result['errors'], [])
        return result

    def new_ticket(self):
        with self.store.transaction() as tx:
            return boardmodel.ticket_add(tx, self.ws, {'title': 'cycle', 'priority': 100})['ticket']['key']

    def move_to(self, key, column, **kwargs):
        with self.store.transaction() as tx:
            return boardmodel.ticket_move(tx, self.ws, {'key': key, 'to': column, **kwargs})

    def claim(self, key, during):
        self.assertEqual(self.run_tick()['claimed'], 1)
        row = self.pair(key, 'in-progress', during)
        self.assertIsNotNone(row['assignee'])
        self.assertIsNotNone(row['active_run_id'])

    def complete(self, key, status, expected):
        self.finish(self.ticket(key)['active_run_id'], status)
        self.assertEqual(self.run_tick(running=False)['applied'], 1)
        self.pair(key, 'in-progress', expected)

    def test_first_tick_backfills_legacy_tickets(self):
        cases = [('backlog', 'backlog', 'none'), ('dev-ready', 'todo', 'dev-ready'),
                 ('qa-ready', 'in-progress', 'qa-ready'), ('blocked', 'in-progress', 'blocked'),
                 ('done', 'done', 'merged'), ('close', 'closed', 'closed')]
        for old, _, _ in cases:
            key = self.new_ticket()
            self.conn.execute('UPDATE tickets SET status = ?, workflow_status = NULL WHERE key = ?', (old, key))
            if old == 'qa-ready':
                row = self.ticket(key)
                boardmodel._ticket_event(self.conn, row['id'], 'ticket.claimed', 'coordinator', None, None, {})
        self.run_tick(running=False)
        for index, (_, column, workflow) in enumerate(cases, 1):
            self.pair(f'T-{index:03}', column, workflow)

    def test_happy_path_merge_backlog_and_force_reopen(self):
        key = self.new_ticket()
        self.pair(key, 'backlog', 'none')
        self.move_to(key, 'todo')
        self.pair(key, 'todo', 'dev-ready')
        self.claim(key, 'deving')
        self.complete(key, 'succeeded', 'qa-ready')
        self.claim(key, 'qa-ing')
        self.complete(key, 'succeeded', 'review-ready')
        self.claim(key, 'reviewing')
        with patch.object(boardsched, '_run_merge_actions', return_value=0):
            self.complete(key, 'succeeded', 'merge-ready')
        self.run_tick(running=False)
        self.pair(key, 'done', 'merged')
        events = self.conn.execute("SELECT to_status FROM ticket_events WHERE ticket_id = ? AND name = 'ticket.workflow_changed'", (self.ticket(key)['id'],)).fetchall()
        self.assertIn('merging', [row[0] for row in events])
        self.move_to(key, 'backlog', force=True)
        self.pair(key, 'backlog', 'none')
        self.move_to(key, 'closed')
        self.pair(key, 'closed', 'closed')
        with self.assertRaises(AsError):
            self.move_to(key, 'backlog')
        self.move_to(key, 'backlog', force=True)
        self.pair(key, 'backlog', 'none')

    def test_qa_failures_escalate_and_backlog_resets(self):
        key = self.new_ticket()
        self.move_to(key, 'todo')
        for attempt in range(3):
            self.claim(key, 'deving')
            self.complete(key, 'succeeded', 'qa-ready')
            self.claim(key, 'qa-ing')
            self.complete(key, 'failed', 'need-escalate' if attempt == 2 else 'dev-ready')
        self.move_to(key, 'backlog')
        self.pair(key, 'backlog', 'none')

    def test_round_limit_blocks_and_unblock_restores_queue(self):
        key = self.new_ticket()
        self.move_to(key, 'todo')
        for attempt in range(6):
            self.claim(key, 'deving')
            self.complete(key, 'failed', 'blocked' if attempt == 5 else 'dev-ready')
        row = self.ticket(key)
        self.assertEqual((row['return_status'], row['blocked_reason']), ('dev-ready', 'ROUND_LIMIT:dev-ready'))
        with self.store.transaction() as tx:
            boardmodel.ticket_unblock(tx, self.ws, {'key': key})
        self.pair(key, 'in-progress', 'dev-ready')
