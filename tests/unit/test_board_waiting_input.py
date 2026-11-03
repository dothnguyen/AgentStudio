"""Board workflows (T-204): a run waiting for input keeps its claim and resumes with the answer."""
import contextlib
import io
import json
import os
import unittest
import uuid
from types import SimpleNamespace
from unittest import mock
from unittest.mock import patch

from tests.unit.test_p04_s10_scheduler import SchedCase
from agent_studio import boardmodel, dispatch, needsinput, prompts, resolve, workflow
from agent_studio.protocol import AsError

# A v3 board keeps the status id "done", so a passing run ends the ticket at workflow_status "done" rather than
# the legacy "merged" alias that upgrade_config gives a v2 board's done column.
DONE_BOARD = {"version": 3,
              "workflowStatuses": [{"id": "none", "kind": "initial"}, {"id": "build"}, {"id": "in-progress"},
                                   {"id": "done", "kind": "done"}],
              "todoEntry": ["build"], "todoDefault": "build", "ticketFields": [],
              "rules": [{"when": {"status": "build"}, "role": "worker", "workflow": "solo",
                         "onPass": "done", "onFail": "build", "during": "in-progress"}]}


class WaitingInputCase(SchedCase):
    def wait(self, session="sess-1", items=("Which database?",)):
        """Claim a ticket, report the assignment as waiting for input, and advance it to paused."""
        self.add_ticket()
        self.tick()
        run = self.ticket("T-001")["active_run_id"]
        row = self.conn.execute(
            "SELECT assignment_id FROM stage_attempts WHERE workflow_run_id = ? AND status = 'active'",
            (run,)).fetchone()
        assignment = row["assignment_id"]
        with self.store.transaction() as tx:
            result = {"diagnosticCode": "INPUT_REQUIRED", "providerSessionId": session,
                      "attention": {"kind": "input_required", "items": list(items)}, "summary": "asked"}
            for step in ("claimed", "running"):
                tx.transition("assignment", assignment, step)
            tx.transition("assignment", assignment, "waiting_input",
                          set_values={"diagnostic_code": "INPUT_REQUIRED", "result_json": result})
        self.assertEqual(workflow.advance(self.store, self.ctx), 1)
        self.assertEqual(self.conn.execute("SELECT status FROM workflow_runs WHERE id = ?", (run,)).fetchone()[0],
                         "paused")
        return run, assignment

    def answer(self, assignment, text="Postgres", **extra):
        with self.store.transaction() as tx:
            return resolve.resolve(tx, {"assignmentId": assignment, "action": "retry", "answer": text, **extra},
                                   self.ctx)

    def new_attempt(self, assignment):
        return self.conn.execute(
            "SELECT s.prompt_path, s.visit, a.request_json FROM stage_attempts s JOIN assignments a "
            "ON a.id = s.assignment_id WHERE a.id = ?", (assignment,)).fetchone()

    def test_waiting_run_keeps_claim_status_and_counts_nothing(self):
        run, assignment = self.wait()
        self.conn.execute("UPDATE tickets SET lease_until = '2000-01-01T00:00:00.000Z' WHERE key = 'T-001'")
        self.conn.commit()
        tick = self.tick()
        self.assertEqual((tick["errors"], tick["applied"]), ([], 0))
        ticket = self.ticket("T-001")
        self.assertEqual((ticket["active_run_id"], ticket["assignee"], ticket["workflow_status"]),
                         (run, self.worker, "in-progress"))
        self.assertIsNone(ticket["rounds_json"])
        names = [r[0] for r in self.conn.execute("SELECT name FROM ticket_events ORDER BY id").fetchall()]
        self.assertNotIn("ticket.lease_expired", names)
        self.assertNotIn("ticket.claim_released", names)

    def test_ticket_json_list_summary_and_board_show_report_needs_input(self):
        run, assignment = self.wait()
        since = self.conn.execute("SELECT updated_at FROM assignments WHERE id = ?", (assignment,)).fetchone()[0]
        fresh = self.add_ticket("fresh")
        tickets = boardmodel.ticket_list(self.conn, self.ws, summary=True)["tickets"]
        by_key = {t["key"]: t for t in tickets}
        self.assertEqual(by_key["T-001"]["needsInput"], {"question": "Which database?", "since": since})
        self.assertIsNone(by_key[fresh["key"]]["needsInput"])
        full_tickets = boardmodel.ticket_list(self.conn, self.ws)["tickets"]
        self.assertEqual({t["key"]: t for t in full_tickets}["T-001"]["needsInput"],
                         {"question": "Which database?", "since": since})
        phases = boardmodel.board_show(self.conn, self.ws)["phases"]
        self.assertEqual([p["needsInput"] for p in phases].count(1), 1)
        self.assertTrue(all(p["needsInput"] == 0 for p in phases if p["needsInput"] != 1))

    def test_answer_resumes_same_session_when_provider_can(self):
        run, assignment = self.wait()
        before = self.conn.execute("SELECT step_count FROM workflow_runs WHERE id = ?", (run,)).fetchone()[0]
        with patch.dict(os.environ, {"AGENT_STUDIO_FAKE_RESUME": "1"}):
            out = self.answer(assignment)
        self.assertEqual((out["status"], out["resumedSession"], out["stage"]), ("answered", True, "work"))
        self.assertEqual(self.conn.execute("SELECT status FROM workflow_runs WHERE id = ?", (run,)).fetchone()[0],
                         "running")
        new = out["newAssignmentId"]
        attempt = self.new_attempt(new)
        request = json.loads(attempt["request_json"])
        self.assertEqual(request["resumeSessionId"], "sess-1")
        self.assertTrue(request["fallbackPromptFile"])
        with open(attempt["prompt_path"], encoding="utf-8") as f:
            self.assertEqual(f.read(), prompts.answer_message("Which database?", "Postgres"))
        self.assertEqual(attempt["visit"], 1)
        self.assertEqual(self.conn.execute("SELECT step_count FROM workflow_runs WHERE id = ?", (run,)).fetchone()[0],
                         before)
        self.assertEqual(self.ticket("T-001")["active_run_id"], run)
        self.assertIsNone(boardmodel.ticket_needs_input(self.conn, self.ticket("T-001")))
        names = [r[0] for r in self.conn.execute("SELECT name FROM ticket_events ORDER BY id").fetchall()]
        self.assertIn("ticket.input_answered", names)

    def test_answer_without_resume_appends_question_and_answer(self):
        run, assignment = self.wait()
        old = self.conn.execute("SELECT prompt_path FROM stage_attempts WHERE assignment_id = ?",
                                (assignment,)).fetchone()[0]
        with open(old, encoding="utf-8") as f:
            original = f.read()
        with patch.dict(os.environ, {"AGENT_STUDIO_FAKE_RESUME": "0"}):
            out = self.answer(assignment)
        self.assertFalse(out["resumedSession"])
        attempt = self.new_attempt(out["newAssignmentId"])
        request = json.loads(attempt["request_json"])
        self.assertNotIn("resumeSessionId", request)
        with open(attempt["prompt_path"], encoding="utf-8") as f:
            prompt = f.read()
        self.assertTrue(prompt.startswith(original))
        self.assertIn("===== QUESTION =====\nWhich database?", prompt)
        self.assertIn("===== ANSWER =====\nPostgres", prompt)

    def test_answer_does_not_resume_without_session_id(self):
        run, assignment = self.wait(session=None)
        with patch.dict(os.environ, {"AGENT_STUDIO_FAKE_RESUME": "1"}):
            out = self.answer(assignment)
        self.assertFalse(out["resumedSession"])
        request = json.loads(self.new_attempt(out["newAssignmentId"])["request_json"])
        self.assertNotIn("resumeSessionId", request)

    def test_answer_does_not_resume_when_assignment_provider_differs(self):
        run, assignment = self.wait()
        self.conn.execute("UPDATE assignments SET provider_id = 'codex' WHERE id = ?", (assignment,))
        self.conn.commit()
        with patch.dict(os.environ, {"AGENT_STUDIO_FAKE_RESUME": "1"}):
            out = self.answer(assignment)
        self.assertFalse(out["resumedSession"])
        request = json.loads(self.new_attempt(out["newAssignmentId"])["request_json"])
        self.assertNotIn("resumeSessionId", request)

    def test_answer_with_non_object_result_still_re_dispatches(self):
        run, assignment = self.wait()
        self.conn.execute("UPDATE assignments SET result_json = '[1]' WHERE id = ?", (assignment,))
        self.conn.commit()
        with patch.dict(os.environ, {"AGENT_STUDIO_FAKE_RESUME": "1"}):
            out = self.answer(assignment)
        self.assertEqual((out["status"], out["resumedSession"]), ("answered", False))
        attempt = self.new_attempt(out["newAssignmentId"])
        self.assertNotIn("resumeSessionId", json.loads(attempt["request_json"]))
        with open(attempt["prompt_path"], encoding="utf-8") as f:
            prompt = f.read()
        self.assertIn("===== QUESTION =====\n" + needsinput.DEFAULT_QUESTION, prompt)

    def test_answer_with_unparseable_result_uses_default_question(self):
        run, assignment = self.wait()
        self.conn.execute("UPDATE assignments SET result_json = 'not json' WHERE id = ?", (assignment,))
        self.conn.commit()
        with patch.dict(os.environ, {"AGENT_STUDIO_FAKE_RESUME": "1"}):
            out = self.answer(assignment)
        self.assertEqual((out["status"], out["resumedSession"]), ("answered", False))
        attempt = self.new_attempt(out["newAssignmentId"])
        self.assertNotIn("resumeSessionId", json.loads(attempt["request_json"]))
        with open(attempt["prompt_path"], encoding="utf-8") as f:
            prompt = f.read()
        self.assertIn("===== QUESTION =====\n" + needsinput.DEFAULT_QUESTION, prompt)

    def test_answered_run_counts_one_round(self):
        self.write_board(DONE_BOARD)
        run, assignment = self.wait()
        before = self.conn.execute("SELECT step_count FROM workflow_runs WHERE id = ?", (run,)).fetchone()[0]
        with patch.dict(os.environ, {"AGENT_STUDIO_FAKE_RESUME": "0"}):
            out = self.answer(assignment)
        self.free_member()
        workflow.advance(self.store, self.ctx)
        tick = self.tick()
        self.assertEqual(tick["errors"], [])
        ticket = self.ticket("T-001")
        self.assertEqual(ticket["workflow_status"], "done")
        self.assertEqual(json.loads(ticket["rounds_json"]), {"build": 1})
        row = self.conn.execute("SELECT retry_count, step_count FROM workflow_runs WHERE id = ?", (run,)).fetchone()
        self.assertEqual((row["retry_count"], row["step_count"]), (0, before))

    def test_answer_rejected_for_non_waiting_or_direct(self):
        run = self._paused_failed_run()
        assignment = self.conn.execute("SELECT assignment_id FROM stage_attempts WHERE workflow_run_id = ?",
                                       (run,)).fetchone()[0]
        with self.assertRaises(AsError) as caught:
            self.answer(assignment)
        self.assertEqual(caught.exception.code, resolve.RESOLVE_NOT_ALLOWED)
        self.assertEqual(self.conn.execute("SELECT status FROM assignments WHERE id = ?",
                                           (assignment,)).fetchone()[0], "failed")
        self.assertEqual(self.conn.execute("SELECT status FROM workflow_runs WHERE id = ?", (run,)).fetchone()[0],
                         "paused")

        direct = self._direct_waiting_assignment()
        with self.assertRaises(AsError) as caught:
            self.answer(direct)
        self.assertEqual(caught.exception.code, "BAD_REQUEST")
        self.assertEqual(self.conn.execute("SELECT status FROM assignments WHERE id = ?",
                                           (direct,)).fetchone()[0], "waiting_input")

        aid = str(uuid.uuid4())
        for args in ({"assignmentId": aid, "action": "fail", "answer": "x"},
                     {"assignmentId": aid, "action": "cancel", "answer": "x"},
                     {"assignmentId": aid, "action": "retry", "answer": "  "},
                     {"assignmentId": aid, "action": "retry", "answer": 1},
                     {"assignmentId": aid, "action": "retry", "answer": "x" * 16001}):
            with self.subTest(args=args):
                with self.assertRaises(AsError) as caught:
                    dispatch._validate_resolve(args)
                self.assertEqual(caught.exception.code, "BAD_REQUEST")
        self.assertEqual(dispatch._validate_resolve({"assignmentId": aid, "action": "retry", "answer": " ok "}),
                         {"assignmentId": aid, "action": "retry", "answer": "ok"})
        self.assertEqual(dispatch._validate_resolve({"assignmentId": aid, "action": "retry",
                                                      "answer": "x" * 16000})["answer"], "x" * 16000)

    def _paused_failed_run(self):
        self.add_ticket()
        self.tick()
        run = self.ticket("T-001")["active_run_id"]
        assignment = self.conn.execute("SELECT assignment_id FROM stage_attempts WHERE workflow_run_id = ?",
                                       (run,)).fetchone()[0]
        with self.store.transaction() as tx:
            tx.transition("assignment", assignment, "failed", set_values={
                "diagnostic_code": "PROVIDER_ERROR", "result_json": {"diagnosticCode": "PROVIDER_ERROR"}})
        workflow.advance(self.store, self.ctx)
        self.assertEqual(self.conn.execute("SELECT status FROM workflow_runs WHERE id = ?", (run,)).fetchone()[0],
                         "paused")
        return run

    def _direct_waiting_assignment(self):
        with self.store.transaction() as tx:
            task = tx.create("task", {"team_id": self.team, "origin": "direct", "workspace": self.ws, "goal": "g"})
            assignment = tx.create("assignment", {"team_id": self.team, "task_id": task, "agent_id": self.worker,
                                                  "attempt": 1, "policy": "read_only", "provider_id": "fake"})
            for step in ("claimed", "running", "waiting_input"):
                tx.transition("assignment", assignment, step)
        return assignment

    def test_cli_passes_answer(self):
        import agent_studio.cli as cli
        aid = str(uuid.uuid4())

        def reply(req, require_id=False):
            self.assertEqual(req["command"], "assignment.resolve")
            self.assertEqual(req["args"], {"assignmentId": aid, "action": "retry", "answer": "Postgres"})
            return {"ok": True, "data": {"status": "answered"}}

        raw, err = io.BytesIO(), io.StringIO()
        out = io.TextIOWrapper(raw, encoding="utf-8", write_through=True)
        with mock.patch("agent_studio.dispatch.handle_request", reply), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = cli.main(["assignment", "resolve", "--assignment", aid, "--action", "retry",
                           "--answer", "Postgres"])
        self.assertEqual((rc, err.getvalue()), (0, ""))

    def test_team_resolve_passes_answer(self):
        from agent_studio import teamcli
        aid = str(uuid.uuid4())
        parsed = teamcli._parser("resolve").parse_args(
            ["--assignment", aid, "--action", "retry", "--answer", "Postgres"])
        self.assertEqual(parsed.answer, "Postgres")
        ns = SimpleNamespace(resolve_action="retry", member=None, assignment=aid, answer="Postgres")
        sent = {}

        def write_call(command, args):
            sent.update(command=command, args=args)
            return {"status": "answered"}

        with mock.patch.object(teamcli, "_running_team", return_value=({}, [])), \
                mock.patch.object(teamcli, "_snapshot", return_value={"assignments": []}), \
                mock.patch.object(teamcli, "_name_of", return_value="Dev"), \
                mock.patch.object(teamcli, "_write_call", side_effect=write_call):
            teamcli._resolve(ns)
        self.assertEqual(sent, {"command": "assignment.resolve",
                                "args": {"assignmentId": aid, "action": "retry", "answer": "Postgres"}})

    def test_input_question_rules(self):
        self.assertEqual(needsinput.input_question(
            {"attention": {"kind": "permission_denied", "items": ["Bash: rm"]}}),
            "Permission denied: Bash: rm")
        self.assertEqual(needsinput.input_question({"summary": "s"}), "s")
        self.assertEqual(needsinput.input_question({}), needsinput.DEFAULT_QUESTION)
        self.assertEqual(len(needsinput.input_question({"attention": {"items": ["x" * 600]}})), 500)
        self.assertIsNone(needsinput.needs_input("running", "{}", "t"))
        self.assertEqual(needsinput.needs_input("waiting_input", "not json", "t"),
                         {"question": needsinput.DEFAULT_QUESTION, "since": "t"})
