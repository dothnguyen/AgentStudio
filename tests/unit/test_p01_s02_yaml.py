"""P01-S02: strict YAML subset parser and the YAML path of the definition loader."""
import hashlib
import json
import os
import random
import unittest

import tests.helpers  # noqa: F401  (puts backend/ on sys.path)
from agent_studio import workflowdef as wd
from agent_studio import yamlsubset as ys
from agent_studio.protocol import AsError
from tests.unit import test_p01_s01_definitions as s01

FIXTURES = os.path.join(os.path.dirname(__file__), "..", "fixtures", "workflowdefs")


def fixture(name):
    with open(os.path.join(FIXTURES, name), "rb") as f:
        return f.read()


def error_of(text):
    try:
        ys.loads(text)
    except ys.YamlSubsetError as e:
        return e
    raise AssertionError(f"expected YamlSubsetError for {text!r}")


class Accepted(unittest.TestCase):
    def test_error_has_line_and_message_attributes(self):
        e = error_of("a: 1\nb: &x 2\n")
        self.assertEqual((e.line, type(e.line)), (2, int))
        self.assertIsInstance(e.message, str)
        self.assertIn("anchors", e.message)

    def test_indentless_and_indented_sequences_give_the_same_value(self):
        flush = "stages:\n- id: x\n  role: R\n- id: y\n"
        deeper = "stages:\n  - id: x\n    role: R\n  - id: y\n"
        wide = "stages:\n    -   id: x\n        role: R\n    -   id: y\n"
        want = {"stages": [{"id": "x", "role": "R"}, {"id": "y"}]}
        for text in (flush, deeper, wide):
            with self.subTest(text=text):
                self.assertEqual(ys.loads(text), want)

    def test_sequences_of_scalars_and_nested_collections(self):
        self.assertEqual(ys.loads("k:\n- a\n- 1\n- true\n-\n- - x\n  - y\n- [a, b]\n- {c: d}\n"),
                         {"k": ["a", 1, True, None, ["x", "y"], ["a", "b"], {"c": "d"}]})

    def test_nested_and_empty_flow_collections(self):
        self.assertEqual(ys.loads("a: {b: [1, two, {c: d}], e: {}, f: [], g: { h: [ ] }}\n"),
                         {"a": {"b": [1, "two", {"c": "d"}], "e": {}, "f": [], "g": {"h": []}}})
        self.assertEqual(ys.loads("a: [\"x, y\", 'it''s', \"q: r\", '[z]']\nb: {\"k\": \"v\", 'j': w, e:}\n"),
                         {"a": ["x, y", "it's", "q: r", "[z]"], "b": {"k": "v", "j": "w", "e": None}})
        self.assertEqual(ys.loads("a: [$succeed, on]\n"), {"a": ["$succeed", "on"]})

    def test_double_quoted_escapes(self):
        text = 'a: "\\\\ \\" \\n \\t \\u00e9 \\u263A"\n'
        self.assertEqual(ys.loads(text), {"a": "\\ \" \n \t \u00e9 \u263a"})

    def test_single_quotes_only_double_the_quote(self):
        self.assertEqual(ys.loads("a: 'it''s'\nb: 'x\\ny'\nc: ''\n"), {"a": "it's", "b": "x\\ny", "c": ""})

    def test_unsupported_escapes_are_errors(self):
        for text in ('a: "\\x41"', 'a: "\\ud800"', 'a: "\\uDFFF"', 'a: "\\u12"', 'a: "\\/"', 'a: "\\0"'):
            with self.subTest(text=text):
                self.assertEqual(error_of(text + "\n").line, 1)

    def test_text_after_a_quoted_value_is_an_error(self):
        for text in ('a: "x" y\n', "a: 'x'y\n", 'a: [b] c\n', 'a: {b: c}d\n'):
            with self.subTest(text=text):
                self.assertEqual(error_of(text).line, 1)

    def test_block_scalar_header_may_carry_a_comment(self):
        self.assertEqual(ys.loads("a: | # note\n  x\n  y\nb: |- # n\n  z\n"), {"a": "x\ny\n", "b": "z"})

    def test_leading_document_marker_is_optional(self):
        self.assertEqual(ys.loads("---\na: 1\n"), {"a": 1})
        self.assertEqual(ys.loads("# c\n\n---  # x\na: 1\n"), {"a": 1})
        self.assertEqual(ys.loads("a: 1\n"), {"a": 1})

    def test_crlf_file_equals_its_lf_copy(self):
        lf = fixture("section-b.yaml").decode("utf-8")
        self.assertEqual(ys.loads(lf.replace("\n", "\r\n")), ys.loads(lf))
        self.assertEqual(ys.loads_with_lines(lf.replace("\n", "\r\n"))[1], ys.loads_with_lines(lf)[1])

    def test_comments_after_values_and_on_their_own_lines(self):
        text = ("# top\na: 1 # one\n  # indented comment\nb: 'x # y' # z\nc: \"p: q\" #w\nd: # nothing\n"
                "e: [1, 2] # t\nf: x#y\n\n")
        self.assertEqual(ys.loads(text), {"a": 1, "b": "x # y", "c": "p: q", "d": None, "e": [1, 2], "f": "x#y"})

    def test_scalar_typing(self):
        text = ("a: on\nb: yes\nc: no\nd: off\ne: $succeed\nf: \"123\"\ng: '123'\nh: 123\ni: 0\nj: -1\nk: true\n"
                "l: false\nm: ~\nn: null\no:\np: \"x: y # z\"\nq: 1.2.3\nr: \"\"\ns: \"true\"\n")
        got = ys.loads(text)
        self.assertEqual(got, {"a": "on", "b": "yes", "c": "no", "d": "off", "e": "$succeed", "f": "123",
                               "g": "123", "h": 123, "i": 0, "j": -1, "k": True, "l": False, "m": None,
                               "n": None, "o": None, "p": "x: y # z", "q": "1.2.3", "r": "", "s": "true"})
        for k in "ab":
            self.assertIs(type(got[k]), str)
        self.assertIs(type(got["h"]), int)
        self.assertIs(got["k"], True)

    def test_keys_are_text_without_type_resolution(self):
        self.assertEqual(ys.loads("on: 1\n123: a\ntrue: b\nnull: c\n\"q k\": d\n"),
                         {"on": 1, "123": "a", "true": "b", "null": "c", "q k": "d"})

    def test_block_scalar_literal_content(self):
        text = "a: |\n  one\n    indented\n\n  # not a comment\n  last\n\n\nb: 1\n"
        self.assertEqual(ys.loads(text), {"a": "one\n  indented\n\n# not a comment\nlast\n", "b": 1})

    def test_block_scalar_keeps_one_final_newline_even_with_trailing_blank_lines(self):
        self.assertEqual(ys.loads("a: |\n  x\n\n\n"), {"a": "x\n"})
        self.assertEqual(ys.loads("a: |\n  x"), {"a": "x\n"})
        self.assertEqual(ys.loads("a: |\n  x\n\n\nb: 2\n"), {"a": "x\n", "b": 2})

    def test_block_scalar_strip_has_no_final_newline(self):
        self.assertEqual(ys.loads("a: |-\n  x\n  y\n\n"), {"a": "x\ny"})

    def test_block_scalar_equals_the_double_quoted_string(self):
        block = ys.loads("a: |\n  one\n    indented\n\n  # c\n  last\n")
        quoted = ys.loads('a: "one\\n  indented\\n\\n# c\\nlast\\n"\n')
        self.assertEqual(block, quoted)

    def test_block_scalar_as_sequence_item_and_in_item_mapping(self):
        self.assertEqual(ys.loads("k:\n- |\n  hi\n- two\n- p: |-\n    deep\n  q: 1\n"),
                         {"k": ["hi\n", "two", {"p": "deep", "q": 1}]})

    def test_block_scalar_needs_deeper_content(self):
        for text in ("a: |\nb: 1\n", "a: |\n", "a: |\n# c\n  x\n"):
            with self.subTest(text=text):
                self.assertEqual(error_of(text).line, 1)

    def test_line_map_follows_keys_items_and_flow_items(self):
        _, lm = ys.loads_with_lines(fixture("section-b.yaml").decode("utf-8"))
        want = {(): 1, ("version",): 1, ("stages",): 4, ("stages", 0): 5, ("stages", 0, "id"): 5,
                ("stages", 0, "next"): 10, ("stages", 0, "next", "done"): 10, ("stages", 1): 11,
                ("stages", 2): 15, ("stages", 2, "passRequires"): 19, ("stages", 2, "passRequires", 0): 19,
                ("stages", 2, "prompt"): 20, ("stages", 2, "next", "fail"): 25, ("stages", 3): 26,
                ("stages", 3, "next", "pass"): 31}
        for path, line in want.items():
            with self.subTest(path=path):
                self.assertEqual(lm.get(path), line)

    def test_line_map_keeps_a_dotted_key_apart_from_a_nested_path(self):
        _, lm = ys.loads_with_lines("x: 1\na.b: 1\na:\n  b: 2\n")
        self.assertEqual(lm[("a.b",)], 2)
        self.assertEqual(lm[("a", "b")], 4)

    def test_long_plain_integers_are_integers(self):
        self.assertEqual(ys.loads("a: 1234567890123456789\n"), {"a": 1234567890123456789})
        self.assertEqual(ys.loads("a: -" + "9" * 40 + "\n"), {"a": -int("9" * 40)})

    def test_nesting_at_the_limit_is_accepted(self):
        text = "".join(" " * i + "k:\n" for i in range(ys.MAX_DEPTH))
        self.assertIsInstance(ys.loads(text), dict)
        # the root mapping is level 1, so 31 nested flow sequences reach level 32
        value = ys.loads("a: " + "[" * 31 + "]" * 31 + "\n")["a"]
        for _ in range(30):
            value = value[0]
        self.assertEqual(value, [])
        self.assertEqual(error_of("a: " + "[" * 32 + "]" * 32 + "\n").line, 1)
        self.assertEqual(error_of("".join(" " * i + "k:\n" for i in range(ys.MAX_DEPTH + 1))).line,
                         ys.MAX_DEPTH + 1)


