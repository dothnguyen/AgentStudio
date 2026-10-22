# P01-S01 — Definition model, JSON loader, and static validation

Status: Donem
Depends on: — (P00 Done)
Architecture: [P01 design contract](../README.md#a-where-definitions-live-and-how-they-are-named), sections A and B

## Goal

Turn a workflow definition file into a validated, immutable in-memory model, or a precise list of errors. This story covers JSON only and is pure code: no coordinator, database, or provider changes. Every later story consumes the model built here.

## Implement in this order

1. Create `backend/agent_studio/workflowdef.py` with frozen dataclasses: `Definition` (`name`, `version`, `description`, `max_steps`, `stages`, `source_sha256`, `warnings`) and `Stage` (`id`, `type`, `role`, `permission`, `prompt`, `prompt_source`, `max_visits`, `pass_requires`, `next`, `kind` ∈ `work | verdict | validation`). In the model, `prompt` is always the template **text** (inline or read from the file) and `prompt_source` records where it came from: `"inline"` or the `promptFile` path as written. Validation stages have `prompt = None`, `prompt_source = None`.
2. `parse_obj(obj, source) -> Definition` reads the **source form** (what a user writes): applies every rule in design contract §B, resolves `next` defaults, and computes `kind`. All violations are collected, not just the first, and raised together as `AsError(WORKFLOW_DEFINITION_INVALID, "<n> error(s) in <file>", data={"errors": [...], "warnings": [...]})`. Every error item has exactly this shape (design contract §B, "Errors"):
   - `file`: the definition file relative to the workspace (`.agent-studio/workflows/story-dev.json`), or `builtin:developer-reviewer.json` for the built-in, or the `source` label passed to `parse_obj`;
   - `path`: the JSON path of the offending value (`stages[2].next.fail`, `stages[0].promptFile`), or `$` for whole-file errors (over 64 KiB, invalid UTF-8, JSON syntax error, duplicate key, top level not an object);
   - `line`: `null` in this story. S02 fills it for YAML; JSON syntax errors fill it from the decoder's line number;
   - `message`: one sentence naming the rule, and for duplicate keys the key and the object it appears in (for example `duplicate key "next" in stages[1]`).
   `parse_obj` takes the prompt texts for `promptFile` stages from a `prompts` mapping supplied by `load` (path → text), so it never touches the filesystem itself.
3. Graph checks: every target exists, every stage is reachable from the first, and `$succeed` is reachable. Both warnings are defined on the **graph of `next` edges**, not on list order:
   - *re-enterable with `maxVisits: 1`*: the stage lies on a cycle (it can be reached again from itself) and its `maxVisits` is 1;
   - *reviewer without `{{diff}}`*: a `read_only` agent stage that can be reached from some `workspace_write` stage along `next` edges, whose template text (inline or from its prompt file) does not contain `{{diff}}`.
   Warnings have the same shape as errors (`path` = `stages[i]`). Placeholder validity is S03's job; keep a hook for it.
4. `load(workspace, name, builtin_dir=None)`: name regex, then lookup in `.agent-studio/workflows/` of **all three** extensions, `<name>.json`, `<name>.yaml`, `<name>.yml`, from this story on:
   - none found → `WORKFLOW_DEFINITION_NOT_FOUND`; more than one → `WORKFLOW_DEFINITION_AMBIGUOUS` (listing the files);
   - exactly one `.json` → parsed here; exactly one `.yaml` / `.yml` → `WORKFLOW_DEFINITION_INVALID` with one error (`path: "$"`, message `YAML definitions are supported from P01-S02`), which S02 replaces with the real parser.
   **Built-ins:** `builtin_dir` is a folder of built-in definitions passed in by the caller. With `builtin_dir=None` (the default in this story) only the workspace is searched. With a `builtin_dir`, a name with no workspace file is looked up there (JSON only), and its prompt files resolve under that folder. Tests pass a temporary folder; the real folder `backend/agent_studio/workflows/`, wiring it into `workflow.start`, and reserving the name `developer-reviewer` all stay in S04 / S06. Then: `WORKFLOW_DEFINITION_NOT_FOUND`, `WORKFLOW_DEFINITION_AMBIGUOUS`, the 64 KiB size limit, strict UTF-8, JSON with duplicate keys rejected, and SHA-256 of the raw definition bytes (`source_sha256`). **`promptFile` paths are relative to `<workspace>/.agent-studio/`** (the same base as `roles.json` paths): `promptFile: prompts/develop.md` means `<workspace>/.agent-studio/prompts/develop.md`. For a built-in definition the base is its `builtin_dir`. Reuse the path guard from `roles.py` (inside the base, no `..`, no absolute paths, no symlink escapes). Each prompt file is read once here, size-checked (32 KiB) and decoded as strict UTF-8, then handed to `parse_obj`; a run never re-reads it.
5. `list_definitions(workspace, builtin_dir=None)` returns one entry per name, sorted by name: `{name, files, builtin, description, stages, roles, errors, warnings}`. A broken, ambiguous or (until S02) YAML definition is listed with its `errors` and empty `stages` / `roles`, never hidden or skipped. Built-ins appear only when `builtin_dir` is given.
6. **Frozen form.** `to_json(definition)` emits the canonical JSON that S04 stores in `workflow_runs.definition_json`: sorted keys, UTF-8, no insignificant whitespace, every default filled in, and:
   - every agent stage carries its template text as `prompt` and its origin as `promptSource` (`"inline"` or the `promptFile` path); `promptFile` never appears in the frozen form;
   - top-level `name`, `sourceSha256` and `warnings` are included, so the frozen JSON alone describes the run.
   `from_json(obj) -> Definition` reads only this frozen form: it accepts `promptSource`, `sourceSha256`, `name` and `warnings` (which `parse_obj` rejects as unknown keys in source files), rejects `promptFile`, re-runs the structural and graph checks, and never touches the filesystem. Round trip, both ways: `from_json(json.loads(to_json(d))) == d` (all fields, including `source_sha256` and `warnings`), and `to_json(from_json(json.loads(t))) == t` byte for byte.

## Done when

- [ ] The §B example (written as JSON, with its prompt files) loads with the documented kinds, targets and limits.
- [ ] **Defaults fixture** (separate from the §B example) omits every optional value and loads with the documented defaults: `maxSteps` = 20, each `maxVisits` = 1, `type` = `agent`, `description` = `""`; a verdict stage with only `fail` gets `pass` = the next stage in the list; the last stage's missing `pass` = `$succeed`; a missing `fail` = `$fail`; a validation stage with no `next` gets `pass` = next stage, `fail` = `$fail`.
- [ ] **Failing fixtures, one per rule**, each giving `WORKFLOW_DEFINITION_INVALID` with the expected `file`, `path`, `line` and `message`:
  - top level: not an object; `version` missing or not `1`; unknown top-level key; `description` not text; `maxSteps` not an integer, below 1 or above 100 (booleans are not integers); `stages` missing, empty, not a list, or more than 20;
  - stage shape: not an object; bad `id`; duplicate `id`; unknown key; `type` not `agent` / `validation`;
  - agent stages: missing `role` or `role` not text; missing or unknown `permission`; neither or both of `prompt` / `promptFile`; empty `prompt`; `next` missing, not an object, empty, or with an unknown key; `done` mixed with `pass` / `fail`;
  - validation stages: any of `role`, `permission`, `prompt`, `promptFile`, `passRequires`; `next` containing `done` or an unknown key;
  - targets: not text; unknown stage id or unknown `$` target;
  - graph: unreachable stage; `$succeed` unreachable;
  - `passRequires`: on a work stage; not a list; naming an unknown id; naming a non-validation stage;
  - `maxVisits`: not an integer, below 1 or above 10;
  - files: definition over 64 KiB; prompt file over 32 KiB; prompt file not UTF-8 or missing; duplicate JSON keys; invalid UTF-8; JSON syntax error (with `line`).
- [ ] Several independent errors in one file are all returned in one response, in file order.
- [ ] Whole-file errors use `path: "$"`; a duplicate key's message names the key and its object.
- [ ] **Warnings:** a stage on a cycle with `maxVisits: 1` warns, and the same stage with `maxVisits: 2` does not; a `read_only` agent stage reachable from a `workspace_write` stage without `{{diff}}` in its template warns, and it does not warn when the template contains `{{diff}}`, when its prompt file contains it, or when no writer can reach it (a writer later in the list that cannot reach it does not count). Warnings never block loading.
- [ ] **Lookup:** `.json`, `.yaml` and `.yml` with the same stem → `WORKFLOW_DEFINITION_AMBIGUOUS` (all three pairings tested); a lone `.yaml` or `.yml` → `WORKFLOW_DEFINITION_INVALID` with the "supported from P01-S02" error; an invalid name → `WORKFLOW_DEFINITION_NOT_FOUND`, with no filesystem access outside `.agent-studio/workflows` (checked by name values such as `../x` and `a/b`).
- [ ] **Prompt files:** `promptFile: prompts/develop.md` loads `<workspace>/.agent-studio/prompts/develop.md`; escapes (`..`, absolute path, symlink out of the base) are refused with `path: "stages[i].promptFile"`.
- [ ] **Built-ins (temporary folder passed as `builtin_dir`):** a name found only there loads, its `promptFile` resolves under that folder, and `list_definitions` marks it `builtin: true`; with `builtin_dir=None` the same name is `WORKFLOW_DEFINITION_NOT_FOUND`; a workspace file of the same name is used instead of the built-in (the reservation of `developer-reviewer` is S06's).
- [ ] **`list_definitions`:** a workspace with two valid definitions, one broken JSON file, one ambiguous pair and one lone YAML file lists five names in order, the valid ones with description, stage ids and roles, the other three with their errors and empty `stages` / `roles`.
- [ ] **Frozen form:** the inlined prompt equals the file's text and `promptSource` records the path; no `promptFile` key appears; both round trips hold (`from_json(to_json(d)) == d` including `source_sha256` and `warnings`, and `to_json(from_json(t)) == t` byte for byte), for the §B example and the defaults fixture; `from_json` rejects `promptFile`, and `parse_obj` rejects `promptSource`, `sourceSha256`, `name` and `warnings` in a source file.
- [ ] `source_sha256` changes when the definition bytes change; editing only a prompt file changes the frozen `prompt` text but not `source_sha256`.
- [ ] Tests: `tests/unit/test_p01_s01_definitions.py`, one test per item above (fixtures inline or under `tests/fixtures/workflowdefs/`). The full unit suite stays green.

## Evidence

The S01 tests have not been run since the QA fixes (no shell was available). Run these and paste the output here before marking Done:

```
python3 -m unittest discover -s tests/unit -t .
```

Output: 

python3 -m unittest discover -s tests/unit -t .
.........................................................................................................../mnt/c/Works/Projects/AgentStudio/tests/unit/test_s06_parts.py:75: ResourceWarning: unclosed file <_io.TextIOWrapper name='/tmp/tmpsbuxpl0y/diff.patch' mode='r' encoding='UTF-8'>
  text = open(d["path"]).read()
ResourceWarning: Enable tracemalloc to get the object allocation traceback
.../mnt/c/Works/Projects/AgentStudio/tests/unit/test_s06_parts.py:40: ResourceWarning: unclosed file <_io.BufferedReader name=7>
  validation.run_validator(d)
ResourceWarning: Enable tracemalloc to get the object allocation traceback
/mnt/c/Works/Projects/AgentStudio/tests/unit/test_s06_parts.py:57: ResourceWarning: unclosed file <_io.TextIOWrapper name='/tmp/tmpg8aspd3i/validation.out' mode='r' encoding='UTF-8'>
  self.assertIn("$(touch CANARY_ARGV) ; rm -rf ~", open(r["outputPath"]).read())
ResourceWarning: Enable tracemalloc to get the object allocation traceback
.............................................................sss.........................................
----------------------------------------------------------------------
Ran 215 tests in 6.032s

OK (skipped=3)