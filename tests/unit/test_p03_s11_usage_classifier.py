import copy
import json
import os
import subprocess
import sys
import unittest

from tests import helpers  # noqa: F401
from agent_studio import contract, providers
from agent_studio import report_rules, reports, teams
from agent_studio.protocol import AsError
from agent_studio.providers.base import AssignmentInput, ParseState
from agent_studio.providers.fake.adapter import FAKE_CLI, FakeAdapter


FIX = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "fixtures", "claude")


def inp(provider="fake"):
    return AssignmentInput("aaaaaaaa", "bbbbbbbb", provider, 1, "/tmp", "/tmp/p", "role", "read_only", 1, 1)


def oc(exit_code=1):
    return {"exitCode": exit_code, "signal": None, "timedOut": False, "cancelRequested": False,
            "truncated": False, "outputPath": None, "stderrPath": None}


class UsageClassifierTests(unittest.TestCase):
    def test_report_limit_reset_validation(self):
        report = FakeAdapter().finalize(inp(), ParseState(terminal={"ok": False, "code": "USAGE_LIMIT", "summary": "x", "limitResetAt": "2030-01-01T15:00:00Z"}), oc())
        contract.validate_report(report, {"assignmentId": "aaaaaaaa", "agentId": "bbbbbbbb", "providerId": "fake", "attempt": 1, "policy": "read_only"})
        report.pop("limitResetAt")
        contract.validate_report(report, {"assignmentId": "aaaaaaaa", "agentId": "bbbbbbbb", "providerId": "fake", "attempt": 1, "policy": "read_only"})
        bad = copy.deepcopy(report)
        bad["limitResetAt"] = "tomorrow"
        with self.assertRaises(AsError) as caught:
            contract.validate_report(bad, {})
        self.assertEqual(caught.exception.code, contract.BAD_REPORT)

    def test_fake_usage_limit_scenarios_and_ordinary_error(self):
        """Run the real fake CLI for each scenario and classify what it actually prints."""
        adapter = FakeAdapter()
        cases = (("usage_limit", "USAGE_LIMIT", "2030-01-01T15:00:00Z"), ("usage_limit_no_reset", "USAGE_LIMIT", None),
                 ("provider_failure", "PROVIDER_ERROR", None))
        for scenario, code, reset in cases:
            with self.subTest(scenario=scenario):
                run = subprocess.run([sys.executable, "-I", FAKE_CLI, "--scenario", scenario, "--sandbox", "read-only",
                                      "--duration-ms", "0", "--lines", "0"], input=b"prompt", stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, timeout=30)
                self.assertEqual(run.returncode, 1, run.stderr)
                state = ParseState()
                for line in run.stdout.splitlines():
                    adapter.parse_line(line, state)
                report = adapter.finalize(inp(), state, oc(run.returncode))
                self.assertEqual(report["diagnosticCode"], code)
                self.assertEqual(report.get("limitResetAt"), reset)

    def test_claude_limit_fixtures_and_api_error_control(self):
        adapter = providers.get("claude")
        for name, expected in (("usage_limit.jsonl", "2030-01-01T15:00:00Z"), ("usage_limit_no_reset.jsonl", None), ("api_error.jsonl", None)):
            with self.subTest(name=name):
                state = ParseState()
                with open(os.path.join(FIX, name), "rb") as source:
                    for line in source:
                        adapter.parse_line(line.rstrip(b"\n"), state)
                report = adapter.finalize(inp("claude"), state, oc())
                self.assertEqual(report["diagnosticCode"], "PROVIDER_ERROR" if name == "api_error.jsonl" else "USAGE_LIMIT")
                self.assertEqual(report.get("limitResetAt"), expected)

    def test_claude_weekly_limit_result_triggers_usage_limit(self):
        adapter = providers.get("claude")
        cases = (
            ("You've hit your weekly limit · resets Oct 29, 5am (Australia/Brisbane)", "USAGE_LIMIT"),
            ("You have reached your daily limit", "USAGE_LIMIT"),
            ("Could not retrieve the weekly limit settings", "PROVIDER_ERROR"),
        )
        for message, expected in cases:
            with self.subTest(message=message):
                state = ParseState()
                event = {"type": "result", "subtype": "error", "is_error": True,
                         "terminal_reason": "api_error", "result": message}
                adapter.parse_line(json.dumps(event).encode("utf-8"), state)
                report = adapter.finalize(inp("claude"), state, oc())
                self.assertEqual(report["diagnosticCode"], expected)
                self.assertNotIn("limitResetAt", report)

    def test_codex_limit_result_triggers_usage_limit(self):
        adapter = providers.get("codex")
        cases = (
            ("You have exceeded your current quota", "USAGE_LIMIT", None),
            ("Rate limit reached · resets at 1893510000", "USAGE_LIMIT", "2030-01-01T15:00:00Z"),
            ("You've hit your usage limit", "USAGE_LIMIT", None),
            ("stream disconnected before completion", "PROVIDER_ERROR", None),
        )
        for message, expected_code, expected_reset in cases:
            with self.subTest(message=message):
                state = ParseState()
                event = {"type": "turn.failed", "error": {"message": message}}
                adapter.parse_line(json.dumps(event).encode("utf-8"), state)
                report = adapter.finalize(inp("codex"), state, oc())
                self.assertEqual(report["diagnosticCode"], expected_code)
                self.assertEqual(report.get("limitResetAt"), expected_reset)

    def test_usage_limit_report_marks_agent_limited_and_records_event(self):
        from tests.unit import test_s03_rules as rules
        path, conn, store, agent, _task, assignment = rules.setup()
        runner = __import__("agent_studio.state", fromlist=["connect"]).connect(path, role="runner")
        try:
            teams.dispatch_claims(store, os.path.join(os.path.dirname(path), "state"))
            reports.submit(runner, assignment, 0, "start", {"agentId": agent, "attempt": 1, "pid": 10,
                                                               "startTime": 20, "bootId": "b"})
            reports.apply_pending(store, report_rules.apply)
            reports.submit(runner, assignment, 1, "final", rules.final(assignment, agent, "failed",
                           diagnosticCode="USAGE_LIMIT", limitResetAt="2030-01-01T15:00:00Z"))
            reports.apply_pending(store, report_rules.apply)
            self.assertEqual(tuple(conn.execute("SELECT availability, limit_reset_at FROM agents WHERE id = ?", (agent,)).fetchone()),
                             ("limit_reached", "2030-01-01T15:00:00Z"))
            self.assertEqual(conn.execute("SELECT name FROM events WHERE agent_id = ? ORDER BY seq DESC LIMIT 1", (agent,)).fetchone()[0],
                             "board.limit_reached")
        finally:
            runner.close()