REJECTED = [
    # anchors, aliases, tags, directives
    ("anchor", "a: 1\nb: &x 2\n", 2),
    ("alias", "a:\n  - *x\n", 2),
    ("tag", "a: !!str x\n", 1),
    ("tag as item", "a:\n- !t x\n", 2),
    ("directive", "%YAML 1.2\na: 1\n", 1),
    ("directive in value", "a: %x\n", 1),
    # multiple documents
    ("second document", "a: 1\n---\nb: 2\n", 2),
    ("end marker", "a: 1\n...\n", 2),
    ("end marker first", "...\na: 1\n", 1),
    ("two markers", "---\n---\na: 1\n", 2),
    ("text after marker", "--- a: 1\n", 1),
    # folded scalars and other block indicators
    ("folded", "a: >\n  x\n", 1),
    ("folded strip", "a: >-\n  x\n", 1),
    ("keep", "\na: |+\n  x\n", 2),
    ("indentation indicator", "a: |2\n  x\n", 1),
    ("text after pipe", "a: | x\n  y\n", 1),
    # multi-line collections and scalars
    ("flow sequence over two lines", "a: [b,\n  c]\n", 1),
    ("flow mapping over two lines", "a: {b: c,\n  d: e}\n", 1),
    ("unclosed flow", "a: [b\n", 1),
    ("plain continuation", "a: b\n  c\n", 2),
    ("plain on the next line", "a:\n  b\n  c\n", 2),
    ("double quoted over two lines", 'a: "b\n  c"\n', 1),
    ("single quoted over two lines", "a: 'b\n  c'\n", 1),
    # complex keys and indicator starts
    ("complex key", "? a\n: b\n", 1),
    ("complex key later", "a: 1\n? b\n", 2),
    ("at sign", "a: @x\n", 1),
    ("backtick", "a: `x\n", 1),
    ("comma", "a: ,x\n", 1),
    ("close bracket", "a: ]\n", 1),
    ("close brace", "a: }\n", 1),
    ("pipe then text", "a: |x\n", 1),
    ("indicator key", "x: 1\n@a: 1\n", 2),
    ("colon in plain value", "a: b: c\n", 1),
    # ambiguous scalars
    ("leading zeros", "x: 1\na: 007\n", 2),
    ("plus sign", "x: 1\na: +1\n", 2),
    ("float", "x: 1\na: 1.5\n", 2),
    ("exponent", "x: 1\na: 1e3\n", 2),
    ("hex", "x: 1\na: 0x1F\n", 2),
    ("binary", "x: 1\na: 0b101\n", 2),
    ("sexagesimal", "a: 1:20\n", 1),
    ("sexagesimal in flow", "a: [1:20]\n", 1),
    ("inf", "x: 1\na: .inf\n", 2),
    ("negative inf", "x: 1\na: -.inf\n", 2),
    ("nan", "x: 1\na: .NaN\n", 2),
    ("underscore number", "x: 1\na: 1_000\n", 2),
    ("negative zero", "x: 1\na: -0\n", 2),
    ("number in flow", "a: [007]\n", 1),
    ("True", "x: 1\na: True\n", 2),
    ("TRUE", "x: 1\na: TRUE\n", 2),
    ("False", "x: 1\na: False\n", 2),
    ("FALSE", "x: 1\na: FALSE\n", 2),
    ("Null", "x: 1\na: Null\n", 2),
    ("NULL", "x: 1\na: NULL\n", 2),
    ("integer beyond the interpreter's digit limit", "x: 1\na: " + "9" * 5000 + "\n", 2),
    # duplicate keys
    ("duplicate top-level key", "version: 1\nversion: 1\n", 2),
    ("duplicate nested key", "stages:\n  - id: a\n    next: {done: b}\n  - id: b\n    next: {done: c}\n"
                             "    next: {done: d}\n", 6),
    ("duplicate flow key", "a: {x: 1, x: 2}\n", 1),
    ("duplicate after quoting", "a: 1\n\"a\": 2\n", 2),
    # tabs and indentation
    ("tab indent", "a:\n\tb: 1\n", 2),
    ("space then tab", "a: 1\n \tb: 2\n", 2),
    ("tab after dash", "a:\n-\tb\n", 2),
    ("deeper than anything open", "a:\n    b: 1\n  c: 2\n", 3),
    ("indented after a scalar", "a: 1\n  b: 2\n", 2),
    ("dedent to nowhere at the root", "  a: 1\nb: 2\n", 2),
    ("sequence among keys", "a: 1\n- b\n", 2),
    # characters
    ("control character", "a: 1\nb: \x01\n", 2),
    ("nul", "a: 1\x00\n", 1),
    ("C1 control NEL", "a: 1\nb: \x85\n", 2),
    ("C1 control CSI", "a: \x9b\n", 1),
    ("lone carriage return", "a: 1\rb: 2\n", 1),
    ("byte-order mark", "\ufeffa: 1\n", 1),
    # nesting
    ("flow nesting", "a: " + "[" * 40 + "]" * 40 + "\n", 1),
    ("block nesting", "".join(" " * i + "k:\n" for i in range(40)), 33),
    # root
    ("sequence root", "- a\n- b\n", 1),
    ("scalar root", "just text\n", 1),
    ("quoted root", "\"a\"\n", 1),
    ("flow sequence root", "[a, b]\n", 1),
    ("flow mapping root", "{a: b}\n", 1),
    ("empty document", "", 1),
    ("comment only", "# only a comment\n\n", 1),
    ("marker only", "---\n", 1),
    ("root after blank lines", "\n\n- x\n", 3),
]


