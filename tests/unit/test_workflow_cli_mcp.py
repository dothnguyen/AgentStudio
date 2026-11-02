"""Workflow status commands are exposed consistently to CLI and MCP clients."""
from unittest import mock

from tests.unit.test_p04_s07_board_model import BoardCase, CliTests
from agent_studio import boardcli, mcpserver
from tests.unit.test_p06_mcp_operator import OP, call


class WorkflowCliTests(BoardCase):
    run_cli = CliTests.run_cli
    def test_move_workflow_option_and_workflow_command(self):
        requests = []
        def reply(req):
            requests.append(req)
            return {"ok": True, "data": {"from": "ready", "ticket": {
                "key": "T-001", "status": "in-progress", "workflowStatus": "working"}}}
        for args in (("move", "T-001", "--to", "in-progress", "--workflow", "working", "--force", "--reason", "why"),
                     ("workflow", "T-001", "working", "--reason", "why")):
            rc, out, err = self.run_cli(reply, "ticket", *args, "--workspace", self.ws)
            self.assertEqual((rc, err), (0, ""))
            self.assertIn("T-001:", out)
        self.assertIn("ready -> in-progress", self.run_cli(
            reply, "ticket", "move", "T-001", "--to", "in-progress", "--workspace", self.ws)[1])
        self.assertIn("ready -> working", self.run_cli(
            reply, "ticket", "workflow", "T-001", "working", "--workspace", self.ws)[1])
        self.assertEqual(requests[0]["args"]["workflowStatus"], "working")
        self.assertTrue(requests[0]["args"]["force"])
        self.assertEqual(requests[1]["command"], "ticket.workflow")
        self.assertEqual(requests[1]["args"]["to"], "working")
        self.assertEqual(requests[1]["args"]["reason"], "why")

    def test_move_accepts_workflow_status_alias(self):
        seen = []
        def reply(req):
            seen.append(req)
            return {"ok": True, "data": {"ticket": {"key": "T-001", "status": "todo",
                                                        "workflowStatus": "ready"}}}
        rc, _, err = self.run_cli(reply, "ticket", "move", "T-001", "--to", "todo",
                                  "--workflow-status", "ready", "--workspace", self.ws)
        self.assertEqual((rc, err), (0, ""))
        self.assertEqual(seen[0]["args"]["workflowStatus"], "ready")

    def test_list_filter_and_text(self):
        data = {"tickets": [{"key": "T-001", "priority": 1, "status": "todo", "workflowStatus": "ready",
                             "phase": "default", "title": "One"}], "status": None, "phase": None}
        seen = []
        def reply(req):
            seen.append(req)
            return {"ok": True, "data": data}
        rc, out, err = self.run_cli(reply, "ticket", "list", "--workspace", self.ws, "--workflow-status", "ready")
        self.assertEqual((rc, err), (0, ""))
        self.assertIn("[todo/ready]", out)
        self.assertEqual(seen[0]["args"]["workflowStatus"], "ready")

    def test_board_breakdown_groups_workflow_by_column(self):
        phase = {"slug": "p", "name": "P", "status": "open", "ticketCount": 2,
                 "columns": {"todo": 1, "in-progress": 1}, "columnWorkflow": {
                     "todo": {"ready": 1}, "in-progress": {"ready": 1}}}
        out = boardcli._render_board({"workspace": self.ws, "currentPhase": {"name": "P"}, "phases": [phase]})
        self.assertIn("todo (1): ready (1)", out)
        self.assertIn("in-progress (1): ready (1)", out)


