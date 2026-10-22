# P01-S02 — Strict YAML subset loader

Status: Done (2026-10-22)
Depends on: P01-S01
Architecture: [P01 design contract](../README.md#b-definition-format-version-1), sections A and B; open question Q1

## Goal

Let operators write definitions in YAML without adding a third-party dependency. A small stdlib parser accepts a documented subset of YAML that is large enough for every definition shape in §B, and it rejects everything else with a line number instead of guessing. Its output feeds the same `parse_obj` as JSON, so both formats produce identical models.

## Implement in this order

1. Create `backend/agent_studio/yamlsubset.py` (stdlib only) with:
   - `loads(text: str) -> object`, the parsed value as plain `dict` / `list` / `str` / `int` / `bool` / `None`;
   - `loads_with_lines(text: str) -> (object, dict)`, the same value plus a **line map**: JSON path → 1-based line, using the same path syntax as error items (`$` for the root, `stages`, `stages[2]`, `stages[2].next.fail`). A mapping value's line is the line of its key; a sequence item's line is the line of its `-` (or, in a flow sequence, the line the item is on);
   - `YamlSubsetError(Exception)` with attributes `line` (1-based int) and `message` (str).
   Input is the already-decoded text (`workflowdef` keeps the 64 KiB and strict UTF-8 checks). Supported:
   - block mappings and block sequences, indented with spaces. A block sequence may sit at the same indentation as its parent key (`stages:` then `- id: x` in column 1) or deeper. A sequence item may start a mapping on the same line (`- id: develop`, with the item's other keys aligned under `id`);
   - flow mappings `{ a: b, c: d }` and flow sequences `[a, b]` that open and close **on one line**, including nesting, empty `{}` / `[]`, and quoted scalars inside;
   - plain, single-quoted (`''` is the only escape), and double-quoted scalars (escapes `\\ \" \n \t \uXXXX` only; any other escape, and a `\u` escape of a surrogate, is an error). Plain and quoted scalars are single-line;
   - literal block scalars `|` and `|-` (optionally followed by a `#` comment on the header line). The content indentation is that of the first non-blank line, which must be deeper than the parent; lines keep their indentation beyond it; blank lines inside are kept; `#` inside the content is text, not a comment. `|` ends with exactly one newline, `|-` with none;
   - `#` comments (at line start, or after whitespace) and blank lines; one optional `---` as the first non-comment line;
   - line breaks `\n` and `\r\n`.
   Mapping keys are always strings: a plain or quoted scalar, taken as text without type resolution (so `on:` is the key `"on"`, and `parse_obj` reports it as an unknown key). Plain scalar **values** resolve as follows: `0` or `-?[1-9][0-9]*` → int; `true` / `false` → bool; `null`, `~`, or an empty value (`key:` with nothing nested under it) → None; everything else → string (so `$succeed`, `on`, `yes`, `no`, `off` stay strings). Quoted scalars are always strings.
2. Rejected with `YamlSubsetError` and the line of the offending construct (nothing is guessed):
   - anchors, aliases and tags (`&`, `*`, `!` at the start of a value), and `%` directives;
   - multiple documents (`---` after content, or any `...`);
   - folded scalars `>` / `>-`, and block scalar indicators other than `|` / `|-` (`|+`, `|2`, ...);
   - multi-line flow collections, multi-line plain or quoted scalars;
   - complex keys (`? `), and a plain scalar that starts with an indicator (`@`, `` ` ``, `,`, `]`, `}`, `|`/`>` other than a block header, `%`);
   - plain values that YAML 1.1/1.2 would read differently from this subset: numbers other than the int form above (`007`, `+1`, `1.5`, `1e3`, `0x1F`, `.inf`) and the case variants `True`, `TRUE`, `False`, `FALSE`, `Null`, `NULL` — the message tells the operator to quote the value;
   - duplicate keys, with the §B message (`duplicate key "next" in stages[1]`, `duplicate key "version" in the top-level object`);
   - tabs in indentation, and inconsistent indentation (a line indented to a level that no open block uses);
   - control characters other than tab, LF and CR-before-LF (a lone CR is an error), and a leading byte-order mark;
   - nesting deeper than 32 levels;
   - a document whose root is not a block mapping, including an empty document (line 1).
3. In `workflowdef`, replace S01's "YAML definitions are supported from P01-S02" error in `load` (and so in `list_definitions`) with this parser. Lookup and ambiguity already cover all three extensions since S01 and do not change. For a `.yaml` / `.yml` file:
   - size and UTF-8 checks are as for JSON (`line: null`). A `YamlSubsetError` becomes one `WORKFLOW_DEFINITION_INVALID` error with `path: "$"`, the error's `line`, and its message. The parse stops there;
   - otherwise the value goes through the same prompt-file reading and `parse_obj` as JSON, and `source_sha256` is the SHA-256 of the YAML bytes. Then every error **and warning** gets the line from the line map: the line of its exact `path`, or else of the nearest ancestor path that exists (a missing `stages[0].role` gets the line of `stages[0]`; a missing top-level key gets line 1). `parse_obj` itself does not change;
   - JSON files keep S01's behaviour (`line: null`, except syntax errors).
   Replace the S01 test `test_lone_yaml_reports_supported_from_s02` in `tests/unit/test_p01_s01_definitions.py` (its expected message no longer exists) with a pointer to the S02 tests. The S01 `list_definitions` test keeps passing unchanged, because its `version: 1` YAML files still have errors (no `stages`).
4. Add `backend/agent_studio/workflows/README.md` (the built-in folder that S06 fills; `list_definitions` reads only `.json` there, so the README is never listed) with a short "YAML subset" section: what is accepted, what is refused and why (quote ambiguous values), and why the key is `next` and not `on`.

## Done when

- [x] **Same model from both formats:** the §B example as YAML and the same definition as JSON (each with the same prompt files under `.agent-studio/prompts/`, fixtures in `tests/fixtures/workflowdefs/`) load to `Definition` objects that are equal in every field except `source_sha256` (and the `file` of any warning), and whose canonical JSON is equal after removing `sourceSha256` and those `file` values. Also tested for the S01 defaults fixture written as YAML.
- [x] **Rejected constructs:** one test per bullet of step 2 (every listed form of the bullet) asserts `YamlSubsetError` with the expected line, and, through `workflowdef.load`, one `WORKFLOW_DEFINITION_INVALID` error with `path: "$"` and that line. The duplicate-key test checks the §B message text.
- [x] **Accepted forms:** a test per bullet of step 1: an indentless and an indented sequence give the same value; nested and empty flow collections; both quote styles with every allowed escape; a header comment on `|`; a leading `---`; a CRLF file equals its LF copy; comments after values and on their own lines.
- [x] **Scalar typing:** `on`, `yes`, `no`, `off`, `$succeed` → strings; `"123"` and `'123'` → strings; `123`, `0`, `-1` → ints; `true` / `false` → bools; `~`, `null` and an empty value → None; quoted strings containing `: ` and ` #` keep them; an `on:` key reaches `parse_obj` as the unknown key `"on"` with its line.
- [x] **Block scalars:** `|` keeps newlines, inner blank lines, deeper relative indentation and `#` lines, and ends with exactly one newline (also when trailing blank lines follow); `|-` has no final newline; a `|` block is identical to the double-quoted string with `\n` escapes.
- [x] **Lines on semantic errors:** a YAML file with an unknown top-level key, a stage missing `role`, an unknown target in `stages[2].next.fail`, and a cycle stage with `maxVisits: 1` (warning) reports each error and the warning with the expected line (exact key line, nearest-ancestor line for the missing key). The same definition as JSON still reports `line: null`.
- [x] **Loader:** a lone valid `.yaml` and a lone valid `.yml` load; `list_definitions` shows a valid YAML definition with its description, stages and roles, and a YAML syntax error as an entry with that error.
- [x] **Fuzz:** a seeded (reproducible) test feeds 1,000 random strings (random bytes decoded with `errors="replace"`, mixed with YAML indicator characters) and every truncated prefix of the §B YAML to `loads`; each call returns a value or raises `YamlSubsetError`, never any other exception (including `RecursionError`). The same inputs as raw bytes through `workflowdef.load` give only `WORKFLOW_DEFINITION_INVALID` or a `Definition`.
- [x] **Docs:** `backend/agent_studio/workflows/README.md` has the "YAML subset" section described in step 4, and it lists every rejected construct from step 2.
- [x] Tests: `tests/unit/test_p01_s02_yaml.py`; S01's `test_lone_yaml_reports_supported_from_s02` is replaced as in step 3. The full unit suite stays green (`python3 -m unittest discover -s tests/unit -t .`).

## Evidence

- Command: `python3 -m unittest discover -s tests/unit -t .` → `Ran 262 tests in 6.443s`, `OK (skipped=3)`. The suite
  also printed three ResourceWarnings from `tests/unit/test_s06_parts.py`, which is not part of this story.
- Added: `backend/agent_studio/yamlsubset.py`, `backend/agent_studio/workflows/README.md`,
  `tests/unit/test_p01_s02_yaml.py`, `tests/fixtures/workflowdefs/{section-b,defaults}.{json,yaml}`.
- Changed: `backend/agent_studio/workflowdef.py` (YAML branch in `_parse_file`, `_yaml_line` nearest-ancestor
  lookup, applied to errors and warnings); `tests/unit/test_p01_s01_definitions.py`
  (`test_lone_yaml_reports_supported_from_s02` replaced by `test_lone_yaml_is_validated_like_json`, which points to
  the S02 tests).
- Deviation from step 1: the keys of the `loads_with_lines` line map are segment tuples (`()` for the root,
  `("stages", 2, "next", "fail")`), not path strings. This means a dotted key such as `a.b` cannot be confused with
  the nested path `a` → `b` (tested). `workflowdef._yaml_line` converts error paths to these keys. `workflowdef` is the
  only consumer.
- Choices made: rejected forms run as one table-driven test (`REJECTED`, one `subTest` per form, grouped by step-2
  bullet), not one test method per bullet. A plain `2026-10-22` is read as text, not refused as a YAML 1.1 timestamp.
- QA follow-ups (suggestions, not blocking): the unrelated `scripts/team/team.py` change should be committed
  separately; `test_p01_s02_yaml.py:289` asserts `list_definitions(...) is not None`, which is always true; the
  README's Refused list does not mention flow trailing commas (`[a, ]`) or the timestamp choice; the
  `workflowdef.py` module docstring still mentions only JSON.