class Rejected(s01.Ws):
    def test_every_rejected_construct_has_a_line_in_the_parser_and_in_the_loader(self):
        for label, text, line in REJECTED:
            with self.subTest(label):
                with self.assertRaises(ys.YamlSubsetError) as cm:
                    ys.loads(text)
                self.assertEqual(cm.exception.line, line, cm.exception.message)
                self.write_def("rej", text.encode("utf-8"), ".yaml")
                errs = self.invalid("rej")
                self.assertEqual(len(errs), 1, errs)
                self.assertEqual((errs[0]["path"], errs[0]["line"]), ("$", line))
                self.assertEqual(errs[0]["message"], cm.exception.message)

    def test_ambiguous_scalar_messages_tell_the_operator_to_quote(self):
        for text in ("a: 007\n", "a: 1.5\n", "a: True\n", "a: NULL\n"):
            with self.subTest(text=text):
                self.assertIn("quote", error_of(text).message)

    def test_top_level_key_with_bracket_is_an_unknown_key_error_not_a_crash(self):
        text = "version: 1\n\"a[x\": 1\n" + MINIMAL.split("\n", 2)[2]
        self.write_def("brk", text.encode(), ".yaml")
        errs = self.invalid("brk")
        self.assertEqual(len(errs), 1, errs)
        self.assertEqual((errs[0]["path"], errs[0]["line"]), ("a[x", 2))
        self.assertEqual(wd.list_definitions(self.ws) is not None, True)

    def test_readme_documents_the_subset_and_every_refused_form(self):
        path = os.path.join(os.path.dirname(ys.__file__), "workflows", "README.md")
        with open(path, encoding="utf-8") as f:
            readme = f.read()
        self.assertIn("\n## YAML subset\n", readme)
        section = readme.split("\n## YAML subset\n", 1)[1]
        self.assertIn("**Refused**", section)
        for form in ("Anchors", "aliases", "tags", "`%` directives", "More than one document", "`...`",
                     "Folded scalars", "`|+`", "`|2`", "Multi-line flow collections", "Complex keys",
                     "`007`", "`+1`", "`1.5`", "`1e3`", "`0x1F`", "`0b101`", "`1:20`", "`.inf`",
                     "`True`", "`TRUE`", "`False`", "`FALSE`", "`Null`", "`NULL`", "Quote the value",
                     "Duplicate keys", "tabs in indentation", "inconsistent indentation",
                     "Control characters", "lone CR", "byte-order mark", "32 levels", "block mapping"):
            with self.subTest(form=form):
                self.assertIn(form, section)

    def test_duplicate_key_messages_name_the_key_and_its_object(self):
        self.assertEqual(error_of("version: 1\nversion: 1\n").message,
                         'duplicate key "version" in the top-level object')
        nested = ("stages:\n  - id: a\n    next: {done: b}\n  - id: b\n    next: {done: c}\n"
                  "    next: {done: d}\n")
        self.assertEqual(error_of(nested).message, 'duplicate key "next" in stages[1]')
        self.assertEqual(error_of("a: {x: 1, x: 2}\n").message, 'duplicate key "x" in a')
        self.write_def("dup", nested.encode(), ".yaml")
        self.assertEqual(self.invalid("dup")[0]["message"], 'duplicate key "next" in stages[1]')


