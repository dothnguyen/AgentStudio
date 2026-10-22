"""P01-S01: definition model, JSON loader, static validation, frozen form."""
import copy
import hashlib
import json
import os
import tempfile
import unittest
from unittest import mock

import tests.helpers  # noqa: F401  (puts backend/ on sys.path)
from agent_studio import workflowdef as wd
from agent_studio.protocol import AsError

FILE = ".agent-studio/workflows/t.json"

SECTION_B = {
    "version": 1,
    "description": "Developer implements, tests run, QA reviews, TeamLead signs off.",
    "maxSteps": 16,
    "stages": [
        {"id": "develop", "role": "Developer", "permission": "workspace_write", "maxVisits": 3,
         "promptFile": "prompts/develop.md", "next": {"done": "tests"}},
        {"id": "tests", "type": "validation", "maxVisits": 3, "next": {"pass": "qa", "fail": "qa"}},
        {"id": "qa", "role": "QA", "permission": "read_only", "maxVisits": 3, "passRequires": ["tests"],
         "prompt": "Review DIFF.\n{{task}}\n{{diff}}\n{{validation}}\n", "next": {"pass": "final", "fail": "develop"}},
        {"id": "final", "role": "TeamLead", "permission": "read_only", "maxVisits": 2,
         "promptFile": "prompts/final-review.md", "next": {"pass": "$succeed", "fail": "develop"}},
    ],
}

DEFAULTS = {
    "version": 1,
    "stages": [
        {"id": "a", "role": "Dev", "permission": "workspace_write", "prompt": "do {{diff}}", "next": {"done": "b"}},
        {"id": "b", "type": "validation"},
        {"id": "c", "role": "QA", "permission": "read_only", "prompt": "check {{diff}}", "next": {"fail": "a"}},
        {"id": "d", "role": "QA", "permission": "read_only", "prompt": "last {{diff}}", "next": {"fail": "a"}},
    ],
}


def stage(**kw):
    s = {"id": "a", "role": "Dev", "permission": "read_only", "prompt": "x", "next": {"done": "$succeed"}}
    s.update(kw)
    return s


def definition(*stages, **top):
    d = {"version": 1, "stages": list(stages)}
    d.update(top)
    return d


def errors_of(obj, prompts=None, source=FILE):
    with_err = None
    try:
        wd.parse_obj(obj, source, prompts)
    except AsError as e:
        with_err = e
    assert with_err is not None, "expected WORKFLOW_DEFINITION_INVALID"
    assert with_err.code == wd.WORKFLOW_DEFINITION_INVALID
    return with_err.data["errors"]


