# P05-S14 — Team and membership editing UI

Status: To Do
Depends on: P05-S09, P05-S12, P05-S13
Architecture: [Teams management architecture](../README.md#architecture-and-gaps)

## Goal
Allow operators to create and edit teams and assign reusable agent definitions to named members with roles. The forms follow `design/teams-screen-v1.png` when supplied and do not assume its sample roster.

## Implement in this order
1. Build create/edit flows over the typed management API with validation and conflict feedback.
2. Support add/remove member and team rename/delete where contract permits, with keyboard-friendly controls and explicit saving/error state.
3. Cover valid edits, invalid references, duplicate names, active-team restrictions, and refresh after save.

## Done when
- [ ] A user can create a team and manage its members without editing JSON. Test: component tests.
- [ ] Failed or unsafe writes display backend errors and do not imply success. Test: component tests.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
