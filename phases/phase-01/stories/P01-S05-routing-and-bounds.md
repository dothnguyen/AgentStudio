# P01-S05 — Agent-stage outcomes, routing, and bounds

Status: To Do
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

- [ ] Fake, three roles: develop → qa fail → develop → qa pass → final pass → `succeeded`. Exactly five assignments, `retry_count` 1, and the routed events chain `fromStage → toStage` with source assignment IDs.
- [ ] Fake: final fail → develop → qa pass → final pass, so the TeamLead's findings reach the Developer prompt's FINDINGS section.
- [ ] Fake: qa always fails, so the run ends `failed` at the `maxVisits` limit with no extra assignment. A separate definition hits `maxSteps` first.
- [ ] Malformed verdict, provider error, and `waiting_input` each pause the run with the right code. A cancelled stage cancels the run.
- [ ] Prompts on disk show the latest diff and the previous summary. Hostile findings text appears literally and never runs.
- [ ] Task status is `running` / `review` according to the stage kind, and the final task status equals the run's.
- [ ] Tests: `tests/integration/test_p01_s05_routing.py` and the guard test. All P00 tests stay green.

## Evidence

(filled in when the story is done)
