# P03-S04 — Per-run workspace for `workflow.start` and `task.direct`

Status: To Do
Depends on: P03-S01, P03-S03
Architecture: [P03 design contract](../README.md#design-contract), §D (locks), §E (registered worktree); [P01 §D](../../phase-01/README.md#d-engine-semantics) (start preconditions)

## Goal

`workflow.start` and `task.direct` accept an optional `workspace` that must be a worktree registered for the team's workspace: a live ticket row with that `worktree_path`, also listed by `git worktree list`. The task records that path, so the existing write lock (`tasks._mutating_in_workspace`) is keyed by it, and role context, prompt files, definitions and `workflow.json` are read from it. Two developers writing in two worktrees at the same time are allowed. Arbitrary paths are refused.

## Implement in this order

1. `tickets.registered_worktree(tx, team_workspace, path)`: canonicalises `path`, then requires a non-terminal ticket of that workspace with that `worktree_path` and a matching entry in `worktrees.list_registered`. Otherwise `WORKTREE_NOT_REGISTERED`.
2. `workflow.start` and `task.direct`: optional `workspace`. Default: the team's workspace, so behaviour is unchanged. When given, it is validated as above, and the task row stores it. Everything that today reads `team["workspace"]` for the run (clean-tree check, base commit, lock, `roles.context_for`, definition lookup, `workflow.json`, diff capture, validation cwd) uses `task.workspace` instead.
3. Resolve-retry and restart recovery keep using `task.workspace` (check `resolve.py` and `reconcile.py`).
4. Add `--workspace PATH` to the CLI (`workflow start`, `task direct`) and to `serve`. Add it to the idempotency payload.

## Done when

- [ ] Two fake `workspace_write` runs in two registered worktrees of one team run at the same time, both succeed, and each diff contains only its own file. The main checkout is unchanged. Test: `tests/integration/test_p03_s04_parallel_worktrees.py`.
- [ ] A second mutating run on the **same** worktree → `WORKSPACE_BUSY`. A mutating run on the main checkout while a worktree run is active is allowed.
- [ ] `/tmp/x`, the main checkout's parent, an unregistered `git worktree add` path, and a worktree whose ticket is `cancelled` → `WORKTREE_NOT_REGISTERED`.
- [ ] Role context and `workflow.json` come from the worktree. A test changes `.agent-studio/roles/developer.md` only on the branch and finds the new text in the frozen `roleContext`.
- [ ] Without `workspace`, every P00/P01 integration test passes unchanged, and so does a restart mid-run in a worktree (crash point), which resumes against the worktree.
- [ ] Tests: the file above plus `tests/unit/test_p03_s04_registered.py`.

## Evidence

(filled in when the story is done)
