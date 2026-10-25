"""P04-S05: team unpack / review / dev / fix / qa / final / commit / index with dispatch, git and tests stubbed."""
import ast
import contextlib
import io
import json
import os
import shutil
import subprocess
import tempfile
import types
import unittest
from unittest import mock

from tests import helpers  # noqa: F401  (puts backend on sys.path)
from agent_studio import cli, storycli, teamcli
from agent_studio.protocol import envelope
from tests.unit.test_p04_s04_ask_and_workflows import ASG, SAM, SAM2, TASK, TEAM, WF, Fake, members, team_status

STORY = "phases/p/stories/P99-S01-x.md"
KEY = "story-P99_S01_x"
PASS = 'ok\n{"verdict": "pass", "findings": []}'
FAIL = 'no\n{"verdict": "fail", "findings": ["SUGGESTION: a", "blocker b"]}'
COMMIT = "```commit\nDo the thing\n\nBody\n```"


def roster(*roles):
    out = []
    for i, role in enumerate(roles):
        out.append({"memberId": f"m{i}", "name": f"N{i}", "role": role, "provider": "fake",
                    "agentId": f"{i}" * 8 + "-0000-4000-8000-" + f"{i}" * 12, "availability": "idle",
                    "paneState": "alive", "assignment": None})
    return out


def team_with(*roles):
    d = team_status()
    d["members"] = roster(*roles)
    return d


def aid(i):
    return f"{i}" * 8 + "-0000-4000-8000-" + f"{i}" * 12


