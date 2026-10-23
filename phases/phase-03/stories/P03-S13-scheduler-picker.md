# P03-S13 — Scheduler: role-based picker, priorities, dependencies, `board.run` / `board.pause`

Status: To Do
Depends on: P03-S07, P03-S08, P03-S10, P03-S11, P03-S12
Architecture: [P03 design contract](../README.md#design-contract), §D (main-checkout serialization), §G (scheduler)

## Goal

The board runs on its own. Once the operator runs `board.run`, each coordinator tick offers every idle agent the highest-priority eligible ticket for its role and calls `board.start_column` (S05) for it. Eligibility follows the §G table: dependencies merged, `maxParallelDev` with the blocker slot, one main-checkout run at a time, and lead starvation guard. `board.pause` stops new claims and never interrupts running work. The board is off by default.

## Implement in this order

1. `board_state` (S01's v7 table, one row per workspace): `running` | `paused`, `reason`, frozen config JSON, `review_streak`. `board.run {workspace}` validates `board.json` (S05) against the running team, freezes it, and writes `board.started`. `board.pause {workspace, reason?}` writes `board.paused`.
2. `board.pick(tx, workspace, agent, config) -> ticket | None`, a pure query that applies §G:
   - columns for the agent's role in config order (review > triage > refine; unpack separately);
   - priority, then `created_at`;
   - develop: `deps_merged`, the `in_dev` count, a blocker bug may exceed the cap by one;
   - main-checkout columns: none when the lock is held, the merge row is set or the tree is dirty, writing `board.held`;
   - starvation guard: after two consecutive reviews by this agent, a waiting triage/refine ticket goes first (count kept in `board_state.review_streak`, per agent as a JSON map).
3. `board.tick(store, ctx)` in the coordinator loop after `apply_outcomes` and `merge_ready`. When running, for each `idle` agent of the team on that workspace, in agent order: `pick` → `board.claim_and_start` (S12; claim and run start in two transactions). A start error is already released by `claim_and_start` (`start_failed`); the tick writes `board.held` with the code and moves on (no retry in the same tick).
4. CLI `agent-studio board run|pause`.

## Done when

- [ ] `pick` unit tests cover every §G row:
  - review before triage before refine;
  - blocker bug before `changes_requested` before `ready_dev` bug (major before minor) before story;
  - a dependency not merged skips the ticket;
  - the `maxParallelDev` cap, with a blocker taking the extra slot and a second blocker not;
  - a second main-checkout column is refused while one runs;
  - the starvation guard after two reviews;
  - oldest first within a priority.
  Test: `tests/unit/test_p03_s13_pick.py`.
- [ ] Integration on the fake with a lead, a developer and QA: three story tickets (T-003 depends on T-001) go from `refine` to `merged` after `board.run`, with no operator command. T-003 is never `in_dev` before T-001 is `merged`. Test: `tests/integration/test_p03_s13_board_run.py`.
- [ ] With the board not started, nothing is claimed. `board.pause` mid-run: the running column finishes and is applied, nothing new is claimed, and `board.run` continues.
- [ ] A limited agent (S11) is never picked, while the other roles keep moving.
- [ ] No busy loop: with nothing eligible, a tick does no writes (asserted on the event count over 20 ticks).
- [ ] All existing tests stay green, and the guard test covers the scheduler module.

## Evidence

(filled in when the story is done)
