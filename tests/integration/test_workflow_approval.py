"""Operator decisions on workflow approval stages."""
import uuid

from tests.helpers import key, req
from tests.integration.test_p01_s04_start import StartCase, fake


class Approval(StartCase):
    def setUp(self):
        super().setUp()
        self.write_def("approval", {"version": 2, "role": "Developer", "steps": [
            {"id": "ask", "approval": {"ask": "Publish?"}, "onPass": "end-pass", "onFail": "repair"},
            {"id": "repair", "agent": {"prompt": "repair.md", "access": "read"}}]})
        import os
        folder = os.path.join(self.ws, ".agent-studio", "workflows", "prompts")
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, "repair.md"), "w") as f:
            f.write("Findings: {{findings}}")
        self.commit("approval workflow")

    def decide(self, wf, stage="ask", approve=True, note=None, idem=None):
        args = {"workflowRunId": wf, "stage": stage, "approve": approve}
        if note is not None:
            args["note"] = note
        return self.sb.request(req("workflow.approve", args, idempotencyKey=idem or key()))[1]

    def test_wait_approve_and_idempotent_replay(self):
        wf = self.start("approval", debugStageOptions={"repair": fake("verdict_pass")})["data"]["workflowRunId"]
        detail = self.show(wf)
        self.assertEqual(detail["waitingApproval"]["stage"], "ask")
        self.assertEqual(detail["waitingApproval"]["ask"], "Publish?")
        self.assertTrue(detail["waitingApproval"]["since"])
        self.assertEqual(detail["stageAttempts"][0]["phase"], "waiting_approval")
        self.assertIsNone(detail["stageAttempts"][0]["assignmentId"])
        self.assertEqual(detail["assignments"], [])
        idem = key()
        first = self.decide(wf, idem=idem)
        self.assertTrue(first["ok"], first)
        self.assertEqual(self.decide(wf, idem=idem), first)
        self.assertEqual(self.wait(wf)["workflowRun"]["status"], "succeeded")
        self.assertEqual(self.decide(wf)["error"]["code"], "WORKFLOW_NOT_WAITING")

    def test_reject_routes_note_to_next_agent(self):
        wf = self.start("approval", debugStageOptions={"repair": fake("verdict_pass")})["data"]["workflowRunId"]
        result = self.decide(wf, approve=False, note="Needs edits")
        self.assertTrue(result["ok"], result)
        detail = self.wait(wf)
        self.assertEqual(detail["stageAttempts"][0]["verdict"]["findings"], ["Needs edits"])
        with open(detail["stageAttempts"][1]["promptPath"]) as f:
            self.assertIn("Needs edits", f.read())

    def test_approve_routes_to_pass_and_records_note_as_finding(self):
        wf = self.start("approval", debugStageOptions={"repair": fake("verdict_pass")})["data"]["workflowRunId"]
        result = self.decide(wf, approve=True, note="Approved for publishing")
        self.assertTrue(result["ok"], result)
        detail = self.wait(wf)
        self.assertEqual(detail["stageAttempts"][0]["verdict"]["findings"], ["Approved for publishing"])
        self.assertEqual(detail["workflowRun"]["status"], "succeeded")

    def test_wrong_stage_missing_run_and_cancel(self):
        wf = self.start("approval")["data"]["workflowRunId"]
        self.assertEqual(self.decide(wf, stage="other")["error"]["code"], "WORKFLOW_WRONG_STAGE")
        self.assertEqual(self.decide(str(uuid.uuid4()))["error"]["code"], "NOT_FOUND")
        self.cancel(wf)
        self.assertEqual(self.show(wf)["workflowRun"]["status"], "cancelled")
        self.assertEqual(self.decide(wf)["error"]["code"], "WORKFLOW_NOT_WAITING")