def shape(d):
    """Everything in a Definition except source_sha256 and the file / line of warnings."""
    return (d.name, d.version, d.description, d.max_steps,
            [(s.id, s.type, s.role, s.permission, s.prompt, s.prompt_source, s.max_visits, s.pass_requires,
              dict(s.next), s.kind) for s in d.stages],
            [{k: v for k, v in w.items() if k not in ("file", "line")} for w in d.warnings])


def canonical(d):
    obj = json.loads(wd.to_json(d))
    del obj["sourceSha256"]
    for w in obj["warnings"]:
        del w["file"]
        del w["line"]
    return obj


class SameModel(s01.Ws):
    def load_as(self, name, ext, fixture_name):
        for e in (".json", ".yaml", ".yml"):
            path = os.path.join(self.ws, ".agent-studio", "workflows", name + e)
            if os.path.exists(path):
                os.remove(path)
        self.write_def(name, fixture(fixture_name), ext)
        return wd.load(self.ws, name)

    def test_section_b_example_is_the_same_definition_in_yaml_and_json(self):
        a = self.load_as("same", ".json", "section-b.json")
        b = self.load_as("same", ".yaml", "section-b.yaml")
        self.assertEqual(shape(a), shape(b))
        self.assertEqual(canonical(a), canonical(b))
        self.assertEqual([s.kind for s in b.stages], ["work", "validation", "verdict", "verdict"])
        self.assertEqual(b.stages[2].prompt,
                         "Review DIFF against TASK, taking VALIDATION into account.\n{{task}}\n{{diff}}\n"
                         "{{validation}}\n")
        self.assertEqual(b.stages[0].prompt_source, "prompts/develop.md")
        self.assertEqual(dict(b.stages[3].next), {"pass": "$succeed", "fail": "develop"})

    def test_defaults_fixture_is_the_same_definition_in_yaml_and_json(self):
        a = self.load_as("same", ".json", "defaults.json")
        b = self.load_as("same", ".yml", "defaults.yaml")
        self.assertEqual(shape(a), shape(b))
        self.assertEqual(canonical(a), canonical(b))
        self.assertEqual((b.max_steps, b.description), (20, ""))
        self.assertEqual(dict(b.stages[1].next), {"pass": "c", "fail": "$fail"})
        self.assertTrue(b.warnings)

    def test_source_sha256_is_the_hash_of_the_yaml_bytes(self):
        d = self.load_as("same", ".yaml", "section-b.yaml")
        self.assertEqual(d.source_sha256, hashlib.sha256(fixture("section-b.yaml")).hexdigest())


