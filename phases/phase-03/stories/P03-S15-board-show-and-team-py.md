# P03-S15 — `board.show`, `team.py board` and `team.py ticket`

Status: To Do
Depends on: P03-S11, P03-S12
Architecture: [P03 design contract](../README.md#design-contract), §I (commands), §H (visibility); brief §5

## Goal

The operator sees the board and drives it from `team.py`. `board.show` returns every column with its tickets: who holds what, rounds, blocked reasons, limit lines and the board state, as JSON that P02 can render later. `team.py board` prints it as a text kanban. `team.py ticket add|move|show|depend` and `team.py board run|pause|resume` wrap the commands and show the parsed dependencies back to the operator.

## Implement in this order

1. `board.show {workspace}` (read-only) returns:
   - `board {status, reason}`;
   - `columns: [{status, tickets: [{key, kind, title, priority, severity, assignee, runId, rounds {dev, test, review}, blockedReason, depsOpen: [keys]}]}]` in §B order;
   - `agents: [{name, role, availability, limitResetAt}]`;
   - `held: [{column, reason}]`.
   Terminal tickets are shown as counts plus the last 10.
2. `team.py board` prints the text kanban: a column per status that has tickets, one line per ticket (`T-003 [dev:1 qa:0] dev-1 ← T-001`), then a red `LIMIT: …` line per limited agent and the held reasons. Subcommands: `team.py board run|pause [--reason]|resume [--agent NAME|--all]`.
3. `team.py ticket add STORY [--depends T-001 ...] [--no-deps]` prints the parsed or overridden dependencies and any unresolved story IDs. `team.py ticket add --brief PATH --out DIR`. `team.py ticket move KEY STATUS [--reason]`, `ticket show KEY`, `ticket depend KEY --on T-…`.
4. `team.py status` adds a one-line board summary when a board is running.

## Done when

- [ ] `board.show` on a fixture board with one ticket per status matches a golden JSON. The CLI and `serve` output are identical. Test: `tests/integration/test_p03_s15_board_show.py`.
- [ ] The `team.py board` rendering of the same fixture matches a golden text file (colours off when not a TTY). Test: `tests/unit/test_p03_s15_team_py_board.py`.
- [ ] `team.py ticket add` with a `Depends on:` line prints the resolved keys and unresolved IDs. `--no-deps` prints none.
- [ ] A limited agent appears in `board.show.agents` with `limit_reached` and in the `LIMIT:` line.
- [ ] All existing tests stay green.

## Evidence

(filled in when the story is done)
