import ast
import contextlib
import io
import json
import os
import shutil
import sqlite3
import tempfile
import unittest
from unittest import mock

from tests import helpers  # noqa: F401  (puts backend on sys.path)
from agent_studio import cli, teamcli, teamdefs, teams, workspace
from agent_studio.protocol import envelope

TEAM = "a" * 8 + "-0000-4000-8000-" + "a" * 12
RYAN, SAM, SAM2 = ("1" * 8 + "-0000-4000-8000-" + "1" * 12, "2" * 8 + "-0000-4000-8000-" + "2" * 12,
                   "3" * 8 + "-0000-4000-8000-" + "3" * 12)
ASG = "c" * 8 + "-0000-4000-8000-" + "c" * 12
TASK = "d" * 8 + "-0000-4000-8000-" + "d" * 12
WF = "e" * 8 + "-0000-4000-8000-" + "e" * 12


def members(extra=False):
    out = [{"memberId": "ryan", "name": "Ryan", "role": "developer", "provider": "fake", "agentId": RYAN,
            "availability": "idle", "paneState": "alive", "assignment": None},
           {"memberId": "sam", "name": "Sam", "role": "reviewer", "provider": "fake", "agentId": SAM,
            "availability": "idle", "paneState": "alive", "assignment": None}]
    if extra:
        out.append({"memberId": "sue", "name": "Sue", "role": "reviewer", "provider": "fake", "agentId": SAM2,
                    "availability": "idle", "paneState": "alive", "assignment": None})
    return out


def team_status(status="running", extra=False):
    return {"team": {"id": TEAM, "teamDefId": "alpha", "name": "Alpha", "status": status, "workspace": "/w"},
            "members": members(extra)}


class Fake:
    """Stands in for dispatch.handle_request; records every request."""

    def __init__(self, **answers):
        self.answers = {"team.status": team_status()}
        self.answers.update({k.replace("_", "."): v for k, v in answers.items()})
        self.requests = []

    def __call__(self, req, require_id=True):
        self.requests.append(req)
        a = self.answers.get(req["command"])
        if callable(a):
            a = a(req)
        if isinstance(a, dict) and "protocol" in a:
            return a
        return envelope(None, True, data=a)

    def commands(self):
        return [r["command"] for r in self.requests]

    def sent(self, command):
        return [r for r in self.requests if r["command"] == command]


