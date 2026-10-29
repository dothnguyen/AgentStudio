# P05-S38 — Integrate role selection and deep links in Teams

Status: To Do
Depends on: P05-S21, P05-S35, P05-S36
Architecture: [Roles catalog assumptions](../README.md#open-questions-and-planning-assumptions)

## Goal
Use the shared role catalog in team member management and link a selected member to its role detail, while keeping member identity, ticket permission, ordered agent options, live switching, and quota controls explicitly separate.

## Implement in this order
1. Extend `WorkspaceShell` navigation with a typed optional role-selection payload/state scoped to the current workspace. A Teams “View role” action navigates to Roles and selects the stable id; direct Roles navigation and workspace switching clear stale requested ids safely without adding URL routing.
2. Feed role catalog items into `TeamEditForms.tsx`. Replace free-form role entry for valid catalogs with a labelled existing-role selector showing display name and stable id; preserve an invalid/missing current reference as a visible repair option rather than silently choosing another role.
3. In the member detail/row in `TeamsScreen.tsx`, show role display name/description and “View in Roles” when defined. For undefined/unavailable roles, retain existing diagnostics and offer retry/repair rather than a broken link.
4. Correct the design-reference language: role instructions are shared, but `canAddTickets`, ordered agent options/default-for-next-start, runtime active agent, switching, and quota holds remain member/runtime sections. Do not send changes to those fields when only role changes.
5. Retain the existing backend rule that saved member role edits apply on next team start; a running member's role/runtime does not change optimistically. Show this alongside the distinct instruction timing (new assignments after save).
6. Update `teamEditModel.ts`, `TeamsScreen.tsx`, `TeamEditForms.tsx`, shell navigation types, fixtures, and `app/test/teamEditModel.test.ts`, `teamEdit.test.tsx`, `teamsScreen.test.tsx`, `teamsLiveControls.test.tsx`, and `workspaceShell.test.tsx`.
7. Add regression automation proving routing continues to use stable ids, role edits apply next start, role instruction edits apply to new assignments, frozen role context remains unchanged, and Teams/Agents navigation and controls remain intact. Finish with the full app test, typecheck, and production build commands.

## Done when
- [ ] Add/edit member chooses an existing role, preserves undefined references for repair, and backend errors remain authoritative. A role-only save sends no agent, permission, switch, or quota change.
- [ ] “View in Roles” opens the exact stable role id, survives duplicate display names, and stale/missing ids show a truthful fallback; workspace switching cannot carry a role selection across workspaces.
- [ ] Copy and structure state that only instructions/metadata are shared; ticket permission and ordered/live agent controls remain independently editable and existing live-switch tests pass.
- [ ] Backend regression tests prove direct/workflow dispatch still freezes role context and routing resolves stable ids; renderer tests contain no role-owned permission/default-agent claim.
- [ ] `npm --prefix app test`, `npm --prefix app run typecheck`, and `npm --prefix app run build` pass.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
