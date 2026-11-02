"""P06: delegated command catalog, request rules, prompt sections and the detached runner (no coordinator)."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import tests.helpers  # noqa: F401  (puts backend/ on sys.path)
from agent_studio import delegation, prompts, state, workflowdef
from agent_studio.protocol import AsError

PY = sys.executable


def cat(**commands):
    return {"version": 1, "commands": commands or {"deps": {"description": "d", "argv": ["npm", "ci"],
                                                             "roles": ["Developer"]}}}


def cmd(**kw):
    return dict({"description": "d", "argv": ["npm", "ci"], "roles": ["Developer"]}, **kw)


class Config(unittest.TestCase):
    def code_path(self, raw):
        with self.assertRaises(AsError) as e:
            delegation.parse_config(raw)
        self.assertEqual(e.exception.code, delegation.DELEGATION_CONFIG_INVALID)
        return e.exception.data["path"]

    def test_defaults_fill_every_command(self):
        c = delegation.parse_config(cat())["commands"]["deps"]
        self.assertEqual({k: c[k] for k in delegation.DEFAULTS}, delegation.DEFAULTS)
        self.assertEqual((c["cwd"], c["env"], c["params"]), (".", {}, {}))

    def test_file_defaults_and_per_command_overrides(self):
        raw = dict(cat(a=cmd(), b=cmd(approval="human", maxPerVisit=5)), defaults={"network": True, "maxPerRun": 9})
        c = delegation.parse_config(raw)["commands"]
        self.assertEqual((c["a"]["network"], c["a"]["maxPerRun"], c["a"]["approval"]), (True, 9, "auto"))
        self.assertEqual((c["b"]["approval"], c["b"]["maxPerVisit"]), ("human", 5))
        self.assertEqual(delegation.parse_config(raw)["onDenialWithRequest"], "delegate")

    def test_each_bad_field_is_named(self):
        self.assertEqual(self.code_path({"version": 2, "commands": {}}), "$")
        self.assertEqual(self.code_path(dict(cat(), extra=1)), "extra")
        self.assertEqual(self.code_path(dict(cat(), defaults={"approval": "maybe"})), "defaults.approval")
        self.assertEqual(self.code_path({"version": 1}), "commands")
        self.assertEqual(self.code_path(cat(Bad=cmd())), "commands.Bad")
        self.assertEqual(self.code_path(cat(x=cmd(description=""))), "commands.x.description")
        self.assertEqual(self.code_path(cat(x=cmd(argv="npm ci"))), "commands.x.argv")
        self.assertEqual(self.code_path(cat(x=cmd(argv=["npm", "i", "pkg-{name}"],
                                                  params={"name": {"pattern": "x"}}))), "commands.x.argv[2]")
        self.assertEqual(self.code_path(cat(x=cmd(argv=["{name}"], params={"name": {"pattern": "x"}}))),
                         "commands.x.argv[0]")
        self.assertEqual(self.code_path(cat(x=cmd(argv=["npm", "{nope}"]))), "commands.x.argv[1]")
        self.assertEqual(self.code_path(cat(x=cmd(params={"name": {"pattern": "x"}}))), "commands.x.params.name")
        self.assertEqual(self.code_path(cat(x=cmd(argv=["a", "{n}"], params={"n": {"pattern": "("}}))),
                         "commands.x.params.n.pattern")
        self.assertEqual(self.code_path(cat(x=cmd(cwd="../up"))), "commands.x.cwd")
        self.assertEqual(self.code_path(cat(x=cmd(cwd="/abs"))), "commands.x.cwd")
        self.assertEqual(self.code_path(cat(x=cmd(env={"BAD-KEY": "1"}))), "commands.x.env")
        self.assertEqual(self.code_path(cat(x=cmd(roles="Developer"))), "commands.x.roles")
        self.assertEqual(self.code_path(cat(x=cmd(network=1))), "commands.x.network")
        self.assertEqual(self.code_path(cat(x=cmd(trackedChanges="sometimes"))), "commands.x.trackedChanges")
        self.assertEqual(self.code_path(cat(x=cmd(timeoutMs=10))), "commands.x.timeoutMs")
        self.assertEqual(self.code_path(cat(x=cmd(shell=True))), "commands.x.shell")

    def test_missing_file_is_off_and_bad_json_is_an_error(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d)
        self.assertIsNone(delegation.load_config(d))
        os.makedirs(os.path.join(d, ".agent-studio"))
        with open(os.path.join(d, delegation.CONFIG_REL), "w") as f:
            f.write("{nope")
        with self.assertRaises(AsError) as e:
            delegation.load_config(d)
        self.assertEqual(e.exception.code, delegation.DELEGATION_CONFIG_INVALID)


class TicketNotes(unittest.TestCase):
    def test_ticket_note_records_workflow_status_not_board_column(self):
        row = {"id": "ticket-1", "status": "in-progress", "workflow_status": "dev-active"}
        conn = mock.Mock()
        conn.execute.return_value.fetchone.return_value = row
        tx = mock.Mock(conn=conn)
        with mock.patch("agent_studio.boardmodel._ticket_event") as event:
            delegation.ticket_note(tx, "run-1", "delegation.started", {})
        self.assertIn("workflow_status", conn.execute.call_args.args[0])
        self.assertEqual(event.call_args.args[4:6], ("dev-active", "dev-active"))

    def test_ticket_note_falls_back_to_legacy_status(self):
        row = {"id": "ticket-1", "status": "in-progress", "workflow_status": None}
        conn = mock.Mock()
        conn.execute.return_value.fetchone.return_value = row
        tx = mock.Mock(conn=conn)
        with mock.patch("agent_studio.boardmodel._ticket_event") as event:
            delegation.ticket_note(tx, "run-1", "delegation.started", {})
        self.assertEqual(event.call_args.args[4:6], ("in-progress", "in-progress"))


def stage(role="Developer", permission="workspace_write", delegates=None, type_="agent"):
    return workflowdef.Stage(id="s", type=type_, role=role, permission=permission, prompt="x", prompt_source="inline",
                             max_visits=1, pass_requires=(), next={"done": "$succeed"}, kind="work",
                             delegates=delegates)


class Allowed(unittest.TestCase):
    cfg = delegation.parse_config(cat(a=cmd(), b=cmd(roles=["QA", "Developer"], trackedChanges="allow"),
                                      c=cmd(roles=["QA"])))

    def test_role_stage_list_and_read_only_rule(self):
        self.assertEqual(delegation.allowed_for(self.cfg, stage()), ["a", "b"])
        self.assertEqual(delegation.allowed_for(self.cfg, stage(role="QA")), ["b", "c"])
        self.assertEqual(delegation.allowed_for(self.cfg, stage(role="QA", permission="read_only")), ["c"])
        self.assertEqual(delegation.allowed_for(self.cfg, stage(delegates=("b",))), ["b"])
        self.assertEqual(delegation.allowed_for(self.cfg, stage(delegates=())), [])
        self.assertEqual(delegation.allowed_for(self.cfg, stage(type_="validation")), [])
        self.assertEqual(delegation.allowed_for(None, stage()), [])

    def test_unknown_delegates_id_is_refused_at_start(self):
        d = workflowdef.parse_obj({"version": 1, "stages": [
            {"id": "dev", "role": "Developer", "permission": "workspace_write", "prompt": "x",
             "next": {"done": "$succeed"}, "delegates": ["a", "zz"]}]}, "t.json")
        with self.assertRaises(AsError) as e:
            delegation.check_definition(d, self.cfg)
        self.assertEqual(e.exception.data, {"stage": "dev", "command": "zz"})
        delegation.check_definition(workflowdef.parse_obj({"version": 1, "stages": [
            {"id": "dev", "role": "Developer", "permission": "workspace_write", "prompt": "x",
             "next": {"done": "$succeed"}, "delegates": ["a"]}]}, "t.json"), self.cfg)


class Params(unittest.TestCase):
    c = delegation.parse_config(cat(add=cmd(argv=["npm", "install", "--save-dev", "{pkg}"],
                                            params={"pkg": {"pattern": "[a-z][a-z0-9-]*", "maxLength": 20}})))["commands"]["add"]

    def bad(self, params):
        with self.assertRaises(AsError) as e:
            delegation.render_argv(self.c, params)
        return e.exception.message

    def test_a_param_fills_its_whole_element_only(self):
        self.assertEqual(delegation.render_argv(self.c, {"pkg": "left-pad"}), ["npm", "install", "--save-dev", "left-pad"])
        self.assertEqual(delegation.render_argv(self.c, {"pkg": "$(rm -rf ~)"}.__class__({"pkg": "ok"})),
                         ["npm", "install", "--save-dev", "ok"])

    def test_refusals(self):
        self.assertIn("needs param", self.bad({}))
        self.assertIn("no param", self.bad({"pkg": "a", "other": "b"}))
        self.assertIn("may not start with '-'", self.bad({"pkg": "-rf"}))
        self.assertIn("does not match", self.bad({"pkg": "a;b"}))
        self.assertIn("does not match", self.bad({"pkg": "$(rm -rf ~)"}))
        self.assertIn("too long", self.bad({"pkg": "a" * 21}))
        self.assertIn("control character", self.bad({"pkg": "a\nb"}))
        self.assertIn("params must be an object", self.bad(["a"]))


class Text(unittest.TestCase):
    def test_markers(self):
        text = ('done\nAGENT_STUDIO_DELEGATE {"command": "a", "params": {"x": "1"}}\n'
                '  AGENT_STUDIO_DELEGATE {not json}\nsay AGENT_STUDIO_DELEGATE {"command": "b"}\n')
        found = delegation.parse_markers(text)
        self.assertEqual([o for o, _ in found], [{"command": "a", "params": {"x": "1"}}, None])
        self.assertEqual(delegation.parse_markers(None), [])
        self.assertEqual(len(delegation.parse_markers('AGENT_STUDIO_DELEGATE {"command": "a"}\n' * 30)), 20)

    def test_catalog_text_lists_only_the_given_ids(self):
        cfg = delegation.parse_config(cat(a=cmd(description="Install deps"), b=cmd(approval="human"),
                                          c=cmd(argv=["x", "{n}"], params={"n": {"pattern": "[a-z]+"}})))
        text = delegation.catalog_text(cfg, ["a", "b", "c"])
        self.assertIn("- a: Install deps (runs `npm ci` in .)", text)
        self.assertIn("needs human approval", text)
        self.assertIn("param n: value (must match [a-z]+", text)
        self.assertIn("delegated_command_request", text)
        self.assertNotIn("- b", delegation.catalog_text(cfg, ["a"]))
        self.assertEqual(delegation.catalog_text(cfg, []), "")

    def test_prompt_section_is_added_when_the_template_has_no_placeholder(self):
        out = prompts.render("Do it.", kind="work", task="t", stage="s", visit=1, delegated_commands="- a: x")
        self.assertIn("===== DELEGATED_COMMANDS =====\n- a: x\n", out)
        self.assertNotIn("DELEGATED_COMMANDS", prompts.render("Do it.", kind="work", task="t", stage="s", visit=1))
        placed = prompts.render("A {{delegated_commands}} B", kind="work", task="t", stage="s", visit=1)
        self.assertIn("(no delegated commands are available to this stage)", placed)
        self.assertEqual(placed.count("===== DELEGATED_COMMANDS"), 1)

    def test_resume_prompt_keeps_the_original_and_adds_data_sections(self):
        out = prompts.resume_prompt("ORIGINAL {{task}}\n", "[1] a: SUCCEEDED", "half done")
        self.assertTrue(out.startswith("ORIGINAL {{task}}\n"))  # never expanded again
        self.assertIn("===== PREVIOUS_SUMMARY =====\nhalf done\n", out)
        self.assertIn("===== DELEGATED =====\n[1] a: SUCCEEDED\n", out)

    def test_result_text(self):
        rows = [{"ordinal": 1, "command_id": "a", "argv_json": '["npm","ci"]', "status": "succeeded",
                 "result_json": json.dumps({"exitCode": 0, "durationMs": 5, "outputTail": "added 3"})},
                {"ordinal": 2, "command_id": "b", "argv_json": '["x"]', "status": "failed",
                 "result_json": json.dumps({"exitCode": None, "timedOut": True, "durationMs": 9})},
                {"ordinal": 3, "command_id": "c", "argv_json": '["x"]', "status": "rejected",
                 "result_json": json.dumps({"rejectedReason": "no"})},
                {"ordinal": 4, "command_id": "d", "argv_json": '["x"]', "status": "failed",
                 "result_json": json.dumps({"exitCode": 0, "trackedChanges": ["package.json"]})}]
        text = delegation.result_text(rows)
        self.assertIn("[1] a (`npm ci`): SUCCEEDED, 5 ms.\nOutput (last part):\nadded 3", text)
        self.assertIn("[2] b (`x`): TIMED OUT", text)
        self.assertIn("[3] c (`x`): NOT RUN - rejected: no", text)
        self.assertIn("changed tracked files, which this command may not do: package.json", text)


class Definitions(unittest.TestCase):
    def parse(self, delegates, type_=None):
        st = {"id": "dev", "role": "Developer", "permission": "workspace_write", "prompt": "x",
              "next": {"done": "$succeed"}, "delegates": delegates}
        if type_:
            st = {"id": "dev", "type": type_, "delegates": delegates}
        return workflowdef.parse_obj({"version": 1, "stages": [st]}, "t.json")

    def test_delegates_round_trip_through_the_frozen_form(self):
        d = self.parse(["a", "b"])
        self.assertEqual(d.stages[0].delegates, ("a", "b"))
        again = workflowdef.from_json(json.loads(workflowdef.to_json(d)))
        self.assertEqual(again.stages[0].delegates, ("a", "b"))
        self.assertEqual(self.parse([]).stages[0].delegates, ())

    def test_absent_means_none_and_bad_values_are_errors(self):
        d = workflowdef.parse_obj({"version": 1, "stages": [
            {"id": "dev", "role": "Developer", "permission": "workspace_write", "prompt": "x",
             "next": {"done": "$succeed"}}]}, "t.json")
        self.assertIsNone(d.stages[0].delegates)
        self.assertNotIn("delegates", workflowdef.to_json(d))
        for bad in ("a", ["A"], ["a", "a"], [1]):
            with self.assertRaises(AsError):
                self.parse(bad)
        with self.assertRaises(AsError):
            workflowdef.parse_obj({"version": 1, "stages": [
                {"id": "v", "type": "validation", "delegates": []}]}, "t.json")


class Runner(unittest.TestCase):
    def setUp(self):
        self.ws = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.ws)
        git = lambda *a: subprocess.run(["git", "-C", self.ws] + list(a), check=True, capture_output=True)
        git("init", "-q")
        git("config", "user.email", "t@example.invalid")
        git("config", "user.name", "t")
        with open(os.path.join(self.ws, "tracked.txt"), "w") as f:
            f.write("one\n")
        os.makedirs(os.path.join(self.ws, "app"))
        git("add", "-A")
        git("commit", "-qm", "base")
        self.n = 0

    def run_cmd(self, argv, **kw):
        self.n += 1
        c = dict(delegation.parse_config(cat(x=cmd(argv=argv, **kw)))["commands"]["x"])
        run_dir = os.path.join(self.ws, ".runs", str(self.n))
        os.makedirs(run_dir)
        root = os.path.realpath(self.ws)
        req = {"argv": argv, "cwd": os.path.realpath(os.path.join(root, c["cwd"])), "workspace": root,
               "timeoutMs": c["timeoutMs"], "env": c["env"], "network": c["network"],
               "trackedChanges": c["trackedChanges"], "command": "x", "requestId": "r"}
        with open(os.path.join(run_dir, "request.json"), "w") as f:
            json.dump(req, f)
        self.assertEqual(delegation.run_delegated(run_dir), 0)
        return delegation.result(run_dir)

    def test_success_failure_and_output(self):
        ok = self.run_cmd([PY, "-c", "import os; print('in', os.path.basename(os.getcwd()))"], cwd="app")
        self.assertEqual((ok["exitCode"], ok["passed"]), (0, True))
        self.assertIn("in app", ok["outputTail"])
        bad = self.run_cmd([PY, "-c", "import sys; print('boom'); sys.exit(3)"])
        self.assertEqual((bad["exitCode"], bad["passed"]), (3, False))
        missing = self.run_cmd(["definitely-not-a-command-xyz"])
        self.assertIn("command not found", missing["error"])

    def test_timeout(self):
        r = self.run_cmd([PY, "-c", "import time; time.sleep(30)"], timeoutMs=1000)
        self.assertTrue(r["timedOut"])
        self.assertFalse(r["passed"])
        self.assertLess(r["durationMs"], 15000)

    def test_tracked_changes_forbidden_by_default_allowed_on_request(self):
        touch = [PY, "-c", "open('tracked.txt', 'a').write('two\\n')"]
        r = self.run_cmd(touch)
        self.assertEqual((r["exitCode"], r["trackedChanges"], r["passed"]), (0, ["tracked.txt"], False))
        untracked = self.run_cmd([PY, "-c", "open('new.txt', 'w').write('x')"])
        self.assertTrue(untracked["passed"])
        allowed = self.run_cmd(touch, trackedChanges="allow")
        self.assertTrue(allowed["passed"])
        self.assertNotIn("trackedChanges", allowed)

    def test_environment_is_an_allowlist_plus_the_entry(self):
        show = [PY, "-c", "import os; print(os.environ.get('HTTPS_PROXY'), os.environ.get('MY_FLAG'), "
                          "os.environ.get('SECRET_TOKEN'), os.environ.get('AGENT_STUDIO_DELEGATED_COMMAND'))"]
        with mock.patch.dict(os.environ, {"HTTPS_PROXY": "http://proxy:1", "SECRET_TOKEN": "s3cret"}):
            off = self.run_cmd(show, env={"MY_FLAG": "1"})
            on = self.run_cmd(show, env={"MY_FLAG": "1"}, network=True)
        self.assertIn("None 1 None x", off["outputTail"])
        self.assertIn("http://proxy:1 1 None x", on["outputTail"])

    def test_spawn_refuses_a_cwd_that_escapes_through_a_link(self):
        os.symlink("/tmp", os.path.join(self.ws, "out"))
        c = delegation.parse_config(cat(x=cmd(cwd="out")))["commands"]["x"]
        with self.assertRaises(AsError):
            delegation.spawn(os.path.join(self.ws, ".runs", "s"), self.ws, {"argv_json": '["npm"]', "id": "r"}, c)


class Migration(unittest.TestCase):
    def test_the_requests_table_exists_after_migrating(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d)
        path = os.path.join(d, "s.db")
        conn = state.connect(path, role="coordinator", create=True)
        self.assertEqual(state.migrate(conn, path), 19)
        cols = {r[1] for r in conn.execute("PRAGMA table_info(command_requests)")}
        self.assertTrue({"command_id", "argv_json", "status", "result_json", "visit", "ordinal"} <= cols)
        conn.close()


if __name__ == "__main__":
    unittest.main()


class PassRequiresCommands(unittest.TestCase):
    def parse(self, **extra):
        st = dict({"id": "dev", "role": "Developer", "permission": "workspace_write", "prompt": "x",
                   "next": {"pass": "$succeed", "fail": "$fail"}}, **extra)
        return workflowdef.parse_obj({"version": 1, "stages": [st]}, "t.json")

    def test_only_on_verdict_stages_and_round_trips(self):
        d = self.parse(passRequiresCommands=["test-all", "test-all"])
        self.assertEqual(d.stages[0].pass_requires_commands, ("test-all",))
        again = workflowdef.from_json(json.loads(workflowdef.to_json(d)))
        self.assertEqual(again.stages[0].pass_requires_commands, ("test-all",))
        self.assertNotIn("passRequiresCommands", workflowdef.to_json(self.parse()))
        for bad in ([], "test-all", ["Bad"]):
            with self.assertRaises(AsError):
                self.parse(passRequiresCommands=bad)
        with self.assertRaises(AsError):
            workflowdef.parse_obj({"version": 1, "stages": [
                {"id": "dev", "role": "Developer", "permission": "workspace_write", "prompt": "x",
                 "next": {"done": "$succeed"}, "passRequiresCommands": ["test-all"]}]}, "t.json")

    def test_unknown_required_command_is_refused_at_start(self):
        cfg = delegation.parse_config(cat(a=cmd()))
        with self.assertRaises(AsError) as e:
            delegation.check_definition(self.parse(passRequiresCommands=["test-all"]), cfg)
        self.assertEqual(e.exception.data, {"stage": "dev", "command": "test-all"})


class Fingerprint(unittest.TestCase):
    def setUp(self):
        self.ws = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.ws)
        self.git = lambda *a: subprocess.run(["git", "-C", self.ws] + list(a), check=True, capture_output=True)
        self.git("init", "-q")
        self.git("config", "user.email", "t@example.invalid")
        self.git("config", "user.name", "t")
        with open(os.path.join(self.ws, ".gitignore"), "w") as f:
            f.write("ignored/\n")
        self.write("a.txt", "one\n")
        self.git("add", "-A")
        self.git("commit", "-qm", "base")

    def write(self, rel, text):
        path = os.path.join(self.ws, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(text)

    def test_tracks_tracked_edits_and_untracked_content_but_not_ignored_files(self):
        fp = delegation.workspace_fingerprint
        base = fp(self.ws)
        self.assertEqual(fp(self.ws), base)
        self.write("ignored/x.log", "noise")
        self.assertEqual(fp(self.ws), base)
        self.write("new_test.py", "x = 1\n")
        with_new = fp(self.ws)
        self.assertNotEqual(with_new, base)
        self.write("new_test.py", "x = 2\n")
        self.assertNotEqual(fp(self.ws), with_new)
        os.remove(os.path.join(self.ws, "new_test.py"))
        self.assertEqual(fp(self.ws), base)
        self.write("a.txt", "two\n")
        self.assertNotEqual(fp(self.ws), base)
        self.assertIsNone(fp(tempfile.mkdtemp()))


class VerifyPass(unittest.TestCase):
    """verify_pass reads command_requests through tx.conn; an in-memory table is enough."""

    def setUp(self):
        import sqlite3
        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("CREATE TABLE command_requests (id TEXT, workflow_run_id TEXT, command_id TEXT, status TEXT, "
                          "ordinal INTEGER, result_json TEXT)")
        self.tx = type("Tx", (), {"conn": self.conn})()
        self.n = 0

    def add(self, command, status, fingerprint, run="w1", **res):
        self.n += 1
        self.conn.execute("INSERT INTO command_requests VALUES (?, ?, ?, ?, ?, ?)",
                          (f"r{self.n}", run, command, status, self.n,
                           json.dumps(dict(res, workspaceFingerprint=fingerprint))))

    def verify(self, now="F2"):
        with mock.patch.object(delegation, "workspace_fingerprint", return_value=now):
            return delegation.verify_pass(self.tx, {"id": "w1"}, ("test-all",), "/ws")

    def test_needs_a_run_in_this_run(self):
        self.add("test-all", "succeeded", "F2", run="other")
        self.add("test-unit", "succeeded", "F2")
        self.assertIn("was not run", self.verify())

    def test_passes_only_on_the_current_code(self):
        self.add("test-all", "succeeded", "F1")
        self.assertIn("code changed after the last test-all run", self.verify())
        self.add("test-all", "succeeded", "F2")
        self.assertIsNone(self.verify())

    def test_the_newest_run_on_this_code_decides(self):
        self.add("test-all", "succeeded", "F2")
        self.add("test-all", "failed", "F2", exitCode=1)
        self.assertIn("latest test-all run on the final code failed (exit 1)", self.verify())
        self.add("test-all", "succeeded", "F2")
        self.assertIsNone(self.verify())

    def test_cannot_fingerprint(self):
        self.add("test-all", "succeeded", "F2")
        self.assertIn("could not fingerprint", self.verify(now=None))


class RequiredSuite(unittest.TestCase):
    def test_the_changed_files_pick_the_suite(self):
        r = lambda *paths: delegation.required_suite(set(paths))[0]
        self.assertEqual(r("app/src/renderer/a.tsx", "app/test/a.test.tsx", "app/package.json"), "test-ui")
        self.assertEqual(r("backend/agent_studio/a.py", "tests/unit/test_a.py"), "test-backend")
        self.assertEqual(r("tests/integration/test_a.py"), "test-backend")
        self.assertEqual(r("app/src/a.ts", "backend/a.py"), "test-all")
        self.assertEqual(r("scripts/validate.py"), "test-all")
        self.assertEqual(r("app/src/a.ts", "scripts/validate.py"), "test-all")
        self.assertEqual(r("phases/phase-05/README.md", "design/x.png", ".agent-studio/commands.json"), "test-all")
        self.assertEqual(r(), "test-all")
        self.assertEqual(r("app/src/a.ts", "phases/phase-05/README.md"), "test-ui")   # docs alongside do not widen it
        self.assertEqual(delegation.required_suite(None)[0], "test-all")
        self.assertIn("only the app", delegation.required_suite({"app/a.ts"})[1])

    def test_a_directory_named_like_a_prefix_does_not_count(self):
        self.assertEqual(delegation.required_suite({"application/x.ts", "backendish/y.py"})[0], "test-all")


class ChangedPaths(unittest.TestCase):
    def setUp(self):
        self.ws = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.ws)
        self.git = lambda *a: subprocess.run(["git", "-C", self.ws] + list(a), check=True, capture_output=True)
        self.git("init", "-q")
        self.git("config", "user.email", "t@example.invalid")
        self.git("config", "user.name", "t")
        self.write("README.md", "x\n")
        self.write("app/old.ts", "x\n")
        self.git("add", "-A")
        self.git("commit", "-qm", "base")
        self.git("branch", "-f", "main", "HEAD")   # the base branch the run branched from

    def write(self, rel, text):
        path = os.path.join(self.ws, rel)
        os.makedirs(os.path.dirname(path) or self.ws, exist_ok=True)
        with open(path, "w") as f:
            f.write(text)

    def test_committed_uncommitted_untracked_and_deleted_all_count(self):
        self.git("checkout", "-q", "-b", "ticket")
        self.assertEqual(delegation.changed_paths(self.ws), set())
        self.write("backend/a.py", "x\n")
        self.git("add", "-A")
        self.git("commit", "-qm", "round 1")          # committed since leaving main
        self.assertEqual(delegation.changed_paths(self.ws), {"backend/a.py"})
        self.write("README.md", "changed\n")           # uncommitted
        self.write("tests/unit/new_test.py", "x\n")    # untracked
        os.remove(os.path.join(self.ws, "app", "old.ts"))   # deleted, still tracked
        self.assertEqual(delegation.changed_paths(self.ws),
                         {"backend/a.py", "README.md", "tests/unit/new_test.py", "app/old.ts"})
        self.assertEqual(delegation.required_suite(delegation.changed_paths(self.ws))[0], "test-all")

    def test_ui_only_branch_and_the_board_json_base_branch(self):
        self.git("checkout", "-q", "-b", "ticket")
        self.write(".agent-studio/board.json", json.dumps({"baseBranch": "develop"}))
        self.git("add", "-A")
        self.git("commit", "-qm", "board")
        self.git("branch", "develop", "HEAD")           # the configured base leaves main behind
        self.write("app/src/a.tsx", "x\n")
        self.git("add", "-A")
        self.git("commit", "-qm", "ui")
        self.assertEqual(delegation.changed_paths(self.ws), {"app/src/a.tsx"})
        self.assertEqual(delegation.required_suite(delegation.changed_paths(self.ws))[0], "test-ui")

    def test_not_a_repository(self):
        self.assertIsNone(delegation.changed_paths(tempfile.mkdtemp()))


class VerifyPassBySuite(VerifyPass):
    """The standard suites: the changed files decide which one must have passed on this code."""
    IDS = ("test-all", "test-backend", "test-ui")

    def verify_for(self, paths, now="F2"):
        with mock.patch.object(delegation, "workspace_fingerprint", return_value=now), \
                mock.patch.object(delegation, "changed_paths", return_value=paths):
            return delegation.verify_pass(self.tx, {"id": "w1"}, self.IDS, "/ws")

    def test_a_ui_only_change_needs_test_ui_not_test_backend(self):
        self.add("test-backend", "succeeded", "F2")
        msg = self.verify_for({"app/src/a.ts"})
        self.assertIn("test-ui or test-all was not run", msg)
        self.assertIn("only the app", msg)
        self.add("test-ui", "succeeded", "F2")
        self.assertIsNone(self.verify_for({"app/src/a.ts"}))

    def test_a_backend_only_change_needs_test_backend_not_test_ui(self):
        self.add("test-ui", "succeeded", "F2")
        self.assertIn("test-backend or test-all was not run", self.verify_for({"backend/a.py"}))
        self.add("test-backend", "succeeded", "F2")
        self.assertIsNone(self.verify_for({"backend/a.py"}))

    def test_test_all_covers_any_change(self):
        self.add("test-all", "succeeded", "F2")
        for paths in ({"app/a.ts"}, {"backend/a.py"}, {"app/a.ts", "backend/a.py"}, set(), None):
            self.assertIsNone(self.verify_for(paths), paths)

    def test_a_change_to_both_sides_needs_test_all(self):
        self.add("test-ui", "succeeded", "F2")
        self.add("test-backend", "succeeded", "F2")
        self.assertIn("test-all was not run", self.verify_for({"app/a.ts", "backend/a.py"}))

    def test_a_failing_wider_run_does_not_cancel_a_passing_required_one(self):
        self.add("test-ui", "succeeded", "F2")
        self.add("test-all", "failed", "F2", exitCode=1)   # newer, but the backend failed for an unrelated reason
        self.assertIsNone(self.verify_for({"app/a.ts"}))

    def test_failures_and_stale_runs_are_reported_for_the_required_suite(self):
        self.add("test-ui", "failed", "F2", exitCode=1)
        self.assertIn("latest test-ui run on the final code failed (exit 1)", self.verify_for({"app/a.ts"}))
        self.add("test-ui", "succeeded", "F1")
        self.assertIn("latest test-ui run on the final code failed", self.verify_for({"app/a.ts"}))
        self.assertIn("code changed after the last test-ui or test-all run", self.verify_for({"app/a.ts"}, now="F3"))

    def test_a_stage_with_only_other_commands_keeps_any_of_semantics(self):
        self.add("test-all", "succeeded", "F2")
        with mock.patch.object(delegation, "workspace_fingerprint", return_value="F2"), \
                mock.patch.object(delegation, "changed_paths", side_effect=AssertionError("not consulted")):
            self.assertIsNone(delegation.verify_pass(self.tx, {"id": "w1"}, ("test-all",), "/ws"))


class ResumeMessageAndFlag(unittest.TestCase):
    def test_the_resume_message_holds_only_the_results(self):
        from agent_studio import prompts
        text = prompts.resume_message("deps-setup SUCCEEDED\ninstalled all")
        self.assertIn("===== DELEGATED =====\ndeps-setup SUCCEEDED", text)
        self.assertNotIn("PREVIOUS_SUMMARY", text)
        self.assertNotIn("TASK", text)

    def test_resumeSession_must_be_a_bool(self):
        from agent_studio import delegation
        base = {"version": 1, "commands": {}}
        self.assertTrue(delegation.parse_config(base)["resumeSession"])
        self.assertFalse(delegation.parse_config(dict(base, resumeSession=False))["resumeSession"])
        with self.assertRaises(Exception):
            delegation.parse_config(dict(base, resumeSession="no"))
