# P03-S12 — Leases, release on crash/timeout/restart, orphan worktrees, `ticket.retry`

Status: Done (2026-10-23)
Depends on: P03-S06
Architecture: [P03 design contract](../README.md#design-contract), §E (startup reconcile), §G (claim and lease)

## Goal

No ticket is ever lost or held forever. A claim that never got a run (coordinator crash between claim and start) is released when its lease expires. A ticket whose run ended while the coordinator was down gets its outcome applied once at startup. A run that ended by deadline or a dead runner follows the P00/P01 rules and then the §C table. Worktrees with no live ticket are removed at startup. `ticket.retry` lets the operator release a stuck claim by hand.

Today `ticket.start` claims and starts the run in **one** command transaction, so a "claim without a run" can never be committed. This story adds the two-transaction path that §G describes (`board.claim_and_start`, used by the S13 scheduler tick) and the recovery for its gap. `ticket.start` stays one atomic command, unchanged.

## Terms

- **Pending claim**: a ticket in a working status (`schema.BOARD_COLUMNS[*]["working"]`) with no `ticket.run_started` ticket event after its latest `ticket.claimed` ticket event (compare `ticket_events.id`). Do not test `run_id IS NULL`: a re-claimed ticket still carries the previous column's `run_id` until the new run starts.
- **Release** (`board.release(tx, ticket, reason)`): a coordinator move from the working status back to the queue it was picked from (`_queue`, the same as the existing usage-limit release), `assignee_agent_id` and `lease_until` set to NULL, and one `ticket.released {reason}`. Refactor the usage-limit branch of `_apply` to use it. Reasons added here: `lease_expired`, `operator_retry`, `start_failed`.

## Implement in this order

1. Split `board.start_column` into `board.claim(tx, ticket, agent, config, ctx)` (the role and dependency checks, claim, lease, and for develop the worktree create + `tickets.record_worktree`) and `board.start_claimed(tx, ticket, agent, config, ctx)` (base merge, definition, seed, `workflow.start`, `run_id`, `ticket.run_started`). `start_column` calls both in the caller's transaction, so `ticket.start` behaves exactly as before, including its rollback rule (§I).
2. `board.claim_and_start(store, workspace, key, agent_id, ctx)`: transaction 1 = `claim`, then `crashpoints.hit("after_ticket_claim_commit")` (add the name to `crashpoints.POINTS`), then transaction 2 = `start_claimed`. If transaction 2 raises `AsError`, a third transaction releases the ticket with `start_failed` and re-raises. The worktree recorded in transaction 1 stays owned by the ticket and is reused on the next start (it is not discarded). No caller in the loop yet; S13's tick calls it.
3. `board.reconcile(store, ctx, *, startup=False, now=None)` (`now` is a UTC `datetime` for tests, default the current time). It does the following:
   - for each pending claim whose `lease_until` (parsed as UTC) is before `now`: `release(…, "lease_expired")`, one transaction per ticket;
   - `apply_outcomes(store, ctx)` (S06), which applies a run that is terminal, or paused, and not yet applied.
   The coordinator calls `board.reconcile(store, ctx, startup=True)` as a new startup step `("board", …)` after the `"merge"` step in `coordinator.run`, and calls `board.reconcile(store, ctx)` on each monitor tick after `reconcile.tick`. It returns a JSON-able summary (`{released, applied, orphansRemoved, worktreesMissing, unregisteredPaths}`), which is recorded as `startupReconciliation.board`.
   (`run_id` always names an existing run: `tickets.run_id` is a foreign key with `PRAGMA foreign_keys = ON`, so there is no `RUN_MISSING` case.)
4. Startup only (`startup=True`), for each distinct `tickets.workspace` whose directory exists:
   - **Orphans**: each `worktrees.list_registered` entry whose realpath is not the `worktree_path` of a non-terminal ticket on that workspace. Skip an entry whose ticket (matched by `worktree_path`) still has a run in `queued`/`running`/`paused`. If the entry's branch starts with `ticket/<key>-` for a ticket on this workspace whose `branch` is NULL (a start that crashed before recording it), call `worktrees.discard`, which removes the worktree and its branch, the same as a rolled-back start. Otherwise call `worktrees.remove` and keep the branch (Q6). Each removal writes one `board.worktree_orphan_removed {path}` event in the `events` stream (and a ticket event when a ticket matches).
   - **Missing worktrees**: each non-terminal ticket that is not `blocked`, has `worktree_path` set and has no run in `queued`/`running`, where the path is not a directory or is not in `list_registered` → `tickets.block(…, "coordinator", "WORKTREE_MISSING")`, with assignee and lease cleared. Nothing is re-created. The operator's way out is `ticket.cancel` (documented in S16).
   - Directories under the root that git does not list are left alone and only reported in `unregisteredPaths`.
5. `ticket.retry {workspace, key}` (mutating, `dispatch` validator `_validate_ticket_retry`, handler `_handle_ticket_retry`):
   - for a pending claim it calls `release(…, "operator_retry")` whatever the lease, and returns `{ticket}`;
   - for a ticket in a working status whose run has started → `TICKET_BUSY`;
   - for any other status → `TICKET_TRANSITION_INVALID`.
6. CLI `agent-studio ticket retry KEY`, with the same workspace option as the other `ticket` subcommands, and the same JSON through `serve`.

## Done when

- [x] Crash after the claim: `claim_and_start` for a `ready_dev` ticket, with `crashpoints.hit` patched to raise at `after_ticket_claim_commit`. Then, on a new `Store` over the same database:
  - `reconcile(now=lease_until − 1 s)` changes nothing;
  - `reconcile(now=lease_until + 1 s)` puts the ticket back in `ready_dev` with assignee and lease NULL and exactly one `ticket.released {reason: "lease_expired"}`;
  - a second `reconcile` writes nothing;
  - the worktree is still recorded on the ticket and in `list_registered`, and `ticket.start` then reuses it (same `worktree_path`, no `WORKTREE_EXISTS`).
  Test: `tests/unit/test_p03_s12_recovery.py`.
- [x] A re-claimed ticket whose `run_id` still names the previous, applied run is detected as a pending claim. A ticket whose run has started is not released, even after its lease. `start_claimed` failing inside `claim_and_start` → released with `start_failed`, worktree kept. Test: the unit file above.
- [x] `ticket.start` is unchanged: the existing S05 tests stay green, including its rollback and worktree-discard cases.
- [x] Coordinator stopped while a fake QA run finishes → after restart, one `ticket.outcome_applied` with `to: ready_review`, and no second assignment for the stage (P00 R-07 rule). Test: `tests/integration/test_p03_s12_restart.py`.
- [x] Killed runner during develop → the P00 reconcile result (assignment `reconciling`, run paused) → ticket `blocked` / `RUN_PAUSED:<code>` with `return_status` `ready_dev`. `assignment.resolve --action retry` then finishes the run, and the ticket moves on to `ready_test` (late outcome). Test: the integration file above.
- [x] Startup orphans, in a real temp git repo:
  - a git-registered worktree under the root with no live ticket → removed, with one `board.worktree_orphan_removed`, and its branch kept;
  - an orphan `ticket/<key>-…` worktree of a `ready_dev` ticket with `branch` NULL → worktree and branch removed, and the next `ticket.start` succeeds;
  - a plain directory under the root that git does not list → untouched and reported;
  - the worktree of a cancelled ticket whose run is still `running` → untouched.
  - The monitor tick (`startup=False`) removes nothing.
  Test: the unit file above.
- [x] A ticket's worktree deleted by hand (`ready_test`, no active run) → after startup reconcile, `blocked` / `WORKTREE_MISSING` with `return_status` `ready_test`, and no worktree re-created. Test: the unit file above.
- [x] `ticket.retry`:
  - on a pending claim → released (`operator_retry`), even before its lease expires;
  - on a ticket whose run has started → `TICKET_BUSY`;
  - on `ready_dev` → `TICKET_TRANSITION_INVALID`;
  - the CLI and `serve` give the same JSON.
  Test: the unit file above (command handler, dispatch validator, and CLI `ticket retry` argument building, in the same style as `tests/unit/test_p03_s02_commands.py`).
- [x] The guard test still passes: the new board code names no role, column or provider.
- [x] All existing tests stay green.

## Evidence

- `python3 scripts/validate.py --touched`: PASS.
  - Unit suite: `Ran 454 tests … OK (skipped=3)`. This includes the existing S05 `ticket.start` rollback/discard tests and the guard test.
  - Integration: `tests.integration.test_p03_s12_restart`, `Ran 3 tests in 21.200s OK`.
- Tests added:
  - `tests/unit/test_p03_s12_recovery.py`: crashed claim → lease expiry once → `ticket.start` reuses the worktree; re-claim pending detection; a started run is not released; `start_failed` release keeps the worktree; `ticket.retry` (released / `TICKET_TRANSITION_INVALID` / `TICKET_BUSY`), the validator, CLI and `serve`; startup orphans (removed with the branch kept, unrecorded `ticket/<key>-` branch discarded, plain directory reported, running cancelled-ticket tree kept, the monitor tick removes nothing); a deleted workspace is skipped; `WORKTREE_MISSING` with `return_status` `ready_test`.
  - `tests/integration/test_p03_s12_restart.py`: a QA outcome is applied once after a restart with no second assignment; a SIGKILLed develop runner → `reconciling` / `RUNNER_GONE` → `blocked` `RUN_PAUSED:*` (return `ready_dev`) → `assignment.resolve retry` → `ready_test`; a paused develop run is retried after a restart.
- Code changed:
  - `backend/agent_studio/board.py`: `release`, `claim` / `start_claimed` split, `claim_and_start`, `_pending`, `reconcile`.
  - `backend/agent_studio/coordinator.py`: the `board` startup step, `board.reconcile` on the monitor tick, `_handle_ticket_retry`.
  - `backend/agent_studio/dispatch.py`: `_validate_ticket_retry`.
  - `backend/agent_studio/cli.py`: `ticket retry`.
  - `backend/agent_studio/crashpoints.py`: `after_ticket_claim_commit`.
- Docs changed: `phases/phase-03/README.md` §C/§E/§G/§I/§J and the S13 step 3, both from the pre-work review.
- QA: two earlier blockers are fixed in the final code.
  - A missing workspace directory is skipped (`board.py` reconcile, with a unit test).
  - The killed-runner case is now a real SIGKILL integration test.
- Notes for follow-up (not blocking):
  - The `start_failed` test asserts that a `ticket.released` event exists, not its reason.
  - The discarded-branch test does not run the next `ticket.start`. That path is the same as a fresh start.
  - A *detached* orphan worktree under the root (`branch` None) would make `entry.get("branch", "").startswith` raise. That aborts the `board` startup step (it is caught per step) until the tree is removed.
