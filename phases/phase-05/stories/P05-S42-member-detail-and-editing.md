# P05-S42 — Build member detail and membership editing

Status: To Do
Depends on: P05-S41, P05-S38
Architecture: [Focused Teams views](../README.md#focused-teams-views-t-073)

## Goal
Open one selected member in a focused detail view for identity, assigned shared role, ticket permission, saved ordered agent choices, and membership mutations. Keep shared role instructions in Roles and keep saved options visibly separate from the running agent.

## Implement in this order
1. Add a focused member-detail component under `app/src/renderer/teams/` with a labelled Back to members action and breadcrumb/context naming the team and member. Move, do not duplicate, the existing add/edit/remove flows from `TeamDetailPanel` and `TeamEditForms.tsx`.
2. Present Member settings for name, role, and `canAddTickets`; show the role catalog display name, stable id, description/warnings when returned, and the existing `onViewRole(roleId)` deep link. Missing/undefined/unavailable roles stay visible for repair and never produce a broken link.
3. State precisely that shared role instructions are edited in Roles and apply to new assignments. Do not say roles supply permissions, default/ordered agents, active agents, quota controls, or switching; member role changes retain the existing next-team-start timing.
4. Present saved Agent options in authoritative order with missing catalog references, default-for-next-start, provider/model/reasoning when known, and the existing Agents-catalog navigation/copy if available. Do not convert inline or single-catalog members implicitly and do not treat saved edits as a live switch.
5. Reuse `MemberForm`, `teamEditModel.ts`, and role catalog inputs for add/edit. Preserve validation, invalid current role/agent references, agent ordering/default, inline compatibility, optimistic-write locks, applies-on-next-start copy, backend errors, and post-save refresh. Keep remove confirmation scoped to the exact member.
6. Restore focus to the invoking row/action after cancel, failed mutation, successful return, or member removal where the element still exists; place focus on the detail heading when opening a member and on the confirmation dialog when removing.
7. Update `app/test/teamEditModel.test.ts`, `teamEdit.test.tsx`, `teamEditEdges.test.tsx`, `teamsScreen.test.tsx`, and `workspaceShell.test.tsx` for role separation, ordered options, inline/single modes, add/edit/remove, deep links, timing copy, missing references, and focus transitions.

## Done when
- [ ] Member detail separates name, assigned shared role, ticket permission, and saved ordered agent choices, and contains no claim that roles own member permissions or agent behavior. Test: renderer copy/structure assertions in `teamsScreen.test.tsx`.
- [ ] Add/edit/remove retain current validation, ordered/default agent semantics, invalid-reference repair, inline compatibility, next-start timing, backend authority, and exact-member confirmation. Test: `teamEditModel`, `teamEdit`, and `teamEditEdges` suites.
- [ ] View role opens the exact stable role id; missing/unavailable roles remain repairable without a link, and role-only changes send no agent, permission, switch, or quota mutation. Test: `teamsScreen.test.tsx` and `teamEdit.test.tsx`.
- [ ] Opening, cancelling, saving, removing, and returning have deterministic focus behavior. Test: React focus assertions.
- [ ] `npm --prefix app test`, `npm --prefix app run typecheck`, and `npm --prefix app run build` pass.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
