# P05-S53 — Add a separate saved member configuration editor

Status: To Do
Depends on: P05-S52
Architecture: [Teams overview and member detail refresh](../README.md#teams-overview-and-member-detail-refresh-t-083)

## Goal
Give member detail a clearly separate Saved configuration section for viewing and editing the member name, role, ticket-creation permission, and ordered catalog agent options. Make Save and Discard explicit, preserve the first option as the next-start default, and never silently change a running member.

## Implement in this order
1. Inspect `app/src/renderer/teams/MemberDetailPanel.tsx`, `TeamEditForms.tsx`, `teamEditModel.ts`, `MemberAgentOptionsField.tsx`, Roles deep-link handling in `WorkspaceShell.tsx`, and edit/remove tests. Reuse the existing form model and typed `teamdef.member.update/remove` calls.
2. Render a Saved configuration section after Live state. In read mode show name/id, assigned role, ticket-creation permission, ordered catalog options, and the first saved option labelled as the default for the next team start; preserve inline-member, missing-reference, runtime-only, role-catalog-unavailable, and ticket-permission-load states.
3. Add one Edit saved configuration action that changes the section into the existing controlled editor. Provide explicit Save changes and Discard changes actions; Discard restores the last returned values without a mutation, Save computes `memberChanges` and submits once, no-op submissions stay disabled or close without claiming a save, and backend validation/problems remain visible.
4. Preserve ordered agent controls, unique ids, missing references for repair, first-option default semantics, inline-to-catalog opt-in, and agent provider/model/reasoning descriptions. Saved changes must not invoke `team.member.switch` or `team.member.resume`, alter Live display optimistically, or claim to affect the current run.
5. State next to the editor/result that saved member configuration applies on the next team start. Keep shared role instructions out of this form and provide the existing exact stable-id link to Roles; explain that role instructions are edited there and apply to new assignments.
6. Keep Remove member as a separate destructive action with exact member/team confirmation, active-team/backend restrictions, Escape/focus handling, and truthful success/error feedback. Returning after Save, Discard, failed Save, role navigation, or removal must place focus deterministically.
7. Update `app/test/teamEditModel.test.ts`, `teamEdit.test.tsx`, `teamEditEdges.test.tsx`, `teamsScreen.test.tsx`, and `workspaceShell.test.tsx` for view/edit modes, Save/Discard/no-op, ordered/default options, inline/missing/unavailable cases, no live calls, next-start copy, Roles navigation, removal, and focus.

## Done when
- [ ] Saved configuration is visually and semantically separate from Live state and shows real name, role, ticket permission, and ordered options with the first saved option labelled as next-start default. Test: `teamsScreen.test.tsx` fixture matrix.
- [ ] Edit, Save, and Discard use the existing form/model and typed mutation once, preserve invalid-reference repair and inline compatibility, and cannot issue switch/resume calls or optimistically change Live state. Test: `teamEditModel`, `teamEdit`, and `teamEditEdges` suites plus API call assertions.
- [ ] Timing copy clearly says saved changes apply on the next team start; role instructions remain in Roles and the deep link targets the exact stable role id. Test: renderer copy and `workspaceShell.test.tsx` navigation assertions.
- [ ] Safe removal and all edit/remove focus transitions remain intact. Test: exact-member confirmation, error, Escape, Save, Discard, and removal focus cases.
- [ ] `npm --prefix app test`, `npm --prefix app run typecheck`, and `npm --prefix app run build` pass.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
