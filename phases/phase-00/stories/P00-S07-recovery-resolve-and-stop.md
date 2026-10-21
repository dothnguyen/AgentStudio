# P00-S07 — Recovery, operator resolution, and scoped stop

Status: To Do
Depends on: P00-S05, P00-S06
Architecture: [P00 implementation contract](../architecture.md), sections C, D, H

## Goal

Make every interruption recoverable and every uncertain state resolvable by an explicit operator command, proven with the fake adapter before real providers are involved. This is implementation work; S12 only re-proves it live.

## Implement in this order

1. Coordinator startup: lock → migrate → unfinished commands → owned tmux sessions → pane/process identity (PID + start time + boot ID) → pending reports → adapter `reconcile` → event per decision. Uncertain attempts become `reconciling` with a diagnostic.
2. Never re-dispatch because a client response was missed. A new CLI/serve call reads snapshot and events by cursor and gets the original receipt for a repeated idempotency key.
3. `assignment.resolve {retry | fail | cancel}`: valid only from `waiting_input`, `reconciling`, or a paused workflow's current assignment. `retry` creates a new attempt (new assignment ID) only after the previous attempt's process is proven gone; an operator-chosen different policy is recorded explicitly. Workflows resume from the resolved stage.
4. `assignment.cancel` and `team.stop`: verify ownership, signal only recorded process identity, bounded wait, stop only the run-owned session, keep sanitized logs/events, and return `CLEANUP_INCOMPLETE` when identity or cleanup is uncertain.
5. Pane death mid-assignment: agent `offline`, assignment reconciled from runner evidence (completed reports still apply), never succeeded by default.
6. Document each recovery action an operator can take, with the exact command.

## Failure drills (fake adapter)

- Coordinator killed before intent commit, after intent before claim, after claim before start, while running, after final report before apply.
- Runner finishes while coordinator is down; report applied once on restart.
- Duplicate request, missed response, malformed report, dead pane, tmux marker mismatch, timeout, waiting input → resolve retry/fail/cancel.
- PID reuse: a different process with the recorded PID but a different start time is not treated as the attempt.

## Done when

- [ ] Every drill ends in a truthful, visible state and a documented command that resolves it.
- [ ] No drill produces a duplicate provider execution or invented success.
- [ ] Stop/cancel never affect non-owned tmux sessions, processes, or data.