class Env(unittest.TestCase):
    """Real temp workspace for state files; git, validation and the follow are stubbed."""

    def setUp(self):
        self.root = os.path.realpath(tempfile.mkdtemp(prefix="as-s05-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.state = os.path.join(self.root, "state")
        patcher = mock.patch.dict(os.environ, {"XDG_STATE_HOME": self.state})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.ws = os.path.join(self.root, "proj")
        os.makedirs(os.path.join(self.ws, "phases", "p", "stories"))
        open(os.path.join(self.ws, STORY), "w").write("# s\n")
        from agent_studio import teamdefs, workspace
        workspace.init(self.ws)
        teamdefs.save(self.ws, {"id": "alpha", "name": "Alpha", "members": [
            {"id": "ryan", "name": "Ryan", "role": "developer", "provider": "fake"}]})
        self.git_calls, self.git_out = [], {}
        self.answers = []            # agent answers, popped in order
        self.tests_ok, self.dirty = True, ""
        self.runs = []
        for target, new in (("agent_studio.storycli.subprocess.run", self.fake_run),
                            ("agent_studio.storycli.watch.follow", self.fake_follow),
                            ("agent_studio.storycli.watch.follow_workflow", self.fake_follow_wf)):
            p = mock.patch(target, new)
            p.start()
            self.addCleanup(p.stop)
        self.wf_detail = None

    def fake_run(self, argv, **kw):
        self.runs.append((list(argv), kw))
        if argv[0] == "git":
            self.git_calls.append(argv[1:])
            key = " ".join(argv[1:3])
            out = self.git_out.get(key, "")
            if argv[1:3] == ["status", "--porcelain"] and "status --porcelain" not in self.git_out:
                out = self.dirty
            if argv[1:3] == ["rev-parse", "HEAD"] and "rev-parse HEAD" not in self.git_out:
                out = "abc123def456\n"
            return subprocess.CompletedProcess(argv, 0, stdout=out)
        if "stdout" not in kw:       # the commit gate inherits the terminal
            return subprocess.CompletedProcess(argv, 0 if self.tests_ok else 1)
        return subprocess.CompletedProcess(argv, 0 if self.tests_ok else 1, stdout="test output\n")

    def fake_follow(self, assignment_id, task_id, *a, **kw):
        text = self.answers.pop(0)
        return {"assignments": [{"id": assignment_id, "status": "succeeded", "result": {"finalText": text}}]}

    def fake_follow_wf(self, wf_id, *a, **kw):
        return self.wf_detail

    def write_config(self):
        os.makedirs(os.path.join(self.ws, ".agent-studio"), exist_ok=True)
        json.dump({"validation": {"argv": ["python3", "scripts/validate.py", "--touched"], "timeoutMs": 5000}},
                  open(os.path.join(self.ws, ".agent-studio", "workflow.json"), "w"))

    def fake(self, *roles, **answers):
        base = {"team.status": team_with(*(roles or ("TeamLead", "Developer", "QA"))),
                "task.direct": {"taskId": TASK, "assignmentId": ASG},
                "workflow.start": {"workflowRunId": WF, "baseCommit": "abc123def456"}}
        base.update({k.replace("_", "."): v for k, v in answers.items()})
        return Fake(**base)

    def run_cli(self, fake, *argv, inp=None):
        raw = io.BytesIO()
        out, err = io.TextIOWrapper(raw, encoding="utf-8", write_through=True), io.StringIO()
        with mock.patch("agent_studio.dispatch.handle_request", fake), contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(err), mock.patch("builtins.input", side_effect=inp or []) as m:
            rc = cli.main(["team"] + list(argv) + ["--workspace", self.ws])
        self.input_calls = m.call_args_list
        return rc, raw.getvalue().decode(), err.getvalue()

    def state_file(self, key=KEY):
        return os.path.join(storycli.state_dir(self.ws), key + ".json")

    def put_state(self, **kw):
        os.makedirs(os.path.dirname(self.state_file()), exist_ok=True)
        json.dump(kw, open(self.state_file(), "w"), indent=2)

    def get_state(self):
        return json.load(open(self.state_file()))


class StateFiles(Env):
    def test_state_keys_are_kept_and_format_is_two_space_json(self):
        self.put_state(story=STORY, approved=True, extra="keep")
        storycli.save_state(self.ws, KEY, dict(storycli.load_state(self.ws, KEY), qaPassed=True))
        raw = open(self.state_file()).read()
        self.assertEqual(json.loads(raw), {"story": STORY, "approved": True, "extra": "keep", "qaPassed": True})
        self.assertEqual(raw, json.dumps(json.loads(raw), indent=2))

    def test_missing_story_is_bad_request(self):
        rc, out, err = self.run_cli(self.fake(), "qa", "nope.md")
        self.assertEqual(rc, 1)
        self.assertTrue(err.startswith("BAD_REQUEST: Story file not found in the workspace: nope.md"), err)


class Continuation(Env):
    def test_state_written_by_team_py_continues_with_qa_final_commit(self):
        self.write_config()
        self.put_state(story=STORY, approved=True, review="r", base="abc", workflow="w1", findings=["f"],
                       qaPassed=False)
        fake = self.fake()
        self.answers = [PASS]
        rc, out, err = self.run_cli(fake, "qa", STORY)
        self.assertEqual(rc, 0, err)
        s = self.get_state()
        self.assertEqual(s, {"story": STORY, "approved": True, "review": "r", "base": "abc", "workflow": "w1",
                             "findings": [], "qaPassed": True})
        self.answers = [PASS + "\n" + COMMIT]
        rc, out, err = self.run_cli(fake, "final", STORY)
        self.assertEqual(rc, 0, err)
        s = self.get_state()
        self.assertTrue(s["finalPassed"])
        self.assertEqual(s["commitMessage"], "Do the thing\n\nBody")
        self.assertIn("finalReview", s)
        rc, out, err = self.run_cli(fake, "commit", STORY, "--skip-integration", inp=["y"])
        self.assertEqual(rc, 0, err)
        self.assertEqual(self.get_state()["committed"], "abc123def456")
        self.assertIn(["commit", "-F", "-"], self.git_calls)
        commit = next(kw for argv, kw in self.runs if argv[:2] == ["git", "commit"])
        self.assertEqual(commit["input"], "Do the thing\n\nBody\n")


class RolePick(Env):
    def sent_nothing(self, fake):
        self.assertEqual(fake.sent("task.direct"), [])
        self.assertEqual(fake.sent("workflow.start"), [])

    def test_one_member_per_role_is_used(self):
        self.write_config()
        self.put_state(base="abc")
        self.answers = [PASS]
        fake = self.fake("TeamLead", "developer", "qa")
        rc, out, err = self.run_cli(fake, "qa", STORY)
        self.assertEqual(rc, 0, err)
        sent = fake.sent("task.direct")[0]
        self.assertEqual(sent["args"]["agentId"], aid(2))
        self.assertEqual(sent["args"]["policy"], "read_only")
        self.assertIn("idempotencyKey", sent)

    def test_no_member_with_the_role_is_role_unbound(self):
        self.write_config()
        self.put_state(base="abc")
        fake = self.fake("TeamLead", "Developer")
        rc, out, err = self.run_cli(fake, "qa", STORY)
        self.assertEqual(rc, 1)
        self.assertTrue(err.startswith("ROLE_UNBOUND:"), err)
        self.assertIn("--member", err)
        self.sent_nothing(fake)

    def test_several_members_is_role_ambiguous_naming_candidates(self):
        self.write_config()
        self.put_state(base="abc")
        fake = self.fake("TeamLead", "QA", "QA")
        rc, out, err = self.run_cli(fake, "qa", STORY)
        self.assertEqual(rc, 1)
        self.assertTrue(err.startswith("ROLE_AMBIGUOUS:"), err)
        self.assertIn("N1", err)
        self.assertIn("N2", err)
        self.sent_nothing(fake)

    def test_member_option_overrides_the_pick(self):
        self.write_config()
        self.put_state(base="abc")
        self.answers = [PASS]
        fake = self.fake("TeamLead", "QA", "QA")
        rc, out, err = self.run_cli(fake, "qa", STORY, "--member", "N2")
        self.assertEqual(rc, 0, err)
        self.assertEqual(fake.sent("task.direct")[0]["args"]["agentId"], aid(2))

    def test_dev_binds_developer_and_qa_in_the_p00_workflow(self):
        self.put_state(approved=True)
        self.wf_detail = {"workflowRun": {"id": WF, "status": "succeeded"}, "stageAttempts": []}
        fake = self.fake("TeamLead", "Developer", "QA")
        rc, out, err = self.run_cli(fake, "dev", STORY)
        self.assertEqual(rc, 0, err)
        args = fake.sent("workflow.start")[0]["args"]
        self.assertEqual((args["developerAgentId"], args["reviewerAgentId"]), (aid(1), aid(2)))
        self.assertEqual(self.get_state()["base"], "abc123def456")

    def test_unpack_prefers_product_owner_then_team_lead(self):
        (os.path.join(self.ws, "b.md"))
        open(os.path.join(self.ws, "b.md"), "w").write("brief")
        for roles, want_idx, tickets in ((("TeamLead", "ProductOwner"), 1, True), (("TeamLead", "QA"), 0, False)):
            self.answers = ["done"]
            fake = self.fake(*roles)
            rc, out, err = self.run_cli(fake, "unpack", "b.md", "--out", "phases/x")
            self.assertEqual(rc, 0, err)
            args = fake.sent("task.direct")[0]["args"]
            self.assertEqual(args["agentId"], aid(want_idx))
            self.assertEqual(args["policy"], "workspace_write")
            self.assertEqual("tickets.json" in args["text"], tickets)
            self.assertFalse(os.path.exists(self.state_file()))


class Gates(Env):
    def test_dev_without_approval_is_story_not_ready_and_force_passes(self):
        self.wf_detail = {"workflowRun": {"id": WF, "status": "failed"}, "stageAttempts": []}
        fake = self.fake()
        rc, out, err = self.run_cli(fake, "dev", STORY)
        self.assertEqual(rc, 1)
        self.assertTrue(err.startswith("STORY_NOT_READY:"), err)
        self.assertIn("team review", err)
        self.assertEqual(fake.sent("workflow.start"), [])
        rc, out, err = self.run_cli(fake, "dev", STORY, "--force")
        self.assertEqual(rc, 0, err)
        self.assertFalse(self.get_state()["qaPassed"])

    def test_dirty_tree_is_workspace_dirty(self):
        self.put_state(approved=True)
        self.dirty = " M x.py\n"
        fake = self.fake()
        rc, out, err = self.run_cli(fake, "dev", STORY)
        self.assertEqual(rc, 1)
        self.assertTrue(err.startswith("WORKSPACE_DIRTY:"), err)
        self.assertEqual(fake.sent("workflow.start"), [])

    def test_fix_and_qa_without_base_are_story_not_ready(self):
        for cmd in ("fix", "qa"):
            fake = self.fake()
            rc, out, err = self.run_cli(fake, cmd, STORY)
            self.assertEqual(rc, 1)
            self.assertTrue(err.startswith("STORY_NOT_READY:"), err)
            self.assertIn("team dev", err)
            self.assertEqual(fake.sent("task.direct"), [])

    def test_final_needs_qa_passed_unless_forced(self):
        self.write_config()
        self.put_state(base="abc", qaPassed=False)
        fake = self.fake()
        rc, out, err = self.run_cli(fake, "final", STORY)
        self.assertTrue(err.startswith("STORY_NOT_READY:"), err)
        self.answers = [FAIL]
        rc, out, err = self.run_cli(fake, "final", STORY, "--force")
        self.assertEqual(rc, 0, err)
        s = self.get_state()
        self.assertFalse(s["finalPassed"])
        self.assertFalse(s["qaPassed"])
        self.assertEqual(s["findings"], ["SUGGESTION: a", "blocker b"])

    def test_commit_needs_final_passed(self):
        self.put_state(base="abc", qaPassed=True)
        rc, out, err = self.run_cli(self.fake(), "commit", STORY)
        self.assertTrue(err.startswith("STORY_NOT_READY:"), err)
        self.assertIn("team final", err)

    def test_failing_gate_is_tests_failed_and_skip_skips_it(self):
        self.put_state(finalPassed=True)
        self.tests_ok = False
        rc, out, err = self.run_cli(self.fake(), "commit", STORY, inp=["n"])
        self.assertEqual(rc, 1)
        self.assertTrue(err.startswith("TESTS_FAILED:"), err)
        self.assertIn("--skip-integration", err)
        self.assertIn("team fix", err)
        rc, out, err = self.run_cli(self.fake(), "commit", STORY, "--skip-integration", inp=["n"])
        self.assertTrue(err.startswith("NOT_COMMITTED:"), err)
        self.assertNotIn("committed", self.get_state())
        self.assertNotIn(["add", "-A"], self.git_calls)

    def test_integration_keeps_touched_and_unit_replaces_it(self):
        self.write_config()
        self.put_state(base="abc")
        for flag, want in (([], "--unit"), (["--integration"], "--touched")):
            self.runs.clear()
            self.answers = [PASS]
            rc, out, err = self.run_cli(self.fake(), "qa", STORY, *flag)
            self.assertEqual(rc, 0, err)
            argv, kw = next(r for r in self.runs if r[0][0] == "python3")
            self.assertEqual(argv, ["python3", "scripts/validate.py", want])
            self.assertEqual(kw["timeout"], 5)

    def test_failed_unit_tests_save_the_canned_finding(self):
        self.write_config()
        self.put_state(base="abc")
        self.tests_ok = False
        self.answers = [PASS]
        self.run_cli(self.fake(), "qa", STORY)
        s = self.get_state()
        self.assertFalse(s["qaPassed"])
        self.assertEqual(s["findings"], ["unit tests fail - see the test output"])

    def test_agent_busy_waiting_input_adds_the_blocked_hint(self):
        self.write_config()
        self.put_state(base="abc")
        busy = envelope(None, False, error={"code": "AGENT_BUSY", "message": "N2 is waiting_input", "retryable": False})
        rc, out, err = self.run_cli(self.fake(task_direct=busy), "qa", STORY)
        self.assertEqual(rc, 1)
        self.assertIn("AGENT_BUSY:", err)
        self.assertIn("team blocked", err)
        self.assertIn("team resolve --member N2 --action fail", err)


class Review(Env):
    def setUp(self):
        super().setUp()
        self.status = [[], [" M phases/p/stories/P99-S01-x.md", " M notes.txt"]]

    def fake_run(self, argv, **kw):
        if argv[:3] == ["git", "status", "--porcelain"] and "--untracked-files=all" in argv:
            self.git_calls.append(argv[1:])
            out = "\n".join(self.status.pop(0)) + "\n"
            return subprocess.CompletedProcess(argv, 0, stdout=out)
        return super().fake_run(argv, **kw)

    def test_review_saves_state_lists_files_and_commits_only_planning(self):
        self.answers = [PASS]
        rc, out, err = self.run_cli(self.fake(), "review", STORY, inp=["y"])
        self.assertEqual(rc, 0, err)
        s = self.get_state()
        self.assertEqual((s["story"], s["approved"], s["review"]), (STORY, True, PASS))
        self.assertIn("===== team lead review (succeeded) =====", out)
        self.assertIn("WARNING: changes outside the planning documents", out)
        self.assertIn("notes.txt", out)
        self.assertEqual(self.input_calls[0].args[0], "Commit the planning changes now? [Y/n] ")
        self.assertIn(["add", "--", "phases/p/stories/P99-S01-x.md"], self.git_calls)
        self.assertIn(["commit", "-q", "-m", "Review P99-S01-x.md: story updated by the team lead", "--",
                       "phases/p/stories/P99-S01-x.md"], self.git_calls)
        self.assertIn("APPROVED - next: agent-studio team dev " + STORY, out)

    def test_json_never_prompts_or_commits_and_returns_edited_files(self):
        self.answers = [FAIL]
        rc, out, err = self.run_cli(self.fake(), "review", STORY, "--json")
        self.assertEqual(rc, 0, err)
        env = json.loads(out)
        self.assertTrue(env["ok"])
        d = env["data"]
        self.assertEqual(sorted(d), ["editedFiles", "key", "output", "state", "status", "story"])
        self.assertEqual(d["editedFiles"], ["notes.txt", "phases/p/stories/P99-S01-x.md"])
        self.assertEqual(d["state"]["approved"], False)
        self.assertEqual(self.input_calls, [])
        self.assertFalse([c for c in self.git_calls if c[0] == "commit"])


class JsonOutput(Env):
    def test_qa_json_envelope(self):
        self.write_config()
        self.put_state(base="abc")
        self.answers = [PASS]
        rc, out, err = self.run_cli(self.fake(), "qa", STORY, "--json")
        self.assertEqual(rc, 0, err)
        env = json.loads(out)
        self.assertEqual(env["data"]["story"], STORY)
        self.assertEqual(env["data"]["key"], KEY)
        self.assertEqual(env["data"]["status"], "succeeded")
        self.assertEqual(env["data"]["output"], PASS)
        self.assertTrue(env["data"]["state"]["qaPassed"])

    def test_commit_json_is_bad_request(self):
        self.put_state(finalPassed=True)
        rc, out, err = self.run_cli(self.fake(), "commit", STORY, "--json")
        self.assertEqual(rc, 1)
        env = json.loads(out)
        self.assertEqual(env["error"]["code"], "BAD_REQUEST")
        self.assertIn("without --json", env["error"]["message"])
        self.assertEqual(self.input_calls, [])


class Index(Env):
    def test_ctags_missing_is_bad_request(self):
        with mock.patch("agent_studio.storycli.shutil.which", return_value=None):
            rc, out, err = self.run_cli(self.fake(), "index")
        self.assertEqual(rc, 1)
        self.assertTrue(err.startswith("BAD_REQUEST:"), err)
        self.assertIn("sudo apt install universal-ctags", err)

    def test_index_runs_ctags_and_counts_symbols(self):
        def run(argv, **kw):
            os.makedirs(os.path.join(self.ws, ".agent-studio", "cache"), exist_ok=True)
            open(os.path.join(self.ws, ".agent-studio", "cache", "tags"), "w").write("!_TAG_X\na\nb\n")
            self.runs.append(argv)
            return subprocess.CompletedProcess(argv, 0, stdout="")
        with mock.patch("agent_studio.storycli.shutil.which", return_value="/usr/bin/ctags"), \
                mock.patch("agent_studio.storycli.subprocess.run", run):
            rc, out, err = self.run_cli(self.fake(), "index", "--json")
        self.assertEqual(rc, 0, err)
        self.assertEqual(json.loads(out)["data"], {"symbols": 2, "path": ".agent-studio/cache/tags"})
        self.assertEqual(self.runs[0][:2], ["ctags", "-R"])


class RunWorkflowStory(Env):
    def detail(self, status="succeeded", outcome="verdict_pass"):
        return {"workflowRun": {"id": WF, "status": status}, "route": "r",
                "stageAttempts": [{"assignmentId": ASG, "outcome": outcome,
                                   "verdict": {"verdict": "pass", "findings": ["f1"]}}],
                "assignments": [{"id": ASG, "result": {"finalText": "ok\n" + COMMIT}}]}

    def fake_wf(self):
        return Fake(**{"team.status": team_with("developer", "reviewer"),
                       "workflow.validate": {"definition": "pair", "stages": [], "bindings": {
                           "developer": {"agentId": aid(0)}, "reviewer": {"agentId": aid(1)}}},
                       "workflow.start": {"workflowRunId": WF, "baseCommit": "abc123def456"}})

    def test_story_run_sends_story_text_and_saves_state(self):
        self.wf_detail = self.detail()
        fake = self.fake_wf()
        rc, out, err = self.run_cli(fake, "run-workflow", "pair", "--story", STORY)
        self.assertEqual(rc, 0, err)
        text = fake.sent("workflow.start")[0]["args"]["text"]
        self.assertTrue(text.startswith(f"The story to deliver is in {STORY}. Read it first."))
        s = self.get_state()
        self.assertEqual(s, {"story": STORY, "base": "abc123def456", "workflow": WF, "findings": ["f1"],
                             "qaPassed": True, "finalPassed": True, "commitMessage": "Do the thing\n\nBody"})
        self.assertIn("Approved - next: agent-studio team commit " + STORY, out)

    def test_story_run_json_has_status_and_output(self):
        self.wf_detail = self.detail()
        rc, out, err = self.run_cli(self.fake_wf(), "run-workflow", "pair", "--story", STORY, "--json")
        self.assertEqual(rc, 0, err)
        d = json.loads(out)["data"]
        self.assertEqual((d["story"], d["status"]), (STORY, "succeeded"))
        self.assertIn("Do the thing", d["output"])
        self.assertTrue(d["state"]["finalPassed"] and d["key"])

    def test_commit_message_only_from_a_verdict_pass_stage(self):
        self.wf_detail = self.detail(status="failed", outcome="verdict_fail")
        rc, out, err = self.run_cli(self.fake_wf(), "run-workflow", "pair", "--story", STORY)
        s = self.get_state()
        self.assertEqual((s["qaPassed"], s["finalPassed"], s["commitMessage"]), (False, False, None))

    def test_story_run_refuses_a_dirty_tree_and_a_text(self):
        self.dirty = " M x\n"
        fake = self.fake_wf()
        rc, out, err = self.run_cli(fake, "run-workflow", "pair", "--story", STORY)
        self.assertTrue(err.startswith("WORKSPACE_DIRTY:"), err)
        self.dirty = ""
        rc, out, err = self.run_cli(fake, "run-workflow", "pair", "--story", STORY, "also text")
        self.assertTrue(err.startswith("BAD_REQUEST:"), err)
        self.assertEqual(fake.sent("workflow.start"), [])


class Attach(unittest.TestCase):
    def setUp(self):
        self.root = os.path.realpath(tempfile.mkdtemp(prefix="as-s05a-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.state = os.path.join(self.root, "state")
        patcher = mock.patch.dict(os.environ, {"XDG_STATE_HOME": self.state})
        patcher.start()
        self.addCleanup(patcher.stop)
        from agent_studio import teamdefs, workspace
        self.ws = os.path.join(self.root, "proj")
        os.makedirs(self.ws)
        workspace.init(self.ws)
        teamdefs.save(self.ws, {"id": "alpha", "name": "Alpha", "members": [
            {"id": "ryan", "name": "Ryan", "role": "developer", "provider": "fake"}]})

    def test_fixture_workspace_registry_is_isolated(self):
        registry = os.path.join(self.state, "agent-studio", "workspaces.json")
        with open(registry, encoding="utf-8") as f:
            entries = json.load(f)["workspaces"]
        self.assertEqual([entry["path"] for entry in entries], [self.ws])

    def test_definition_id_resolves_to_the_running_team(self):
        fake = Fake(team_attach={"argv": ["/bin/true"], "wsl": "x"})
        with mock.patch("agent_studio.dispatch.handle_request", fake):
            req = cli._human_request(["team", "attach", "--team", "alpha", "--workspace", self.ws, "--print"])
        self.assertEqual(req["command"], "team.attach")
        self.assertEqual(req["args"], {"teamId": TEAM})
        self.assertEqual(fake.sent("team.status")[0]["args"], {"workspace": self.ws, "teamDefId": "alpha"})

    def test_uuid_works_as_before_without_a_status_call(self):
        fake = Fake()
        with mock.patch("agent_studio.dispatch.handle_request", fake):
            req = cli._human_request(["team", "attach", "--team", TEAM])
        self.assertEqual(req["args"], {"teamId": TEAM})
        self.assertEqual(fake.requests, [])

    def test_stopped_definition_is_team_not_running(self):
        fake = Fake(team_status={"team": None, "members": []})
        with mock.patch("agent_studio.dispatch.handle_request", fake):
            with self.assertRaises(Exception) as cm:
                cli._human_request(["team", "attach", "--team", "alpha", "--workspace", self.ws])
        self.assertEqual(cm.exception.code, "TEAM_NOT_RUNNING")


class NoBoard(unittest.TestCase):
    # Concatenated so this file holds no literal name of a deleted module (the P04-S06 repo gate greps for them).
    BOARD = {"board", "board_" + "scheduler", "board_" + "config", "tick" + "ets", "bug" + "file",
             "man" + "ifest"}

    def test_no_board_imports_or_commands(self):
        for name in ("storycli", "teamcli"):
            path = os.path.join(os.path.dirname(storycli.__file__), name + ".py")
            tree = ast.parse(open(path).read())
            for node in ast.walk(tree):
                mods = set()
                if isinstance(node, ast.ImportFrom):
                    mods = {node.module or ""} | {a.name for a in node.names}
                elif isinstance(node, ast.Import):
                    mods = {a.name for a in node.names}
                self.assertFalse({m.split(".")[-1] for m in mods} & self.BOARD, (name, mods))
            src = open(path).read()
            # story commands send no board or ticket command; teamcli may send the board lifecycle
            # commands only (P04-S10 run-board / stop-board)
            banned = r'"(board|ticket)\.' if name == "storycli" else r'"(board|ticket)\.(?!run\b|stop\b)'
            self.assertNotRegex(src, banned)



class NoBoardRequests(Env):
    def test_every_built_request_avoids_board_commands(self):
        self.write_config()
        self.put_state(approved=True, base="abc", qaPassed=True, finalPassed=True)
        self.wf_detail = {"workflowRun": {"id": WF, "status": "succeeded"}, "stageAttempts": []}
        self.answers = [PASS, PASS, PASS, PASS]
        fake = self.fake()
        for cmd in ("review", "dev", "fix", "qa", "final"):
            self.run_cli(fake, cmd, STORY)
        self.assertTrue(fake.sent("task.direct") and fake.sent("workflow.start"))
        for r in fake.requests:
            self.assertFalse(r["command"].startswith(("board.", "ticket.")), r)
