# P01-S04 — Schema rebuild, role binding, and starting a definition run

Status: Done (2026-10-22)
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

- [x] Migration test: a database created at the previous schema version with P00 runs, stage attempts, and assignments migrates, every row and foreign key is intact, and a stage id outside the P00 set is now accepted.
- [x] A definition run started with the fake adapter freezes definition, SHA-256, and bindings. Editing the file afterwards changes nothing in the run.
- [x] The first assignment goes to the bound agent with the stage's policy and the rendered prompt (TASK present, footer only on verdict stages).
- [x] Each binding error and the P00 preconditions (`WORKSPACE_DIRTY`, `WORKSPACE_NOT_GIT`, `WORKSPACE_BUSY`, `TEAM_NOT_RUNNING`) are rejected before any row is written.
- [x] Idempotency: the same key and payload return the original receipt; the same key with another definition → `IDEMPOTENCY_CONFLICT`.
- [x] Tests: `tests/unit/test_p01_s04_migration.py`, `tests/integration/test_p01_s04_start.py`. All P00 tests stay green.

## Evidence

- Tests: unit suite `python3 -m unittest discover -s tests/unit -t .` → 302 OK (5 skipped), including 9 new in
  `tests/unit/test_p01_s04_migration.py`. New `tests/integration/test_p01_s04_start.py`: 22 OK. P00 integration:
  `test_s01_coordinator` + `test_s02_state` (29), `test_s04_runner` + `test_s05_direct` (26), `test_s06_workflow` (10)
  OK; `test_s07_recovery` 16 of 17 OK. The one error, `StartupAndStop.test_orphan_sessions_at_startup`
  (`KeyError: 'startupReconciliation'`), passes when its class runs alone and **fails the same way on an unmodified
  `git archive HEAD` copy**, so it is a pre-existing order/timing flake in the full-module run, not caused by this story.
- Migration (schema v6, `schema.MIGRATION_6`): `workflow_runs` and `stage_attempts` rebuilt in one transaction (new
  table, copy named columns, drop, rename, recreate `workflow_runs_by_status`, `PRAGMA foreign_key_check`). Dropped:
  the stage-name CHECKs and `retry_count <= retry_budget`. Kept: status CHECKs, `retry_count >= 0`, UNIQUE
  `(workflow_run_id, stage, attempt)`. New: `workflow_runs.definition_name / definition_json / definition_sha256 /
  bindings_json / step_count`; `stage_attempts.stage_type / visit`.
- Deviation: `state.migrate` now switches `PRAGMA foreign_keys` OFF around the migration transaction (the documented
  SQLite procedure) and back ON afterwards. Deferring the keys was tried first and failed at COMMIT, because
  dropping `stage_attempts` leaves deferred violations that renaming does not clear. The step's own
  `foreign_key_check` raises, which rolls everything back (tested).
- Engine: `workflow.bind_roles`, `workflow._start_definition`, `workflow.is_definition_run / frozen_definition`;
  `_dispatch` now takes `prompt=None` plus `data` and renders the frozen template (policy from `permission`, agent from
  the bindings). `dispatch._validate_workflow_start` accepts `definition`, `bindings`, and stage-id keys for
  `debugStageOptions`; mixing with `developerAgentId` / `reviewerAgentId` is `BAD_REQUEST`. A definition whose first
  stage is a validation stage is refused (`BAD_REQUEST`) until S06.
- Choices: a role matches the roster `role` exactly (case-sensitive). Errors carry their data at the response's
  top-level `data` (existing convention), e.g. `data.errors` for `WORKFLOW_DEFINITION_INVALID`, `data.role` for
  `ROLE_UNBOUND`, `data.agentIds` for `ROLE_AMBIGUOUS`. Definition files and prompts must be committed, because the
  clean-tree rule applies to them like any other file. `workflow.show` needed no change: its generic row conversion
  returns `definition`, `bindings`, `definitionName`, `definitionSha256`, `stepCount`, `stageType`, `visit`.
- Until S05: when a definition run's first stage finishes, the run **pauses** with `ROUTING_NOT_AVAILABLE` (or the
  stage's own diagnostic code) and can be cancelled; it never runs P00's reviewer logic by accident. The built-in
  `developer-reviewer` file arrives in S06, so starting it now answers `WORKFLOW_DEFINITION_NOT_FOUND`.
- Not done here (by design): CLI flags (`--definition`, `--bind`: S08), routing and bounds (S05), validation stages
  (S06), `workflow_runs.session_key` (S12, which must be added in its own migration).
