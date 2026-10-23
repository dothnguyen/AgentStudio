# P03-S06 — Outcome applier: transitions, findings, round limits, develop and refine commits

Status: Done (2026-10-23)
Depends on: P03-S05
Architecture: [P03 design contract](../README.md#design-contract), §B (late outcome, `return_status`), §C (outcome table), §E (commit on branch), §F (planning commits), §J (events)

## Goal

When a ticket's column run ends, the coordinator applies the §C outcome exactly once: next column, stored findings, round counters and limits, a commit of the develop round on the branch, and for refine a planning commit to the base branch after the path check. Paused runs block the ticket with the run's code. After this story the story pipeline refine → develop → test → review runs end to end by hand with `ticket.start`, up to `ready_merge`. Storing the review's ```` ```commit ```` message and the merge itself are S07. The unpack and triage outcomes are S10 and S08, and the `USAGE_LIMIT` row is S11.

What exists today (read before starting): `board.start_column` and `schema.BOARD_COLUMNS` (S05); `tickets.move` / `block` / `_transition` / `_ticket_event`; `worktrees.commit_round` / `changed_paths` / `check_paths` / `commit_paths` (S03); in `workflow.py`, `advance`, `_pause` (the code is in the `workflow_run.paused` event payload as `diagnosticCode`, not on the row), `_latest_result` and `_validation_text`, and `stage_attempts.verdict_json` (`{verdict, findings, agentVerdict}`); `crashpoints.POINTS`. A verdict `pass` ends a verdict-column run `succeeded` and a `fail` ends it `failed`. A `board-develop` run fails only on its visit limit (bounds).

**Guard reminder:** `board.py` may not contain the words `develop`, `tests`, `check`, `final` or any role or provider name as names or strings (`tests/unit/test_p01_s05_guard.py`). So the outcome rules are data in `schema.py`, and the develop commit message is built from the column name.

## Implement in this order

1. **Outcome table (data).** `schema.BOARD_OUTCOMES`, next to `BOARD_COLUMNS`, one entry per column this story applies:
   - `refine`: `{"kind": "verdict", "pass": "ready_dev", "fail": "blocked", "counter": None, "limit": None, "commit": "planning", "globs": ("{story}", "{phase}/*")}`
   - `develop`: `{"kind": "work", "pass": "ready_test", "fail": "ready_dev", "counter": "dev_rounds", "limit": "dev", "commit": "branch"}`
   - `test`: `{"kind": "verdict", "pass": "ready_review", "fail": "fail_test", "counter": "test_rounds", "limit": "test", "commit": None}`
   - `review`: `{"kind": "verdict", "pass": "ready_merge", "fail": "changes_requested", "counter": "review_rounds", "limit": "review", "commit": None}`

   `{story}` is the ticket's `story_path`. `{phase}` is its first two path parts when they match `phases/phase-\d+` (that glob is dropped when they do not). `fnmatch` `*` also matches `/`, so `{phase}/*` covers the whole phase folder. S08 and S10 add `triage` and `unpack` entries. A run of a column with no entry → `blocked` / `OUTCOME_UNSUPPORTED:<column>`.
2. **Pure decision function** `board.decide(entry, run_status, verdict, counters, limits) -> {to, reason, counter, findingsFrom}`, with no I/O, so the table can be unit-tested:
   - `cancelled` → `to = "release"`.
   - Work kind: `succeeded` → `pass`; `failed` → counter + 1, then over `limits[limit]` → `blocked` / `ROUND_LIMIT:<column>`, else `fail` with findings = the validation output.
   - Verdict kind: verdict `pass` → `pass`; verdict `fail` → counter + 1 (when the entry has one), then over the limit → `blocked` / `ROUND_LIMIT:<column>`, else `fail` with findings = the verdict's findings. A refine `fail` → `blocked` / `VERDICT_FAIL:<column>`, with the findings stored as `questions_json`.
   - A terminal run with no verdict on a verdict column (it should not happen) → `blocked` / `RUN_FAILED:<column>`.
   - "Over the limit" means the new counter > `roundLimits.<limit>`. The incremented counter is stored even when the ticket is blocked.
3. **`tickets.block(..., return_status=None)`.** Add an optional override, used only by the coordinator. It must be a non-working, non-terminal status on the kind's path other than `blocked`, else `TICKET_TRANSITION_INVALID`. A ticket blocked by an outcome stores as `return_status` the status that outcome would have entered: `ROUND_LIMIT` → the `fail` target (`ready_dev` / `fail_test` / `changes_requested`). `PLANNING_DIFF_INVALID`, `VERDICT_FAIL` and `RUN_PAUSED` store the queue the ticket was picked from (step 7).
4. **`board.apply_outcomes(store, ctx) -> int`.** It runs in the coordinator loop right after `workflow.advance`, using one transaction per ticket like `advance`. Candidates are tickets with `run_id` set, `run_id IS NOT applied_run_id`, and either
   - a run in `succeeded` / `failed` / `cancelled`, or
   - a `paused` run while the ticket is still in that column's working status.

   For each candidate:
   - Call `crashpoints.hit("before_outcome_apply")`.
   - Read the config with `board_config.current(tx, workspace, <roles of the run's team>)`.
   - Read the verdict from the run's last verdict stage attempt (`verdict_json`). Read findings from there, or for a develop `failed` run from `_validation_text(_latest_result(...))`.
   - Call `decide`, do the commit (steps 5–6), and write the result in that transaction:
     - the transition (actor `coordinator`), counters, `findings_json` / `questions_json`, and `applied_run_id = run_id`;
     - `assignee_agent_id` and `lease_until` = NULL;
     - `ticket.findings {column, count}` when findings were stored;
     - one `ticket.outcome_applied {runId, column, runStatus, verdict, to, reason}` (§J).
   - Call `crashpoints.hit("after_outcome_commit")` after the commit.

   Findings are a list of strings. Each item is at most 2000 characters and there are at most 50 items. The serialized JSON stays within 16 KiB: drop items from the end, then truncate the last one. An `AsError` raised while applying (git failure, `MAIN_CHECKOUT_WRONG_BRANCH`, `BOARD_CONFIG_INVALID`) blocks the ticket with `blocked_reason` = the error code and sets `applied_run_id`, so it is never retried in a loop. Add the two crash point names and `after_outcome_git_commit` to `crashpoints.POINTS`.
5. **Develop `succeeded`** (`commit: "branch"`).
   - Call `worktrees.commit_round(worktree_path, "<key>: <column> round <n>")`. `<column>` is the column name from the table, so the message reads `T-001: develop round 1`. `n` is the number of this ticket's earlier `ticket.committed` events with a `branch` payload, plus 1.
   - Call `crashpoints.hit("after_outcome_git_commit")`.
   - Record `head_commit` and write `ticket.committed {branch, commit, runId}`.
   - No changes (`commit: None`) → handled as a failed dev round with findings `["NO_CHANGES"]` (counter, limit, `ready_dev`).
   - **Crash between the git commit and the DB commit:** before committing, if the worktree has no changes and the branch HEAD's subject equals the expected message and no `ticket.committed` event of this ticket records that HEAD, use HEAD as this round's commit. Do not treat it as `NO_CHANGES`.
6. **Refine** (`commit: "planning"`), as a helper `board.commit_planning(tx, ticket, column, globs, config, run_id) -> {ok, commit, paths, offending}`. S08 (triage) and S10 (unpack) reuse it.
   - Call `worktrees.changed_paths(workspace)`, then `worktrees.check_paths(paths, globs)`.
   - All paths allowed and at least one → `worktrees.commit_paths(workspace, baseBranch, paths, "<key>: <column> <story_path>")`, then `crashpoints.hit("after_outcome_git_commit")`, then `ticket.committed {baseBranch, commit, paths, runId}`. No changed paths → no commit, and the outcome still applies.
   - Any offending path → `blocked` / `PLANNING_DIFF_INVALID` with `offending` in the `ticket.outcome_applied` payload. Nothing is committed or reverted, and this replaces the verdict outcome.
   - Refine verdict `fail` still commits a valid diff (§C), then blocks with `VERDICT_FAIL:refine`.
   - The same crash rule as step 5 applies. If no paths are changed, HEAD has the expected subject and no `ticket.committed` event of this ticket records HEAD, then HEAD is this run's commit.
7. **Paused, cancelled and late outcomes.** The "queue picked from" is `from_status` of the ticket's latest `ticket.moved` ticket_event whose `to_status` is the current working status (the claim).
   - **Paused** (ticket still in its working status) → `blocked`. `blocked_reason` = `RUN_PAUSED:<code>`, where `<code>` is the `diagnosticCode` of the run's latest `workflow_run.paused` event, or `UNKNOWN`. `return_status` = the queue picked from. The lease is cleared and the assignee is kept, and `applied_run_id` is **not** set, so the run is applied again when it ends. Because the ticket is no longer in a working status, the pause is not applied twice.
   - **Cancelled**, ticket in its working status → back to the queue picked from (a release row) with `ticket.released {reason: "run_cancelled"}`, and no round is counted.
   - **Ticket `blocked` when its run ends** (after a pause the operator resolved, or an operator block). If the outcome's target is a status, the ticket takes the §B late-outcome row, which clears `return_status` and `blocked_reason`. If the outcome is `blocked` again, update `blocked_reason` and `return_status` in place (no `ticket.moved`). If the run was cancelled, the ticket stays `blocked`. Every case sets `applied_run_id` and writes `ticket.outcome_applied`.
   - **Ticket terminal** (for example `ticket.cancel`, which cancelled the run first) → only `applied_run_id` and `ticket.outcome_applied`, with no transition.
8. **Coordinator.** Call `board.apply_outcomes(store, ctx)` in the main loop right after `workflow.advance(store, ctx)`.

## Done when

- [x] Table: `board.decide` gives the expected `to`, `reason` and counter for every `BOARD_OUTCOMES` row. The rows are refine pass/fail, develop succeeded/failed, test pass/fail, review pass/fail, a cancelled run, and the counter crossing the limit (equal to the limit is still allowed; one over → `ROUND_LIMIT:<column>`). `tickets.block` with an invalid `return_status` override → `TICKET_TRANSITION_INVALID`. Findings bounding keeps the JSON at 16 KiB or less. Test: `tests/unit/test_p03_s06_outcome_table.py`.
- [x] Fake scenario table, each row once: refine pass/fail, develop succeeded/failed (validation failing until the visit limit), test pass/fail, review pass/fail, paused (`verdict_malformed`) and cancelled (`workflow.cancel`). Each ends in the expected status with the expected counters, `assignee_agent_id`/`lease_until` cleared (kept for paused), `applied_run_id` set (not for paused), one `ticket.outcome_applied`, and `ticket.findings` where findings are stored. Test: `tests/integration/test_p03_s06_outcomes.py`.
- [x] Full manual path on the fake: `ticket start` four times takes T-001 from `refine` to `ready_merge`. The refine fake writes only the story file. The branch has exactly one commit, `T-001: develop round 1`, recorded as `head_commit`. `main` gets exactly one planning commit, `T-001: refine <story_path>`, holding only the story file. QA's first prompt contains that develop commit's diff. Test: the integration file above.
- [x] QA fail twice, then pass: `test_rounds` = 2, the branch has rounds 1–3, and the third develop prompt (after the second QA fail) contains the second QA findings. With `board.json` `roundLimits.test = 1`, the second fail → `blocked` / `ROUND_LIMIT:test` with `return_status` `fail_test` and `test_rounds` = 2. Test: the integration file above.
- [x] A develop run whose worktree has no changes → `ready_dev` with `findings_json` `["NO_CHANGES"]`, `dev_rounds` = 1 and no commit. Test: the integration file above.
- [x] The refine stage writes outside the phase folder → `blocked` / `PLANNING_DIFF_INVALID` (`return_status` `refine`), no commit on `main`, and the file is still in the tree. Test: the integration file above.
- [x] Paused, then resolved: a `verdict_malformed` QA run → `blocked` / `RUN_PAUSED:<code>` with `return_status` `ready_test`. After `assignment.resolve --action retry` with a passing verdict, the ticket goes to `ready_review` with `return_status` and `blocked_reason` cleared. Test: the integration file above.
- [x] Idempotent apply: a DEBUG coordinator crashed with `AGENT_STUDIO_TEST_CRASH_AT` at `before_outcome_apply`, `after_outcome_git_commit` and `after_outcome_commit` (one run per point, on a develop `succeeded` run), then restarted, gives exactly one `in_dev → ready_test` transition, one `ticket.outcome_applied`, one `ticket.committed` and one new commit on the branch. One refine run crashed at `after_outcome_git_commit` gives exactly one planning commit on `main`. Test: the integration file above.
- [x] Guard: `board.py` still passes `tests/unit/test_p01_s05_guard.py`. The whole unit suite and the touched integration modules stay green (`python3 scripts/validate.py`).

## Evidence

- `python3 scripts/validate.py --unit` (final review, 2026-10-23): PASS, `Ran 395 tests in 16.794s, OK (skipped=3)`, guard `tests/unit/test_p01_s05_guard.py` included. The touched integration module `tests/integration/test_p03_s06_outcomes.py` runs at commit (two-tier rule).
- QA: passed with no findings. QA blocker regressions: `python3 -m unittest tests.unit.test_p03_s06_outcome_table` (terminal cancelled runs preserve terminal-ticket fields while recording their outcome; terminal outcome-application errors also preserve those fields; unsupported outcomes clear claims when blocking).
- Code: `backend/agent_studio/schema.py` (`BOARD_OUTCOMES`), `backend/agent_studio/board.py` (`decide`, `commit_planning`, `apply_outcomes`, findings bounding, HEAD reuse after a crash), `backend/agent_studio/tickets.py` (`block(..., return_status=None)`), `backend/agent_studio/crashpoints.py` (three outcome points), `backend/agent_studio/coordinator.py` (loop call after `workflow.advance`).
- Tests: `tests/unit/test_p03_s06_outcome_table.py`, `tests/integration/test_p03_s06_outcomes.py`. Design contract: `phases/phase-03/README.md` §B, §C, §J.
- Notable: a develop run that `failed` with a clean worktree is recorded as `["NO_CHANGES"]`, not the validation text. Refine `commit_planning` runs whatever the run's status, so a cancelled or `RUN_FAILED` refine run with a valid planning diff still commits it to the base branch. Follow-up for S08/S10, which reuse the helper.
- Final review notes (follow-ups, not blockers): the develop HEAD-reuse check runs without first checking that the worktree is clean (step 5 says "no changes"). Some integration assertions are weaker than their "Done when" wording: the full path checks the subject of `main`'s last commit, not the commit count or its file list; the no-change and `PLANNING_DIFF_INVALID` rows do not assert "no commit"; the crash drill checks event counts and the HEAD subject, not the number of `in_dev → ready_test` moves.