class Ws(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.ws = os.path.join(self._tmp.name, "ws")
        os.makedirs(os.path.join(self.ws, ".agent-studio", "workflows"))
        os.makedirs(os.path.join(self.ws, ".agent-studio", "prompts"))
        self.write_prompt("develop.md", "Develop: {{task}}")
        self.write_prompt("final-review.md", "Final {{diff}}")

    def write_prompt(self, name, text, base=None):
        base = base or os.path.join(self.ws, ".agent-studio", "prompts")
        os.makedirs(base, exist_ok=True)
        with open(os.path.join(base, name), "wb") as f:
            f.write(text if isinstance(text, bytes) else text.encode())

    def write_def(self, name, obj, ext=".json", folder=None):
        folder = folder or os.path.join(self.ws, ".agent-studio", "workflows")
        os.makedirs(folder, exist_ok=True)
        data = obj if isinstance(obj, bytes) else (obj if isinstance(obj, str) else json.dumps(obj)).encode()
        with open(os.path.join(folder, name + ext), "wb") as f:
            f.write(data)

    def invalid(self, name):
        with self.assertRaises(AsError) as cm:
            wd.load(self.ws, name)
        self.assertEqual(cm.exception.code, wd.WORKFLOW_DEFINITION_INVALID)
        return cm.exception.data["errors"]

    def assertErr(self, errs, path, fragment=None, line=None):
        hits = [e for e in errs if e["path"] == path]
        self.assertTrue(hits, f"no error at {path}: {errs}")
        if fragment:
            self.assertTrue(any(fragment in e["message"] for e in hits), hits)
        for e in hits:
            self.assertEqual(set(e), {"file", "path", "line", "message"})
        if line is not None:
            self.assertEqual(hits[0]["line"], line)


class Loading(Ws):
    def test_section_b_example_loads_with_kinds_targets_and_limits(self):
        self.write_def("story-dev", SECTION_B)
        d = wd.load(self.ws, "story-dev")
        self.assertEqual((d.name, d.version, d.max_steps), ("story-dev", 1, 16))
        self.assertEqual([s.kind for s in d.stages], ["work", "validation", "verdict", "verdict"])
        self.assertEqual([s.max_visits for s in d.stages], [3, 3, 3, 2])
        self.assertEqual(dict(d.stages[0].next), {"done": "tests"})
        self.assertEqual(dict(d.stages[3].next), {"pass": "$succeed", "fail": "develop"})
        self.assertEqual(d.stages[2].pass_requires, ("tests",))
        self.assertEqual(d.stages[0].prompt, "Develop: {{task}}")
        self.assertEqual(d.stages[0].prompt_source, "prompts/develop.md")
        self.assertEqual(d.stages[2].prompt_source, "inline")
        self.assertIsNone(d.stages[1].prompt)
        self.assertIsNone(d.stages[1].prompt_source)

    def test_defaults_fixture_fills_documented_defaults(self):
        d = wd.parse_obj(DEFAULTS, FILE)
        self.assertEqual((d.max_steps, d.description), (20, ""))
        self.assertTrue(all(s.max_visits == 1 for s in d.stages))
        self.assertEqual(d.stages[0].type, "agent")
        self.assertEqual(dict(d.stages[1].next), {"pass": "c", "fail": "$fail"})
        self.assertEqual(dict(d.stages[2].next), {"pass": "d", "fail": "a"})
        self.assertEqual(dict(d.stages[3].next), {"pass": "$succeed", "fail": "a"})
        v = wd.parse_obj(definition(stage(next={"pass": "$succeed"})), FILE)
        self.assertEqual(dict(v.stages[0].next), {"pass": "$succeed", "fail": "$fail"})

    def test_definition_is_immutable(self):
        d = wd.parse_obj(DEFAULTS, FILE)
        with self.assertRaises(Exception):
            d.name = "x"
        with self.assertRaises(TypeError):
            d.stages[0].next["done"] = "x"

    def test_several_errors_are_all_returned_in_file_order(self):
        errs = errors_of({"version": 2, "description": 3, "maxSteps": 0, "stages": [
            stage(id="Bad"), stage(id="b", permission="x"), stage(id="c", next={"done": "zzz"})]})
        self.assertEqual([e["path"] for e in errs], ["version", "description", "maxSteps", "stages[0].id",
                                                     "stages[1].permission", "stages[2].next.done"])
        self.assertTrue(all(e["file"] == FILE and e["line"] is None for e in errs))

    def test_errors_follow_key_order_in_the_file_not_validation_order(self):
        bad = {"zzz": 1, "id": "Bad", "role": "R", "permission": "read_only", "prompt": "x",
               "next": {"done": "$succeed"}}
        errs = errors_of({"version": 1, "stages": [bad], "maxSteps": 0})
        self.assertEqual([e["path"] for e in errs], ["stages[0].zzz", "stages[0].id", "maxSteps"])
        late = {"next": {"done": "nope"}, "permission": "x", "id": "a", "role": "R", "prompt": "p"}
        errs = errors_of({"stages": [late], "version": 2})
        self.assertEqual([e["path"] for e in errs],
                         ["stages[0].next.done", "stages[0].permission", "version"])

    def test_lone_surrogate_in_description_or_role_is_rejected(self):
        errs = errors_of(definition(stage(role="\ud800"), description="\ud800"))
        self.assertEqual(sorted(e["path"] for e in errs), ["description", "stages[0].role"])

    def test_error_carries_count_and_file_in_message(self):
        with self.assertRaises(AsError) as cm:
            wd.parse_obj([], "label")
        self.assertEqual(cm.exception.message, "1 error(s) in label")
        self.assertEqual(cm.exception.data["errors"][0]["path"], "$")


class TopLevelRules(unittest.TestCase):
    def test_top_level_rules(self):
        ok = stage()
        cases = [
            ([], "$"), ("x", "$"),
            ({"stages": [ok]}, "version"), ({"version": "1", "stages": [ok]}, "version"),
            ({"version": True, "stages": [ok]}, "version"), ({"version": 2, "stages": [ok]}, "version"),
            (definition(ok, extra=1), "extra"),
            (definition(ok, description=5), "description"),
            (definition(ok, maxSteps="3"), "maxSteps"), (definition(ok, maxSteps=0), "maxSteps"),
            (definition(ok, maxSteps=101), "maxSteps"), (definition(ok, maxSteps=True), "maxSteps"),
            (definition(ok, maxSteps=2.0), "maxSteps"),
            ({"version": 1}, "stages"), ({"version": 1, "stages": []}, "stages"),
            ({"version": 1, "stages": {}}, "stages"),
            ({"version": 1, "stages": [stage(id=f"s{i}", next={"done": "$succeed"}) for i in range(21)]}, "stages"),
        ]
        for obj, path in cases:
            with self.subTest(obj=str(obj)[:60]):
                hits = [e for e in errors_of(obj) if e["path"] == path]
                self.assertTrue(hits)
                for e in hits:
                    self.assertEqual(e["file"], FILE)
                    self.assertTrue(e["message"])
                    self.assertIsNone(e["line"])


class StageRules(unittest.TestCase):
    def check(self, obj, path, fragment=""):
        errs = errors_of(obj)
        hits = [e for e in errs if e["path"] == path and fragment in e["message"]]
        self.assertTrue(hits, f"{path} / {fragment!r} not in {errs}")
        for e in hits:
            self.assertEqual(e["file"], FILE)
            self.assertIn("line", e)
            self.assertIsNone(e["line"])

    def test_stage_shape(self):
        self.check(definition("x"), "stages[0]")
        self.check(definition(stage(id="Bad")), "stages[0].id")
        self.check(definition(stage(id=3)), "stages[0].id")
        s = stage()
        del s["id"]
        self.check(definition(s), "stages[0].id")
        self.check(definition(stage(), stage(next={"done": "$succeed"})), "stages[1].id", "duplicate")
        self.check(definition(stage(bogus=1)), "stages[0].bogus", "unknown key")
        self.check(definition(stage(type="human")), "stages[0].type")

    def test_agent_stage_rules(self):
        for key, path in (("role", "stages[0].role"), ("permission", "stages[0].permission")):
            s = stage()
            del s[key]
            self.check(definition(s), path, "required")
        self.check(definition(stage(role=3)), "stages[0].role")
        self.check(definition(stage(permission="admin")), "stages[0].permission")
        s = stage()
        del s["prompt"]
        self.check(definition(s), "stages[0]", "exactly one")
        self.check(definition(stage(promptFile="p.md")), "stages[0]", "exactly one")
        self.check(definition(stage(prompt="")), "stages[0].prompt", "empty")
        self.check(definition(stage(prompt=4)), "stages[0].prompt")
        self.check(definition(stage(prompt="x" * (32 * 1024 + 1))), "stages[0].prompt", "32 KiB")
        s = stage()
        del s["next"]
        self.check(definition(s), "stages[0].next", "required")
        self.check(definition(stage(next=["done"])), "stages[0].next", "object")
        self.check(definition(stage(next={})), "stages[0].next", "empty")
        self.check(definition(stage(next={"done": "$succeed", "maybe": "a"})), "stages[0].next.maybe")
        self.check(definition(stage(next={"done": "$succeed", "pass": "$succeed"})), "stages[0].next", "cannot")
        self.check(definition(stage(next={"done": "$succeed", "fail": "$fail"})), "stages[0].next", "cannot")

    def test_validation_stage_rules(self):
        for key, val in (("role", "R"), ("permission", "read_only"), ("prompt", "p"), ("promptFile", "p.md"),
                         ("passRequires", [])):
            with self.subTest(key=key):
                self.check(definition({"id": "v", "type": "validation", key: val}), f"stages[0].{key}",
                           "not allowed")
        v = {"id": "v", "type": "validation"}
        self.check(definition(dict(v, next={"done": "$succeed"})), "stages[0].next.done")
        self.check(definition(dict(v, next={"pass": "$succeed", "x": "a"})), "stages[0].next.x")

    def test_targets(self):
        self.check(definition(stage(next={"done": 3})), "stages[0].next.done", "text")
        self.check(definition(stage(next={"done": "nope"})), "stages[0].next.done", "unknown target")
        self.check(definition(stage(next={"done": "$other"})), "stages[0].next.done", "unknown target")

    def test_graph_rules(self):
        self.check(definition(stage(next={"done": "$succeed"}), stage(id="b")), "stages[1]", "not reachable")
        self.check(definition(stage(next={"done": "$fail"})), "stages", "$succeed")

    def test_pass_requires(self):
        v = {"id": "v", "type": "validation"}
        verdict = stage(id="q", next={"pass": "$succeed"})
        self.check(definition(stage(id="w", passRequires=["v"], next={"done": "v"}), v), "stages[0].passRequires",
                   "verdict")
        self.check(definition(v, dict(verdict, passRequires="v")), "stages[1].passRequires", "list")
        self.check(definition(v, dict(verdict, passRequires=["ghost"])), "stages[1].passRequires[0]", "unknown")
        self.check(definition(v, dict(verdict, passRequires=["q"])), "stages[1].passRequires[0]", "not a validation")
        ok = wd.parse_obj(definition(dict(v, next={"pass": "q"}), dict(verdict, passRequires=["v"])), FILE)
        self.assertEqual(ok.stages[1].pass_requires, ("v",))

    def test_max_visits(self):
        for bad in ("2", 0, 11, True, 1.5):
            with self.subTest(bad=bad):
                self.check(definition(stage(maxVisits=bad)), "stages[0].maxVisits")
        self.assertEqual(wd.parse_obj(definition(stage(maxVisits=10)), FILE).stages[0].max_visits, 10)


class Warnings(unittest.TestCase):
    def warnings(self, obj, prompts=None):
        return wd.parse_obj(obj, FILE, prompts).warnings

    def loop(self, visits):
        return definition(
            stage(id="a", permission="workspace_write", next={"done": "b"}),
            stage(id="b", maxVisits=visits, prompt="{{diff}}", next={"pass": "$succeed", "fail": "a"}, permission="read_only"))

    def test_reenterable_stage_with_one_visit_warns_and_two_does_not(self):
        w = self.warnings(self.loop(1))
        self.assertEqual([(x["path"], x["file"], x["line"]) for x in w], [("stages[0]", FILE, None),
                                                                           ("stages[1]", FILE, None)])
        self.assertIn("maxVisits", w[0]["message"])
        w = self.warnings(self.loop(2))
        self.assertEqual([x["path"] for x in w], ["stages[0]"])

    def test_cycle_is_defined_on_next_edges_not_list_order(self):
        # a -> c -> b -> a is a cycle although a's edge points forward in the list
        cyclic = definition(stage(id="a", next={"done": "c"}),
                            stage(id="b", next={"pass": "$succeed", "fail": "a"}),
                            stage(id="c", next={"done": "b"}))
        self.assertEqual([x["path"] for x in self.warnings(cyclic)], ["stages[0]", "stages[1]", "stages[2]"])
        # c -> b points backwards in the list but nothing leads back to c: no cycle
        acyclic = definition(stage(id="a", next={"done": "c"}), stage(id="b"), stage(id="c", next={"done": "b"}))
        self.assertEqual(self.warnings(acyclic), ())

    def reviewer(self, text):
        w = stage(id="w", permission="workspace_write", prompt="w", next={"done": "r"})
        r = stage(id="r", permission="read_only", prompt=text, next={"done": "$succeed"})
        return definition(w, r)

    def test_writer_later_in_list_that_reaches_reviewer_warns(self):
        a = stage(id="a", permission="read_only", next={"done": "w"})
        w = stage(id="w", permission="workspace_write", next={"done": "r"})
        r = stage(id="r", permission="read_only", prompt="look", next={"done": "$succeed"})
        w_ = self.warnings(definition(a, w, r))
        self.assertEqual([x["path"] for x in w_], ["stages[2]"])
        self.assertIn("{{diff}}", w_[0]["message"])

    def test_warnings_are_immutable(self):
        d = wd.parse_obj(self.reviewer("look"), FILE)
        with self.assertRaises(TypeError):
            d.warnings[0]["message"] = "x"

    def test_reviewer_without_diff_warns(self):
        w = self.warnings(self.reviewer("look"))
        self.assertEqual([x["path"] for x in w], ["stages[1]"])
        self.assertIn("{{diff}}", w[0]["message"])

    def test_reviewer_with_diff_in_template_or_file_does_not_warn(self):
        self.assertEqual(self.warnings(self.reviewer("look {{diff}}")), ())
        obj = self.reviewer("x")
        obj["stages"][1].pop("prompt")
        obj["stages"][1]["promptFile"] = "p.md"
        self.assertEqual(self.warnings(obj, {"p.md": "see {{diff}}"}), ())
        self.assertEqual(len(self.warnings(obj, {"p.md": "see nothing"})), 1)

    def test_writer_that_cannot_reach_reviewer_does_not_count(self):
        r = stage(id="r", permission="read_only", prompt="look", next={"done": "w"})
        w = stage(id="w", permission="workspace_write", prompt="w", next={"done": "$succeed"})
        # w comes later in the list but r -> w only; no writer reaches r
        self.assertEqual(self.warnings(definition(r, w)), ())

    def test_warnings_do_not_block_loading(self):
        self.assertTrue(wd.parse_obj(self.reviewer("look"), FILE).warnings)


class Lookup(Ws):
    def one(self):
        return definition(stage())

    def test_same_stem_in_two_extensions_is_ambiguous_for_every_pairing(self):
        for exts in ((".json", ".yaml"), (".json", ".yml"), (".yaml", ".yml")):
            name = "pair" + "".join(e[1:] for e in exts)
            for e in exts:
                self.write_def(name, self.one(), e)
            with self.assertRaises(AsError) as cm:
                wd.load(self.ws, name)
            self.assertEqual(cm.exception.code, wd.WORKFLOW_DEFINITION_AMBIGUOUS)
            self.assertEqual(len(cm.exception.data["files"]), 2)
            self.assertIn(f"{name}{exts[0]}", cm.exception.message)

    def test_lone_yaml_is_validated_like_json(self):
        # YAML parsing and its line numbers are tested in tests/unit/test_p01_s02_yaml.py (P01-S02)
        for ext in (".yaml", ".yml"):
            self.write_def("y" + ext[1:], "version: 1\n", ext)
            errs = self.invalid("y" + ext[1:])
            self.assertEqual([e["path"] for e in errs], ["stages"])

    def test_invalid_or_missing_name_is_not_found_without_touching_outside_paths(self):
        for name in ("../x", "a/b", "Upper", "", "-x", "a" * 65, None, "..\\x"):
            with self.subTest(name=name):
                with self.assertRaises(AsError) as cm:
                    wd.load(self.ws, name)
                self.assertEqual(cm.exception.code, wd.WORKFLOW_DEFINITION_NOT_FOUND)
        with self.assertRaises(AsError) as cm:
            wd.load(self.ws, "missing")
        self.assertEqual(cm.exception.code, wd.WORKFLOW_DEFINITION_NOT_FOUND)

    def test_invalid_name_never_reaches_the_filesystem(self):
        for name in ("../x", "a/b", "ok\n", "..\\x"):
            with self.subTest(name=name):
                with mock.patch("os.path.isfile") as isfile, mock.patch("builtins.open") as opened:
                    with self.assertRaises(AsError):
                        wd.load(self.ws, name)
                isfile.assert_not_called()
                opened.assert_not_called()

    def test_trailing_newline_is_rejected_in_names_stage_ids_and_sha(self):
        errs = errors_of(definition(stage(id="a\n")))
        self.assertIn("stages[0].id", [e["path"] for e in errs])
        self.assertIsNone(wd.NAME_RE.match("abc\n"))
        self.assertIsNone(wd.SHA_RE.match("0" * 64 + "\n"))


class PromptFiles(Ws):
    def wf(self, path):
        return definition({k: v for k, v in stage(promptFile=path).items() if k != "prompt"})

    def test_prompt_file_is_relative_to_agent_studio(self):
        self.write_prompt("develop.md", "hello")
        self.write_def("w", self.wf("prompts/develop.md"))
        self.assertEqual(wd.load(self.ws, "w").stages[0].prompt, "hello")

    def test_escapes_are_refused_at_prompt_file_path(self):
        outside = os.path.join(self._tmp.name, "outside.md")
        with open(outside, "w") as f:
            f.write("secret")
        os.symlink(outside, os.path.join(self.ws, ".agent-studio", "prompts", "link.md"))
        for rel in ("../outside.md", "prompts/../../x", outside, "prompts/link.md"):
            with self.subTest(rel=rel):
                self.write_def("e", self.wf(rel))
                errs = self.invalid("e")
                self.assertErr(errs, "stages[0].promptFile")

    def test_missing_oversize_and_non_utf8_prompt_files(self):
        self.write_prompt("big.md", b"x" * (32 * 1024 + 1))
        self.write_prompt("bad.md", b"\xff\xfe\x00")
        for rel, frag in (("prompts/none.md", "not found"), ("prompts/big.md", "32 KiB"),
                          ("prompts/bad.md", "UTF-8")):
            with self.subTest(rel=rel):
                self.write_def("p", self.wf(rel))
                self.assertErr(self.invalid("p"), "stages[0].promptFile", frag)

    def test_prompt_file_that_is_not_text_or_empty_path_is_refused(self):
        for bad in (3, "", None, ["p.md"]):
            with self.subTest(bad=bad):
                errs = errors_of(self.wf(bad), {})
                self.assertIn("stages[0].promptFile", [e["path"] for e in errs])
                self.assertTrue(any("relative file path" in e["message"] for e in errs))

    def test_prompt_file_missing_from_the_prompts_mapping_is_not_loaded(self):
        errs = errors_of(self.wf("p.md"), {})
        self.assertTrue(any(e["path"] == "stages[0].promptFile" and "was not loaded" in e["message"] for e in errs))

    def test_blank_prompt_file_is_empty(self):
        errs = errors_of(self.wf("p.md"), {"p.md": "  \n"})
        self.assertTrue(any(e["path"] == "stages[0].promptFile" and "is empty" in e["message"] for e in errs))
        self.write_prompt("blank.md", "")
        self.write_def("b", self.wf("prompts/blank.md"))
        self.assertErr(self.invalid("b"), "stages[0].promptFile", "is empty")

    def test_unreadable_prompt_file_is_invalid_at_prompt_file_path(self):
        self.write_def("u", self.wf("prompts/develop.md"))
        real_open = open

        def deny(path, *a, **kw):
            if str(path).endswith("develop.md"):
                raise PermissionError(13, "Permission denied")
            return real_open(path, *a, **kw)

        with mock.patch("builtins.open", deny):
            errs = self.invalid("u")
        self.assertErr(errs, "stages[0].promptFile", "cannot be read")

    def test_lone_surrogate_prompt_is_invalid_not_a_crash(self):
        errs = errors_of(definition(stage(prompt="\ud800")))
        self.assertEqual([(e["path"], e["file"]) for e in errs], [("stages[0].prompt", FILE)])
        self.write_def("s", '{"version":1,"stages":[{"id":"a","role":"R","permission":"read_only",'
                            '"prompt":"\\ud800","next":{"done":"$succeed"}}]}')
        self.assertErr(self.invalid("s"), "stages[0].prompt")

    def test_prompt_file_shared_by_stages_is_read_once(self):
        a, b = self.wf("prompts/develop.md")["stages"][0], self.wf("prompts/develop.md")["stages"][0]
        self.write_def("s", definition(dict(a, next={"done": "b"}), dict(b, id="b")))
        calls = []
        real = wd._read_prompt
        wd._read_prompt = lambda *a: (calls.append(a), real(*a))[1]
        try:
            wd.load(self.ws, "s")
        finally:
            wd._read_prompt = real
        self.assertEqual(len(calls), 1)


class Files(Ws):
    def test_file_level_errors_use_dollar_path(self):
        self.write_def("big", b" " * (64 * 1024 + 1))
        self.assertErr(self.invalid("big"), "$", "64 KiB")
        self.write_def("utf", b'{"version": "\xff"}')
        self.assertErr(self.invalid("utf"), "$", "UTF-8")
        self.write_def("arr", "[]")
        self.assertErr(self.invalid("arr"), "$", "object")

    def test_json_syntax_error_reports_line(self):
        self.write_def("syn", '{\n "version": 1,\n "stages": [\n }')
        errs = self.invalid("syn")
        self.assertEqual((errs[0]["path"], errs[0]["file"]), ("$", ".agent-studio/workflows/syn.json"))
        self.assertEqual(errs[0]["line"], 4)

    def test_deeply_nested_json_is_a_whole_file_error(self):
        self.write_def("deep", "[" * 50000)
        errs = self.invalid("deep")
        self.assertErr(errs, "$", "nested too deeply")

    def test_huge_integer_literal_is_a_whole_file_error_in_load_and_list(self):
        self.write_def("huge", '{"version":1,"maxSteps":' + "9" * 5000 + ',"stages":[]}')
        try:
            "9" * 5000 and int("9" * 5000)
        except ValueError:
            pass
        else:
            self.skipTest("this Python has no integer string-conversion limit")
        self.assertErr(self.invalid("huge"), "$", "integer literal")
        entry = wd.list_definitions(self.ws)[0]
        self.assertEqual(entry["errors"][0]["path"], "$")

    def test_duplicate_key_names_key_and_object(self):
        self.write_def("dup", '{"version":1,"stages":[{"id":"a","next":{"done":"$succeed"},"next":{}}]}')
        errs = self.invalid("dup")
        self.assertEqual(errs[0]["path"], "$")
        self.assertEqual(errs[0]["message"], 'duplicate key "next" in stages[0]')
        self.write_def("dup2", '{"version":1,"version":1,"stages":[]}')
        self.assertIn('duplicate key "version" in the top-level object', self.invalid("dup2")[0]["message"])

    def test_duplicate_key_is_reported_together_with_other_errors(self):
        self.write_def("both", '{"version":1,"version":1,"maxSteps":0,'
                               '"stages":[{"id":"Bad","role":"R","permission":"read_only","prompt":"x",'
                               '"next":{"done":"$succeed"}}]}')
        errs = self.invalid("both")
        self.assertEqual(errs[0]["message"], 'duplicate key "version" in the top-level object')
        paths = [e["path"] for e in errs]
        self.assertIn("maxSteps", paths)
        self.assertIn("stages[0].id", paths)

    def test_source_sha256_tracks_definition_bytes_not_prompt_files(self):
        obj = {k: v for k, v in stage(promptFile="prompts/develop.md").items() if k != "prompt"}
        self.write_def("h", definition(obj))
        with open(os.path.join(self.ws, ".agent-studio", "workflows", "h.json"), "rb") as f:
            raw = f.read()
        d1 = wd.load(self.ws, "h")
        self.assertEqual(d1.source_sha256, hashlib.sha256(raw).hexdigest())
        self.write_prompt("develop.md", "changed")
        d2 = wd.load(self.ws, "h")
        self.assertEqual(d2.source_sha256, d1.source_sha256)
        self.assertNotEqual(json.loads(wd.to_json(d2))["stages"][0]["prompt"],
                            json.loads(wd.to_json(d1))["stages"][0]["prompt"])
        self.write_def("h", json.dumps(definition(obj), indent=2))
        self.assertNotEqual(wd.load(self.ws, "h").source_sha256, d1.source_sha256)


class Builtins(Ws):
    def setUp(self):
        super().setUp()
        self.bdir = os.path.join(self._tmp.name, "builtin")
        os.makedirs(self.bdir)
        obj = definition({k: v for k, v in stage(promptFile="prompts/b.md").items() if k != "prompt"})
        self.write_def("dr", obj, folder=self.bdir)
        self.write_prompt("b.md", "builtin prompt", base=os.path.join(self.bdir, "prompts"))

    def test_builtin_loads_with_prompt_under_its_folder_and_is_listed(self):
        d = wd.load(self.ws, "dr", self.bdir)
        self.assertEqual(d.stages[0].prompt, "builtin prompt")
        entries = wd.list_definitions(self.ws, self.bdir)
        self.assertEqual([(e["name"], e["builtin"]) for e in entries], [("dr", True)])

    def test_builtin_is_not_searched_without_builtin_dir(self):
        with self.assertRaises(AsError) as cm:
            wd.load(self.ws, "dr")
        self.assertEqual(cm.exception.code, wd.WORKFLOW_DEFINITION_NOT_FOUND)
        self.assertEqual(wd.list_definitions(self.ws), [])

    def test_workspace_file_with_a_builtin_name_is_invalid(self):
        # S06 reserves built-in names (design contract section A); S01 had let the workspace file win.
        self.write_def("dr", definition(stage(role="Mine")))
        with self.assertRaises(AsError) as cm:
            wd.load(self.ws, "dr", self.bdir)
        self.assertEqual(cm.exception.code, wd.WORKFLOW_DEFINITION_INVALID)
        err = cm.exception.data["errors"][0]
        self.assertEqual((err["path"], err["file"]), ("$", ".agent-studio/workflows/dr.json"))
        self.assertIn("reserved", err["message"])
        entries = wd.list_definitions(self.ws, self.bdir)
        self.assertEqual([e["name"] for e in entries], ["dr"])


class Listing(Ws):
    def test_list_shows_valid_broken_ambiguous_and_yaml_entries_sorted(self):
        self.write_def("a-ok", definition(stage(), description="first"))
        self.write_def("b-broken", "{nope")
        self.write_def("c-amb", definition(stage()))
        self.write_def("c-amb", "version: 1", ".yaml")
        self.write_def("d-yaml", "version: 1", ".yml")
        self.write_def("e-ok", definition(stage(id="x", role="R1", next={"done": "y"}), stage(id="y", role="R1")))
        entries = wd.list_definitions(self.ws)
        self.assertEqual([e["name"] for e in entries], ["a-ok", "b-broken", "c-amb", "d-yaml", "e-ok"])
        ok = entries[0]
        self.assertEqual((ok["description"], ok["stages"], ok["roles"], ok["errors"], ok["builtin"]),
                         ("first", ["a"], ["Dev"], [], False))
        self.assertEqual(entries[4]["roles"], ["R1"])
        for e in entries[1:4]:
            self.assertTrue(e["errors"])
            self.assertEqual((e["stages"], e["roles"]), ([], []))
        self.assertEqual(len(entries[2]["files"]), 2)

    def test_file_with_invalid_name_is_listed_with_an_error_not_skipped(self):
        self.write_def("Bad_Name", definition(stage()))
        self.write_def("good", definition(stage()))
        entries = wd.list_definitions(self.ws)
        self.assertEqual([e["name"] for e in entries], ["Bad_Name", "good"])
        bad = entries[0]
        self.assertEqual((bad["stages"], bad["roles"], bad["builtin"]), ([], [], False))
        self.assertEqual(bad["files"], [".agent-studio/workflows/Bad_Name.json"])
        self.assertEqual(bad["errors"][0]["file"], ".agent-studio/workflows/Bad_Name.json")
        self.assertEqual(len(bad["errors"]), 1)
        self.assertEqual(bad["errors"][0]["path"], "$")
        self.assertIn("must match", bad["errors"][0]["message"])
        self.assertEqual(entries[1]["errors"], [])

    def test_missing_workflows_folder_and_builtin_dir_list_as_empty(self):
        empty = os.path.join(self._tmp.name, "empty-ws")
        os.makedirs(empty)
        self.assertEqual(wd.list_definitions(empty), [])
        self.assertEqual(wd.list_definitions(empty, os.path.join(self._tmp.name, "no-such-dir")), [])

    def test_lone_surrogate_prompt_is_listed_as_invalid(self):
        self.write_def("sur", '{"version":1,"stages":[{"id":"a","role":"R","permission":"read_only",'
                              '"prompt":"\\ud800","next":{"done":"$succeed"}}]}')
        entry = wd.list_definitions(self.ws)[0]
        self.assertEqual(entry["errors"][0]["path"], "stages[0].prompt")


class Unreadable(Ws):
    def test_unreadable_definition_is_invalid_in_load_and_listed_with_error(self):
        self.write_def("locked", definition(stage()))
        real_open = open

        def deny(path, *a, **kw):
            if str(path).endswith("locked.json"):
                raise PermissionError(13, "Permission denied")
            return real_open(path, *a, **kw)

        with mock.patch("builtins.open", deny):
            self.assertErr(self.invalid("locked"), "$", "cannot be read")
            entry = wd.list_definitions(self.ws)[0]
        self.assertEqual(entry["name"], "locked")
        self.assertEqual(entry["errors"][0]["path"], "$")


class FrozenForm(Ws):
    def fixtures(self):
        self.write_def("sec", SECTION_B)
        self.write_def("dflt", DEFAULTS)
        return [wd.load(self.ws, "sec"), wd.load(self.ws, "dflt")]

    def test_inlined_prompt_and_prompt_source_without_prompt_file(self):
        d = self.fixtures()[0]
        frozen = json.loads(wd.to_json(d))
        self.assertEqual(frozen["stages"][0]["prompt"], "Develop: {{task}}")
        self.assertEqual(frozen["stages"][0]["promptSource"], "prompts/develop.md")
        self.assertEqual(frozen["stages"][2]["promptSource"], "inline")
        self.assertNotIn("promptFile", wd.to_json(d))
        self.assertEqual(frozen["name"], "sec")
        self.assertEqual(frozen["sourceSha256"], d.source_sha256)
        self.assertIn("warnings", frozen)

    def test_canonical_json_is_compact_and_sorted(self):
        text = wd.to_json(self.fixtures()[0])
        self.assertNotIn("\n", text)
        self.assertEqual(text, json.dumps(json.loads(text), sort_keys=True, separators=(",", ":"),
                                          ensure_ascii=False))

    def test_to_json_emits_every_default(self):
        frozen = json.loads(wd.to_json(wd.parse_obj(DEFAULTS, FILE)))
        self.assertEqual((frozen["description"], frozen["maxSteps"], frozen["version"]), ("", 20, 1))
        a, b, c, _d = frozen["stages"]
        for s in frozen["stages"]:
            self.assertEqual(s["maxVisits"], 1)
            self.assertIn("type", s)
            self.assertIn("next", s)
        self.assertEqual((a["type"], b["type"]), ("agent", "validation"))
        self.assertNotIn("passRequires", a)
        self.assertEqual(c["passRequires"], [])
        self.assertEqual(b["next"], {"pass": "c", "fail": "$fail"})
        for key in ("prompt", "promptSource", "role", "permission"):
            self.assertNotIn(key, b)

    def frozen_default(self):
        return json.loads(wd.to_json(wd.parse_obj(DEFAULTS, FILE, source_sha256="a" * 64, name="dflt")))

    def test_from_json_rejects_missing_or_malformed_top_level_frozen_keys(self):
        for key in ("name", "sourceSha256", "warnings"):
            with self.subTest(missing=key):
                f = self.frozen_default()
                del f[key]
                self.assertErr_path(self.frozen_errors(f), key)
        bad = {"name": "Bad_Name", "sourceSha256": "xyz", "warnings": "no"}
        for key, val in bad.items():
            with self.subTest(bad=key):
                self.assertErr_path(self.frozen_errors(dict(self.frozen_default(), **{key: val})), key)
        for w in ([{"file": "f"}], ["x"], [{"file": "f", "path": "p", "line": None, "message": "m", "x": 1}]):
            with self.subTest(warnings=w):
                self.assertErr_path(self.frozen_errors(dict(self.frozen_default(), warnings=w)), "warnings")

    def test_from_json_rejects_bad_frozen_prompt_and_prompt_source(self):
        for val in ("", "   ", 3, None, "x" * (32 * 1024 + 1), "\ud800"):
            with self.subTest(prompt=str(val)[:10]):
                f = self.frozen_default()
                f["stages"][0]["prompt"] = val
                self.assertErr_path(self.frozen_errors(f), "stages[0].prompt")
        for val in ("", 3, None):
            with self.subTest(promptSource=val):
                f = self.frozen_default()
                f["stages"][0]["promptSource"] = val
                self.assertErr_path(self.frozen_errors(f), "stages[0].promptSource")
        f = self.frozen_default()
        del f["stages"][0]["prompt"]
        self.assertErr_path(self.frozen_errors(f), "stages[0].prompt")

    def frozen_errors(self, obj):
        with self.assertRaises(AsError) as cm:
            wd.from_json(obj)
        self.assertEqual(cm.exception.code, wd.WORKFLOW_DEFINITION_INVALID)
        return cm.exception.data["errors"]

    def test_round_trips_both_ways(self):
        for d in self.fixtures():
            text = wd.to_json(d)
            back = wd.from_json(json.loads(text))
            self.assertEqual(back, d)
            self.assertEqual(wd.to_json(back), text)

    def test_round_trip_keeps_warnings_and_unicode(self):
        obj = definition(stage(id="w", permission="workspace_write", prompt="é", next={"done": "r"}),
                         stage(id="r", permission="read_only", prompt="look", next={"done": "$succeed"}))
        d = wd.parse_obj(obj, FILE, source_sha256="a" * 64)
        self.assertTrue(d.warnings)
        text = wd.to_json(d)
        self.assertIn("é", text)
        self.assertEqual(wd.from_json(json.loads(text)), d)

    def test_parse_obj_defaults_round_trip_through_frozen_form(self):
        d = wd.parse_obj(DEFAULTS, FILE)
        self.assertRegex(d.source_sha256, r"^[0-9a-f]{64}$")
        self.assertEqual(wd.from_json(json.loads(wd.to_json(d))), d)

    def test_parse_obj_rejects_bad_name_and_sha(self):
        for kw in ({"name": "Bad Name"}, {"source_sha256": "xyz"}):
            with self.subTest(kw=kw):
                with self.assertRaises(AsError) as cm:
                    wd.parse_obj(DEFAULTS, FILE, **kw)
                self.assertEqual(cm.exception.code, wd.WORKFLOW_DEFINITION_INVALID)
        with self.assertRaises(AsError):
            wd.parse_obj(DEFAULTS, ".agent-studio/workflows/Bad_Name.json")

    def test_from_json_rejects_prompt_file_and_source_form_rejects_frozen_keys(self):
        frozen = json.loads(wd.to_json(self.fixtures()[1]))
        bad = copy.deepcopy(frozen)
        bad["stages"][0]["promptFile"] = "p.md"
        with self.assertRaises(AsError) as cm:
            wd.from_json(bad)
        self.assertEqual(cm.exception.data["errors"][0]["path"], "stages[0].promptFile")
        for key, val in (("sourceSha256", "a" * 64), ("name", "x"), ("warnings", [])):
            with self.subTest(key=key):
                self.assertErr_path(errors_of(dict(DEFAULTS, **{key: val})), key)
        s = copy.deepcopy(DEFAULTS)
        s["stages"][0]["promptSource"] = "inline"
        self.assertErr_path(errors_of(s), "stages[0].promptSource")

    def assertErr_path(self, errs, path):
        self.assertIn(path, [e["path"] for e in errs])

    def test_from_json_rechecks_structure_and_graph(self):
        frozen = json.loads(wd.to_json(self.fixtures()[1]))
        frozen["stages"][0]["next"] = {"done": "nowhere"}
        with self.assertRaises(AsError):
            wd.from_json(frozen)
        frozen = json.loads(wd.to_json(self.fixtures()[1]))
        del frozen["stages"][0]["promptSource"]
        with self.assertRaises(AsError):
            wd.from_json(frozen)


if __name__ == "__main__":
    unittest.main()
