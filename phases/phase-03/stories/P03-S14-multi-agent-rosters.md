# P03-S14 — Multi-agent rosters: several agents per role, binding by availability

Status: Done (2026-10-23)
Depends on: P03-S13
Architecture: [P03 design contract](../README.md#design-contract), §C (bindings), §G, §I (`TEAM_CONFIG_INVALID`); [P01 §D](../../phase-01/README.md#d-engine-semantics) (binding, `ROLE_AMBIGUOUS`)

## Goal

A team can have two (or more) agents with the same role, for example two developers. The board binds each column run to the agent that claimed it, so P01's `ROLE_AMBIGUOUS` never stops a board run. A plain `workflow.start` without `--bind` keeps that rule. Each agent holds at most one active assignment, so two developers work two tickets at once in two worktrees.

## Agent names (contract for this story)

- An agent's **name** is its roster `displayName`; when that is absent, the roster entry's `name` key (the key every `.agent-studio/team.json` uses today, and which `teams.validate_roster` currently ignores); when both are absent, the existing default `<role>-<n>`. The result is stored as `agents.display_name`, as today. Same 64-character limit.
- Names are unique in a team, compared after `strip()` and case-insensitively (`team.py` matches agents by name case-insensitively). A duplicate → `TEAM_CONFIG_INVALID` with `data: {name, indexes: [i, j]}` (the two roster indexes), raised by `teams.validate_roster`, so it happens before providers are probed and before any tmux session or pane exists. This applies to a `roster` argument and to a roster read from `team.json` alike.
- Duplicate **roles** stay allowed. Duplicate `agentId` keeps its existing `BAD_REQUEST`.

## Implement in this order

1. `teams.validate_roster`: apply the name rule above (`displayName` → `name` → default) and refuse duplicate names with `TEAM_CONFIG_INVALID` (new code constant in `teams.py`, listed in §I). Confirm duplicate roles with distinct names are accepted.
2. Bindings. `board.start_claimed` already passes `bindings {role: agent["id"]}` to `workflow.start` (`board.py`); keep it that way and prove it: with two Developers in the team, `ticket.start` on a `ready_dev` ticket for the second developer starts a run whose develop stage is bound to that developer (no `ROLE_AMBIGUOUS`). Also prove the P01 path still refuses: `workflow.bind_roles` for the workspace definition `story-delivery` (`.agent-studio/workflows/story-delivery.yaml`, roles TeamLead, Developer, QA) on a team with two Developers and no override → `ROLE_AMBIGUOUS` with `data.agentIds` = both developers; with the override `{Developer: <dev-2 id>}` it binds TeamLead, dev-2 and QA.
3. Scheduler: S13's "free agent" rule (`board_scheduler._free`: availability `idle`, no active assignment, no working ticket assigned) already applies; prove it with two agents of one role. `_serve` visits agents in `ordinal` order, and a ticket claimed for one agent in this tick is never offered to a second agent (it has already left `ready_*` when the next agent's `pick` runs). No scheduler code change is expected; if a test shows one is needed, keep it inside `board_scheduler.py`.
4. Example roster `phases/phase-03/examples/team-two-devs.json` (fixture for S16/S17): the `team.json` format (`{"version": 1, "agents": [...]}`) with a TeamLead `lead`, two Developers `dev-1` and `dev-2`, and a QA `qa`, using the same providers and models as this project's `.agent-studio/team.json` (both developers on the project's Developer provider). No ProductOwner (S17 adds story tickets directly).

## Done when

- [x] Names: a roster with two Developers named `dev-1` / `dev-2` is accepted and stored with those `display_name`s; a `team.json`-style entry with only `name` gets that name; two entries named `dev` and ` DEV ` → `TEAM_CONFIG_INVALID` with `indexes [i, j]`; `team.start` with that roster fails before any provider probe or tmux call (both patched and asserted not called) and writes no `teams` / `agents` row. Test: `tests/unit/test_p03_s14_rosters.py`.
- [x] `phases/phase-03/examples/team-two-devs.json` is valid JSON with `version: 1`, and `teams.validate_roster({"roster": data["agents"]}, allow_fake=False)` accepts it and yields two Developers with distinct names. Test: `tests/unit/test_p03_s14_rosters.py`.
- [x] P01 rule kept: `bind_roles` for `story-delivery` on a team with two Developers and no override → `ROLE_AMBIGUOUS` (`data.agentIds` lists both); with `{Developer: <dev-2>}` it binds dev-2. Board path: `ticket.start` with the second developer on that team starts the develop run with its stage bound to the second developer. Test: `tests/unit/test_p03_s14_rosters.py`.
- [x] Scheduler with two developers (unit, same style as `tests/unit/test_p03_s13_tick.py`): two `ready_dev` tickets and two free developers → one tick claims one ticket per developer, each ticket claimed exactly once (one `ticket.claimed` per ticket); a developer with an active assignment is skipped while the other one claims. Test: `tests/unit/test_p03_s14_rosters.py`.
- [x] Integration on the fake with 2 developers, 1 QA and 1 lead, and three independent `ready_dev` tickets with `maxParallelDev: 2`, after `board.run`: two tickets are `in_dev` at once on different `assignee_agent_id`s and different `worktree_path`s, the third is not claimed into `in_dev` until one of them leaves `in_dev`, and all three reach `merged`. Test: `tests/integration/test_p03_s14_two_devs.py`.
- [x] In that integration run, neither developer ever has two active assignments: polled during the run, no agent has more than one `assignments` row in a `tasks.ACTIVE` status; and from `ticket_events`, each developer's `in_dev` intervals (its `ticket.claimed` into `in_dev` → that ticket's next status change) never overlap. Test: `tests/integration/test_p03_s14_two_devs.py`.
- [x] All existing tests stay green (`python3 -m unittest discover -s tests/unit -t .`, and `-s tests/integration` for the integration file above).

## Evidence

- Implemented: `teams.validate_roster` takes the agent name from `displayName`, then the `team.json` `name` key, then `<role>-<n>`, and refuses duplicate names (after strip, case-insensitive) with the new `TEAM_CONFIG_INVALID` (`data {name, indexes}`). This runs before provider probes, tmux and any row write; a roster read from `team.json` goes through the same check. §I lists the code and §G describes several agents per role. No change to the scheduler or bindings code was needed: `board.start_claimed` already binds the claiming agent.
- Fixture: `phases/phase-03/examples/team-two-devs.json` (lead, dev-1, dev-2, qa; providers and models match `.agent-studio/team.json`).
- Tests: `tests/unit/test_p03_s14_rosters.py` covers name rules, duplicates, the team.start guard, the example roster, `bind_roles` with and without an override, the board start bound to dev-2, and the two-developer scheduler tick. `tests/integration/test_p03_s14_two_devs.py` runs on the fake with 3 tickets, `maxParallelDev: 2` and `board.run`. It checks that two tickets are in_dev at once on different agents and worktrees, the third waits, all three merge, no developer has two active assignments, and no developer's in_dev intervals overlap.
- Validation: `python3 -m unittest discover -s tests/unit -t .` passed with 496 tests OK (skipped=3). Integration `tests.integration.test_p03_s14_two_devs` passed: 1 test OK in 26.9s.
- Notes: the board-path unit test calls `board.start_claimed` directly (the half of `ticket.start` that does the binding) and does not call `ticket.start` end to end. The integration test covers the full scheduler path.
