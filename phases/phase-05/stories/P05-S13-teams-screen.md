# P05-S13 — Teams screen and agent catalog UI

Status: To Do
Depends on: P05-S10, P05-S12
Architecture: [Teams management architecture](../README.md#architecture-and-gaps)

## Goal
Replace the Teams placeholder with the reference-inspired workspace overview and reusable agent catalog. Use `design/teams-screen-v1.png` for hierarchy once available, while every label/value comes from data.

## Implement in this order
1. Reuse `WorkspaceShell`, dashboard tokens, loading/error/empty patterns and the Teams navigation target.
2. Render team cards and agent definitions with role description, provider/model, member counts and clear empty/error/retry states.
3. Add component tests for multiple teams, missing details, long labels, and navigation from Home.

## Done when
- [ ] Teams navigation opens a populated screen with no hard-coded sample agents. Test: React component tests.
- [ ] Loading, empty, partial and error states remain understandable. Test: component tests.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
