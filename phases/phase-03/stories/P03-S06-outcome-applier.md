# P03-S06 — Outcome applier: transitions, findings, round limits, develop and refine commits

Status: To Do
Depends on: P03-S05
Architecture: [P03 design contract](../README.md#design-contract), §C (outcome table), §E (commit on branch), §F (planning commits)

## Goal

When a ticket's column run ends, the coordinator applies the §C outcome exactly once: next column, stored findings, round counters and limits, a commit of the develop round on the branch, and for refine a planning commit to the base branch after the path check. Paused runs block the ticket with the run's code. After this story the story pipeline refine → develop → test → review runs end to end by hand with `ticket.start`, up to `ready_merge`.

## Implement in this order

1. `board.apply_outcomes(store, ctx)` is called in the coordinator loop after `workflow.advance`. It looks for tickets whose `run_id` run is terminal (or paused) and `run_id != applied_run_id`, and applies the §C row in one transaction that also sets `applied_run_id`, clears the assignee and lease, and writes events.
2. Verdict and findings: read from the run's last verdict stage (P01 stores it). Findings are written to `findings_json` (bounded at 16 KiB) and `ticket.findings`. Develop `failed` (bounds) stores the last validation output as findings.
3. Counters: `dev_rounds`, `test_rounds`, `review_rounds`. The limits come from `board_config.current` (S05: the frozen config after `board.run`, else `board.json` as read now), and a counter over its limit → `blocked` with `ROUND_LIMIT:<column>`.
4. Develop `succeeded`: `worktrees.commit_round(path, "<key>: develop round <n>")`, records `head_commit` and writes `ticket.committed`. No changes → handled like a failed dev round with findings `NO_CHANGES`.
5. Refine:
   - `worktrees.changed_paths` + `check_paths` against the §F refine globs;
   - on success, `commit_paths` (`ticket.committed` with the paths);
   - offending paths → `blocked` with `PLANNING_DIFF_INVALID` and the list, nothing committed or reverted.
   Expose the same helper for triage (S08) and unpack (S10).
6. Paused → `blocked` with `RUN_PAUSED:<code>` and `return_status` = the `ready_*` column. A run that the operator later resolves and that finishes is applied as normal. If the ticket is still `blocked` at that point, it leaves `blocked` too. Cancelled → back to the column picked from.

## Done when

- [ ] A fake scenario table drives each §C story-column row once (refine pass/fail, develop succeeded/failed, test pass/fail, review pass/fail, paused, cancelled), and each ends in the expected status with the expected counters and events. Test: `tests/integration/test_p03_s06_outcomes.py`.
- [ ] Full manual path on the fake: `ticket start` four times takes T-001 from `refine` to `ready_merge`. The branch has one commit `T-001: develop round 1`, `main` gets one planning commit with only the story file, and QA's prompt contains that commit's diff.
- [ ] QA fail twice, then pass: `test_rounds` = 2, and the second develop prompt contains the second QA findings. With `roundLimits.test = 1`, the second fail → `blocked` / `ROUND_LIMIT:test`.
- [ ] The refine stage writes outside the phase folder → `blocked` / `PLANNING_DIFF_INVALID`, no commit, and the file is still in the tree.
- [ ] Applying is idempotent: a crash point between the run ending and the outcome being applied (and one right after it) gives exactly one transition and one commit after restart.
- [ ] Tests: the file above plus `tests/unit/test_p03_s06_outcome_table.py`. The guard test covers `board.py`. All existing tests stay green.

## Evidence

(filled in when the story is done)
