# P05-S48 — Move team navigation into the workspace sidebar

Status: To Do
Depends on: P05-S47
Architecture: [Teams overview and member detail refresh](../README.md#teams-overview-and-member-detail-refresh-t-083)

## Goal
Replace the Teams screen's dedicated team-browser column with compact, real-data team navigation nested under Teams in the workspace sidebar. Keep one workspace-scoped selected-team identity across sidebar navigation, refreshes, reconnection, and the Teams content area without adding URL routing or duplicate management reads.

## Implement in this order
1. Inspect `app/src/renderer/shell/WorkspaceShell.tsx`, `shell/navModel.ts`, `teams/TeamsScreen.tsx`, `teams/TeamChooser.tsx`, `teams/teamsViewModel.ts`, `dashboard/useDashboardSection.ts`, and the selection tests in `app/test/workspaceShell.test.tsx` and `app/test/teamsScreen.test.tsx`. Preserve the existing stable definition key rules from `teamsModel.ts`; never select by display name or array index when a definition id exists.
2. Introduce a workspace-scoped Teams navigation/controller boundary under `app/src/renderer/teams/` that owns the `management.overview(workspaceId)` section and selected team key needed by both `WorkspaceShell` and `TeamsScreen`. Pass the existing section/controller into the screen so opening Teams does not issue a second overview read; keep agents, roles, and board-settings reads inside Teams.
3. Render returned teams as nested sidebar buttons beneath the existing Teams destination, with the team display name and truthful compact runtime/definition state. Selecting a team opens Teams on Overview, clears any member detail, preserves that stable selection across refresh/reorder, falls back to the first returned team if it disappears, and resets all team state when `workspace.id` changes.
4. Remove `TeamChooser` and the large `.teams-layout` browser column from the Teams content area after sidebar navigation is wired. Direct navigation to Teams with no explicit team selects the preserved valid team or the first ordered team; an empty workspace opens the existing empty Teams state.
5. Preserve manual refresh, automatic reconnect refresh, retained stale data, partial/truncated notices, loading/error retry, and write locks. Sidebar rows may show retained data as stale but must not imply a runtime or definition is healthy when the current read is unavailable.
6. Add accessible grouping and selection semantics to the nested list: the Teams parent remains the workspace destination, the selected child exposes `aria-current`, every row is keyboard reachable with visible focus, long names wrap or truncate without hiding the accessible name, and focus moves predictably when a refreshed list removes the focused team.
7. Update `app/test/workspaceShell.test.tsx`, `app/test/teamsScreen.test.tsx`, and any new focused controller/model test to cover initial selection, explicit child selection, reorder/removal, stale/error/empty results, reconnect, workspace switching, focus fallback, and management call counts.

## Done when
- [ ] The workspace sidebar lists only teams returned for the active workspace, selecting one opens its Overview, and the former in-content team chooser is absent. Test: `app/test/workspaceShell.test.tsx` and `app/test/teamsScreen.test.tsx`.
- [ ] One shared overview read/controller supplies sidebar and Teams content; selection survives refresh/reorder by stable key, falls back safely after deletion, and resets on workspace change. Test: call-count and rerender cases in the same suites.
- [ ] Loading, stale, partial, error, empty, disconnected, and long-name states remain truthful and the nested controls have accessible names, current state, keyboard operation, and visible focus. Test: focused React accessibility/state cases plus CSS assertions.
- [ ] `npm --prefix app test`, `npm --prefix app run typecheck`, and `npm --prefix app run build` pass.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
