"""Ticket attention projections and per-phase counts."""
import json

from agent_studio import boardmodel
from tests.unit.test_board_waiting_input import WaitingInputCase


class TicketAttentionTests(WaitingInputCase):
    def test_approval_and_pause_fields_follow_run_and_event_lifecycle(self):
        run, assignment = self.wait()
        ticket = self.ticket("T-001")
        self.conn.execute("UPDATE workflow_runs SET status = 'running' WHERE id = ?", (run,))
        self.conn.execute("UPDATE stage_attempts SET phase = 'waiting_approval', artifacts_json = ? "
                          "WHERE workflow_run_id = ?", (json.dumps({"ask": "Publish?"}), run))
        attempt = self.conn.execute("SELECT stage, created_at FROM stage_attempts WHERE workflow_run_id = ?",
                                    (run,)).fetchone()
        expected = {"workflowRunId": run, "stage": attempt["stage"], "ask": "Publish?",
                    "since": attempt["created_at"]}
        for summary in (False, True):
            listed = boardmodel.ticket_list(self.conn, self.ws, summary=summary)["tickets"][0]
            self.assertEqual(listed["waitingApproval"], expected)
            self.assertIsNone(listed["paused"])
        self.assertEqual(boardmodel.ticket_detail(self.conn, self.ws, "T-001")["ticket"]["waitingApproval"], expected)
        boardmodel._ticket_event(self.conn, ticket["id"], "ticket.run_paused", "coordinator", None, None,
                                 {"reason": "FIRST"})
        boardmodel._ticket_event(self.conn, ticket["id"], "ticket.run_paused", "coordinator", None, None,
                                 {"reason": "SECOND"})
        event = self.conn.execute("SELECT at FROM ticket_events WHERE name = 'ticket.run_paused' ORDER BY id DESC LIMIT 1").fetchone()
        projected = boardmodel.ticket_detail(self.conn, self.ws, "T-001")["ticket"]
        expected_pause = {"reason": "SECOND", "at": event["at"]}
        self.assertEqual(projected["paused"], expected_pause)
        for summary in (False, True):
            listed = boardmodel.ticket_list(self.conn, self.ws, summary=summary)["tickets"][0]
            self.assertEqual(listed["paused"], expected_pause)
        phase = next(p for p in boardmodel.board_show(self.conn, self.ws)["phases"] if p["ticketCount"])
        self.assertEqual((phase["waitingApproval"], phase["needsInput"], phase["paused"], phase["blocked"]), (1, 1, 1, 0))
        self.conn.execute("UPDATE tickets SET workflow_status = 'blocked' WHERE id = ?", (ticket["id"],))
        boardmodel._ticket_event(self.conn, ticket["id"], "ticket.claimed", "coordinator", None, None, {})
        self.conn.execute("UPDATE stage_attempts SET status = 'completed' WHERE workflow_run_id = ?", (run,))
        projected = boardmodel.ticket_detail(self.conn, self.ws, "T-001")["ticket"]
        self.assertIsNone(projected["waitingApproval"])
        self.assertIsNone(projected["paused"])
        for summary in (False, True):
            listed = boardmodel.ticket_list(self.conn, self.ws, summary=summary)["tickets"][0]
            self.assertIsNone(listed["waitingApproval"])
            self.assertIsNone(listed["paused"])
        phase = next(p for p in boardmodel.board_show(self.conn, self.ws)["phases"] if p["ticketCount"])
        self.assertEqual((phase["waitingApproval"], phase["needsInput"], phase["paused"], phase["blocked"]), (0, 0, 0, 1))

    def test_attention_context_exposes_active_assignment_and_frozen_routes(self):
        run, assignment = self.wait()
        detail = boardmodel.ticket_detail(self.conn, self.ws, "T-001")
        context = detail["attentionContext"]
        attempt = self.conn.execute("SELECT stage FROM stage_attempts WHERE workflow_run_id = ? AND status = 'active'", (run,)).fetchone()
        definition = json.loads(self.conn.execute("SELECT definition_json FROM workflow_runs WHERE id = ?", (run,)).fetchone()[0])
        stage = next(s for s in definition["stages"] if s["id"] == attempt["stage"])
        self.assertEqual(context["assignmentId"], assignment)
        self.assertEqual(context["stage"], attempt["stage"])
        self.assertEqual(context["routes"], stage["next"])
        self.assertTrue(context["workflow"])

    def test_approval_requires_running_active_run(self):
        run, _ = self.wait()
        self.conn.execute("UPDATE stage_attempts SET phase = 'waiting_approval', artifacts_json = ? WHERE workflow_run_id = ?",
                          (json.dumps({"ask": "Approve?"}), run))
        self.assertIsNone(boardmodel.ticket_detail(self.conn, self.ws, "T-001")["ticket"]["waitingApproval"])
        self.conn.execute("UPDATE workflow_runs SET status = 'running' WHERE id = ?", (run,))
        self.conn.execute("UPDATE tickets SET active_run_id = NULL WHERE key = 'T-001'")
        self.assertIsNone(boardmodel.ticket_detail(self.conn, self.ws, "T-001")["ticket"]["waitingApproval"])
