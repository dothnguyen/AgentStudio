# P01-S10 — Live gate: a real three-role definition run

Status: To Do
Depends on: P01-S01 through P01-S09
Architecture: [P01 design contract](../README.md#d-engine-semantics); [phase exit](../README.md#phase-exit)

## Goal

Prove with real providers, not mocks, that an operator-written definition with three roles runs end to end from one prompt. The run must go through a work stage, a validation stage, and two different verdict stages, survive a coordinator restart, and leave durable evidence that matches what happened in the panes and the workspace.

## Implement in this order

1. Create a disposable git fixture workspace (outside this checkout) with a small Python module, a deliberately missing feature, unit tests that fail until it exists, `.agent-studio/workflow.json` running those tests, a copy of `story-delivery.yaml` and its prompts, and a three-agent `team.json` (TeamLead, Developer, QA) using installed and authenticated providers. Use two different providers if two are ready, and record which.
2. `preflight --deep`, `team start`, attach from WSL and from Windows Terminal, then `agent-studio workflow validate --definition story-delivery --team ID`.
3. `team.py run story-delivery "Add … so the tests pass"` (or `agent-studio workflow start --definition …`). Restart the coordinator once while an agent stage is running.
4. Collect sanitised evidence into `phases/phase-01/evidence/s10/<timestamp>/`: `workflow show` JSON, the event range, every stage's `prompt.txt` and `result.json`, the diff, and the validation output. Review for secrets before saving.
5. If a real QA or TeamLead fail happens, record the loop. If not, cite the fake-adapter loop tests from S05, S06, and S09 for it. Do not coax a model into failing.
6. Stop the team with `team stop` and confirm that pre-existing tmux sessions are untouched.

## Done when

- [ ] The real run ends `succeeded` (or ends `failed`/`paused` with a truthful, documented reason and the story stays In Progress) after visiting `develop`, `tests`, `qa`, and `final`, each by the bound agent with the stage's permission.
- [ ] The run's frozen definition SHA-256 equals the fixture file's. The route in `workflow show` matches the `routed` events and the stage attempts.
- [ ] The final diff makes the fixture tests pass in a fresh checkout, and the `tests` stage's recorded exit code agrees.
- [ ] The coordinator restart caused no duplicate assignment.
- [ ] The QA and TeamLead stages wrote nothing (`read_only` held), as shown by the diff before and after those stages.
- [ ] Evidence files and the commands that were run are listed below. Fake-adapter tests are cited only for the loop, never as proof of the real run.

## Evidence

(filled in when the story is done)
