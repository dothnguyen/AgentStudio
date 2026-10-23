# P03-S13 — Scheduler: role-based picker, priorities, dependencies, `board.run` / `board.pause`

Status: Done (2026-10-23)
Depends on: P03-S07, P03-S08, P03-S10, P03-S11, P03-S12
Architecture: [P03 design contract](../README.md#design-contract), §D (main-checkout serialization), §G (scheduler), §I (commands), §J (events)

## Goal

The board runs on its own. Once the operator runs `board.run`, each coordinator tick offers every free agent the first eligible ticket for its role and starts it with `board.claim_and_start` (S12: claim and run start in two transactions). Eligibility follows the §G table: dependencies merged, `maxParallelDev` with the blocker slot, one main-checkout run at a time, and the lead starvation guard. `board.pause` stops new claims and never interrupts running work. The board is off by default (no `board_state` row, or `paused`).

## Terms

- **Free agent**: an agent of the running team on the workspace with availability `idle`, **no** active assignment (`tasks.ACTIVE`, any task kind), and **no** ticket in a working status (`schema.TICKET_WORKING`) with `assignee_agent_id` = the agent. Availability alone is not enough: an agent stays `idle` until its runner reports, and between two stages of its own run (develop → validation).
- **Main-checkout column**: a column with `schema.BOARD_COLUMNS[c]["workspace"] == "main"`.
- **Main checkout busy**: any ticket of the workspace in a main-checkout working status (this covers a pending claim), or `tasks._mutating_in_workspace(tx, workspace)`, or the `board_locks` `merge` row.
- **Hold reasons** (§J), checked in this order: `MAIN_CHECKOUT_BUSY`, `MAIN_CHECKOUT_DIRTY` (`worktrees.is_clean` false), `MAIN_CHECKOUT_WRONG_BRANCH` (HEAD is not `baseBranch`; same check as `board.merge_ready`).

## Implement in this order

1. **Data in `schema.py`** (board code names no column, status or role; the guard test forbids `develop`):
   - `BOARD_PICK_ORDER = ("review", "triage", "refine", "unpack", "develop", "test")`: the order in which an agent's columns are tried (only the columns whose frozen-config `role` equals the agent's role).
   - `BOARD_PICK_RULES = {"develop": {"cap": "maxParallelDev", "depsMerged": True, "rework": ("changes_requested", "fail_test")}, "review": {"streak": 2}}`.
2. **New module `backend/agent_studio/board_scheduler.py`** with:
   - `holds(tx, workspace, config) -> [{column, reason}]`: read-only; one entry per main-checkout column that has a waiting ticket (in its queue) while a hold reason applies. S15 reuses it for `board.show.held`.
   - `pick(tx, workspace, agent, config) -> (ticket | None, held)`: read-only (database reads plus `git status` / `symbolic-ref` on the main checkout; no writes). For each of the agent's columns in `BOARD_PICK_ORDER`, candidates are the column's queue tickets of that workspace, sorted by rank, then `priority`, then `created_at`, then `key`:
     - rank for a `rework` column: 0 = bug with `severity = 'blocker'`, 1 = status in `rework`, 2 = other bug, 3 = story (so blocker bugs > `changes_requested`/`fail_test` > `ready_dev` bugs, which `priority` orders by severity > `ready_dev` stories); every other column has rank 0 (triage tickets have no severity yet, so `priority` orders them).
     - `depsMerged`: skip a ticket for which `tickets.deps_merged` is false.
     - `cap`: count tickets of the workspace in the column's working status; a ticket is eligible when count < `config[cap]`, or count < `config[cap] + 1` when it is a blocker bug.
     - main-checkout column: no candidate while a hold reason applies; the column and reason go into `held` (only if the column has a waiting ticket).
     - starvation guard (`streak: 2`): if this agent's last two `ticket.claimed` ticket events (by `ticket_events.id`, `payload_json.agentId` = agent) both have `to_status` = the streak column's working status, and a main-checkout column of the same role has an eligible ticket, that ticket is returned before the streak column. Derived from events, so `pick` writes nothing; `board_state.review_streak` stays unused (no migration).
     - The first eligible ticket wins; `None` when there is none.
   - `tick(store, ctx)`: **several boards run in parallel** - each workspace is one board with its own `board_state`, team, agents, frozen config, `maxParallelDev`, main-checkout lock and held reasons; nothing is shared between boards except the coordinator loop. For each `board_state` row with `status = 'running'` whose workspace has a running team (else skip the workspace), handled independently (an exception while serving one board is logged with its workspace and does not stop the others, and `board.pause` on one board never affects another): for each free agent in `ordinal` order, in its own transaction call `pick` with the frozen config (`board_config.current`); write the `held` entries (below); if a ticket came back, call `board.claim_and_start(store, workspace, key, agent_id, ctx)` outside that transaction. Each agent gets at most one start per tick.
     - `board.held {column, reason}` is a team event (`tx.note("team", team_id, …)`, like `board.resumed`), written only when the latest `board.held` event of that team for that column has a different reason (once per reason change).
     - A start error (`AsError` from `claim_and_start`, whose claim is already released as `start_failed`): the tick blocks the ticket with `tickets.block(…, "coordinator", "START_FAILED:<code>", <queue>)` so it is not claimed again every tick, and moves on to the next agent. The operator fixes the cause and runs `ticket.unblock`. Any other exception is logged by the loop as today.
