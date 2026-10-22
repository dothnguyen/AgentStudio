# P03-S12 — Leases, release on crash/timeout/restart, orphan worktrees, `ticket.retry`

Status: To Do
Depends on: P03-S06
Architecture: [P03 design contract](../README.md#design-contract), §E (startup reconcile), §G (claim and lease)

## Goal

No ticket is ever lost or held forever. A claim that never got a run (coordinator crash between claim and start) is released when its lease expires. A ticket whose run ended while the coordinator was down gets its outcome applied once at startup. A run that ended by deadline or a dead runner follows the P00/P01 rules and then the §C table. Worktrees with no live ticket are removed at startup. `ticket.retry` lets the operator release a stuck claim by hand.

## Implement in this order

1. `board.reconcile(store, ctx)` runs at coordinator startup (added to the startup step list in `coordinator.run`) and on each monitor tick:
   - `in_*` / `*ing` ticket with no `run_id` and `lease_until < now` → back to the column it was picked from, `ticket.released {reason: "lease_expired"}`;
   - `run_id` terminal or paused and not applied → `apply_outcomes` (S06);
   - `run_id` pointing at a run that does not exist → `blocked` / `RUN_MISSING`.
2. Startup only: for each path under the worktree root not owned by a non-terminal ticket → `worktrees.remove`, `board.worktree_orphan_removed`. A ticket whose `worktree_path` is missing on disk → `blocked` / `WORKTREE_MISSING`. A worktree is never re-created silently.
3. `ticket.retry {key}`: allowed only for an `in_*` ticket with no active run. It releases the ticket like an expired lease. With an active run → `TICKET_BUSY`.
4. CLI `agent-studio ticket retry KEY`.

## Done when

- [ ] Crash point after the claim, before the run starts: after restart and `leaseSeconds`, the ticket is back in `ready_dev`, there is no worktree leak (the worktree, if created, is still owned by the ticket and reused on the next start), and exactly one `ticket.released`. Test: `tests/integration/test_p03_s12_recovery.py`.
- [ ] Coordinator stopped while a fake QA run finishes → after restart, one transition to `ready_review`, no duplicate assignment (P00 R-07 rule).
- [ ] Killed runner during develop → the P00 reconcile result (`reconciling`/paused) → ticket `blocked` / `RUN_PAUSED:…`. `assignment.resolve --action retry` then finishes the run and the ticket moves on.
- [ ] An orphan directory under the root, registered with git → removed at startup with the event. A ticket's worktree deleted by hand → `blocked` / `WORKTREE_MISSING`.
- [ ] `ticket.retry` on a stuck claim releases it; on an active run → `TICKET_BUSY`.
- [ ] All existing tests stay green.

## Evidence

(filled in when the story is done)