MINIMAL = ("version: 1\ndescription: hi\nstages:\n  - id: a\n    role: R\n    permission: read_only\n"
           "    prompt: do it\n    next: { done: $succeed }\n")


class Loader(s01.Ws):
    def test_lone_yaml_and_yml_files_load(self):
        for ext in (".yaml", ".yml"):
            with self.subTest(ext=ext):
                name = "lone" + ext[1:]
                self.write_def(name, MINIMAL, ext)
                d = wd.load(self.ws, name)
                self.assertEqual((d.name, d.description, [s.id for s in d.stages]), (name, "hi", ["a"]))

    def test_list_shows_valid_yaml_and_yaml_syntax_errors(self):
        self.write_def("good", MINIMAL, ".yaml")
        self.write_def("bad", "version: 1\nstages: [\n", ".yml")
        entries = {e["name"]: e for e in wd.list_definitions(self.ws)}
        good = entries["good"]
        self.assertEqual((good["description"], good["stages"], good["roles"], good["errors"]),
                         ("hi", ["a"], ["R"], []))
        bad = entries["bad"]
        self.assertEqual(len(bad["errors"]), 1)
        self.assertEqual((bad["errors"][0]["path"], bad["errors"][0]["line"]), ("$", 2))
        self.assertEqual((bad["stages"], bad["roles"]), ([], []))

    def test_size_and_utf8_errors_have_no_line(self):
        self.write_def("big", b"a: " + b"x" * (wd.MAX_DEFINITION_BYTES + 1), ".yaml")
        self.write_def("latin", b"a: \xe9\n", ".yml")
        for name in ("big", "latin"):
            errs = self.invalid(name)
            self.assertEqual((len(errs), errs[0]["path"], errs[0]["line"]), (1, "$", None))

    def test_yaml_file_with_prompt_files_reads_them_once_like_json(self):
        self.write_def("pf", "version: 1\nstages:\n- id: a\n  role: R\n  permission: read_only\n"
                             "  promptFile: prompts/develop.md\n  next: {done: $succeed}\n", ".yaml")
        d = wd.load(self.ws, "pf")
        self.assertEqual((d.stages[0].prompt, d.stages[0].prompt_source),
                         ("Develop: {{task}}", "prompts/develop.md"))
        self.write_def("pf2", "version: 1\nstages:\n- id: a\n  role: R\n  permission: read_only\n"
                              "  promptFile: prompts/missing.md\n  next: {done: $succeed}\n", ".yaml")
        errs = self.invalid("pf2")
        self.assertErr(errs, "stages[0].promptFile", "not found", line=6)