3. **Loop**: in `coordinator.py`, call `board_scheduler.tick(store, ctx)` right after `board.merge_ready(store, ctx)`.
4. **Commands** (`dispatch.py` validators + `coordinator.py` handlers, mutating, through the inbox like `board.resume`):
   - `board.run {workspace}`: needs a running team on the workspace (`TEAM_NOT_RUNNING`); `board_config.load(workspace, roles of that team)` (`BOARD_CONFIG_INVALID` leaves `board_state` unchanged); upsert `board_state` = `running`, `reason` NULL, `config_json` = the loaded config; team event `board.started {unstaffed}`. Running it again re-freezes the config. Receipt `{board: {workspace, status, reason, unstaffed}}`.
   - `board.pause {workspace, reason?}` (`reason` a string of 1–200 chars, else `BAD_REQUEST`): needs a running team (`TEAM_NOT_RUNNING`); upsert `status = 'paused'`, `reason`, keeping `config_json` (NULL when the board never ran); team event `board.paused {reason}`. Receipt `{board: {workspace, status, reason}}`. Running runs are not touched; their outcomes are still applied and merged.
5. **CLI**: `agent-studio board run|pause|resume`: extend the existing `board` subparser (`action` choices, `--reason` for `pause`) and the usage text.
6. Add `board_scheduler.py` to `test_board_modules_are_clean` in `tests/unit/test_p01_s05_guard.py`.

## Done when

- [x] `pick` unit tests cover every §G row, each on a store fixture with tickets inserted directly:
  - review before triage before refine (one lead agent, one ticket in each queue);
  - develop order: blocker bug before `changes_requested` before `ready_dev` bug (major before minor) before story;
  - a dependency not merged skips the ticket (and it is picked once the dependency is `merged`);
  - the `maxParallelDev` cap (2): with two `in_dev`, a story is refused, a blocker bug is picked, and with three `in_dev` (one a blocker) a second blocker is refused;
  - a main-checkout column is refused while another main-checkout ticket is working, while a `merge` lock row exists, and while the main checkout is dirty, each returning the right `held` reason; the review column of the same agent is still picked;
  - the starvation guard: after two `ticket.claimed` into `in_review` by this agent, a waiting `refine` ticket beats a waiting `ready_review` ticket; after one, review still wins;
  - oldest `created_at` first within a priority, and lower `priority` first;
  - `pick` writes nothing (event count unchanged).
  Test: `tests/unit/test_p03_s13_pick.py`.
