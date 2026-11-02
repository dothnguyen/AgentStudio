"""Claim release and unblock preserve workflow and board column semantics."""
import json
from unittest.mock import patch

from tests.unit.test_p04_s07_board_model import BoardCase
from tests.unit.test_board_config_v3 import config
from agent_studio import boardmodel, boardsched
from agent_studio.protocol import AsError


class WorkflowClaimReleaseTests(BoardCase):
    def setUp(self):
        super().setUp()
        cfg = config()
        cfg['workflowStatuses'][1]['id'] = 'dev-ready'
        cfg['workflowStatuses'][2]['id'] = 'deving'
        cfg['rules'][0].update(when={'status': 'dev-ready'}, during='deving', onFail='dev-ready')
        cfg['rules'][1]['onFail'] = 'dev-ready'
        cfg.update(todoEntry=['dev-ready'], todoDefault='dev-ready')
        self.write_config(cfg)
        self.ticket = self.add()

    def row(self):
        return boardmodel.get_ticket(self.conn, self.ws, self.ticket['key'])

    def prepare_claim(self):
        self.conn.execute("UPDATE tickets SET status = 'in-progress', workflow_status = 'deving', "
                          "assignee = 'worker', lease_until = '2000-01-01T00:00:00Z' WHERE id = ?",
                          (self.ticket['id'],))

    def assert_workflow_event(self, source, target, reason):
        event = [e for e in self.events(self.ticket['key']) if e['name'] == 'ticket.workflow_changed'][-1]
        self.assertEqual((event['from_status'], event['to_status']), (source, target))
        self.assertEqual(json.loads(event['payload_json'])['reason'], reason)

    def test_unblock_returns_to_recorded_or_explicit_workflow_status(self):
        for explicit, target in ((None, 'dev-ready'), ('merge-ready', 'merge-ready')):
            with self.subTest(target=target):
                self.conn.execute("UPDATE tickets SET status = 'in-progress', workflow_status = 'blocked', "
                                  "return_status = 'dev-ready', blocked_reason = 'reason', rounds_json = '{}' "
                                  "WHERE id = ?", (self.ticket['id'],))
                with self.store.transaction() as tx:
                    args = {'key': self.ticket['key']}
                    if explicit:
                        args['to'] = explicit
                    result = boardmodel.ticket_unblock(tx, self.ws, args)['ticket']
                self.assertEqual((result['workflowStatus'], result['status']), (target, 'in-progress'))
                row = self.row()
                self.assertEqual((row['return_status'], row['blocked_reason'], row['rounds_json']),
                                 (None, None, None))
                self.assert_workflow_event('blocked', target, 'unblock')

    def test_unblock_rejects_invalid_target_without_clearing_block(self):
        self.conn.execute("UPDATE tickets SET status = 'in-progress', workflow_status = 'blocked', "
                          "return_status = 'dev-ready', blocked_reason = 'reason' WHERE id = ?", (self.ticket['id'],))
        with self.assertRaises(AsError):
            with self.store.transaction() as tx:
                boardmodel.ticket_unblock(tx, self.ws, {'key': self.ticket['key'], 'to': 'unknown'})
        self.assertEqual((self.row()['workflow_status'], self.row()['blocked_reason']), ('blocked', 'reason'))

    def test_release_claim_to_status_applies_workflow_transition(self):
        self.prepare_claim()
        with self.store.transaction() as tx:
            boardmodel.release_claim(tx, self.row(), 'start_failed:test', to_status='dev-ready')
        row = self.row()
        self.assertEqual((row['workflow_status'], row['status'], row['assignee']),
                         ('dev-ready', 'in-progress', None))
        self.assert_workflow_event('deving', 'dev-ready', 'start_failed:test')

    def test_retry_returns_during_status_to_rule_queue(self):
        self.prepare_claim()
        with self.store.transaction() as tx:
            result = boardsched.ticket_retry(tx, self.ws, {'key': self.ticket['key']}, {})['ticket']
        self.assertEqual((result['workflowStatus'], result['status']), ('dev-ready', 'in-progress'))
        self.assertIsNone(self.row()['assignee'])
        self.assert_workflow_event('deving', 'dev-ready', 'operator_retry')

    def test_lease_recovery_returns_during_status_once(self):
        self.prepare_claim()
        with patch.object(boardsched.worktrees, 'list_registered', return_value=[]):
            with self.store.transaction() as tx:
                result = boardsched._recover(tx, self.ws, {'stateDir': '/unused'})
            with self.store.transaction() as tx:
                again = boardsched._recover(tx, self.ws, {'stateDir': '/unused'})
        self.assertEqual((result['released'], again['released']), (1, 0))
        row = self.row()
        self.assertEqual((row['workflow_status'], row['status'], row['assignee'], row['lease_until']),
                         ('dev-ready', 'in-progress', None, None))
        self.assert_workflow_event('deving', 'dev-ready', 'lease_expired')

    def test_release_without_matching_rule_keeps_workflow_status(self):
        self.prepare_claim()
        self.conn.execute("UPDATE tickets SET workflow_status = 'merge-ready' WHERE id = ?", (self.ticket['id'],))
        # Remove the matching rule to exercise the fallback for a parked status.
        cfg = config()
        cfg['rules'] = cfg['rules'][:1]
        self.write_config(cfg)
        with self.store.transaction() as tx:
            boardsched._release_with_run(tx, self.ws, self.row(), 'test')
        self.assertEqual((self.row()['workflow_status'], self.row()['status']), ('merge-ready', 'in-progress'))
