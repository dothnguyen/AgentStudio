# P01-S07 — Recovery, resolve, cancel, and deadlines for definition runs

Status: Done (2026-10-22)
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

- [x] Each crash point in step 2 has a passing integration drill: no duplicate assignment, the same final status, and a `workflow_run.routed` chain without gaps or repeats.
- [x] Resolve retry on a paused verdict stage succeeds without consuming a visit. A run that paused at `maxVisits - 1` can still finish.
- [x] Cancel works in each phase (agent stage, validation, paused). The overall deadline fails the run and cancels its active stage.
- [x] `PROCESS_STILL_RUNNING` is still returned when resolving while the runner is alive.
- [x] Tests: `tests/integration/test_p01_s07_recovery.py`. The full suite stays green.

## Evidence

- Tests: unit 305 OK (5 skipped). New `tests/integration/test_p01_s07_recovery.py`: 12 OK (Recovery 5 crash drills,
  Resolve 4, CancelAndDeadlines 3). Re-run OK: `test_p01_s06_validation` (11), P00 `test_s06_workflow` (10).
- Crash points added (`crashpoints.POINTS`, debug only, one-shot): `before_route_commit` (routing done, dispatch not
  committed), `after_advance_commit` (right after a stage commits), `after_verdict_before_route`, `while_validating`
  (validator alive, being polled), `after_validator_spawn` (validator started, transaction not committed). Each drill
  restarts the coordinator and checks: the point was hit, run `succeeded`, exactly 2 assignments (both succeeded), the
  routed chain equals the uncrashed chain, 3 completed attempts, and 2 handoffs.
- Fix found by the drills' design: a validator spawned inside a transaction that never commits would keep running
  while the retried stage spawned a second one in the same directory. `validation.spawn` now records
  `validator.pid.json` and first kills a still-matching old validator (verified identity) and clears its output.
  `advance` now commits each run's transaction before `after_advance_commit`.
- Resolve: no engine change was needed. Drills prove a retry of a paused verdict stage creates attempt 2 with the same
  visit (maxVisits 1 still finishes), `stepCount` unchanged, the same prompt text; a policy change is `BAD_REQUEST`;
  `fail` / `cancel` end the run and task; `PROCESS_STILL_RUNNING` is returned for a live runner (made by flipping the
  assignment to `waiting_input` in the database while the runner is alive).
- Cancel/deadlines: cancel of a running validator kills it (checked in /proc); the overall deadline fails the run and
  cancels the stage; the stage deadline pauses `TIMEOUT` and a retry finishes the run. Paused and agent-stage cancels
  were already covered by S05.
- Docs: `backend/RECOVERY.md` has a new section with the definition-run table.
