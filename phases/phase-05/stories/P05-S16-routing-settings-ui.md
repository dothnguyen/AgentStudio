# P05-S16 — Worktree and routing settings UI

Status: To Do
Depends on: P05-S11, P05-S12, P05-S13
Architecture: [Teams management architecture](../README.md#architecture-and-gaps)

## Goal
Let operators inspect and edit isolated-worktree, merge-on-success, and status → role → workflow → next-status rules, including TeamLead merge-conflict routing. Reference `design/teams-screen-v1.png`; options come from backend configuration.

## Implement in this order
1. Render statuses, roles, workflows and rules from management API, including action rules and distinct onPass/onFail/onBlocked paths.
2. Provide validated editing for worktree mode, merge action, role descriptions, and routing; show dependency and graph errors inline before/after save.
3. Cover edited configuration, invalid routes, and explicit TeamLead merge-conflict paths in component tests.

## Done when
- [ ] An operator can inspect and save a valid routing change with no hard-coded status or workflow names. Test: component and backend contract tests.
- [ ] Invalid graph edits do not appear saved; TeamLead is explicit for both merge-conflict statuses. Test: component tests.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
