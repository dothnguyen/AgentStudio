# P01-S02 — Strict YAML subset loader

Status: To Do
Depends on: P01-S01
Architecture: [P01 design contract](../README.md#b-definition-format-version-1), sections A and B; open question Q1

## Goal

Let operators write definitions in YAML without adding a third-party dependency. A small stdlib parser accepts a documented subset of YAML that is large enough for every definition shape in §B, and it rejects everything else with a line number instead of guessing. Its output feeds the same `parse_obj` as JSON, so both formats produce identical models.

## Implement in this order

1. Create `backend/agent_studio/yamlsubset.py` with `loads(text) -> object`, raising `YamlSubsetError(line, message)`. Supported:
   - block mappings and block sequences, indented with spaces (tabs are an error);
   - single-line flow mappings `{ a: b, c: d }` and flow sequences `[a, b]`;
   - plain, single-quoted, and double-quoted scalars (escape sequences `\\ \" \n \t \uXXXX`);
   - literal block scalars `|` and `|-`;
   - `#` comments and blank lines.
   Plain scalars resolve as follows: integers `-?[0-9]+` → int, `true` / `false` → bool, `null` / `~` → None, and anything else → string (so `$succeed`, `on`, `yes`, and `no` stay strings).
2. Rejected, each with a line number: anchors / aliases / tags (`&`, `*`, `!`), multiple documents (`---` after content, `...`), folded scalars `>`, multi-line flow collections, complex keys (`? `), duplicate keys, inconsistent indentation, and a document whose root is not a mapping.
3. Replace S01's "YAML definitions are supported from P01-S02" error for `.yaml` / `.yml` in `workflowdef.load` (lookup and ambiguity already cover all three extensions since S01) with this parser. Parser errors become `WORKFLOW_DEFINITION_INVALID` errors with `line`. Semantic errors from `parse_obj` carry the line of the offending key where the parser can track it (the parser records a line for each mapping key).
4. Document the subset in a short `backend/agent_studio/workflows/README.md` section (what is accepted, what is refused, why `next` and not `on`).

## Done when

- [ ] The §B example YAML and the same definition as JSON produce equal `Definition` objects and equal canonical JSON.
- [ ] Each rejected construct in step 2 has a test asserting the error and its line number.
- [ ] Scalar typing is tested, including `on`, `yes`, `no`, `$succeed`, `"123"`, `123`, `-1`, `~`, and quoted strings that contain `:` and `#`.
- [ ] `|` blocks keep their newlines and indentation relative to the block, and `|-` strips the final newline.
- [ ] A fuzz-style test feeds 1,000 random byte strings and truncated copies of valid files. The parser either returns a value or raises `YamlSubsetError`, and never any other exception.
- [ ] Tests: `tests/unit/test_p01_s02_yaml.py`. The full unit suite stays green.

## Evidence

(filled in when the story is done)
