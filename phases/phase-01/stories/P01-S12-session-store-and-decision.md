# P01-S12 — Session store, `task.direct` session key, and the decision at assignment creation

Status: To Do
Depends on: P01-S11
Architecture: [P01 design contract](../README.md#h-session-continuity-e4), section H (state, decision table, pointer advance, caps, restart)

## Goal

The coordinator records `(agent, sessionKey) → providerSessionId` and decides at assignment creation whether the next task for that agent and key resumes, starts fresh, or cannot continue. It freezes that decision into the request, so the runner only follows it (S11). The pointer moves only on applied `succeeded` reports, so failed, timed-out, cancelled and uncertain attempts are never resumed from.

## Implement in this order

1. Migration in `schema.py`:
   - The `agent_sessions` table from §H, with a partial unique index on `(agent_id, session_key) WHERE status = 'active'`.
   - The `Entity` column list.
   - Events written through `store.Tx` like every other row.
2. `protocol.py`: `sessionKey` validation (`[A-Za-z0-9][A-Za-z0-9._-]{0,95}`, `SESSION_KEY_INVALID`). `task.direct` accepts optional `sessionKey`, and it is part of the idempotency payload hash. CLI `task direct --session-key KEY`.
3. Session caps:
   - `team.start` reads `.agent-studio/team.json` → `sessions {maxTasks (1–50, default 12), maxContextTokens (10 000–1 000 000, default 160 000)}`.
   - It freezes them on the team row. Anything invalid → `TEAM_CONFIG_INVALID` before any pane exists.
4. New `sessions.py`:
   - `decide(tx, team, agent, key, adapter)` implements the §H table, creates the row (`session.started`) or rotates it (`session.rotated`), and returns the frozen `request.session`.
   - `tasks.build_request(agent, workspace, extra, session_key=None)` calls it, and `assignment.created` records the decision.
   - The `unsupported` warning is returned on the `task.direct` receipt.
5. Report application (`reports.py`): advance, not-advance, fallback re-point, and `unsafe_after_failure` (for adapters without `forkOnResume`), exactly as §H says, in the same transaction that applies the report.
6. Resolve-retry (`resolve.py`) passes the original assignment's key, so the retry decides from the last proven pointer.

## Done when

- [ ] Fake team, one agent, key `K`:
  - task 1 is `fresh`;
  - task 2 is `resume` from task 1's reported ID;
  - task 3 resumes task 2's (forked) ID;
  - `task_count` is 2 after task 2 and 3 after task 3.
- [ ] Two agents with the same key never resume each other's session, and one agent with keys `K` and `L` keeps two independent rows.
- [ ] No key → `mode: none`, no row and no session events, and the request and prompt are identical to P00's (regression test).
- [ ] Failed, `TIMEOUT`, cancelled and `waiting_input` tasks each leave the pointer unchanged (`session.not_advanced`), and the next task resumes the last succeeded ID. With a test adapter that has `forkOnResume: false`, the row ends instead and the next task is `fresh`.
- [ ] A fallback report re-points the row to the new ID and writes `session.fallback`, and the receipt and `task show` carry the warning.
- [ ] Caps: the 13th task (default) or a last usage above `maxContextTokens` gives `fresh` with `session.rotated` and the reason. A changed agent model/reasoning (forced in a test) gives `settings_changed`.
- [ ] A Codex-fixture agent (`resume: unsupported`) with a key → `mode: unsupported`, warning `SESSION_CONTINUATION_UNSUPPORTED`, no row.
- [ ] Restart (via `AGENT_STUDIO_TEST_CRASH_AT`):
  - crash after the runner's `result.json` and before application → after restart the report is applied once and the pointer advances once;
  - a `reconciling` attempt never advances, and its resolve-retry resumes the previous proven ID (or is `fresh` if none).
- [ ] Idempotency: the same key and payload return the original receipt; a different `sessionKey` under the same idempotency key → `IDEMPOTENCY_CONFLICT`.
- [ ] Tests: `tests/unit/test_p01_s12_migration.py`, `tests/unit/test_p01_s12_decide.py`, `tests/integration/test_p01_s12_direct_sessions.py`. The provider-name guard includes `sessions.py`. All existing tests stay green.

## Evidence

(filled in when the story is done)
