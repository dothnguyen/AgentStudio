# P03-S15 — `board.show`, `team.py board` and `team.py ticket`

Status: To Do
Depends on: P03-S11, P03-S12
Architecture: [P03 design contract](../README.md#design-contract), §I (commands), §H (visibility); brief §5

## Goal

The operator sees the board (or all boards, when several workspaces run in parallel) and drives it from `team.py`. `board.show` returns every column with its tickets: who holds what, rounds, blocked reasons, limit lines and the board state, as JSON that P02 can render later. `team.py board` prints it as a text kanban. `team.py ticket add|move|show|depend` and `team.py board run|pause|resume` wrap the commands and show the parsed dependencies back to the operator.

## Implement in this order

1. `board.show {workspace}` (read-only) returns:
   - `board {status, reason}`;
   - `columns: [{status, tickets: [{key, kind, title, priority, severity, assignee, runId, rounds {dev, test, review}, blockedReason, depsOpen: [keys]}]}]` in §B order;
   - `agents: [{name, role, availability, limitResetAt}]`;
   - `held: [{column, reason}]` (computed live: `board_scheduler.holds`, S13, plus the merge hold).
   Terminal tickets are shown as counts plus the last 10.
2. `team.py board` prints the text kanban: a column per status that has tickets, one line per ticket (`T-003 [dev:1 qa:0] dev-1 ← T-001`), then a red `LIMIT: …` line per limited agent and the held reasons. Subcommands: `team.py board run|pause [--reason]|resume [--agent NAME|--all]`.
3. `team.py ticket add STORY [--depends T-001 ...] [--no-deps]` prints the parsed or overridden dependencies and any unresolved story IDs. `team.py ticket add --brief PATH --out DIR`. `team.py ticket move KEY STATUS [--reason]`, `ticket show KEY`, `ticket depend KEY --on T-…`.
4. `team.py status` adds a one-line board summary when a board is running.
5. **All boards.** `board.list {}` (read-only, no workspace argument) returns `boards: [{workspace, name, status, reason, team: {teamId, status} | null, counts: {<status>: n} (non-terminal statuses with tickets, plus merged/cancelled totals), agents: {total, idle, busy, limitReached}, limits: [{agent, role, resetAt}], held: [{column, reason}]}]`: one entry for every workspace that has tickets or a `board_state` row, ordered by workspace path (`name` = the directory's base name). It reads the same data as `board.show`, never writes, and a workspace whose directory is gone is listed with `status: "unavailable"` instead of failing the call. `team.py boards` prints one line per board (`<name>  running  dev:2 test:1 review:0 blocked:1  LIMIT: qa until 14:05`). Every other `team.py` and CLI command that takes a workspace keeps taking `--workspace` (default: the current directory's repo), so each board is driven independently.

## Done when

- [ ] `board.show` on a fixture board with one ticket per status matches a golden JSON. The CLI and `serve` output are identical. Test: `tests/integration/test_p03_s15_board_show.py`.
- [ ] The `team.py board` rendering of the same fixture matches a golden text file (colours off when not a TTY). Test: `tests/unit/test_p03_s15_team_py_board.py`.
- [ ] `team.py ticket add` with a `Depends on:` line prints the resolved keys and unresolved IDs. `--no-deps` prints none.
- [ ] `board.list` with two workspaces (one running, one paused with a limited agent) and a third whose directory was deleted: three entries with the right status, counts, agents and limits, the deleted one `unavailable`, and no write (event count unchanged). The CLI and `serve` output are identical; `team.py boards` matches a golden text. Test: `tests/integration/test_p03_s15_board_list.py` and the unit file above.
- [ ] A limited agent appears in `board.show.agents` with `limit_reached` and in the `LIMIT:` line.
- [ ] All existing tests stay green.

## Evidence

(filled in when the story is done)
