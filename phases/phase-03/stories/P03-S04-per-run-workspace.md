# P03-S04 — Per-run workspace for `workflow.start` and `task.direct`

Status: Done (2026-10-23)
Depends on: P03-S01, P03-S03
Architecture: [P03 design contract](../README.md#design-contract), §D (locks), §E (registered worktree); [P01 §D](../../phase-01/README.md#d-engine-semantics) (start preconditions)

## Goal

`workflow.start` and `task.direct` accept an optional `workspace` that must be a worktree registered for the team's workspace: a live ticket row with that `worktree_path`, also listed by `git worktree list`. The task records that path, so the existing write lock (`tasks._mutating_in_workspace`) is keyed by it, and role context, prompt files, definitions and `workflow.json` are read from it. Two developers writing in two worktrees at the same time are allowed. Arbitrary paths are refused.

What exists today (read before starting): `workflow._start_definition` (`backend/agent_studio/workflow.py`) and `tasks.task_direct` (`backend/agent_studio/tasks.py`) read `team["workspace"]`; everything after start already reads the task row (`workflow.wf_workspace`, `workflow.py` stage entry `build_request(... task["workspace"])`, `resolve.py`, and `teams.write_request`, which gives the runner `t.workspace` as its cwd). So the change is at the two start points plus the argument plumbing.

## Implement in this order

1. `tickets.registered_worktree(tx, team_workspace, path, *, state_dir=None) -> str` returns the canonical path or raises `WORKTREE_NOT_REGISTERED` (`protocol.WORKTREE_NOT_REGISTERED`, data `{workspace: <canonical path>}`):
   - canonicalise with `os.path.realpath(path)` only. A path that does not exist is still just "not registered" (never `WORKSPACE_NOT_FOUND`);
   - require a ticket row with `workspace = team_workspace`, `worktree_path = <canonical>` and `status` not in `TICKET_TERMINAL`;
   - require an entry with the same `path` in `worktrees.list_registered(team_workspace, state_dir=state_dir)` (so a path outside the worktree root, or a removed worktree, is refused even when the row exists).
2. `workflow.start` (both the definition form and the P00 `developerAgentId`/`reviewerAgentId` form) and `task.direct` take an optional `workspace`:
   - omitted, or equal to `team["workspace"]` after `realpath` → the team's workspace (behaviour unchanged);
   - otherwise → `tickets.registered_worktree(tx, team["workspace"], workspace, state_dir=ctx["stateDir"])`.
   The chosen path is stored in `tasks.workspace`. In `_start_definition`, every use of `ws` (definition lookup, `gitws.require_repo` base commit, `gitws.dirty_entries` clean-tree check, `validation.load_config` / `workflow.json`, `_mutating_in_workspace`) uses it. In `task_direct`, the `WORKSPACE_BUSY` check (and its `data.workspace`), `build_request` (`roles.context_for`) and the task row use it. The registration check runs before the dirty-tree and lock checks.
3. Resume paths keep using `task.workspace`: confirm `resolve.py` (resolve-retry lock check and `build_request`), `reconcile.py` and `workflow.py` stage entry / validation spawn / diff capture read the task row, never `team["workspace"]`. Change any that do not. No new code is expected here; the restart test in "Done when" proves it.
4. Arguments:
   - `dispatch._validate_definition_start`, `_validate_workflow_start` (P00 form) and `_validate_task_direct`: optional `workspace`, a string ≤ 4096 bytes that is an absolute POSIX path, else `BAD_REQUEST`. `serve` goes through `dispatch`, so this covers it.
   - CLI: `--workspace PATH` on `workflow start` (both forms) and `task direct`, put in `args` only when given. Because the idempotency hash covers `args` (`inbox.payload_hash`), the same key with a different `workspace` → `IDEMPOTENCY_CONFLICT`.
   - `workflow.validate` and `workflow.list` are unchanged (team workspace).
5. Test fixture: a debug-only command `debug.ticket_worktree {workspace, key}` (dispatch + coordinator handler, refused by non-debug coordinators like `debug.assign`). It calls `worktrees.create(workspace, key, worktrees.slug(title), <current branch of the main checkout>)` for an existing ticket and records it with a new `tickets.record_worktree(tx, ticket, created)`, which sets `branch`, `worktree_path`, `base_commit` and writes `ticket.worktree_created {branch, path, baseCommit}` (events + `ticket_events`, §J). It returns `{ticket, worktree: created}`. S05 reuses `tickets.record_worktree`.

## Done when

- [x] `registered_worktree` unit cases on a temp repo and temp state dir: a ticket worktree from `worktrees.create` with its row recorded → its canonical path (also when given through a symlink); `/tmp/x` (missing); the main checkout's parent; a path made with plain `git worktree add` outside the root; a recorded row whose worktree was removed with `worktrees.remove`; the same worktree after its ticket is `cancelled` → each `WORKTREE_NOT_REGISTERED`. Test: `tests/unit/test_p03_s04_registered.py`.
- [x] Argument validation: a relative `workspace` → `BAD_REQUEST` for `workflow.start` (both forms) and `task.direct`; the CLI puts `--workspace` into `args`; the same idempotency key reused with another `workspace` → `IDEMPOTENCY_CONFLICT`. Test: `tests/unit/test_p03_s04_registered.py`.
- [x] Parallel: a fake team with two developer agents, two story tickets with worktrees from `debug.ticket_worktree`, and a one-stage `workspace_write` definition committed on the base branch (`.agent-studio/workflows/`). Two `workflow.start --workspace <wt>` runs whose fakes write different files (`writeFile`, `durationMs` long enough to overlap) are both `running` at the same time, both succeed, and each captured diff names only its own file. The main checkout's `HEAD` and `git status --porcelain` are unchanged. Test: `tests/integration/test_p03_s04_parallel_worktrees.py`.
- [x] Locks: while a worktree run is active, a second `workspace_write` start on the **same** worktree (`workflow.start`, and `task.direct --policy workspace_write`) → `WORKSPACE_BUSY`, while a `workspace_write` `task.direct` on the main checkout is accepted. Test: same integration file.
- [x] Through the coordinator, `/tmp/x`, the main checkout's parent, an unregistered `git worktree add` path, and a worktree whose ticket was cancelled with `ticket.cancel` → `WORKTREE_NOT_REGISTERED` for `workflow.start` and `task.direct`, and no task row is created. Test: same integration file.
- [x] Role context and `workflow.json` come from the worktree: the test commits a changed `.agent-studio/roles/developer.md` and a changed `validation.argv` in `.agent-studio/workflow.json` in the worktree only (the main checkout keeps the old text); the run's first assignment's frozen `request.roleContext.text` contains the new text and the `workflow.start` receipt's `validationArgv` is the new one. Test: same integration file.
- [x] Restart: a worktree run with the coordinator killed at the `after_claim_commit` crash point (`AGENT_STUDIO_TEST_CRASH_AT`, as in `tests/integration/test_p01_s07_recovery.py`) resumes after restart and succeeds, with its diff taken from the worktree and the main checkout unchanged. Test: same integration file.
- [x] Without `workspace`, every existing P00/P01 integration and unit test passes unchanged (full `tests/unit` and `tests/integration` run in Evidence).

## Evidence

2026-10-23:

- Implemented `tickets.registered_worktree` and `tickets.record_worktree`, the optional `workspace` argument on `workflow.start` (both forms) and `task.direct` (dispatch validation, CLI `--workspace`, coordinator handlers), the task row now storing the chosen path, and the debug-only `debug.ticket_worktree` fixture.
- `python3 scripts/validate.py` (the project's validation command: whole unit suite plus the integration modules the change touched), run in the operator's WSL: PASS, including `tests.integration.test_p03_s04_parallel_worktrees` (5 tests: parallel worktrees independent and main checkout unchanged; per-worktree locks with the main checkout still available; unregistered, plain and cancelled worktrees refused with no task rows; role context and `workflow.json` read from the worktree; restart after `after_claim_commit` resumes in the worktree) and `tests/unit/test_p03_s04_registered.py`.
- The Codex developer's sandbox cannot run tmux, so the integration test was first run outside it. Two fixture mistakes in the test (a worktree record passed as a path, diffs read from `changedFiles` only, role file name case) were fixed in the test; no behaviour change was needed.
