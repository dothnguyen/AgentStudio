# P03-S11 — Usage limits: classification, `limit_reached`, `board.resume`

Status: To Do
Depends on: P03-S06
Architecture: [P03 design contract](../README.md#design-contract), §H (usage limits); brief §6b

## Goal

When a provider says its usage or rate limit is reached, the adapter reports `USAGE_LIMIT` (with the reset time if given) instead of a generic error. The board then cancels that run, puts the ticket back in its column without counting a round, and marks only that agent `limit_reached`, so it is offered no work until the operator runs `board.resume`. Other agents and columns keep working.

## Implement in this order

1. `providers/base.py`: diagnostic `USAGE_LIMIT` and optional `limitResetAt` (ISO-8601) on the normalized result.
2. Fake adapter scenario `usage_limit` (with and without a reset time).
3. Claude adapter classifier. Capture the real CLI's limit output (stream-json result, exit code) into `backend/agent_studio/providers/claude/fixtures/usage_limit*.json`, from a real occurrence or the provider's documented message. Record the source in `CONTRACT.md`. Codex: the same if a real sample exists. Otherwise its classifier stays absent and that gap is recorded (unrecognised → `PROVIDER_ERROR`, never guessed).
4. Schema v8: rebuild `agents` so its CHECK accepts `limit_reached`, and add `limit_reset_at` (the P01 §F rebuild pattern, `foreign_key_check`).
5. Report application: an assignment `failed`/`USAGE_LIMIT` sets its agent to `limit_reached` and writes `board.limit_reached`. The board outcome (§C row) cancels the run, releases the ticket back to the column it was picked from, writes `ticket.released {reason: "usage_limit"}`, and counts no round. P00/P01 dispatch refuses a `limit_reached` agent (`AGENT_UNAVAILABLE`, the existing busy-agent rule).
6. `board.resume {workspace, agentId? | all}` → `idle`, `board.resumed`. CLI `agent-studio board resume`. `snapshot` and `team.py status` show `LIMIT: <name> (<provider>) until <time>`.

## Done when

- [ ] Classifier unit tests: each captured Claude fixture → `USAGE_LIMIT` with the reset time where present, and an ordinary error fixture → `PROVIDER_ERROR`. Test: `tests/unit/test_p03_s11_usage_classifier.py`. The fixture source is recorded in the Claude `CONTRACT.md`.
- [ ] Migration v7 → v8 keeps every agent row, `foreign_key_check` is empty. Test: `tests/unit/test_p03_s11_migration.py`.
- [ ] Fake `usage_limit` mid-ticket in `in_test`: the ticket is back in `ready_test` with `test_rounds` unchanged, the QA agent is `limit_reached`, and a direct task to it → `AGENT_UNAVAILABLE`. The developer agent can still be started on another ticket.
- [ ] `board.resume --agent` sets it back to `idle`. A second limit sets the flag again after one call (no loop).
- [ ] Tests: `tests/integration/test_p03_s11_usage_limit.py`. All existing tests stay green.

## Evidence

(filled in when the story is done)
