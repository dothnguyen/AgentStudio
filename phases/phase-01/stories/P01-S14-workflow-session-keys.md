# P01-S14 — Session keys for workflow runs

Status: Dropped (2026-10-22): the kanban board (phases/briefs/feature-kanban-board.md) makes agents stateless per ticket, so session continuity is not needed.
Depends on: P01-S12
Architecture: [P01 design contract](../README.md#h-session-continuity-e4), section H (session key, state); [P00 contract](../../phase-00/architecture.md) §G

## Goal

Every stage of a workflow run carries one session key: the run ID by default, or an explicit `sessionKey` given to `workflow.start`. The developer's repair stage therefore continues the developer's earlier session, the reviewer's recheck continues the reviewer's, and a later `task.direct` with the same key (the `team fix` / `team qa` rounds) continues them too. The two roles never share a session.

## Implement in this order

1. Migration: `workflow_runs.session_key TEXT` (NULL for old rows). Add it to the `Entity` columns.
2. `workflow.start` accepts optional `sessionKey` (same validation as S12, part of the idempotency payload). The run stores `sessionKey or run ID`, and `workflow_run.started` records it. CLI: `workflow start ... --session-key KEY`.
3. Every place that creates a stage assignment passes the run's key to `tasks.build_request`: the stage dispatch in `workflow.py`, repair, recheck, and the resolve-retry of a stage in `resolve.py`. Old runs with a NULL key run unkeyed (as today).
4. `workflow.show` returns `sessionKey`, and each stage attempt shows its assignment's `session` block.
5. Guard test: every request file written by the coordinator in the integration suite has a `session` block. This catches any new assignment path, including P01-S04/S05's generic engine, that bypasses `build_request` or drops the key.

## Done when

- [ ] Fake workflow with review fail → repair → pass:
  - `developer` is `fresh`, and `developer_repair` resumes the developer's reported session;
  - `reviewer` is `fresh`, and `reviewer_recheck` resumes the reviewer's;
  - developer and reviewer rows are distinct.
- [ ] A run with no explicit key uses its run ID as the key. A second run starts fresh for both roles.
- [ ] `workflow start --session-key S` followed by `task direct --session-key S` to the developer: the direct task resumes the developer's last succeeded workflow session.
- [ ] A paused stage resolved with `retry` resumes from the last proven pointer of that agent and key, not from the uncertain attempt.
- [ ] Rows created before the migration (NULL key) still run, show and cancel. All P00 workflow tests stay green.
- [ ] Tests: `tests/integration/test_p01_s14_workflow_sessions.py`, plus the guard test (`tests/integration/test_p01_s14_request_session_guard.py`).

## Evidence

(filled in when the story is done)
