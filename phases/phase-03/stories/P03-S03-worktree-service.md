# P03-S03 — Worktree service, commit-on-branch and planning commits

Status: To Do
Depends on: — (pure git; can run in parallel with S01–S02)
Architecture: [P03 design contract](../README.md#design-contract), §E (git and worktrees), §F (planning commits)

## Goal

One module, `backend/agent_studio/worktrees.py`, does every git operation the board needs, with argv lists and no shell: create, list, remove and reconcile ticket worktrees and branches, commit a round on a branch, compute a branch diff, and commit an exact list of planning paths to the base branch in the main checkout after checking them against an allow-list. It has no database access, so it is unit-testable on throwaway repositories.

## Implement in this order

1. `root_for(state_dir, workspace)` → `<state>/worktrees/<sha256(workspace)[:12]>/`, which refuses a root under `/mnt/`. `slug(title)` → `[a-z0-9-]{1,40}`.
2. `create(workspace, key, slug, base_branch)` → `{branch, path, baseCommit}` via `git worktree add -b ticket/<key>-<slug> <path> <base_branch>`. It refuses if the branch or path exists, and returns the error text on failure.
3. `list_registered(workspace)`: parses `git worktree list --porcelain` and returns `{path, branch, head}` for paths under the root only.
4. `remove(workspace, path)`: `git worktree remove --force`, then `git worktree prune`. It refuses paths outside the root.
5. `commit_round(path, message)` → `{commit}` or `{commit: None}` when nothing changed (`git add -A`, `git commit -m`).
6. `branch_diff(workspace, base_branch, branch, out_dir)`: the diff from `merge-base` to `branch`, bounded like `gitws.capture_diff`.
7. `changed_paths(workspace)` (porcelain, untracked included); `check_paths(paths, allowed_globs)` → `(ok, offending)`; `commit_paths(workspace, base_branch, paths, message)`. It checks that HEAD is `base_branch` (`MAIN_CHECKOUT_WRONG_BRANCH`), stages only those paths, and runs `git commit -m … -- <paths>`.
8. `is_clean(workspace)` for the merge and main-checkout checks.

## Done when

- [ ] In a temp repo with a commit on `main`: `create` gives a worktree at the expected root path on `ticket/T-001-<slug>`, and `list_registered` returns it. A second `create` with the same key is refused. A root under `/mnt/` is refused.
- [ ] `commit_round` after writing a file returns a commit on the branch, `main` is unchanged, and with no changes it returns `{commit: None}`.
- [ ] `branch_diff` shows only the branch's changes after `main` moved forward independently.
- [ ] `check_paths` accepts in-folder paths and rejects `../`, sibling folders and a second bug file. `commit_paths` commits exactly the given paths and leaves another unrelated untracked file uncommitted. On a non-base HEAD it fails with `MAIN_CHECKOUT_WRONG_BRANCH`.
- [ ] `remove` deletes the worktree, keeps the branch, and refuses a path outside the root.
- [ ] Every git call passes an argv list. A test feeds a title with `$(rm -rf /)`, quotes and newlines: the slug is safe and no shell is used.
- [ ] Tests: `tests/unit/test_p03_s03_worktrees.py`. All existing tests stay green.

## Evidence

(filled in when the story is done)