class Base(unittest.TestCase):
    def setUp(self):
        self.root = os.path.realpath(tempfile.mkdtemp(prefix="as-s04-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self._old = os.environ.get("XDG_STATE_HOME")
        os.environ["XDG_STATE_HOME"] = os.path.join(self.root, "state")
        self.addCleanup(self._restore)
        self.ws = os.path.join(self.root, "proj")
        os.makedirs(self.ws)
        workspace.init(self.ws)
        with open(os.path.join(self.ws, ".agent-studio", "roles.json"), "w") as f:
            json.dump({"version": 1, "roles": {"developer": {}, "reviewer": {}}}, f)
        teamdefs.save(self.ws, {"id": "alpha", "name": "Alpha", "members": [
            {"id": "ryan", "name": "Ryan", "role": "developer", "provider": "fake"}]})

    def _restore(self):
        if self._old is None:
            os.environ.pop("XDG_STATE_HOME", None)
        else:
            os.environ["XDG_STATE_HOME"] = self._old

    def run_cli(self, fake, *argv, stdin=None):
        raw = io.BytesIO()
        out, err = io.TextIOWrapper(raw, encoding="utf-8", write_through=True), io.StringIO()
        with mock.patch("agent_studio.dispatch.handle_request", fake), contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(err):
            if stdin is not None:
                with mock.patch("sys.stdin", mock.Mock(buffer=io.BytesIO(stdin.encode()))):
                    rc = cli.main(["team"] + list(argv))
            else:
                rc = cli.main(["team"] + list(argv))
        return rc, raw.getvalue().decode(), err.getvalue()

    def ws_args(self, *argv):
        return list(argv) + ["--workspace", self.ws]


class Resolution(Base):
    def test_definition_id_only_team_and_uuid_reach_the_same_team(self):
        for extra in (["--team", "alpha"], [], ["--team", TEAM]):
            fake = Fake(workflow_list={"definitions": []})
            rc, out, err = self.run_cli(fake, "workflows", "--workspace", self.ws, *extra)
            self.assertEqual(fake.sent("workflow.list")[0]["args"], {"teamId": TEAM}, err)
            self.assertEqual(rc, 0, err)

    def test_stopped_or_never_started_team_is_not_running_and_writes_nothing(self):
        for answer in ({"team": None, "members": []}, team_status("stopped")):
            fake = Fake(team_status=answer)
            rc, out, err = self.run_cli(fake, "ask", "--workspace", self.ws, "--member", "Ryan", "hi")
            self.assertEqual(rc, 1)
            self.assertTrue(err.startswith("TEAM_NOT_RUNNING:"), err)
            self.assertIn("agent-studio team start --team alpha", err)
            self.assertEqual(fake.commands(), ["team.status"])

    def test_unknown_member_is_member_not_found(self):
        fake = Fake()
        rc, out, err = self.run_cli(fake, "ask", "--workspace", self.ws, "--member", "Nobody", "hi")
        self.assertEqual(rc, 1)
        self.assertTrue(err.startswith("MEMBER_NOT_FOUND:"), err)
        self.assertEqual(fake.sent("task.direct"), [])

    def test_member_lookup_matches_find_agent(self):
        rows = [{"id": RYAN, "member_id": "ryan", "display_name": "Ryan"},
                {"id": SAM, "member_id": "sam", "display_name": "Sam"}]
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute("CREATE TABLE agents (id, team_id, ordinal, member_id, display_name)")
        for i, r in enumerate(rows):
            conn.execute("INSERT INTO agents VALUES (?, 't', ?, ?, ?)", (r["id"], i, r["member_id"], r["display_name"]))
        for ref in (RYAN, "ryan", "RYAN", "Sam", "sAM"):
            want = teams.find_agent(conn, "t", ref)["id"]
            got = teamcli._member(members(), ref)["agentId"]
            self.assertEqual(got, want, ref)


class Ask(Base):
    def test_ask_builds_task_direct_with_default_policy(self):
        fake = Fake(task_direct={"taskId": TASK, "assignmentId": ASG})
        rc, out, err = self.run_cli(fake, "ask", "--workspace", self.ws, "--member", "ryan", "look at this")
        self.assertEqual(rc, 0, err)
        req = fake.sent("task.direct")[0]
        self.assertEqual(req["args"], {"teamId": TEAM, "agentId": RYAN, "policy": "read_only", "text": "look at this"})
        self.assertTrue(req["idempotencyKey"])
        self.assertEqual(out.strip(), f"asked Ryan: task {TASK} assignment {ASG}")

    def test_ask_text_from_stdin_and_policy(self):
        fake = Fake(task_direct={"taskId": TASK, "assignmentId": ASG})
        rc, _, err = self.run_cli(fake, "ask", "--workspace", self.ws, "--member", "Sam", "--policy",
                                  "workspace_write", "--text-file", "-", stdin="from stdin")
        self.assertEqual(rc, 0, err)
        args = fake.sent("task.direct")[0]["args"]
        self.assertEqual((args["agentId"], args["policy"], args["text"]), (SAM, "workspace_write", "from stdin"))

    def test_ask_needs_exactly_one_text_source(self):
        for argv in (["hi", "--text-file", "-"], []):
            fake = Fake()
            rc, _, err = self.run_cli(fake, "ask", "--workspace", self.ws, "--member", "ryan", *argv, stdin="x")
            self.assertEqual(rc, 1)
            self.assertTrue(err.startswith("BAD_REQUEST:"), err)
            self.assertEqual(fake.requests, [])

    def test_busy_member_answer_is_passed_through(self):
        busy = {"protocol": 1, "id": None, "ok": False,
                "error": {"code": "AGENT_BUSY", "message": "Ryan is busy", "retryable": False}}
        rc, _, err = self.run_cli(Fake(task_direct=busy), "ask", "--workspace", self.ws, "--member", "ryan", "hi")
        self.assertEqual(rc, 1)
        self.assertTrue(err.startswith("AGENT_BUSY:"), err)

    def test_ask_wait_prints_member_and_result(self):
        detail = {"task": {}, "assignments": [{"id": ASG, "status": "succeeded",
                                                "result": {"summary": "short", "finalText": "the answer"}}]}
        fake = Fake(task_direct={"taskId": TASK, "assignmentId": ASG})
        with mock.patch("agent_studio.watch.follow", return_value=detail):
            rc, out, err = self.run_cli(fake, "ask", "--workspace", self.ws, "--member", "ryan", "--wait", "hi")
        self.assertEqual(rc, 0, err)
        self.assertEqual(out.splitlines(), ["Ryan [fake/developer]: succeeded", "the answer"])
        with mock.patch("agent_studio.watch.follow", return_value=detail):
            rc, out, _ = self.run_cli(fake, "ask", "--workspace", self.ws, "--member", "ryan", "--wait", "--json", "hi")
        data = json.loads(out)["data"]
        self.assertEqual(data["receipt"]["assignmentId"], ASG)


VALID = {"ok": True, "definition": "pair", "stages": [{"id": "build", "role": "developer", "kind": "agent"},
                                                       {"id": "look", "role": "reviewer", "kind": "verdict"}],
         "bindings": {"developer": {"agentId": RYAN, "name": None}, "reviewer": {"agentId": SAM, "name": None}},
         "warnings": [{"message": "careful", "path": "stages.0"}]}
START = {"workflowRunId": WF, "taskId": TASK, "baseCommit": "f" * 40, "bindings": {"developer": RYAN, "reviewer": SAM}}


class RunWorkflow(Base):
    def test_run_workflow_validates_then_starts_with_every_role_bound(self):
        fake = Fake(workflow_validate=VALID, workflow_start=START)
        rc, out, err = self.run_cli(fake, "run-workflow", "--workspace", self.ws, "pair", "--bind", "reviewer=sam", "go")
        self.assertEqual(rc, 0, err)
        self.assertEqual(fake.commands(), ["team.status", "workflow.validate", "workflow.start"])
        self.assertEqual(fake.sent("workflow.validate")[0]["args"],
                         {"teamId": TEAM, "definition": "pair", "bindings": {"reviewer": SAM}})
        self.assertNotIn("idempotencyKey", fake.sent("workflow.validate")[0])
        self.assertEqual(fake.sent("workflow.start")[0]["args"],
                         {"teamId": TEAM, "definition": "pair", "text": "go",
                          "bindings": {"developer": RYAN, "reviewer": SAM}})
        self.assertEqual(out.splitlines(), [f"started workflow {WF}", "developer -> Ryan", "reviewer -> Sam"])

    def test_ambiguous_role_names_the_role_and_writes_nothing(self):
        amb = {"protocol": 1, "id": None, "ok": False, "data": {"role": "reviewer", "agentIds": [SAM, SAM2]},
               "error": {"code": "ROLE_AMBIGUOUS", "message": "2 agents have the role 'reviewer'.",
                         "retryable": False, "remediation": "Pass --bind reviewer=<agent id>."}}
        fake = Fake(workflow_validate=amb, team_status=team_status(extra=True))
        rc, out, err = self.run_cli(fake, "run-workflow", "--workspace", self.ws, "pair", "go")
        self.assertEqual(rc, 1)
        self.assertTrue(err.startswith("ROLE_AMBIGUOUS:"), err)
        self.assertIn("pass --bind reviewer=<member>", err)
        self.assertIn("Sam, Sue", err)
        self.assertEqual(fake.sent("workflow.start"), [])
        rc, out, _ = self.run_cli(fake, "run-workflow", "--workspace", self.ws, "pair", "go", "--json")
        self.assertEqual(json.loads(out)["error"]["code"], "ROLE_AMBIGUOUS")

    def test_duplicate_bind_and_unknown_member_fail_before_any_write(self):
        for binds, code in ((["--bind", "reviewer=sam", "--bind", "reviewer=ryan"], "BAD_REQUEST"),
                            (["--bind", "reviewer=nobody"], "MEMBER_NOT_FOUND")):
            fake = Fake(workflow_validate=VALID)
            rc, _, err = self.run_cli(fake, "run-workflow", "--workspace", self.ws, "pair", "go", *binds)
            self.assertEqual(rc, 1)
            self.assertTrue(err.startswith(code + ":"), err)
            self.assertEqual(fake.sent("workflow.start"), [])

    def test_wait_prints_bindings_route_status_findings_and_last_summary(self):
        detail = {"route": "build -> look (pass)", "workflowRun": {"status": "succeeded"},
                  "stageAttempts": [{"assignmentId": ASG, "verdict": {"findings": ["nit one"]}}],
                  "assignments": [{"id": ASG, "result": {"summary": "all good"}}]}
        fake = Fake(workflow_validate=VALID, workflow_start=START)
        with mock.patch("agent_studio.watch.follow_workflow", return_value=detail):
            rc, out, err = self.run_cli(fake, "run-workflow", "--workspace", self.ws, "pair", "--wait", "go")
        self.assertEqual(rc, 0, err)
        self.assertEqual(out.splitlines(), ["developer -> Ryan", "reviewer -> Sam", "route: build -> look (pass)",
                                            "status: succeeded", "last findings:", "- nit one",
                                            "last stage summary:", "all good"])


class Helpers(Base):
    """workflows / check / retry send the same dispatch commands and render the same fields."""

    def test_workflows(self):
        defs = {"definitions": [{"name": "pair", "builtin": True, "description": "d", "errors": []},
                                {"name": "bad", "builtin": False, "description": "", "errors": ["x", "y"]}]}
        fake = Fake(workflow_list=defs)
        rc, out, err = self.run_cli(fake, "workflows", "--workspace", self.ws)
        self.assertEqual(fake.sent("workflow.list")[0]["args"], {"teamId": TEAM})
        self.assertEqual(out.splitlines(), ["pair  built-in  d", "bad  project  INVALID (2 error(s))"])

    def test_check(self):
        fake = Fake(workflow_validate=VALID)
        rc, out, err = self.run_cli(fake, "check", "--workspace", self.ws, "pair")
        self.assertEqual(fake.sent("workflow.validate")[0]["args"], {"teamId": TEAM, "definition": "pair", "bindings": {}})
        self.assertEqual(out.splitlines(), ["pair: OK  stages: build -> look", "  developer -> Ryan",
                                            "  reviewer -> Sam", "  warning: careful (stages.0)"])
        self.assertEqual(fake.commands(), ["team.status", "workflow.validate"])

    def snapshot(self):
        return {"agents": [{"id": RYAN, "displayName": "Ryan", "memberId": "ryan", "role": "developer"}],
                "workflowRuns": [{"id": "old", "status": "running", "createdAt": "2030-01-01"},
                                 {"id": WF, "status": "paused", "createdAt": "2030-01-03"},
                                 {"id": "done", "status": "succeeded", "createdAt": "2030-01-04"}],
                "stageAttempts": [{"workflowRunId": WF, "assignmentId": ASG, "createdAt": "2030-01-03"}],
                "assignments": [{"id": ASG, "agentId": RYAN, "status": "failed", "result": {"summary": "s" * 400}}]}

    def test_retry_picks_newest_running_or_paused_run(self):
        fake = Fake(snapshot=self.snapshot(), workflow_retry={"status": "retried", "stage": "build",
                                                              "newAssignmentId": "n1"})
        rc, out, err = self.run_cli(fake, "retry", "--workspace", self.ws)
        self.assertEqual(rc, 0, err)
        self.assertEqual(fake.sent("snapshot")[0]["args"], {"teamId": TEAM})
        self.assertEqual(fake.sent("workflow.retry")[0]["args"], {"workflowRunId": WF})
        self.assertEqual(out.strip(), f"workflow {WF}: stage build retried (new assignment n1)")

    def test_retry_without_a_live_run_is_not_found(self):
        fake = Fake(snapshot={"workflowRuns": [{"id": "d", "status": "failed"}]})
        rc, _, err = self.run_cli(fake, "retry", "--workspace", self.ws)
        self.assertEqual(rc, 1)
        self.assertTrue(err.startswith("NOT_FOUND: No running or paused workflow for this team."), err)
        self.assertEqual(fake.sent("workflow.retry"), [])

    def test_blocked_lists_stuck_and_paused_stage_assignments(self):
        snap = self.snapshot()
        snap["assignments"].append({"id": "w2", "agentId": SAM, "status": "waiting_input",
                                    "result": {"summary": "denied", "attention": {"kind": "permission", "items": ["rm"]}}})
        snap["agents"].append({"id": SAM, "displayName": "Sam", "memberId": "sam", "role": "reviewer"})
        fake = Fake(snapshot=snap)
        rc, out, _ = self.run_cli(fake, "blocked", "--workspace", self.ws, "--json")
        items = {i["member"]: i for i in json.loads(out)["data"]["items"]}
        self.assertEqual(set(items), {"Ryan", "Sam"})
        self.assertEqual(items["Ryan"]["workflowRunId"], WF)
        self.assertIsNone(items["Sam"]["workflowRunId"])
        rc, out, _ = self.run_cli(fake, "blocked", "--workspace", self.ws)
        self.assertIn(f"Ryan [developer] assignment {ASG} failed  workflow {WF} paused", out)
        self.assertIn("s" * 300, out)
        self.assertNotIn("s" * 301, out)
        self.assertIn("permission: rm", out)
        self.assertIn("team resolve --member Sam --action retry", out)
        self.assertEqual(fake.commands().count("assignment.resolve"), 0)

    def test_blocked_empty(self):
        rc, out, _ = self.run_cli(Fake(snapshot={}), "blocked", "--workspace", self.ws)
        self.assertEqual(out.strip(), "No member is waiting for a decision.")

    def test_resolve_by_member_and_by_assignment(self):
        snap = self.snapshot()
        fake = Fake(snapshot=snap, assignment_resolve={"status": "ok"})
        rc, out, err = self.run_cli(fake, "resolve", "--workspace", self.ws, "--member", "ryan", "--action", "retry")
        self.assertEqual(rc, 0, err)
        self.assertEqual(fake.sent("assignment.resolve")[0]["args"], {"assignmentId": ASG, "action": "retry"})
        self.assertEqual(out.strip(), f"Ryan: assignment {ASG} resolved with retry")
        fake = Fake(snapshot=snap, assignment_resolve={"status": "ok"})
        self.run_cli(fake, "resolve", "--workspace", self.ws, "--assignment", "xyz", "--action", "cancel")
        self.assertEqual(fake.sent("assignment.resolve")[0]["args"], {"assignmentId": "xyz", "action": "cancel"})
        fake = Fake(snapshot={})
        rc, _, err = self.run_cli(fake, "resolve", "--workspace", self.ws, "--member", "sam", "--action", "fail")
        self.assertEqual(rc, 1)
        self.assertIn("NOT_FOUND: No assignment of Sam is waiting for a decision", err)
        self.assertEqual(fake.sent("assignment.resolve"), [])

    def test_resolve_refusal_is_passed_through(self):
        no = {"protocol": 1, "id": None, "ok": False,
              "error": {"code": "RESOLVE_NOT_ALLOWED", "message": "nope", "retryable": False}}
        rc, _, err = self.run_cli(Fake(assignment_resolve=no, snapshot={}), "resolve", "--workspace", self.ws, "--assignment", "x",
                                  "--action", "fail")
        self.assertEqual(rc, 1)
        self.assertTrue(err.startswith("RESOLVE_NOT_ALLOWED:"), err)


class Envelopes(Base):
    def test_json_prints_the_raw_envelope_for_each_command(self):
        fake = Fake(task_direct={"taskId": TASK, "assignmentId": ASG}, workflow_list={"definitions": []},
                    workflow_validate=VALID, workflow_start=START, snapshot={"workflowRuns": [
                        {"id": WF, "status": "running", "createdAt": "1"}]},
                    workflow_retry={"stage": "build", "newAssignmentId": "n"}, assignment_resolve={"status": "ok"})
        cases = [("ask", "--member", "ryan", "hi"), ("run-workflow", "pair", "go"), ("workflows",),
                 ("check", "pair"), ("retry",), ("blocked",),
                 ("resolve", "--assignment", "x", "--action", "fail")]
        for argv in cases:
            rc, out, err = self.run_cli(fake, *argv, "--workspace", self.ws, "--json")
            env = json.loads(out)
            self.assertEqual((rc, env["ok"]), (0, True), (argv, err))
            self.assertEqual(out.count("\n"), 1)


class Isolation(unittest.TestCase):
    def test_no_board_imports_and_no_board_or_ticket_commands(self):
        path = os.path.join(os.path.dirname(teamcli.__file__), "teamcli.py")
        tree = ast.parse(open(path).read())
        names = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                names.add(node.module or "")
                names.update(a.name for a in node.names)
            elif isinstance(node, ast.Import):
                names.update(a.name for a in node.names)
        self.assertFalse(names & {"board", "board_" + "scheduler", "board_" + "config", "tick" + "ets",
                                  "bug" + "file"}, names)
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                # the board lifecycle commands (P04-S10 run-board / stop-board) are the exception
                allowed = node.value in ("board.run", "board.stop")
                self.assertFalse(node.value.startswith(("board.", "ticket.")) and not allowed, node.value)


if __name__ == "__main__":
    unittest.main()
