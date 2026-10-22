# P01-S06 — Validation stages, `passRequires`, and the built-in definition

Status: Done (2026-10-22)
Depends on: P01-S05
Architecture: [P01 design contract](../README.md#g-upgrade-and-compatibility), sections B (`type: validation`, `passRequires`), D (Outcomes), and G

## Goal

Let a definition place the deterministic test command anywhere in its stage list, and let a verdict count as a pass only when the tests it depends on passed. Then re-express P00's workflow as the built-in `developer-reviewer` definition and delete the hard-wired engine path, leaving one engine for every run.

## Implement in this order

1. Validation stages: on entry, spawn the detached validator with the frozen `workflow.json` config exactly as P00 does (`validation.spawn`, the `validating` phase, `stage_attempt.validating` / `validated` events). Exit 0 → `pass`, nonzero or timeout → `fail`, could not run → pause `VALIDATION_ERROR`, validator gone without a result → pause `VALIDATION_LOST`. Then route. `{{validation}}` in later prompts uses the latest result.
2. `passRequires`: on a verdict `pass`, check the latest result of each listed validation stage. If any failed or never ran, the outcome becomes `fail`, and a finding `"<stage> did not pass"` is prepended (the agent's own findings are kept).
3. Ship `backend/agent_studio/workflows/developer-reviewer.json`, unrolled as in design contract §G, with templates equal to P00's `TEMPLATES`. Reserve the name in `workflowdef.load`.
4. The P00 `workflow.start` form (`developerAgentId`, `reviewerAgentId`) loads the built-in definition with bindings `{Developer: developerAgentId, Reviewer: reviewerAgentId}`, which bypasses roster-role lookup, so P00 teams with any role names keep working. The receipt keeps its P00 fields.
5. Delete the legacy branch (`DEV_STAGES`, `REVIEW_STAGES`, `POLICY`, `TEMPLATES`, `_decide`, `_last_dev_attempt`, the `developer_agent_id` reads). Q8: on coordinator start and every tick, an active run with no `definition_json` pauses `LEGACY_WORKFLOW_RUN` once its current assignment or validator is terminal (never killed). `assignment.resolve` refuses it, and `workflow.cancel` works.
6. Update the P00 S06/S07 tests only where they count stage attempts (validation is now its own attempt) or read removed columns. Every behaviour assertion stays: outcomes, assignment counts, retry count, events, and the truth-table rows. Each changed assertion is listed in Evidence.

## Done when

- [x] Fake: a definition with `develop → tests → qa(passRequires: tests)` where tests fail and QA says pass routes as `fail` with the added finding.
- [x] `VALIDATION_ERROR` and `VALIDATION_LOST` pause the run. Hostile validation argv is printed and never run through a shell.
- [x] Every PRD §6 truth-table row gives the same final status, assignment count, and retry count through the built-in definition as in P00.
- [x] The legacy-run drill: a run inserted without `definition_json` pauses `LEGACY_WORKFLOW_RUN` after its assignment finishes, and cancels cleanly.
- [x] `workflow.py` has a single engine path, and the guard test from S05 now covers the whole file.
- [x] Tests: `tests/integration/test_p01_s06_validation.py`, plus the updated P00 workflow tests. The full suite stays green.

## Evidence

- Tests: unit 305 OK (5 skipped). New `tests/integration/test_p01_s06_validation.py`: 11 OK (Validation 7, BuiltIn 3,
  LegacyRuns 1). Re-run OK: `test_p01_s04_start` (19), `test_p01_s05_routing` (16 after removing the obsolete
  "validation refused" test), P00 `test_s06_workflow` (10), `test_s05_direct` + `test_s01_coordinator` + `test_s02_state`
  (43), `test_s04_runner` (12), `test_s12_live_gate_dryrun` (1). `test_s07_recovery` 16 of 17: only the pre-existing
  `test_orphan_sessions_at_startup` flake (fails identically on unmodified HEAD, see S04).
- Engine: `workflow.py` has one path. Validation stages (`_enter_validation`, `_advance_validation`; events
  `stage_attempt.validating` / `validated`, `workflow_run.stage_entered`), `passRequires` in `_advance_definition`
  (verdict_json keeps `agentVerdict`), `{{validation}}` from the latest result, `_legacy_run` (Q8) and the P00 form
  in `start`. Removed: `DEV_STAGES`, `REVIEW_STAGES`, `POLICY`, `TEMPLATES`, `compose_prompt`, `_decide`,
  `_last_dev_attempt`, the `developer_agent_id` reads. `P00_FORM` is the one constant naming the built-in and its two
  roles; the S05 guard now scans the whole file and exempts only that constant.
- Built-in: `backend/agent_studio/workflows/developer-reviewer.json`, six stages as in §G, P00 template text (the
  reviewer JSON sentence comes from the verdict footer, per S03). Names are reserved: a workspace file with a
  built-in's name is `WORKFLOW_DEFINITION_INVALID` (S01 had let the workspace file win; its test
  `test_workspace_file_wins_over_builtin` became `test_workspace_file_with_a_builtin_name_is_invalid`).
- Q8: a run with no `definition_json` pauses `LEGACY_WORKFLOW_RUN` once its assignment or validator is over (a cancel
  request ends it cancelled); `assignment.resolve` answers `RESOLVE_NOT_ALLOWED`; `workflow.cancel` works. Drill: a
  definition run's `definition_json` is nulled while the coordinator is stopped, then restarted.
- Changed P00 assertions (behaviour assertions kept): `test_s06_workflow`: (1) stage attempt list is now the six
  stages with outcomes `done / validation_failed / verdict_fail / done / validation_passed / verdict_pass`;
  (2) the unpack `dev1, rev1, dev2, rev2` became six names and the validation output is read from the validation
  attempt; (3) failed-twice run has 6 attempts (still 4 assignments) and `transitionReason` `reviewer_recheck fail`
  instead of "repair budget"; (4) `test_rows`: 3 attempts for pass+pass, the next-stage wait uses index 3, the repair
  event is checked through `findings[0] == "validation did not pass"` instead of `reason == "validation failed"`, and
  the last row's reason is `reviewer_recheck fail` with `lastFinding` `validation_recheck did not pass`;
  (5) the CLI-detached run expects at least 3 attempts. `test_s07_recovery`: the retried-timeout run lists four
  attempts (abandoned, developer, validation, reviewer). `test_s06_parts` and the S03 `P00Compatibility` tests render
  the built-in's templates instead of calling `compose_prompt`. Truth-table rows give the same final status, assignment
  counts and retry counts.
- Behaviour notes: the P00 form's `workflow` column now reads `definition` and `retry_budget` is 0 (no longer
  enforced); `developer_agent_id` / `reviewer_agent_id` are no longer written for new runs. A validation stage's attempt
  directory is `workflows/<id>/<nn>-<stage>/` with a `stage.txt` marker (its `prompt_path`). A validator that cannot run at
  all (missing executable) pauses `VALIDATION_ERROR`; a nonzero exit, including a missing script, is a plain failure.
  Hostile argv text is printed in the output and never reaches a shell (tested).
