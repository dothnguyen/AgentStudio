# P05-S49 — Create teams from the workspace sidebar

Status: To Do
Depends on: P05-S48
Architecture: [Teams overview and member detail refresh](../README.md#teams-overview-and-member-detail-refresh-t-083)

## Goal
Keep team creation discoverable after team navigation moves into the workspace sidebar. Reuse the existing validated `teamdef.create` flow and make a successfully created team the selected Teams destination without weakening stale-data or duplicate-submit protections.

## Implement in this order
1. Inspect the create flow in `app/src/renderer/teams/TeamsScreen.tsx`, `TeamEditForms.tsx`, and `teamEditModel.ts`, plus create cases in `app/test/teamEdit.test.tsx` and `teamEditEdges.test.tsx`. Move ownership through the S48 navigation controller instead of copying validation or mutation logic into `WorkspaceShell`.
2. Add a compact, labelled New team action next to the sidebar Teams group. Open the existing `TeamNameForm` in an accessible dialog or compact shell-owned form that fits the sidebar design; keep name trimming/validation, Cancel, Escape where dialog semantics are used, initial focus, focus restoration, and visible error feedback.
3. Call the existing typed `management.createTeam(workspaceId, {name})` once per submission. Preserve connection/stale-data/write locks, backend problem details, retryability/remediation, and do not report success until the management result is successful.
4. On success, refresh the shared overview section, select the returned stable team id, open its Overview, close the form, and announce the existing success/definition-problem message. A failed refresh must retain the successful creation feedback without inventing a selected row that was not returned.
5. Keep creation available in the empty-team state and unavailable while disconnected, loading stale data, or another team definition write is pending. Do not add a second create action in the main Teams panel.
6. Update `app/test/teamEdit.test.tsx`, `teamEditEdges.test.tsx`, `workspaceShell.test.tsx`, and `teamsScreen.test.tsx` for empty and populated workspaces, validation, rapid clicks, backend errors, successful selection, refresh failure, cancellation, keyboard focus, and workspace switching while the form is open.

## Done when
- [ ] The sidebar exposes one New team action for empty and populated workspaces and uses the existing validation and typed create API exactly once per accepted submit. Test: `teamEdit.test.tsx`, `teamEditEdges.test.tsx`, and `workspaceShell.test.tsx`.
- [ ] Successful creation refreshes real data, selects the returned team, and opens Overview; errors, stale data, disconnects, and refresh failures remain truthful and recoverable. Test: focused mutation/result cases.
- [ ] Open, Cancel/Escape, error, and success paths place focus predictably and do not leave an orphaned dialog after workspace switching. Test: React keyboard/focus assertions.
- [ ] `npm --prefix app test`, `npm --prefix app run typecheck`, and `npm --prefix app run build` pass.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
