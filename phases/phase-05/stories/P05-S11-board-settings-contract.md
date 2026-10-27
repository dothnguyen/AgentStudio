# P05-S11 — Board settings and control contracts

Status: To Do
Depends on: P05-S09
Architecture: [Teams management architecture](../README.md#architecture-and-gaps)

## Goal
Expose validated workspace board settings for isolated worktrees, merge-on-success action rules, ticket-status routing, and live run controls. The visual reference `design/teams-screen-v1.png` supplies layout intent; status labels and workflow names come from workspace configuration.

## Implement in this order
1. Add a read projection for board statuses, rules, roles, workflows, worktree mode, action rules, and current runner/team state; reuse `board.show`, rule validation, and existing run/stop commands.
2. Add atomic validated update commands for role descriptions and board configuration; preserve unknown fields, reject invalid graph references, and require explicit TeamLead routing for merge-conflict and plan-merge-conflict in this workspace.
3. Exercise start/stop/idempotency and invalid edits with backend tests, including a valid status → role → workflow → onPass/onFail path and merge action.

## Done when
- [ ] Valid settings round-trip, and invalid edits leave `board.json`/`roles.json` untouched. Test: backend unit tests.
- [ ] Both merge-conflict statuses explicitly route to TeamLead; board control returns truthful runner state. Test: backend integration tests.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
