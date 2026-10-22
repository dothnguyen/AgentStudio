# P01-S04 — Schema rebuild, role binding, and starting a definition run

Status: To Do
Depends on: P01-S01, P01-S03
Architecture: [P01 design contract](../README.md#d-engine-semantics), sections D (Binding, Start) and F (Migration)

## Goal

Make the database able to hold runs with arbitrary stage ids, and let `workflow.start` with a `definition` bind roles to agents, freeze the definition and bindings into the run, and dispatch the first stage. Routing after that first stage is S05. P00-form starts and runs keep using the existing engine path, unchanged, until S06.

## Implement in this order

1. Next migration in `schema.py`: rebuild `workflow_runs` and `stage_attempts` in one transaction (create `*_new`, copy every row, drop, rename, recreate indexes, run `PRAGMA foreign_key_check`). Drop the `stage IN STAGES`, `current_stage IN STAGES`, and `retry_count <= retry_budget` CHECKs, and add the §F columns. Keep `assignments.stage_attempt_id` references valid. Update the `Entity` column lists.
2. Binding in a new `workflow.bind_roles(tx, team, definition, overrides, ctx)`: one agent per distinct role from the roster `role` (Q2), overrides from `bindings`, `ROLE_UNBOUND` / `ROLE_AMBIGUOUS` / `AGENT_NOT_IN_TEAM` / `SAME_AGENT` (Q3), live pane and availability (`AGENT_UNAVAILABLE`), and a verified adapter mapping for every permission that role's stages use (`POLICY_UNSUPPORTED`).
3. `workflow.start` with a `definition` arg: load through `workflowdef.load` (and the built-in directory for the reserved name), then apply the existing P00 preconditions in the same order. Create the task and run with `workflow = "definition"`, `definition_name`, `definition_json` (the frozen form from `workflowdef.to_json`; the engine reads it back only with `workflowdef.from_json`, never `parse_obj`), `definition_sha256` (= the frozen form's `sourceSha256`), `bindings_json`, and `step_count = 1`. The `workflow_run.started` payload includes name, SHA-256, and bindings.
4. Generic `_dispatch`: the agent comes from the bindings via the stage's role, the policy from the stage's `permission`, and the prompt from `prompts.render` of the frozen template. Stage attempts record `stage_type` and `visit`. The prompt dir stays `workflows/<id>/<nn>-<stage>/`. P00 runs (`definition_json` NULL) keep the current `DEV_STAGES` / `POLICY` lookups.
5. `workflow.show` returns the new columns (parsed JSON for the definition and bindings).

## Done when

- [ ] Migration test: a database created at the previous schema version with P00 runs, stage attempts, and assignments migrates, every row and foreign key is intact, and a stage id outside the P00 set is now accepted.
- [ ] A definition run started with the fake adapter freezes definition, SHA-256, and bindings. Editing the file afterwards changes nothing in the run.
- [ ] The first assignment goes to the bound agent with the stage's policy and the rendered prompt (TASK present, footer only on verdict stages).
- [ ] Each binding error and the P00 preconditions (`WORKSPACE_DIRTY`, `WORKSPACE_NOT_GIT`, `WORKSPACE_BUSY`, `TEAM_NOT_RUNNING`) are rejected before any row is written.
- [ ] Idempotency: the same key and payload return the original receipt; the same key with another definition → `IDEMPOTENCY_CONFLICT`.
- [ ] Tests: `tests/unit/test_p01_s04_migration.py`, `tests/integration/test_p01_s04_start.py`. All P00 tests stay green.

## Evidence

(filled in when the story is done)
