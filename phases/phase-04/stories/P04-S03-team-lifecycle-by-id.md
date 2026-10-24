# P04-S03 — Team lifecycle by id

Status: To Do
Depends on: P04-S02 (team definitions)
Architecture: [P04 design contract](../README.md#design-contract), §C

## Goal
`team start`, `stop` and `status` act on a team definition by id. The runtime team and agents are keyed by the definition's ids, so panes, logs and commands say `Ryan`, and several teams can run in one workspace.

## Implement in this order
1. `team start [--team ID]` reads the definition fresh, validates it (`TEAM_CONFIG_INVALID` on failure), and starts it through the existing start path. The `team.json` fallback and `team start --workspace` with `--agent` keep working.
2. Runtime keys: store the definition team id and member ids on the runtime team/agent rows (a new additive migration only if a column is missing; record the version in Evidence). Pane titles and log names use member names.
3. Lift the "one running team per workspace" check to "one running team per team id"; keep the per-workspace/worktree write lock from P00 (Q8).
4. `team stop [--team ID]` stops only that team; `team status [--team ID]` shows members, state and current assignment, and never calls board code.
5. `--member` resolves a name or id for later stories; reuse `teamdefs.find_member` from P04-S02 and test the runtime lookup.

## Done when
- [ ] Two teams run in one workspace and each `stop` affects only its own team. Test: integration with the fake provider.
- [ ] Panes, agent records and `status` use member names; the old UUID/ordinal addressing still works for `task direct`. Test: integration.
- [ ] Editing the file while running changes nothing until the next `start`. Test: unit/integration.
- [ ] `team.json` start and the existing suites are unaffected. Test: existing suites green.

## Evidence
(filled in when the story is done)
