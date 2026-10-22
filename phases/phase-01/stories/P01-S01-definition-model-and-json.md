# P01-S01 — Definition model, JSON loader, and static validation

Status: To Do
Depends on: — (P00 Done)
Architecture: [P01 design contract](../README.md#a-where-definitions-live-and-how-they-are-named), sections A and B

## Goal

Turn a workflow definition file into a validated, immutable in-memory model, or a precise list of errors. This story covers JSON only and is pure code: no coordinator, database, or provider changes. Every later story consumes the model built here.

## Implement in this order

1. Create `backend/agent_studio/workflowdef.py` with frozen dataclasses: `Definition` (`name`, `version`, `description`, `max_steps`, `stages`, `source_sha256`, `warnings`) and `Stage` (`id`, `type`, `role`, `permission`, `prompt` or `prompt_file`, `max_visits`, `pass_requires`, `next`, `kind` ∈ `work | verdict | validation`).
2. `parse_obj(obj, source) -> Definition`: applies every rule in design contract §B, resolves `next` defaults, and computes `kind`. All violations are collected, not just the first. Each error carries `path` (for example `stages[2].next.fail`) and `message`, and the whole result is raised as `AsError(WORKFLOW_DEFINITION_INVALID, data={"errors": [...]})`.
3. Graph checks: every target exists, every stage is reachable from the first, and `$succeed` is reachable. Warnings for a re-enterable stage with `maxVisits: 1` and for a `read_only` stage after a writer that never uses `{{diff}}`. Placeholder validity is S03's job; keep a hook for it.
4. `load(workspace, name)`: name regex, lookup in `.agent-studio/workflows/` (S02 adds `.yaml`/`.yml`; this story handles `.json`), `WORKFLOW_DEFINITION_NOT_FOUND`, `WORKFLOW_DEFINITION_AMBIGUOUS`, the 64 KiB size limit, strict UTF-8, JSON with duplicate keys rejected, and SHA-256 of the raw bytes. Reuse the path guard from `roles.py` for the directory and for `promptFile` (inside `.agent-studio`, no `..`, no absolute paths, no symlink escapes). `promptFile` content is read and size-checked here (32 KiB) and stored in the model, so a run never re-reads it.
5. `list_definitions(workspace)` returns each name with its description, stage ids, roles, and load errors (a broken file is listed with its errors, not hidden).
6. `to_json(definition)` emits canonical JSON (sorted keys, defaults filled in) for freezing into a run. Round trip: `parse_obj(json.loads(to_json(d)))` equals `d`.

## Done when

- [ ] The §B example (written as JSON) loads, with the defaults and `kind` resolved as documented.
- [ ] Each §B rule has a failing fixture that produces the expected error code and `path`: bad id, duplicate id, unknown key, missing role/permission/prompt, both `prompt` and `promptFile`, `done` mixed with `pass`, unknown target, unreachable stage, unreachable `$succeed`, `passRequires` on a work stage or naming a non-validation stage, `maxVisits` / `maxSteps` out of range, more than 20 stages, a file over 64 KiB, a prompt file over 32 KiB, duplicate JSON keys, invalid UTF-8.
- [ ] `promptFile` escapes (`..`, absolute path, symlink out of `.agent-studio`) are refused.
- [ ] Two files with the same stem → `WORKFLOW_DEFINITION_AMBIGUOUS`. An invalid name → `WORKFLOW_DEFINITION_NOT_FOUND`, and no filesystem access happens outside `.agent-studio/workflows`.
- [ ] Canonical JSON round-trips, and SHA-256 changes when the source bytes change.
- [ ] Tests: `tests/unit/test_p01_s01_definitions.py`. The full unit suite stays green.

## Evidence

(filled in when the story is done)
