# P03-S07 — Merge step: squash merge, main-checkout lock, conflicts and dependents

Status: Done (2026-10-23)
Depends on: P03-S06
Architecture: [P03 design contract](../README.md#design-contract), §C (review pass, merge conflict), §D (main-checkout lock), §E, Q3, Q5

## Goal

The coordinator squash-merges a `ready_merge` ticket into the base branch, in the main checkout, with the lead's commit message. The merge waits while the main checkout is busy or dirty, and it is never forced. A conflict sends the ticket back to a developer with the conflicting files, and the next develop round starts from base merged into the branch. After the merge the worktree is removed, and dependents become eligible because their blockers are `merged`. Merges run on every coordinator tick, with or without `board.run` (manual pipeline, see the README "Value" line). S13 does not change this.

## Implement in this order

1. **Commit message** (`board.commit_message(text, ticket) -> (message, defaulted)`, a pure function):
   - `text` is the review run's final text, i.e. the `artifacts_json.summary` of its latest stage attempt (`workflow._last_summary`).
   - The message is the content of the first fenced block whose opening line is exactly ```` ```commit ````, up to the next line that is exactly ```` ``` ````, with surrounding whitespace stripped.
   - A missing, unclosed or empty block gives the default `<key>: <title>` and `defaulted = True`.
   - The coordinator always appends the trailer: a blank line, then `Ticket: <key>`. It does not add a second one when the message already ends with that exact line.
2. **Storing it.** The review `pass` outcome (S06 `_write_outcome` → `_finish`), including a late `blocked → ready_merge` outcome, adds `{"commitMessage": message}` to the `ticket.outcome_applied` payload. When the message was defaulted, it also writes `ticket.merge_message_defaulted` (Q5). The schema does not change. The merge reads the message from the latest `ticket.outcome_applied` event of the ticket whose `to` is `ready_merge`. If no such event exists, it uses the default.
3. **`board.merge_ready(store, ctx)`**, called in the coordinator loop right after `board.apply_outcomes`. For each workspace with `ready_merge` tickets, it takes the first one in §G order (`priority`, then `created_at`) and does at most one merge per workspace per tick. It reads `baseBranch` from `board_config.current(tx, workspace, None)`. It merges only when all of these hold:
   - the main checkout has no holder: `tasks._mutating_in_workspace(tx, main)` is empty and no `board_locks` row `(workspace, "merge")` exists. Otherwise the reason is `MAIN_CHECKOUT_BUSY`.
   - the tree is clean (`worktrees.is_clean(main)`). Otherwise the reason is `MAIN_CHECKOUT_DIRTY`.
   - HEAD is `baseBranch` (`git symbolic-ref --short HEAD`). Otherwise the reason is `MAIN_CHECKOUT_WRONG_BRANCH`.

   When a check fails, the ticket stays `ready_merge` and the coordinator writes `board.held {column: "merge", reason}` as a ticket event of that ticket (through `_note`). It skips the write when the ticket's latest ticket event is already `board.held` with the same reason, so each reason is written once.
4. **Merge** (git calls are argv lists through `gitws` / `worktrees`, §E):
   1. Transaction 1: insert the `board_locks` row `(workspace, "merge", ticket_id)`.
   2. `git merge --squash <branch>` in the main checkout.
   3. If the story file has a `Status:` line, rewrite the first one to `Status: Done (YYYY-MM-DD)` (today, UTC) in the working tree, then `git add -- <story_path>` (Q3). A story file with no `Status:` line is left as it is. Crash point `after_merge_squash`.
   4. Write the message (step 1, with the trailer) to a file under `<state>/board/<ticket_id>/`, then run `git commit --allow-empty -F <file>`. `--allow-empty` makes sure every merge has a `merged_commit`. Crash point `after_merge_git_commit`.
   5. Transaction 2: set `merged_commit` (the new HEAD) and `head_commit` (the branch head), move the ticket `ready_merge → merged`, write `ticket.merged {commit}` and run step 6, then delete the lock row.
   6. After transaction 2, `worktrees.remove` the worktree. The branch is kept (Q6). If removal fails, it is only logged; the §E startup reconcile removes the orphan later.

   Add both crash point names to `crashpoints.POINTS`.
5. **Restart safety**: `board.recover_merge(store, ctx)` runs as a startup reconciliation step in `coordinator.py`, next to `reports` / `assignments`. For each `board_locks` merge row:
   - If the ticket is still `ready_merge` and the main checkout's HEAD message (`git log -1 --format=%B`) ends with the trailer `Ticket: <key>`, run transaction 2 and the removal from step 4. This needs no second commit.
   - Otherwise, run `git reset --merge` in the main checkout and delete the lock row. The tree is back at HEAD and the ticket is still `ready_merge`. Do not use `git merge --abort`: a squash merge leaves no `MERGE_HEAD`, so it fails.
6. **Conflict**: when `git merge --squash` exits non-zero, list the files with `git diff --name-only --diff-filter=U`, then run `git reset --merge`. Transaction 2 for a conflict does this:
   - adds 1 to `review_rounds`;
   - stores the findings `["MERGE_CONFLICT: <path>", …]` (one per file);
   - moves the ticket `ready_merge → changes_requested`. When `review_rounds` would exceed `roundLimits.review`, it blocks the ticket instead, with `ROUND_LIMIT:review` and `return_status` `changes_requested`, the same rule as S06;
   - writes `ticket.merge_conflict {files}`;
   - deletes the lock row.
7. **Next develop start** (S05 `start_column`, develop column, when the worktree already exists and `findings_json` has a `MERGE_CONFLICT: ` item): before the run starts, run `git merge --no-edit -m "<key>: merge <baseBranch>" <baseBranch>` in the worktree.
   - If it conflicts, run `git add -A`, then `git commit -m "<key>: merge <baseBranch> (conflicts)"`, which keeps the markers.
   - Either way, record `head_commit` and `ticket.committed {branch, commit, baseMerge: true, runId: null}`.
   - The S06 develop-round number counts only `ticket.committed` events without `baseMerge`.
   - The findings seed is still the stored `MERGE_CONFLICT` list, so the prompt names the files.
8. **Markers check**: when that develop run succeeds, the S06 develop outcome scans the files named in the ticket's `MERGE_CONFLICT` findings in the worktree before it commits.
   - Any line that starts with `<<<<<<< ` counts as a failed dev round with the findings `["MERGE_MARKERS_LEFT: <path>", …]`, and nothing is committed.
   - No marker → the normal develop commit.
9. **Parent done**: in transaction 2 of a merge, if the ticket has a `parent_ticket_id`, the parent is `unpacked`, and every child of it is `merged` or `cancelled` with at least one `merged`, move the parent `unpacked → done`.

## Done when

- [x] Fake pipeline: a `ready_merge` ticket gives exactly one new commit on `main`. Its message is the lead's ```` ```commit ```` block plus a `Ticket: T-001` trailer, and its tree has the story's `Status: Done (…)`. The branch still exists, the worktree directory is gone, `merged_commit`/`head_commit` are set, `ticket.merged` is written and the lock row is gone. Test: `tests/integration/test_p03_s07_merge.py`.
- [x] Each of these keeps the ticket in `ready_merge` with exactly one `board.held {column: "merge", reason}` over several ticks, and the ticket merges on the first tick after the cause is cleared:
  - an untracked file in the main checkout (`MAIN_CHECKOUT_DIRTY`);
  - an active mutating task on the main checkout, such as a running refine (`MAIN_CHECKOUT_BUSY`);
  - HEAD on another branch (`MAIN_CHECKOUT_WRONG_BRANCH`).

  Test: the integration file above.
- [x] Two tickets edit the same line. The first merges. The second goes to `changes_requested` with `review_rounds` + 1, `MERGE_CONFLICT: <file>` findings and `ticket.merge_conflict`, and the main checkout is clean at the first merge commit. At its next `ticket.start` the worktree HEAD is `T-002: merge main (conflicts)` and the develop prompt lists the file. A fake developer that leaves the marker → a failed dev round (`MERGE_MARKERS_LEFT`, `dev_rounds` + 1, no develop commit). A fake developer that resolves it → `ready_test` with the commit `T-002: develop round 1`. Test: the integration file above.
- [x] T-002 depends on T-001. Before T-001 merges, `ticket.start` T-002 for develop gives `TICKET_DEPS_NOT_MERGED`. After the merge, `tickets.deps_merged(T-002)` is true, and the `base_commit` of T-002's worktree, created at its first develop start, is T-001's `merged_commit`. Test: the integration file above.
- [x] Crash point `after_merge_git_commit` → after restart there is one `merged` record, one `ticket.merged`, no second commit on `main`, and no lock row. Crash point `after_merge_squash` → after restart the tree is clean at the old HEAD, there is no lock row, and the ticket is still `ready_merge`; it then merges normally. Test: the integration file above, with a debug coordinator and `AGENT_STUDIO_TEST_CRASH_AT`.
- [x] A feature with two story children is `done` only after the second child is `merged`, and stays `unpacked` after the first. The test creates the feature directly with `tickets.create(tx, ws, "feature", …)` and coordinator moves to `unpacked`, because `ticket.create kind: feature` is S10. Test: the integration file above.
- [x] Review pass without a block → `ticket.merge_message_defaulted` and the merge commit message `T-00n: <title>` + trailer. Test: the integration file above.
- [x] Unit tests in `tests/unit/test_p03_s07_commit_block.py` for `board.commit_message`:
  - a block among other text;
  - the first of two blocks wins;
  - a missing, unclosed or empty block → the default and `defaulted`;
  - the trailer is added once, never twice;
  - the Status-line rewrite helper changes only the first `Status:` line and leaves a file without one unchanged.
- [x] All existing unit and integration tests stay green (`scripts/validate.py`).

## Evidence

- Validation (unit suite, `scripts/validate.py`): PASS — `Ran 401 tests in 9.893s, OK (skipped=3)`. QA verdict: pass, no findings.
- Implemented in `backend/agent_studio/board.py`: `commit_message` (first exact ```` ```commit ```` block, default `<key>: <title>`, single `Ticket: <key>` trailer), `rewrite_story_status`, `commitMessage` on the review-pass `ticket.outcome_applied` payload plus `ticket.merge_message_defaulted`, `merge_ready` (BUSY/DIRTY/WRONG_BRANCH holds written once, merge lock, squash, Status rewrite, `commit --allow-empty -F`, `merged`, parent `done`, worktree removal), `_merge_conflict` (`git reset --merge`, `MERGE_CONFLICT: <path>`, review round / `ROUND_LIMIT:review`), `recover_merge`, the base merge at the next develop start (`ticket.committed {baseMerge: true}`, not counted in round numbering) and the `MERGE_MARKERS_LEFT` check before the develop commit.
- `backend/agent_studio/coordinator.py`: `board.recover_merge` startup step; `board.merge_ready` in the loop after `apply_outcomes`. `backend/agent_studio/crashpoints.py`: `after_merge_squash`, `after_merge_git_commit`.
- `phases/phase-03/README.md`: §C/§E/§J design-contract updates for the merge.
- Tests: `tests/unit/test_p03_s07_commit_block.py` (block parsing, default, trailer, Status rewrite, base-merge snapshot failures); `tests/integration/test_p03_s07_merge.py` (squash merge, holds, conflict and re-develop, dependency base, both crash points with a debug coordinator, feature parent, default message).
- Note: after a `MERGE_MARKERS_LEFT` round the findings no longer name `MERGE_CONFLICT` files, so a later develop round is not re-scanned for markers (beyond this story's scope).
