# P01-S06 — Validation stages, `passRequires`, and the built-in definition

Status: To Do
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

- [ ] Fake: a definition with `develop → tests → qa(passRequires: tests)` where tests fail and QA says pass routes as `fail` with the added finding.
- [ ] `VALIDATION_ERROR` and `VALIDATION_LOST` pause the run. Hostile validation argv is printed and never run through a shell.
- [ ] Every PRD §6 truth-table row gives the same final status, assignment count, and retry count through the built-in definition as in P00.
- [ ] The legacy-run drill: a run inserted without `definition_json` pauses `LEGACY_WORKFLOW_RUN` after its assignment finishes, and cancels cleanly.
- [ ] `workflow.py` has a single engine path, and the guard test from S05 now covers the whole file.
- [ ] Tests: `tests/integration/test_p01_s06_validation.py`, plus the updated P00 workflow tests. The full suite stays green.

## Evidence

(filled in when the story is done)
