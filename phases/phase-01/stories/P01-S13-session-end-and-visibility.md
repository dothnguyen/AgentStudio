# P01-S13 — Ending sessions and showing them

Status: To Do
Depends on: P01-S12
Architecture: [P01 design contract](../README.md#h-session-continuity-e4), section H (ending, visibility, events)

## Goal

The operator can end a key's sessions on demand, and stopping a team ends all of its sessions. Ended sessions are never resumed. Team status shows, per agent, which session is active, its provider session ID, how many tasks it has carried, and its latest token usage.

## Implement in this order

1. Command `session.end` (mutating, idempotency key):
   - Args: `teamId`, optional `agentId`, optional `sessionKey`, and `all: true` when neither filter is given (`BAD_REQUEST` otherwise).
   - It ends the matching active rows with `end_reason: operator` and one `session.ended` event per row.
   - It returns the ended rows.
   - `SESSION_IN_USE` when a matched agent has a nonterminal assignment carrying a matched key. `AGENT_NOT_IN_TEAM` and `TEAM_NOT_FOUND` as usual.
   - Ending nothing is `ok` with an empty list.
2. Read command `session.list` (`teamId`, optional `sessionKey`, `includeEnded?`).
3. `team.stop` ends every active row of the team (`team_stopped`) in the transaction that cancels its assignments.
4. `snapshot` adds `sessions[]`. `task show` adds the per-assignment `session` block (mode, resumeFrom, providerSessionId, fallback, warning, usageNormalized).
5. CLI: `agent-studio session end --team ID [--agent ID] [--key KEY] [--all]` and `agent-studio session list --team ID [--key KEY] [--include-ended]`. Add both to the `serve` allowlist and to `cli.py` usage.

## Done when

- [ ] After `session end --key K` (and separately `--agent A --key K`, `--agent A`, `--all`), the next keyed task for each matched agent is `fresh`, and unmatched rows still resume.
- [ ] `session end` while the agent is running a task with that key → `SESSION_IN_USE`, and nothing changes.
- [ ] `team stop` → every row of the team is `ended / team_stopped`. A newly started team's first keyed task is `fresh` (new agent IDs).
- [ ] `snapshot` and `task show` return the fields above for a fake run with one resume and one fallback. `session list` filters by key and hides ended rows by default.
- [ ] `serve` accepts `session.end` and `session.list`, and the idempotency rules hold (same key and payload → same receipt).
- [ ] Tests: `tests/integration/test_p01_s13_session_end.py`, `tests/unit/test_p01_s13_snapshot_sessions.py`. All existing tests stay green.

## Evidence

(filled in when the story is done)
