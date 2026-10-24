# P04-S10 — Scheduler and team run-board

Status: To Do
Depends on: P04-S08 (phases), P04-S09 (rules, outcome applier)
Architecture: [P04 design contract](../README.md#design-contract), §E

## Goal
`team run-board` binds a team to the board and starts the scheduler; `stop-board` stops claiming while running work finishes. The scheduler claims tickets by rule, phase, dependencies, caps and free members, with optional worktree isolation and a coordinator-only `merge` action.

## Implement in this order
1. Binding: one team runs the board at a time (`BOARD_ALREADY_RUNNING`). `run-board --team T` runs `rules check` first; `stop-board` stops claiming and leaves running work alone.
2. Tick: for each rule in priority order, pick tickets in that status that are `ticket_in_scope`, have dependencies in a `done` status when `requiresDeps`, are under the rule's `cap`, and match a free member of the rule's role. Claim with a lease, set the `during` status if configured, and start the rule's workflow.
3. Free-member rule: members running `ask`/`run-workflow` or another ticket are never claimed; `ask` to a member holding a ticket returns `AGENT_BUSY`.
4. Workspace modes: `main` (default), `none`, and `worktree` (one branch and worktree per ticket using the retained `worktrees.py`/`gitws.py`). `task.direct` / `workflow.start` then accept a worktree again only when it is registered to a live ticket of the generic board (restoring the check S06 removed, design contract §F); every other path stays `WORKTREE_NOT_REGISTERED`.
5. `merge` action: the coordinator, with no agent, merges the ticket branch into the base branch under a main-checkout lock; a conflict sends the ticket to `onFail` with findings, never leaves the checkout dirty.
6. Finished runs go through the S09 applier.

## Done when
- [ ] The phase filter, `requiresDeps`, and per-rule `cap` are respected. Test: unit tick tests.
- [ ] A ticket runs through three rules to `done` on the fake provider with no operator command beyond `run-board`. Test: integration.
- [ ] A busy member is never claimed and `stop-board` stops new claims only. Test: integration.
- [ ] Worktree mode isolates two tickets, and `merge` lands both, including a conflict that returns to `onFail`. Test: integration on a throwaway repo.

## Evidence
(filled in when the story is done)
