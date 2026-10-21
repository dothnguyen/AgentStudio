# P00-S07 — Recovery, operator resolution, and scoped stop

Status: Done
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

- [x] Every drill ends in a truthful, visible state and a documented command that resolves it.
- [x] No drill produces a duplicate provider execution or invented success.
- [x] Stop/cancel never affect non-owned tmux sessions, processes, or data.

## Evidence (2026-10-22)

- `python3 -m unittest discover -s tests -t .` → 196 tests OK: Ubuntu 22.04 / Python 3.10 / tmux 3.2a (in chunks) and Python 3.13 / tmux 3.4 in one run (231 s; one root-only skip). S07: `tests/integration/test_s07_recovery.py` (17 drills) and `tests/unit/test_s07_reconcile.py` (8).
- Coordinator crash drills via one-shot crash points: before intent commit (client gets `PENDING`; retry with the same key → original receipt), after intent before claim, after claim before the request file (redelivered), while running (SIGKILL) and while applying the final report; plus runner finishing while the coordinator is down. Each: one assignment, one run folder, exactly one provider start, no report applied twice.
- Runner killed → `reconciling / RUNNER_GONE` → `resolve retry` runs attempt 2 to success, old attempt `failed / SUPERSEDED_BY_RETRY`. Runner died after saving `result.json` → saved result applied once (`assignment.reconciled`, source `result.json`). Dead pane mid-assignment → agent `offline`, assignment never succeeded; retry refused (`AGENT_UNAVAILABLE`), `fail` settles task.
- `waiting_input` → retry with an explicit policy change (recorded in `task.retried`), or fail / cancel (agent freed). Malformed report → `assignment.report_rejected`, state unchanged, real report still settles it. Direct timeout → final `failed / TIMEOUT`; resolve refused, a new task runs. Workflow stage timeout → `paused / TIMEOUT` → resolve retry resumes from the developer stage to `succeeded`; paused workflow resolved `fail` → workflow and task `failed`. Guards: resolve refused for running work (`RESOLVE_NOT_ALLOWED`) and while a process is alive (`PROCESS_STILL_RUNNING`).
- PID reuse: same PID with a different start time is never treated as the attempt and is never signalled. Bounded reaping escalates a SIGTERM-ignoring process to SIGKILL within the bound and never touches a process whose identity does not match. `team stop` leaves no runner or provider alive.
- Startup: an unowned Agent Studio-looking session is preserved; an interrupted stop's session (ownership proven) is removed.
- Found and fixed: identity checks treated zombie processes as alive (a crashed validator would have kept a workflow waiting forever); the coordinator now reaps its own finished children. Rejected reports are now visible events.
- Recovery actions and exact commands: `backend/RECOVERY.md`.
