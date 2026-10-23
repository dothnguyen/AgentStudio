# P03-S15 — `board.show`, `team.py board` and `team.py ticket`

Status: Done (2026-10-24)
Depends on: P03-S11 (limit flag), P03-S12 (leases), P03-S13 (`board_scheduler.holds`, `board.run|pause`), P03-S14 (unique agent names)
Architecture: [P03 design contract](../README.md#design-contract), §I (commands), §H (visibility); brief §5

## Goal

The operator sees the board (or all boards, when several workspaces run in parallel) and drives it from `team.py`. `board.show` returns every column with its tickets: who holds what, rounds, blocked reasons, limit lines and the board state, as JSON that P02 can render later. `team.py board` prints it as a text kanban. `team.py ticket add|move|show|depend` and `team.py board run|pause|resume` wrap the existing CLI commands and show the parsed dependencies back to the operator.

## Implement in this order

1. **`board.show {workspace}`** (read-only, a direct database read like `ticket.show`: `dispatch._reader()` + a new `queries.board_show(conn, workspace)`; the workspace goes through `ops.canonical_workspace`). It returns, besides `dbId` and `cursor`:
   - `workspace`;
   - `board: {status, reason}`: the `board_state` row (`running` | `paused`), or `{status: "stopped", reason: null}` when the workspace has no row;
   - `columns: [{status, count, tickets: [...]}]`: one entry for **every** status in `schema.TICKET_STATES` order (empty ones too, so the shape is stable). Each ticket is `{key, kind, title, priority, severity, assignee, runId, rounds: {dev, test, review}, blockedReason, depsOpen: [keys]}`; `assignee` is the assigned agent's name (`agents.display_name`, the S14 name) or null; `depsOpen` are the keys of its dependencies that are not `merged`, sorted. Non-terminal columns list all tickets ordered by `priority`, `created_at`, `key`. Terminal columns (`schema.TICKET_TERMINAL`) list only the 10 most recently updated (`updated_at` desc, then `key`), and `count` is always the full number;
   - `agents: [{agentId, name, role, availability, limitResetAt}]`: the agents of the team on this workspace whose status is not `stopped`/`error` (at most one, §G), in `ordinal` order; `[]` when there is none;
   - `held: [{column, reason}]`, computed live: `board_scheduler.holds(tx, workspace, config)` (S13), then the merge hold `{column: "merge", reason}` when a `ready_merge` ticket waits and the `board.merge_ready` reason applies (extract that reason into a read-only `board.merge_hold(tx, workspace, config)` and use it in `merge_ready`, so both agree). `config` is the frozen `board_state.config_json` when present, else `board_config.current(tx, workspace, None)`; if that raises `BOARD_CONFIG_INVALID`, or the workspace directory does not exist, `held` is `[]` (the view never fails because of `board.json` or git).
   Register it in `dispatch.py` (validator: `workspace` required) and add `agent-studio board show --workspace PATH` to `cli.py`.
2. **`board.list {}`** (read-only, no arguments; `queries.board_list(conn)`; `agent-studio board list`). It returns `boards: [{workspace, name, status, reason, team, counts, agents, limits, held}]`, one entry for every workspace that has tickets or a `board_state` row, ordered by workspace path:
   - `name` = the workspace directory's base name; `status`/`reason` as `board.show.board`, except `status: "unavailable"` (reason null) when the workspace directory no longer exists;
   - `team: {teamId, status} | null` (the same team as `board.show.agents`);
   - `counts: {<status>: n}` for every status that has at least one ticket (terminal included), keys in `schema.TICKET_STATES` order;
   - `agents: {total, idle, busy, limitReached}` (availabilities `idle`, `busy`, `limit_reached`; others count only in `total`);
   - `limits: [{agent, role, resetAt}]` for that team's `limit_reached` agents (`agent` = name);
   - `held` as in `board.show` (`[]` for an unavailable workspace).
   It shares its per-workspace reads with `board.show` (one helper), never writes, and an unavailable workspace never fails the call.
3. **Text renderers in `scripts/team/team.py`**, pure functions (no I/O) so they can be golden-tested:
   - `render_board(data, color) -> str` for a `board.show` result:
     - first line `board <name>: <status>` (`<name>` = the base name of `workspace`) plus ` (<reason>)` when a reason is set;
     - then, for each column with `count > 0`, a header `== <status> (<count>) ==` and one line per listed ticket: `  <key> [dev:<d> test:<t> review:<r>] <assignee or ->`, then ` ← <depsOpen joined by ", ">` when any, then `  !<blockedReason>` when set, then `  <title>` truncated to 50 characters;
     - then one `LIMIT: <name> (<role>) until <HH:MM>Z` line per `limit_reached` agent (`until unknown` when `limitResetAt` is null; the time is the UTC `HH:MM` of `limitResetAt`), and one `HELD: <column> <reason>` line per held entry.
     - With `color` true, `LIMIT:` lines are wrapped in red ANSI (`\033[31m … \033[0m`); otherwise no escape codes. Callers pass `sys.stdout.isatty()`.
   - `render_boards(data, color) -> str` for a `board.list` result: one line per board, `<name>  <status>  <status>:<n> …` (counts in the order `board.list` returns them, single spaces between them; `team.py` imports nothing from the backend), then `  LIMIT: <agent> until <HH:MM>Z` per limit and `  HELD: <column> <reason>` per held entry; `LIMIT:` red under the same rule. Example: `api  running  ready_dev:2 in_dev:1 blocked:1 merged:4  LIMIT: qa-1 until 14:05Z`.
4. **`team.py board`** (every `board` and `ticket` subcommand takes `--workspace PATH`, default `WS`): `team.py board` → `cli("board", "show", …)` and prints `render_board`; `team.py board run`, `team.py board pause [--reason TEXT]`, `team.py board resume (--agent NAME | --all)` wrap `agent-studio board run|pause|resume`. `--agent NAME` is matched case-insensitively against `board.show.agents[].name` and sent as `--agent <agentId>`; an unknown name exits with `Unknown agent NAME. Agents: <names>` without calling `board resume`. Each prints a one-line result (`board running`, `board paused (<reason>)`, `resumed: <names>` / `resumed: none`). `team.py boards` → `cli("board", "list")` and prints `render_boards`.
5. **`team.py ticket`** (wraps `agent-studio ticket …`):
   - `ticket add STORY [--depends T-001 ...] [--no-deps] [--priority N]` → `ticket create --story STORY`; `ticket add --brief PATH --out DIR` → `ticket create --kind feature --brief PATH --out DIR` (STORY and `--brief` are mutually exclusive; exactly one is required, else exit code 2). It prints the new key, then `depends on: <keys or none>`, then for a story `parsed: <ids or none>`, and `unresolved: <ids>` when `parsed.unresolved` is non-empty (from the S02 receipt). With `--no-deps` or an explicit `--depends`, the `depends on:` line shows what was sent and the `parsed:` line is replaced by `dependencies overridden`.
   - `ticket move KEY STATUS [--reason TEXT]` → `ticket move KEY --to STATUS`; prints `<key>: <from> -> <to>`.
   - `ticket show KEY` prints `<key> <kind> <status>  <title>`, the story/brief path, `depends on:`, `dependents:`, `blocked: <reason>` when blocked, and the last 5 ticket events (`<at> <name> <from>-><to>`).
   - `ticket depend KEY --on T-… [--on …]` → `ticket depend KEY --on …`; prints the ticket's dependencies after the change.
6. **`team.py status`**: after the existing lines, when a `board.list` entry exists for `WS` (compared after `os.path.realpath`) and its status is `running` or `paused`, print that entry's `render_boards` line prefixed with `board: `.
7. Update the `team.py` docstring (command list) and the `cli.py` usage text for the new commands.

## Done when

- [x] `board.show` on a fixture board (one ticket per status, built by `ticket.create` and then direct SQL updates of `status`, rounds, `blocked_reason`, `assignee_agent_id`, as in the S13 integration tests; one dependency open; one agent `limit_reached` with a known `limitResetAt`; 12 `merged` tickets so the terminal cap shows) matches the golden `tests/fixtures/board/board_show.json` after normalising `dbId`, `cursor`, `workspace`, `runId` and agent IDs. The CLI and `serve` output are identical, and the event count is unchanged by the call. Test: `tests/integration/test_p03_s15_board_show.py`.
- [x] `board.show` with a dirty main checkout and a waiting `refine` ticket and a waiting `ready_merge` ticket returns `held` entries for `refine` and `merge` with `MAIN_CHECKOUT_DIRTY`; with an invalid `board.json` (no frozen config) it returns `held: []` instead of failing. Test: same integration file.
- [x] `render_board` of `tests/fixtures/board/board_show.json` matches `tests/fixtures/board/board_show.txt` with `color=False`, and with `color=True` only the `LIMIT:` line carries the red escape codes. Test: `tests/unit/test_p03_s15_team_py_board.py`.
- [x] `team.py board resume --agent QA-1` sends `board resume --workspace WS --agent <id of qa-1>`; an unknown name exits without calling `board resume`; `board run` / `board pause --reason x` / `resume --all` send the matching argv (`cli` mocked). Test: the unit file above.
- [x] `team.py ticket add STORY` on a receipt with resolved and unresolved IDs prints the key, the resolved keys and the unresolved IDs; `--no-deps` sends `--no-deps` and prints `depends on: none` and `dependencies overridden`; `--brief`/`--out` sends `--kind feature`; STORY with `--brief` exits 2. `ticket move`, `ticket show` and `ticket depend` send the right argv and print the lines in step 5 (`cli` mocked). Test: `tests/unit/test_p03_s15_team_py_ticket.py`.
- [x] `board.list` with two workspaces (one running, one paused with a `limit_reached` agent) and a third whose directory was deleted: three entries in path order with the right `status`, `counts`, `agents` and `limits`, the deleted one `unavailable` with `held: []`, and no write (event count unchanged). The CLI and `serve` output are identical. Test: `tests/integration/test_p03_s15_board_list.py`.
- [x] `render_boards` of `tests/fixtures/board/board_list.json` matches `tests/fixtures/board/board_list.txt`; `team.py status` prints the `board: ` line only when this workspace's board is running or paused (`cli` mocked). Test: `tests/unit/test_p03_s15_team_py_board.py`.
- [x] A limited agent appears in `board.show.agents` with `availability: "limit_reached"` and its `limitResetAt`, and in the `LIMIT:` line of both renderers (covered by the goldens above).
- [x] `board.merge_ready` still holds and merges as before after the `board.merge_hold` extraction: `tests/integration/test_p03_s07_merge.py` passes unchanged.
- [x] All existing tests stay green (`python3 -m unittest discover -s tests/unit`).

## Evidence

Final review 2026-10-24 (team lead).

- Unit suite: `python3 -m unittest discover -s tests/unit` → `Ran 522 tests … OK (skipped=3)`.
- Integration: `tests.integration.test_p03_s15_board_show` (2 tests, OK) and `tests.integration.test_p03_s15_board_list` (1 test, OK).
- Implemented:
  - `backend/agent_studio/queries.py`: `board_show` and `board_list`, which share the per-workspace helpers `_board_row`, `_board_team`, `_board_agents` and `_board_held`. Holds are computed live, and `held` falls back to `[]` when `board.json` is invalid or the directory is missing.
  - `backend/agent_studio/board.py`: `merge_hold` taken out of `merge_ready` word for word, so the view and the merger give the same reason.
  - `backend/agent_studio/dispatch.py`: `board.show` and `board.list` registered as direct reads. The workspace goes through `ops.canonical_workspace`.
  - `backend/agent_studio/cli.py`: `board show --workspace` and `board list`, plus the usage text.
  - `scripts/team/team.py`: pure renderers `render_board` and `render_boards`; `team.py board [run|pause|resume]`, `team.py boards` and `team.py ticket add|move|show|depend`; the `board:` line in `team.py status`; the updated docstring.
- Tests and fixtures: `tests/board_fixture.py`; `tests/fixtures/board/board_show.{json,txt}` and `board_list.{json,txt}`; `tests/unit/test_p03_s15_queries.py`, `test_p03_s15_team_py_board.py` and `test_p03_s15_team_py_ticket.py`; `tests/integration/test_p03_s15_board_show.py` and `test_p03_s15_board_list.py`.
- Notes:
  - The integration golden comparison leaves out the `merge` hold. With the live coordinator running, a scheduler task may make it `MAIN_CHECKOUT_BUSY`. The unit golden checks the full `held` list, and a separate test covers the merge hold under a dirty checkout.
  - `merge_hold` is a verbatim move of the old inline code. `test_p03_s07_merge.py` is unchanged but was not in this run's integration set.
