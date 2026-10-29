# P05-S36 — Create and edit roles in the catalog

Status: To Do
Depends on: P05-S35
Architecture: [Roles catalog assumptions](../README.md#open-questions-and-planning-assumptions)

## Goal
Provide accessible create and edit flows for display name, stable id, description, shared instructions, and ordered configured skills with clear save timing and conflict recovery.

## Implement in this order
1. Add pure form construction, validation, normalization, and change-set helpers in `app/src/renderer/roles/roleEditModel.ts`. Create shows/validates the stable slug id (auto-suggested from name but user-editable before save); edit renders the id read-only and labels display-name changes as safe renames.
2. Build create/edit UI in focused components under `app/src/renderer/roles/`. Validate required/duplicate name, slug id, length limits, instruction byte limit, and duplicate skill ids client-side while treating backend validation as authoritative.
3. Provide an ordered configured-skills editor using returned `availableSkills`; keep missing configured ids visible and removable, allow valid manual ids, and never create/edit/delete a skill file. Keep member permissions and agent defaults absent from the form.
4. Save metadata/skills and instructions using their respective SHA tokens. If both changed, save metadata first, reload tokens, then save instructions; keep the draft open until the final reload succeeds. On any failure retain unsaved fields, focus/summarize structured problems, and do not report success prematurely.
5. Explain beside instructions: “Shared by all members assigned this role” and “Saved changes apply to new assignments; current assignments keep their frozen instructions.” Cancel discards after confirmation only when dirty; Escape and focus return behave correctly for dialogs.
6. On `CONFIG_CHANGED`, keep the draft, show that another edit won, offer Reload and Review (never blind overwrite), and display fresh server values after reload. Add `app/test/roleEditModel.test.ts` and `app/test/roleEdit.test.tsx`.
7. Cover rapid/repeated submits, mutation/reload races, narrow dialog/form layout, long validation text, keyboard-only skill ordering, and focus return. Stale mutation results from a previous workspace or superseded request must not close or replace the current draft.

## Done when
- [ ] Create validates/saves a stable id and selects the returned role; edit cannot change the id but can safely rename the display label, description, instructions, and ordered skills.
- [ ] Missing skills remain visible, no skill files are mutated, unrelated/direct-task/custom fields survive backend saves, and the UI never offers role-owned permissions or agent defaults.
- [ ] Dirty cancel, keyboard focus, byte limits, backend field errors, first/second-step failure, reload failure, and `CONFIG_CHANGED` retain recoverable drafts. Tests assert no false success and no silent overwrite.
- [ ] Automated narrow-layout and semantic tests prove no clipped fields/actions, correctly labelled errors/status, keyboard skill ordering, dialog focus containment/return, and stale-response rejection.
- [ ] `npm --prefix app test -- roleEdit rolesScreen` and `npm --prefix app run typecheck` pass.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
