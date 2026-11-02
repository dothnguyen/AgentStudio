"""Column and workflow projections for board reads."""
from tests.unit.test_p04_s07_board_model import BoardCase
from tests.unit.test_board_config_v3 import config
from agent_studio import boardmodel, boardsettings, dispatch
from agent_studio.protocol import AsError


class WorkflowReadTests(BoardCase):
    def test_filters_counts_and_ticket_shapes(self):
        self.write_config(config())
        a = self.add('first')
        b = self.add('second')
        self.conn.execute('UPDATE tickets SET status = ?, workflow_status = ? WHERE id = ?', ('todo', 'ready', b['id']))
        listed = boardmodel.ticket_list(self.conn, self.ws, status='todo', workflow_status='ready')
        self.assertEqual([(t['key'], t['status'], t['workflowStatus']) for t in listed['tickets']], [(b['key'], 'todo', 'ready')])
        self.assertEqual([t['key'] for t in boardmodel.ticket_list(self.conn, self.ws, status='todo')['tickets']], [b['key']])
        self.assertEqual([t['key'] for t in boardmodel.ticket_list(self.conn, self.ws, workflow_status='backlog')['tickets']], [a['key']])
        self.assertEqual((listed['status'], listed['workflowStatus']), ('todo', 'ready'))
        self.assertEqual(boardmodel.ticket_list(self.conn, self.ws, status='backlog', workflow_status='ready')['tickets'], [])
        for kwargs in ({'status': 'ready'}, {'workflow_status': 'missing'}):
            with self.assertRaises(AsError):
                boardmodel.ticket_list(self.conn, self.ws, **kwargs)
        self.assertEqual(dispatch._validate_ticket_list({'workspace': self.ws, 'workflowStatus': 'ready'})['workflowStatus'], 'ready')
        phase = boardmodel.phase_list(self.conn, self.ws)['phases'][0]
        self.assertEqual(phase['counts'], {'backlog': 1, 'todo': 1, 'in-progress': 0, 'done': 0, 'closed': 0})
        detail = boardmodel.phase_detail(self.conn, self.ws, 'default')
        self.assertEqual(detail['phase']['counts'], phase['counts'])
        self.assertEqual({t['workflowStatus'] for t in detail['tickets']}, {'backlog', 'ready'})
        shown = boardmodel.ticket_detail(self.conn, self.ws, a['key'])
        self.assertEqual(shown['ticket']['workflowStatus'], 'backlog')
        board = boardmodel.board_show(self.conn, self.ws)['phases'][0]
        self.assertEqual(board['columns'], {'backlog': 1, 'todo': 1, 'in-progress': 0, 'done': 0, 'closed': 0})
        self.assertEqual(board['workflow'], {
            'backlog': 1, 'ready': 1, 'working': 0, 'merge-ready': 0,
            'merging': 0, 'done': 0, 'closed': 0,
        })
        self.assertEqual(board['columnWorkflow']['todo'], {'ready': 1})
        self.assertEqual(board['columnWorkflow']['backlog'], {'backlog': 1})
        self.assertNotIn('tickets', board)

    def test_settings_exposes_workflow_fields_and_during(self):
        self.write_config(config())
        settings = boardsettings.settings(self.conn, self.ws, False, None)
        self.assertEqual(settings['workflowStatuses'], settings['statuses'])
        self.assertEqual(settings['todoEntry'], ['ready'])
        self.assertEqual(settings['todoDefault'], 'ready')
        self.assertEqual([r['during'] for r in settings['rules']], ['working', 'merging'])
