# P01-S16 — `team.py`: story session keys, reset, end on commit, and usage

Status: Dropped (2026-10-22): the kanban board (phases/briefs/feature-kanban-board.md) makes agents stateless per ticket, so session continuity is not needed.
Depends on: P01-S13, P01-S14 (P01-S15 for real Claude resumes; the script works without it, with `unsupported` warnings)
Architecture: [P01 design contract](../README.md#h-session-continuity-e4), section H; `scripts/team/team.py`

## Goal

The project helper drives one story's cycle as one session key, so the lead, the developer and QA each continue their own conversation across `review`, `dev`, `fix`, `qa` and `final`. `commit` ends the story's sessions, and `reset` ends them on demand. A new `usage` command shows, per agent, the input, cached and output tokens and tool reads for a story, so fresh and resumed runs can be compared.

## Implement in this order

1. `direct()` gets a `key` argument and passes `--session-key`. `review`, `fix`, `qa` and `final` pass `story_key(story)`. `unpack` stays unkeyed. `c_dev` passes `--session-key` to `workflow start`. Print the receipt's session warning when there is one.
2. Show the session per task: after each task, print `session: fresh|resumed <short id>|unsupported|fallback`, taken from the assignment's `session` block.
3. `commit`: after a successful `git commit`, run `session end --team T --key K` and say so. If the commit did not happen, sessions stay.
4. `reset <role|all> [STORY]`:
   - `role` ∈ `lead`, `dev`, `qa` (mapped to TeamLead, Developer, QA);
   - with STORY → that key only; without STORY → all keys of that agent.
   - `reset all` with no STORY ends every session of the team (`--all`).
   - Report what ended. `SESSION_IN_USE` is shown as is.
5. `usage [STORY]`: from `task show` of the story's recorded tasks (store each task ID in the story state file as it runs) or from `session list` plus `snapshot`. One row per task: role, command, fresh/resumed, input/cached/output tokens, tool reads (`Read`+`Grep`+`Glob` from `toolUses`), then totals per agent. Without STORY: one line per story recorded in the state directory.
6. `stop` needs no backend change (`team.stop` ends sessions); its message says sessions were ended. Update the module docstring.

## Done when

- [ ] Against a stub `agent-studio` (`AGENT_STUDIO=` pointing at a test script that records argv and stdin and returns canned JSON):
  - `review`, `dev`, `fix`, `qa` and `final` for one story all send the same `--session-key`;
  - two stories send different keys;
  - `unpack` sends none.
- [ ] `commit` sends `session end --key` only after a successful commit (declined prompt → no call).
- [ ] `reset dev STORY`, `reset qa`, and `reset all` send the expected `session end` arguments.
- [ ] `usage STORY` prints per-task and per-agent totals from canned results with and without `usageNormalized`, and missing usage shows as `-`, not 0.
- [ ] Tests: `tests/unit/test_p01_s16_team_py.py`. All existing tests stay green.

## Evidence

(filled in when the story is done)