class WorkflowMcpTests(BoardCase):
    def test_schemas_and_calls(self):
        tools = {t['name']: t for t in mcpserver.operator_tools(True)}
        self.assertIn('workflowStatus', tools['ticket_move']['inputSchema']['properties'])
        self.assertIn('workflowStatus', tools['ticket_list']['inputSchema']['properties'])
        self.assertEqual(tools['ticket_workflow']['inputSchema']['required'], ['key', 'to'])
        self.assertIn("column", tools['ticket_move']['description'])
        self.assertIn("workflow status", tools['ticket_workflow']['description'])
        self.assertNotIn('ticket_workflow', {t['name'] for t in mcpserver.operator_tools(False)})
        seen = []
        def fake(req, require_id=False):
            seen.append(req)
            return {"ok": True, "data": {"ticket": {"key": "T-1", "status": "todo", "workflowStatus": "ready"}}}
        with mock.patch.object(mcpserver.dispatch, 'handle_request', fake), mock.patch.object(
                mcpserver.wsmod, 'resolve', return_value={'path': '/w'}):
            op = dict(OP, allowWrites=True)
            self.assertFalse(call('ticket_workflow', {'key': 'T-1', 'to': 'ready', 'reason': 'why'}, op)['isError'])
            self.assertFalse(call('ticket_move', {'key': 'T-1', 'to': 'todo', 'workflowStatus': 'ready'}, op)['isError'])
        self.assertEqual(seen[0]['command'], 'ticket.workflow')
        self.assertEqual(seen[0]['args']['reason'], 'why')
        self.assertEqual(seen[1]['args']['workflowStatus'], 'ready')
        self.assertTrue(call('ticket_workflow', {'key': 'T-1', 'to': 'ready'})['isError'])

    def test_list_filter_and_compact_board_in_both_modes(self):
        phase = {'slug': 'p', 'current': True, 'columns': {'todo': 1},
                 'workflow': {'ready': 1}, 'columnWorkflow': {'todo': {'ready': 1}}}
        seen = []
        def fake(req, require_id=False):
            seen.append(req)
            if req['command'] == 'ticket.list':
                return {'ok': True, 'data': {'tickets': [{'key': 'T-1', 'status': 'todo',
                    'workflowStatus': 'ready', 'phase': 'p', 'title': 'One'}]}}
            return {'ok': True, 'data': {'currentPhase': {'name': 'P'}, 'phases': [phase]}}
        with mock.patch.object(mcpserver.dispatch, 'handle_request', fake), mock.patch.object(
                mcpserver.wsmod, 'resolve', return_value={'path': '/w'}):
            result = call('ticket_list', {'status': 'todo', 'workflowStatus': 'ready'})
            self.assertIn('[todo/ready]', result['content'][0]['text'])
            self.assertEqual(seen[-1]['args']['workflowStatus'], 'ready')
            board = call('board_show')
            self.assertEqual(board['phases'][0]['columnWorkflow'], {'todo': {'ready': 1}})
            self.assertNotIn('tickets', board['phases'][0])
            assignment = mcpserver._tool_call('board_show', {}, 'assignment', 'agent', '/w', 1)
            self.assertEqual(assignment['phases'][0]['columns'], {'todo': 1})
            assignment_list = mcpserver._tool_call('ticket_list', {'workflowStatus': 'ready'},
                                                   'assignment', 'agent', '/w', 1)
            self.assertIn('[todo/ready]', assignment_list['content'][0]['text'])
            self.assertEqual(seen[-1]['args']['workflowStatus'], 'ready')

    def test_workflow_requires_target_and_write_access(self):
        with mock.patch.object(mcpserver.dispatch, 'handle_request') as dispatch_call, mock.patch.object(
                mcpserver.wsmod, 'resolve', return_value={'path': '/w'}):
            missing = call('ticket_workflow', {'key': 'T-1'}, dict(OP, allowWrites=True))
            forbidden = call('ticket_workflow', {'key': 'T-1', 'to': 'ready'})
        self.assertTrue(missing['isError'])
        self.assertEqual(missing['code'], 'BAD_REQUEST')
        self.assertEqual(forbidden['code'], 'FORBIDDEN')
        dispatch_call.assert_not_called()
