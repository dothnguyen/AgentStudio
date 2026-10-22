# P01-S10 — Live gate: a real three-role definition run

Status: To Do
Depends on: P01-S01 through P01-S09
Architecture: [P01 design contract](../README.md#d-engine-semantics); [phase exit](../README.md#phase-exit)

## Goal

Prove with real providers, not mocks, that an operator-written definition with three roles runs end to end from one prompt. The run must go through a work stage, a validation stage, and two different verdict stages, survive a coordinator restart, and leave durable evidence that matches what happened in the panes and the workspace.

This is an operator-run gate, not new product code. Per the P00 rules, no live provider runs against this checkout. Everything runs in the disposable fixture.

## Implement in this order

1. Create a disposable git fixture workspace outside this checkout, at `~/agent-studio-live/p01-s10-<UTC timestamp>/` (the same area P00-S12 uses). It contains:
   - a small Python module with a deliberately missing feature;
   - `tests/` unit tests that fail until the feature exists;
   - a one-page story file `stories/S1.md` describing the feature, with "Implement in this order" and "Done when" sections. The `final-review.md` prompt reads "the story named in TASK", so the run needs a story file;
   - `.agent-studio/workflow.json`, whose `validation.argv` runs those tests;
   - `.agent-studio/workflows/story-delivery.yaml` and `.agent-studio/workflows/prompts/{develop,qa,final-review}.md`, copied byte for byte from this checkout and kept at the same relative paths (`promptFile` resolves from `.agent-studio/`, §A);
   - `.agent-studio/team.json` with three agents whose roles are `TeamLead`, `Developer` and `QA`, using installed and authenticated providers, plus `roles.json` if `team.json` uses it.

   Use two different providers if two are ready, and record which provider each agent uses (Q9: one provider is enough). Commit everything so the tree is clean, and record the commit SHA and the `sha256sum` of `story-delivery.yaml`.
2. Run `agent-studio preflight --deep`. Then, from the fixture, run `python3 <checkout>/scripts/team/team.py start`. `team.py` uses the git root of the current directory, so it targets the fixture, not this checkout. Record the tmux session list before and after. Attach from WSL and from Windows Terminal, and confirm one pane per agent. Then run `agent-studio workflow validate --definition story-delivery --team ID` (or `team.py check story-delivery`).
3. From the fixture, run `team.py run story-delivery --story stories/S1.md`. The equivalent is `agent-studio workflow start --team ID --definition story-delivery --text-file PROMPT --wait`. While an agent stage is `running`, run `agent-studio coordinator stop`, wait about 5 s, and run `agent-studio coordinator start`, as P00-S12 step 6 does. Record which stage and assignment were running when you did this.
4. When the run ends, record `git diff <base>` and `git status --porcelain` in the fixture. Then clone the fixture into a fresh directory, apply the diff and the untracked files there, and run the tests with the `validation.argv` from `workflow.json`.
5. Collect sanitised evidence in `phases/phase-01/evidence/s10/<timestamp>/`:
   - `workflow show` JSON;
   - the run's event range (`workflow_run.*`, `assignment.*`, and the runner messages "provider process started");
   - every stage attempt's `prompt.txt` and `result.json`;
   - the captured diffs and validation output;
   - the worktree and fresh-checkout results from step 4;
   - the tmux inventories from steps 2 and 7;
   - `commands.md`, listing every command run in order.

   Review the bundle for secrets before saving it, and note in Evidence that the review was done.
6. If a real QA or TeamLead `fail` happens, record the loop. If it does not, cite the fake-adapter loop tests instead: `tests/integration/test_p01_s05_routing.py` (`test_qa_fail_then_pass_then_final_pass`, `test_final_fail_sends_the_leads_findings_to_the_developer`), `tests/integration/test_p01_s06_validation.py` (`test_failing_tests_turn_a_qa_pass_into_fail_with_a_finding`) and `tests/integration/test_p01_s09_story_delivery.py` (`test_qa_fail_then_pass_then_final_commit_block`). Run them and record the result. Do not coax a model into failing.
7. Stop the team with `team.py stop` (or `agent-studio team stop --team ID`). Confirm that the tmux sessions that existed before step 2 are untouched, and that the fixture workspace is kept.

## Done when

- [ ] The fixture is outside this checkout, its `story-delivery.yaml` and prompts are byte-identical to this checkout's, and its tests fail at the base commit. Test: `sha256sum` of both copies, plus the validation command at the base commit, both recorded in Evidence.
- [ ] `workflow validate --definition story-delivery --team ID` reports no errors and binds `TeamLead`, `Developer` and `QA` to three distinct agents, with the providers recorded. Test: the validate JSON in the bundle.
- [ ] Attaching from WSL and from Windows Terminal shows one pane per agent, with activity during the run. Test: confirmed by the operator and noted in `commands.md`.
- [ ] The real run ends `succeeded` after visiting `develop`, `tests`, `qa` and `final`. If it instead ends `failed` or `paused`, the reason is documented truthfully and the story stays In Progress. Each agent stage was run by its bound agent with the stage's permission (`develop` `workspace_write`; `qa` and `final` `read_only`). Test: `workflow show` bindings and stage attempts, plus each assignment's agent and policy.
- [ ] The run's frozen `definition_sha256` equals the fixture file's `sha256sum`. The route in `workflow show` matches the `workflow_run.routed` events and the stage attempts, one for one and in order. Test: compare them in the bundle.
- [ ] The final diff makes the fixture tests pass in a fresh checkout (step 4), and the last `tests` attempt's recorded exit code is 0. Test: the fresh-checkout output and `result.json` of the `tests` stage.
- [ ] The coordinator restart caused no duplicate work. The stage that was running at restart has exactly one assignment, attempt 1, and exactly one "provider process started" event. No stage visit has more than one `assignment.created`. Test: the event range in the bundle. Anything left `reconciling` is resolved explicitly and recorded.
- [ ] The read-only stages wrote nothing. At run end, `git diff <base>` plus the untracked-file list equals the diff the coordinator captured after the last `develop` visit, so the `qa` and `final` visits that followed it changed no files. Test: compare the two in the bundle. Read-only visits that were followed by another `develop` visit are covered only by the provider's `read_only` mapping, and Evidence says so.
- [ ] `team stop` leaves the tmux sessions that existed before step 2 untouched and keeps the fixture workspace. Test: compare the tmux inventories from steps 2 and 7.
- [ ] Evidence lists the evidence files and the commands that were run, and records that the secret review was done. Fake-adapter tests are cited only for the fail loop, with their run result, and never as proof of the real run.

## Evidence

(filled in when the story is done)