- [x] Tick: with no `board_state` row, and with the board `paused`, a tick claims nothing; an agent with an active assignment or a working ticket assigned to it is not offered a ticket; a `limit_reached` developer is never picked while the QA and the lead still get tickets; a start error leaves the ticket `blocked` / `START_FAILED:<code>` and the next agent is still served; `board.held` is written once for two ticks with the same reason and again when the reason changes. Test: `tests/unit/test_p03_s13_tick.py`.
- [x] No busy loop: with nothing eligible (empty queues; and separately a develop ticket waiting on an unmerged dependency plus a held refine ticket after its first `board.held`), 20 ticks add no event (asserted on the `events` count). Test: `tests/unit/test_p03_s13_tick.py`.
- [x] Two boards in parallel: workspaces A and B, each with its own running team (fake provider) and `board.run`. Tickets of both boards reach `merged` with no other operator command; keys overlap (`T-001` in each) without interference; `board.pause --workspace A` stops new claims on A only while B keeps claiming; a ticket start error or a broken `board.json` on A (`BOARD_CONFIG_INVALID` at `board.run`) does not stop B; the main-checkout lock and `maxParallelDev` of A never hold back B. Test: `tests/unit/test_p03_s13_tick.py` (two stores' worth of tickets in one database) and `tests/integration/test_p03_s13_board_run.py`.
- [x] Commands: `board.run` freezes the config and writes `board.started`; an invalid `board.json` → `BOARD_CONFIG_INVALID` and no row change; no running team → `TEAM_NOT_RUNNING`; `board.pause` with and without `reason` writes `board.paused` and keeps `config_json`; `board.pause` with a 201-char reason → `BAD_REQUEST`. CLI `board run` / `board pause --reason x` return the same JSON as the command. Test: `tests/unit/test_p03_s13_commands.py`.
- [x] Integration on the fake with a lead, a developer and QA: three story tickets (T-003 depends on T-001) go from `refine` to `merged` after `board.run`, with no other operator command. From `ticket_events`, T-003's first `in_dev` comes after T-001's `ticket.merged`, and no two main-checkout working statuses ever overlap. Test: `tests/integration/test_p03_s13_board_run.py`.
- [x] Pause mid-run, same fake team: `board.pause` while a ticket is `in_dev`; that run finishes and its outcome is applied (`ready_test`), nothing new is claimed over the following ticks, and after `board.run` the tickets reach `merged`. Test: `tests/integration/test_p03_s13_board_run.py`.
- [x] `board_scheduler.py` is in the guard test, and all existing tests stay green (`python3 -m unittest discover -s tests/unit -t .`, and `-s tests/integration` for the integration files above).

## Evidence

- `python3 scripts/validate.py --unit` (2026-10-23, final review): PASS, 486 tests, 3 skipped.
- `python3 scripts/validate.py --touched` (2026-10-23, development): unit tests PASS (484 tests, 3 skipped); integration `tests.integration.test_p03_s13_board_run` PASS (6 tests).
- QA: passed with no findings.
- Added: `backend/agent_studio/board_scheduler.py` (`holds`, `pick`, `tick`), `tests/unit/test_p03_s13_pick.py`, `tests/unit/test_p03_s13_tick.py`, `tests/unit/test_p03_s13_commands.py`, `tests/integration/test_p03_s13_board_run.py`.
- Changed: `schema.py` (`BOARD_PICK_ORDER`, `BOARD_PICK_RULES`), `board.py` (`claim_and_start(..., config=None)` so the tick passes the frozen config), `coordinator.py` (`board.run` / `board.pause` handlers, `board_scheduler.tick` after `merge_ready`), `dispatch.py` (validators), `cli.py` (`board run|pause [--reason]`), `tests/unit/test_p01_s05_guard.py` (guard covers `board_scheduler.py`); design contract §B/§G/§I/§J in `phases/phase-03/README.md`, and S14/S15 aligned with it.
- Pick order: `test_lead_tries_review_before_triage_before_refine` also proves triage beats refine with review unavailable; `test_review_starvation_and_priority_oldest` proves oldest `created_at` within equal priority.
- Two boards: `test_two_boards_run_pause_and_fail_independently` (two workspaces, overlapping `T-001`, pause A while B merges, broken `board.json` on A gives `BOARD_CONFIG_INVALID` while B still merges, A merges after recovery); unit side in `tests/unit/test_p03_s13_tick.py` (`TwoBoardTickTests`).
