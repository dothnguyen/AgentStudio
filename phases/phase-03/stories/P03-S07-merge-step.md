# P03-S07 — Merge step: squash merge, main-checkout lock, conflicts and dependents

Status: To Do
Depends on: P03-S06
Architecture: [P03 design contract](../README.md#design-contract), §C (review pass, merge conflict), §D (main-checkout lock), §E, Q3, Q5

## Goal

A `ready_merge` ticket is squash-merged into the base branch by the coordinator, in the main checkout, with the lead's commit message. The merge waits while the main checkout is busy or dirty and is never forced. A conflict sends the ticket back to a developer with the conflicting files, and the next develop round starts from base merged into the branch. After the merge, the worktree is removed, and dependents become eligible because their blockers are `merged`.

## Implement in this order

1. Review `pass` (S06) stores the ```` ```commit ```` block from the lead's output on the ticket. A missing block → the default `<key>: <title>` and `ticket.merge_message_defaulted` (Q5).
2. `board.merge_ready(store, ctx)` runs in the loop. For the oldest `ready_merge` ticket, it merges only when there is no main-checkout holder (`_mutating_in_workspace(main)` empty, no `board_locks` merge row), the tree is clean, and HEAD is `baseBranch`. Otherwise it writes `board.held {column: "merge", reason}` once and waits. It uses the `board_locks` table from S01's v7 migration.
3. Merge:
   - set the lock row;
   - `git merge --squash <branch>`;
   - rewrite the `Status:` line of `story_path` to `Done (YYYY-MM-DD)` in the staged tree (Q3);
   - `git commit -F <message file>`;
   - record `merged_commit` and `head_commit`, status `merged`, `ticket.merged`;
   - remove the worktree (the branch is kept, Q6);
   - clear the lock.
   All of this happens in one transaction for the state part. The git part is made restart-safe: on startup, a lock row with HEAD already containing the squash commit (matched by message trailer `Ticket: <key>`) completes the record, and otherwise `git merge --abort` / `git reset --merge` returns the tree to the recorded HEAD.
4. Conflict: `git merge --abort`. The ticket → `changes_requested` with `MERGE_CONFLICT` findings listing the files, `review_rounds` + 1, `ticket.merge_conflict`. On the next develop start for that ticket, the coordinator runs `git merge <baseBranch>` in the worktree. If it conflicts, it commits the result with markers as `<key>: merge <baseBranch> (conflicts)` and passes the files as findings. After that develop run, any remaining `<<<<<<< ` marker in those files → a failed dev round.
5. After `merged`: a feature parent whose children are all `merged` or `cancelled` (at least one `merged`) → `done`.

## Done when

- [ ] Fake pipeline: a `ready_merge` ticket gives exactly one new commit on `main` with the lead's message plus a `Ticket: T-001` trailer and the story's `Status: Done (…)`. The branch is kept, the worktree is gone, and `ticket.merged` is written. Test: `tests/integration/test_p03_s07_merge.py`.
- [ ] Dirty main checkout, a running refine and a wrong HEAD branch each keep the ticket in `ready_merge` with a single `board.held` event. It merges on the first tick after the cause is cleared.
- [ ] Two tickets editing the same line: the first merges, and the second goes to `changes_requested` with `MERGE_CONFLICT` naming the file. Its next develop prompt lists the file, and the worktree contains a conflict commit. A developer stage that leaves a marker → a failed dev round.
- [ ] T-002 depends on T-001: after T-001 merges, `deps_merged(T-002)` is true, and T-002's worktree (created at its first develop) starts from the merged `main`.
- [ ] A crash point after `git commit` but before the state write ends, after restart, with one `merged` record and no second commit. A crash point after `merge --squash` and before commit leaves a clean tree at the old HEAD and the ticket still `ready_merge`.
- [ ] A feature with two children: `done` only after the second is `merged`.
- [ ] Tests: the file above plus `tests/unit/test_p03_s07_commit_block.py` (block parsing, default, trailer). All existing tests stay green.

## Evidence

(filled in when the story is done)
