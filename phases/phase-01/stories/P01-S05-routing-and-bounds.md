# P01-S05 — Agent-stage outcomes, routing, and bounds

Status: Done (2026-10-22)
Depends on: P01-S04
Architecture: [P01 design contract](../README.md#d-engine-semantics), sections D (Outcomes, Routing, Diffs, Task status) and F (Events)

## Goal

Drive a definition run from stage to stage. Each finished agent stage is turned into an outcome (`done`, `pass`, `fail`) or a pause, the `next` table picks the following stage, and `maxVisits` / `maxSteps` keep every loop bounded. This is what makes "QA fail → Developer, QA pass → TeamLead, TeamLead fail → Developer" work. Validation stages are S06; a definition that contains one is rejected at start with a clear "not yet supported" error until S06 lands.

## Implement in this order

1. In `_advance_one`, branch on `definition_json`. P00 runs keep the existing code. Definition runs go to a new `_advance_definition`.
2. Outcome per design contract §D. Work stage + `succeeded` → `done`. Verdict stage + `succeeded` + `valid_verdict` → `pass` / `fail`, recording `stage_attempt.verdict` as P00 does. Malformed or missing verdict → pause `MALFORMED_VERDICT`. A non-success status → pause with its diagnostic code. Cancelled → run cancelled.
3. Diff capture after every successful `workspace_write` stage (reuse `gitws.capture_diff`, store `diff_json` on the attempt). Track the inputs for the next prompt: latest diff, latest validation (none yet), the routing verdict's findings, and the previous agent stage's summary.
4. Routing: target = `next[outcome]`. `$succeed` / `$fail` end the run with the reason `"<stage> <outcome>"`. Otherwise check `maxSteps` (step_count + 1) and the target's visit count against `maxVisits`. If either would be exceeded, end the run `failed` with the reason (`"qa visit limit 3 reached"` / `"step limit 16 reached"`) and record the last finding. Else increment `step_count`, emit `workflow_run.repair_requested` and increment `retry_count` if the target was visited before, move the task between `running` and `review` by the target's kind, and `_dispatch` the target with its rendered prompt.
5. Emit `workflow_run.routed` for every transition, including terminal ones. The run's `current_stage`, `current_agent_id`, and `last_finding` stay current, and `snapshot` shows them.
6. Guard test: `workflow.py`, `workflowdef.py`, and `prompts.py` contain no role names (`Developer`, `QA`, `TeamLead`, `Reviewer`), no stage ids of the example definitions, and no provider IDs, apart from the P00 legacy block that S06 deletes.

## Done when

- [x] Fake, three roles: develop → qa fail → develop → qa pass → final pass → `succeeded`. Exactly five assignments, `retry_count` 1, and the routed events chain `fromStage → toStage` with source assignment IDs.
- [x] Fake: final fail → develop → qa pass → final pass, so the TeamLead's findings reach the Developer prompt's FINDINGS section.
- [x] Fake: qa always fails, so the run ends `failed` at the `maxVisits` limit with no extra assignment. A separate definition hits `maxSteps` first.
- [x] Malformed verdict, provider error, and `waiting_input` each pause the run with the right code. A cancelled stage cancels the run.
- [x] Prompts on disk show the latest diff and the previous summary. Hostile findings text appears literally and never runs.
- [x] Task status is `running` / `review` according to the stage kind, and the final task status equals the run's.
- [x] Tests: `tests/integration/test_p01_s05_routing.py` and the guard test. All P00 tests stay green.

## Evidence

- Tests: unit suite → 305 OK (5 skipped), including the guard `tests/unit/test_p01_s05_guard.py` (3). New
  `tests/integration/test_p01_s05_routing.py`: 16 OK after S06 removed one obsolete test (Loops 5, Bounds 4, Pauses 6, Cancel 1). Re-run
  `test_p01_s04_start` (19) and P00 `test_s06_workflow` (10): OK. `test_s07_recovery` 16 of 17: the same
  pre-existing `test_orphan_sessions_at_startup` flake recorded in S04, unchanged.
- Engine (`workflow.py`): `_advance_definition` (outcome, diff capture, artifacts `summary`) and `_route` (target,
  `$succeed` / `$fail`, `maxSteps`, `maxVisits`, task status by stage kind, `routed` and `repair_requested` events,
  next-stage dispatch with `data = {diff, findings, summary}`; validation is `(not run yet)`). The S04 pause guard is
  gone. `_dispatch` computes `visit`: a routed entry is a new visit, a resolve-retry repeats the current one.
- Events: every transition writes `workflow_run.routed {fromStage, outcome, toStage, reason, sourceAssignmentId}`,
  terminal ones included (`toStage` `$succeed` / `$fail`). A limit failure writes `toStage: "$fail"`, the reason
  (`qa visit limit 2 reached` / `step limit 4 reached`) and `wouldEnter`. The routed event carries the `step_count` and
  `last_finding` update, so no extra event is written.
- **Decision on `retry_count`** (revised in S06): step 4 said "increment when the target was visited before", but the
  Done-when says develop → qa fail → develop → qa pass → final gives `retry_count` 1, and counting every revisit
  gives 2. S05 first counted loop-back edges; the unrolled built-in definition of S06 has none (reviewer →
  developer_repair is forward), so the rule is now: a verdict stage's `fail` outcome that routes to another stage is a
  repair round (`repair_requested`, `retry_count` + 1). §F of the design contract says so.
- Summary for the next stage is the finished stage's `finalText`, else `summary` (the prompt cuts it at 16 KiB).
  A read-only stage captures no diff, so `{{diff}}` keeps showing the last `workspace_write` stage's diff.
- Test hook: in debug coordinators `debugStageOptions` values for a definition run may be a list of fake options, one per
  visit (the last repeats), which is how a stage can fail first and pass later. P00 runs still take one object.
- Changed: a definition with any validation stage is refused at start (`BAD_REQUEST`) until S06, as the story says;
  the S04 first-stage-only check is replaced by this. A first stage of verdict kind now starts the task in `review`.
- Guard test scans the definition-run functions of `workflow.py` plus all of `workflowdef.py` and `prompts.py` for role
  names, example stage ids and provider IDs. `_dispatch` and the P00 functions are the legacy block (S06 splits and
  deletes them), so they are not scanned.
- Not done here (by design): validation stages and `passRequires` (S06), resolve/restart/deadline handling for
  definition runs (S07), CLI (S08).