SEMANTIC = """\
version: 1
on: x
stages:
  - id: a
    permission: read_only
    prompt: do
    next: { done: b }
  - id: b
    role: R
    permission: read_only
    prompt: do
    next: { done: $succeed }
  - id: c
    role: R
    permission: read_only
    prompt: do
    next:
      pass: $succeed
      fail: nowhere
"""

SEMANTIC_JSON = {
    "version": 1, "on": "x",
    "stages": [
        {"id": "a", "permission": "read_only", "prompt": "do", "next": {"done": "b"}},
        {"id": "b", "role": "R", "permission": "read_only", "prompt": "do", "next": {"done": "$succeed"}},
        {"id": "c", "role": "R", "permission": "read_only", "prompt": "do",
         "next": {"pass": "$succeed", "fail": "nowhere"}},
    ],
}

CYCLE = ("version: 1\nstages:\n  - id: a\n    role: R\n    permission: read_only\n    prompt: do {{diff}}\n"
         "    next: { pass: $succeed, fail: a }\n")


class Lines(s01.Ws):
    def test_errors_report_the_line_of_their_key_or_nearest_ancestor(self):
        self.write_def("sem", SEMANTIC, ".yaml")
        errs = self.invalid("sem")
        self.assertErr(errs, "on", 'unknown key "on"', line=2)
        self.assertErr(errs, "stages[0].role", "role is required", line=4)       # missing: line of stages[0]
        self.assertErr(errs, "stages[2].next.fail", 'unknown target "nowhere"', line=19)
        self.assertEqual(len(errs), 3)

    def test_missing_top_level_key_is_reported_on_line_one(self):
        self.write_def("nov", "stages:\n  - id: a\n    role: R\n    permission: read_only\n    prompt: do\n"
                              "    next: { done: $succeed }\n", ".yaml")
        self.assertErr(self.invalid("nov"), "version", "required", line=1)

    def test_the_same_definition_as_json_reports_null_lines(self):
        self.write_def("sem", SEMANTIC_JSON)
        errs = self.invalid("sem")
        self.assertEqual(len(errs), 3)
        self.assertEqual({e["line"] for e in errs}, {None})

    def test_warnings_get_the_line_of_their_stage_in_yaml_and_null_in_json(self):
        self.write_def("cyc", CYCLE, ".yaml")
        d = wd.load(self.ws, "cyc")
        self.assertEqual(len(d.warnings), 1)
        w = d.warnings[0]
        self.assertEqual((w["path"], w["line"], w["file"]), ("stages[0]", 3, ".agent-studio/workflows/cyc.yaml"))
        self.assertIn("maxVisits 1", w["message"])
        self.write_def("cycj", {"version": 1, "stages": [
            {"id": "a", "role": "R", "permission": "read_only", "prompt": "do {{diff}}",
             "next": {"pass": "$succeed", "fail": "a"}}]})
        self.assertIsNone(wd.load(self.ws, "cycj").warnings[0]["line"])

    def test_listing_carries_yaml_warning_lines(self):
        self.write_def("cyc", CYCLE, ".yaml")
        entry = wd.list_definitions(self.ws)[0]
        self.assertEqual(entry["errors"], [])
        self.assertEqual([w["line"] for w in entry["warnings"]], [3])

    def test_dotted_top_level_key_is_not_confused_with_a_nested_path(self):
        self.write_def("dot", "version: 1\na.b: 1\na:\n  b: 2\nstages:\n  - id: a\n    role: R\n"
                              "    permission: read_only\n    prompt: do\n    next: { done: $succeed }\n", ".yaml")
        errs = self.invalid("dot")
        self.assertErr(errs, "a.b", 'unknown key "a.b"', line=2)
        self.assertErr(errs, "a", 'unknown key "a"', line=3)

    def test_unknown_key_in_a_flow_mapping_gets_its_line(self):
        self.write_def("fl", "version: 1\nstages:\n  - id: a\n    role: R\n    permission: read_only\n"
                             "    prompt: do\n    next: { done: $succeed, bad: x }\n", ".yaml")
        self.assertErr(self.invalid("fl"), "stages[0].next.bad", "unknown key", line=7)


