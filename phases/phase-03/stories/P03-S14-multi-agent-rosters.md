# P03-S14 — Multi-agent rosters: several agents per role, binding by availability

Status: To Do
Depends on: P03-S13
Architecture: [P03 design contract](../README.md#design-contract), §C (bindings), §G; [P01 §D](../../phase-01/README.md#d-engine-semantics) (binding, `ROLE_AMBIGUOUS`)

## Goal

A team can have two (or more) agents with the same role, for example two developers. The board binds each column run to the agent that claimed it, so P01's `ROLE_AMBIGUOUS` never stops a board run. A plain `workflow.start` without `--bind` keeps that rule. Each agent holds at most one active assignment, so two developers work two tickets at once in two worktrees.

## Implement in this order

1. Check that `team.start` accepts duplicate roles with distinct `name`s (refusing duplicate names with `TEAM_CONFIG_INVALID`). Fix it if not.
2. `board.start_column` always passes explicit `bindings`. Add a test that the P01 path without bindings still returns `ROLE_AMBIGUOUS` for a duplicated role.
3. Scheduler: an agent with any active assignment (any task, not only board runs) is not idle. `pick` is called per agent in a stable order, and a ticket claimed in this tick is never offered to a second agent (it has already left `ready_*` in the same transaction).
4. Example `team.json` with `dev-1` and `dev-2` in `phases/phase-03/examples/team-two-devs.json` (fixture for S16/S17).

## Done when

- [ ] Fake team with 2 developers, 1 QA and 1 lead, and three independent `ready_dev` tickets with `maxParallelDev: 2`: two tickets are `in_dev` at once on different agents and worktrees, and the third waits until one leaves `in_dev`. Test: `tests/integration/test_p03_s14_two_devs.py`.
- [ ] Neither developer ever has two active assignments (asserted across the run from `assignment.created` events).
- [ ] `workflow start --definition story-delivery` without `--bind` on that team → `ROLE_AMBIGUOUS`. With `--bind Developer=<dev-2>` it starts.
- [ ] Duplicate agent names → `TEAM_CONFIG_INVALID` before any pane exists.
- [ ] All existing tests stay green.

## Evidence

(filled in when the story is done)
