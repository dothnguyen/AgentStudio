# P05-S09 — Team creation and membership contract

Status: To Do
Depends on: P05-S08
Architecture: [Teams management architecture](../README.md#architecture-and-gaps)

## Goal
Support creating and editing teams and their member references to reusable agent definitions, including role assignment, with validated workspace-scoped writes. Use `design/teams-screen-v1.png` as a conceptual reference only.

## Implement in this order
1. Extend `teamdefs.py` read/write operations and serve commands for team rename/delete, member add/edit/remove, and catalog reference resolution; retain support for inline legacy members.
2. Reject duplicate member ids, missing catalog/role, and edits unsafe for an active team; return structured validation errors and atomic results.
3. Cover create/edit/delete, legacy migration, invalid references, and active-team behavior in backend tests.

## Done when
- [ ] A team can be assembled from reusable definitions and validated before start. Test: backend unit/integration tests.
- [ ] Invalid or conflicting edits write nothing and report actionable errors. Test: backend unit tests.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
