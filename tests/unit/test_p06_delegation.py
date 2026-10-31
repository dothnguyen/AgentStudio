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
        self.assertEqual(state.migrate(conn, path), 18)
        cols = {r[1] for r in conn.execute("PRAGMA table_info(command_requests)")}
        self.assertTrue({"command_id", "argv_json", "status", "result_json", "visit", "ordinal"} <= cols)
        conn.close()


if __name__ == "__main__":
    unittest.main()
