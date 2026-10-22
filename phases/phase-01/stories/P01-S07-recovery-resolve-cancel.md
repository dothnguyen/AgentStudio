# P01-S07 — Recovery, resolve, cancel, and deadlines for definition runs

Status: To Do
Depends on: P01-S06
Architecture: [P01 design contract](../README.md#d-engine-semantics), section D; [P00 contract](../../phase-00/architecture.md) section H

## Goal

Prove that definition runs keep P00's recovery guarantees. A coordinator restart at any point never duplicates or loses a stage. `assignment.resolve` resumes a paused stage without spending a visit or step. `workflow.cancel` and both deadlines behave as in P00. Most of the code exists already, so this story is mainly the drills plus fixes for what they find.

## Implement in this order

1. `resolve.py`: retry of a paused definition stage re-renders that stage's prompt from the frozen definition and the inputs it originally had (re-use the attempt's `prompt.txt`), creates a new attempt with the same `visit`, and leaves `step_count` and visit counts unchanged. A policy change on retry stays refused (the stage's `permission` is fixed). `fail` on a paused stage ends the run `failed`, and `cancel` ends it `cancelled`.
2. Crash points (`AGENT_STUDIO_TEST_CRASH_AT`) at: after routing but before dispatch commit, after dispatch, mid-validation, and after a verdict is applied but before routing. Restart at each must give exactly one next assignment and the same final result as an uncrashed run.
3. `workflow.cancel` for a definition run: active agent stage → `assignment.cancel`; running validator → killed by verified identity; paused → ended and agents freed. Workflow and stage deadlines from `workflow.json` apply unchanged.
4. Update `backend/RECOVERY.md` with definition-run examples (`workflow show` route and visits, resolve on a paused QA stage, `LEGACY_WORKFLOW_RUN`).

## Done when

- [ ] Each crash point in step 2 has a passing integration drill: no duplicate assignment, the same final status, and a `workflow_run.routed` chain without gaps or repeats.
- [ ] Resolve retry on a paused verdict stage succeeds without consuming a visit. A run that paused at `maxVisits - 1` can still finish.
- [ ] Cancel works in each phase (agent stage, validation, paused). The overall deadline fails the run and cancels its active stage.
- [ ] `PROCESS_STILL_RUNNING` is still returned when resolving while the runner is alive.
- [ ] Tests: `tests/integration/test_p01_s07_recovery.py`. The full suite stays green.

## Evidence

(filled in when the story is done)