class Fuzz(s01.Ws):
    FRAGMENTS = ["a: ", "- ", "  ", "\n", "|", "|-", "[", "]", "{", "}", ", ", "\"", "'", "key:", "# c", "---",
                 "...", "\\u00", "&x ", "*x", "!t ", "? ", ": ", "\t", "\r", "\r\n", "stages:", "next: {", "007",
                 "True", ">", "%", "@", "`", "\\", "\ud7ff", "é"]

    def samples(self):
        rng = random.Random(20240613)
        out = []
        for i in range(1000):
            if i % 3 == 0:
                data = bytes(rng.randrange(256) for _ in range(rng.randrange(0, 90)))
            elif i % 3 == 1:
                data = "".join(rng.choice("abc xyz019:-#{}[],'\"|>&*!%@`?\\\n\t \r$.~")
                               for _ in range(rng.randrange(0, 120))).encode("utf-8")
            else:
                data = "".join(rng.choice(self.FRAGMENTS) for _ in range(rng.randrange(0, 30))).encode("utf-8")
            out.append(data)
        return out

    def test_random_text_gives_a_value_or_yaml_subset_error(self):
        for data in self.samples():
            try:
                ys.loads(data.decode("utf-8", errors="replace"))
            except ys.YamlSubsetError:
                pass

    def test_every_prefix_of_the_section_b_yaml_gives_a_value_or_yaml_subset_error(self):
        text = fixture("section-b.yaml").decode("utf-8")
        for k in range(len(text) + 1):
            try:
                ys.loads(text[:k])
            except ys.YamlSubsetError:
                pass

    def test_every_prefix_of_the_section_b_yaml_through_the_loader_gives_invalid_or_a_definition(self):
        raw = fixture("section-b.yaml")
        for k in range(len(raw) + 1):
            self.write_def("fz", raw[:k], ".yaml")
            try:
                d = wd.load(self.ws, "fz")
            except AsError as e:
                self.assertEqual(e.code, wd.WORKFLOW_DEFINITION_INVALID, k)
            else:
                self.assertIsInstance(d, wd.Definition)

    def test_random_bytes_through_the_loader_give_invalid_or_a_definition(self):
        for data in self.samples():
            self.write_def("fz", data, ".yaml")
            try:
                d = wd.load(self.ws, "fz")
            except AsError as e:
                self.assertEqual(e.code, wd.WORKFLOW_DEFINITION_INVALID)
            else:
                self.assertIsInstance(d, wd.Definition)


if __name__ == "__main__":
    unittest.main()
