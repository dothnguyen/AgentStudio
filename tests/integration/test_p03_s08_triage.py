"""Live fake-provider coverage for the bug triage planning outcome."""
import os
import unittest

from tests.helpers import key, req
from tests.integration import test_p03_s06_outcomes as outcomes  # module import: keeps its TestCase out of this module

fake, git = outcomes.fake, outcomes.git


BUG = """# BUG-{key} — Login crash
Severity: major

## Steps to reproduce
Open login

## Expected
It works

## Actual
It crashes

## Environment
None

## Suspected area
Auth

## Done when
- [ ] regression test covers the crash

## Out of scope
None

## Open questions
None
"""


class TriageIntegration(unittest.TestCase):
    def setUp(self):
        self.fx = outcomes.OutcomeIntegration()
        self.fx.setUp()

    def tearDown(self):
        self.fx.tearDown()

    def create_bug(self, text="Login crash"):
        _, response, _ = self.fx.sb.request(req("ticket.create", {"workspace": self.fx.workspace, "kind": "bug", "text": text}, idempotencyKey=key()))
        self.assertTrue(response["ok"], response)
        return response["data"]["ticket"]

    def write(self, path, text):
        os.makedirs(os.path.dirname(os.path.join(self.fx.workspace, path)), exist_ok=True)
        with open(os.path.join(self.fx.workspace, path), "w", encoding="utf-8") as f:
            f.write(text)

    def test_triage_commits_valid_bug_and_selects_bug_develop_definition(self):
        ticket = self.create_bug()
        path = "bugs/BUG-" + ticket["key"] + "-login-crash.md"
        self.fx.start(ticket, "TeamLead", "verdict", fake("verdict_pass", duration=4000))
        # The workspace must be clean at start; the triage agent's file appears while the run is in flight.
        self.write(path, BUG.format(key=ticket["key"]))
        triaged = self.fx.wait_ticket(ticket, "ready_dev")
        row = triaged["ticket"]
        self.assertEqual((row["storyPath"], row["severity"], row["priority"]), (path, "major", 40))
        self.assertEqual(git(self.fx.workspace, "log", "-1", "--format=%s"), ticket["key"] + ": triage " + path)
        self.assertEqual(git(self.fx.workspace, "show", "--format=", "--name-only", "HEAD").splitlines(), [path])
        developed = self.fx.start(row, "Developer", "work", fake("success", "fixed.txt"))
        self.assertEqual(developed["definition"], "board-develop-bug")
        detail = self.fx.detail(ticket)
        started = [event for event in detail["events"] if event["name"] == "ticket.run_started"][-1]
        self.assertEqual(started["payload"]["definition"], "board-develop-bug")
        run = self.fx.workflow(developed["workflowRunId"])
        prompt = open(run["stageAttempts"][0]["promptPath"], encoding="utf-8").read()
        self.assertIn("regression test", prompt)

    def test_story_ticket_keeps_standard_develop_definition(self):
        ticket = self.fx.move(self.fx.create(), "ready_dev")
        developed = self.fx.start(ticket, "Developer", "work", fake("success", "fixed.txt"))
        self.assertEqual(developed["definition"], "board-develop")
        started = [event for event in self.fx.detail(ticket)["events"] if event["name"] == "ticket.run_started"][-1]
        self.assertEqual(started["payload"]["definition"], "board-develop")

    def test_triage_fail_blocks_with_verdict_questions_without_commit(self):
        ticket = self.create_bug()
        before = git(self.fx.workspace, "rev-parse", "HEAD")
        self.fx.start(ticket, "TeamLead", "verdict", fake("verdict_fail"))
        detail = self.fx.wait_ticket(ticket, "blocked")
        row = detail["ticket"]
        self.assertEqual(row["blockedReason"], "VERDICT_FAIL:triage")
        self.assertEqual(row["questions"], ["test_add fails: expected 4, got 5",
                                               "shell text is data: $(touch CANARY_FINDING) `touch CANARY_BACKTICK`; rm -rf ~ && echo pwned"])
        self.assertEqual(git(self.fx.workspace, "rev-parse", "HEAD"), before)

    def test_triage_duplicate_cancels_and_commits_bug_file(self):
        original = self.create_bug()
        ticket = self.create_bug("Already reported")
        path = "bugs/BUG-" + ticket["key"] + "-duplicate.md"
        self.fx.start(ticket, "TeamLead", "verdict", fake("verdict_pass", duration=4000))
        # The workspace must be clean at start; the triage agent's file appears while the run is in flight.
        self.write(path, "# BUG-" + ticket["key"] + " — Duplicate\nSeverity: minor\nDuplicate of: " + original["key"] + "\n")
        row = self.fx.wait_ticket(ticket, "cancelled")["ticket"]
        self.assertEqual((row["duplicateOf"], row["severity"], row["storyPath"]), (original["key"], "minor", path))
        self.assertEqual(git(self.fx.workspace, "log", "-1", "--format=%s"), ticket["key"] + ": triage " + path)

    def test_triage_invalid_file_blocks_with_questions_after_commit(self):
        ticket = self.create_bug()
        path = "bugs/BUG-" + ticket["key"] + "-invalid.md"
        self.fx.start(ticket, "TeamLead", "verdict", fake("verdict_pass", duration=4000))
        # The workspace must be clean at start; the triage agent's file appears while the run is in flight.
        self.write(path, BUG.format(key=ticket["key"]).replace("Severity: major", "Severity: urgent"))
        row = self.fx.wait_ticket(ticket, "blocked")["ticket"]
        self.assertEqual((row["blockedReason"], row["storyPath"]), ("BUG_FILE_INVALID", path))
        self.assertTrue(any(question.startswith("Severity:") for question in row["questions"]))
        self.assertEqual(git(self.fx.workspace, "log", "-1", "--format=%s"), ticket["key"] + ": triage " + path)

    def test_triage_rejects_two_bug_files_without_commit(self):
        ticket = self.create_bug()
        before = git(self.fx.workspace, "rev-parse", "HEAD")
        self.fx.start(ticket, "TeamLead", "verdict", fake("verdict_pass", duration=4000))
        # The workspace must be clean at start; the triage agent's file appears while the run is in flight.
        self.write("bugs/BUG-" + ticket["key"] + "-one.md", BUG.format(key=ticket["key"]))
        self.write("bugs/BUG-" + ticket["key"] + "-two.md", BUG.format(key=ticket["key"]))
        row = self.fx.wait_ticket(ticket, "blocked")["ticket"]
        self.assertEqual(row["blockedReason"], "PLANNING_DIFF_INVALID")
        self.assertEqual(git(self.fx.workspace, "rev-parse", "HEAD"), before)

    def test_triage_rejects_file_outside_bugs_without_commit(self):
        ticket = self.create_bug()
        before = git(self.fx.workspace, "rev-parse", "HEAD")
        self.fx.start(ticket, "TeamLead", "verdict", fake("verdict_pass", duration=4000))
        # The workspace must be clean at start; the triage agent's file appears while the run is in flight.
        self.write("outside.md", "not a bug file\n")
        row = self.fx.wait_ticket(ticket, "blocked")["ticket"]
        self.assertEqual(row["blockedReason"], "PLANNING_DIFF_INVALID")
        self.assertEqual(git(self.fx.workspace, "rev-parse", "HEAD"), before)
