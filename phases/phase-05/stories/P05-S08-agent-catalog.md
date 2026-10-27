# P05-S08 — Reusable agent catalog

Status: To Do
Depends on: None
Architecture: [Teams management architecture](../README.md#architecture-and-gaps)

## Goal
Add workspace-scoped reusable agent definitions with stable ids, role instructions or description, provider, model and reasoning metadata; existing inline team members remain valid. Reference `design/teams-screen-v1.png` for the intended catalog, with all example values treated as illustrative.

## Implement in this order
1. Define a versioned catalog under `.agent-studio/` and validate ids, provider/model fields, and references without changing running rosters.
2. Expose workspace-scoped list/create/update/delete commands through the existing command boundary; reject deletion of referenced definitions and preserve unrelated file fields.
3. Add unit tests for round trips, duplicate/invalid ids, referenced deletion, and legacy inline member compatibility.

## Done when
- [ ] Catalog changes survive restart and bad input leaves files unchanged. Test: backend unit tests.
- [ ] Existing inline members still load and a running team keeps its frozen roster. Test: backend unit/integration tests.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
