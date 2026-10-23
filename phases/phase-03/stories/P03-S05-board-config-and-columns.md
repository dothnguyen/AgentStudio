# P03-S05 — Board config, column definitions, run seeds and manual `ticket.start`

Status: To Do
Depends on: P03-S02, P03-S04
Architecture: [P03 design contract](../README.md#design-contract), §A (`board.json`), §C (columns, seeds), §G (claim)

## Goal

A ticket can be pushed into its next column by hand. `ticket.start {key, agentId}` claims it (`ready_x` → `in_x`), prepares the workspace (a worktree on the first develop), and starts the column's P01 definition bound to that agent with the board-composed task text and seeds. This story only *starts* runs. Applying their results is S06, so here a finished run leaves the ticket in its `in_*` column.

## Implement in this order

1. `board_config.py`: loads and validates `.agent-studio/board.json` with the §A defaults (`BOARD_CONFIG_INVALID` with `{path, message}` errors; unknown keys are errors). It checks that each column's `role` exists in the team roster when a team is given.
2. Built-in definitions in `backend/agent_studio/workflows/`, JSON, with prompts beside them:
   - `board-refine`: one TeamLead verdict stage, `workspace_write`;
   - `board-develop`: `develop` work stage `workspace_write`, then `tests` validation, where `fail` → `develop` and `maxVisits` is 3;
   - `board-test`: QA verdict stage, `read_only`, with `{{diff}}`;
   - `board-review`: TeamLead verdict stage, `read_only`, with `{{diff}}` and the instruction to give a ```` ```commit ```` block on `pass`.
   The develop prompt tells the developer to fill the story's Evidence and tick the items it proves (Q3), never to run history-changing git, and to treat `{{findings}}` as the list to fix. Built-in names are reserved (P01 §A).
3. `workflow.start` gets the internal `seed {findings?, diff?}` (P01 `prompts.py` uses a seed until the run produces its own). It is accepted only from coordinator-internal callers, never from the command inbox.
4. `board.start_column(tx, ticket, agent, config, ctx)`:
   - checks that the ticket is in a pickable column for the agent's role (§C) and, for develop, that `deps_merged` holds;
   - claims it (the §G transaction);
   - on the first develop, calls `worktrees.create` and records branch, path and base commit with `tickets.record_worktree` (S04);
   - composes `{{task}}` and the seed;
   - calls `workflow.start` with `workspace`, `bindings {role: agentId}`, `definition` and `seed`, then records `run_id` and writes `ticket.run_started`.
   A start error (for example `WORKSPACE_DIRTY`) rolls the claim back and is returned.
5. `ticket.start` command + CLI `agent-studio ticket start KEY --agent ID`.

## Done when

- [ ] Missing `board.json` → defaults. A bad value, an unknown key, and a column role not in the roster → `BOARD_CONFIG_INVALID` with the path. Test: `tests/unit/test_p03_s05_board_config.py`.
- [ ] All four built-ins load with `workflow.validate` and no errors, and `read_only` / `workspace_write` match §C.
- [ ] Fake team: `ticket start T-001 --agent <lead>` on a `refine` ticket gives `refining` and a run on the main checkout with the board definition. On a `ready_dev` ticket with the developer, it gives `in_dev`, a worktree on `ticket/T-001-<slug>`, and a run in it whose prompt contains the ticket's findings seed. On a `ready_test` ticket, the QA prompt contains the branch diff seed.
- [ ] Refused: a wrong role for the column, a ticket whose dependency is not `merged` (developer), a ticket already `in_*`, and a seed passed through the command inbox (`BAD_REQUEST`). The ticket stays unchanged after each.
- [ ] A run start failure (dirty main checkout for refine) leaves the ticket in `refine` with no `run_id` and returns `WORKSPACE_DIRTY`.
- [ ] Tests: `tests/integration/test_p03_s05_ticket_start.py`. All existing tests stay green.

## Evidence

(filled in when the story is done)
