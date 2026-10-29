# P05-S39 — Add focused Teams navigation

Status: To Do
Depends on: P05-S28, P05-S38
Architecture: [Focused Teams views](../README.md#focused-teams-views-t-073)

## Goal
Refactor the Teams screen into a stable selected-team shell with focused Overview, Members, and Routing child views. Preserve the current workspace reads, refresh behavior, and truthful selection fallbacks while removing the requirement to scan one long page.

## Implement in this order
1. Inspect `app/src/renderer/teams/TeamsScreen.tsx`, `teamsModel.ts`, `WorkspaceShell.tsx`, and `useDashboardSection.ts`. Introduce small typed view state for `overview | members | routing`, the selected definition key, and an optional selected member; keep it local to the current `workspace.id` and do not add URL routing.
2. Extract or add focused-shell components under `app/src/renderer/teams/` so `TeamsScreen` continues to own the existing `overview`, `agents`, `boardSettings`, and `roles` section controllers and shared refresh/write feedback. Render one child view at a time; do not refetch merely because a child view changes.
3. Keep a compact, labelled workspace-team browser/chooser. Select the first `orderTeams` result initially, preserve a selection by stable definition id across successful refreshes, fall back to the first returned team when it disappears, and show no selected-team child UI when the workspace is empty.
4. Add an accessible team heading and child navigation using the appropriate tab semantics (`tablist`, `tab`, `tabpanel`). Implement Left/Right, Home, and End keyboard movement, roving `tabIndex`, visible focus, and `aria-selected`/`aria-controls`; activating a new team returns to Overview and clears a stale member selection.
5. Keep the global create-team and refresh entry points discoverable. Loading, overview error, retained stale data, truncation/partial notices, role-catalog failure, connecting/lost connection, and write feedback remain outside the child panel so changing tabs cannot hide them.
6. Update `app/test/teamsScreen.test.tsx` and `workspaceShell.test.tsx` with fixtures for multiple teams, refresh reorder/removal, workspace switching, empty results, tab keyboard movement, and proof that tab/team selection does not issue extra management reads.

## Done when
- [ ] Teams exposes exactly one selected team's Overview, Members, or Routing panel at a time, preserves a valid stable-id selection across refresh, and resets team/member/view state safely when the selected team or workspace changes. Test: `app/test/teamsScreen.test.tsx` and `app/test/workspaceShell.test.tsx`.
- [ ] The team chooser and child tabs have accessible names, selected state, roving focus, arrow/Home/End behavior, and visible `:focus-visible` treatment. Test: keyboard-focused React tests plus CSS assertions/build.
- [ ] Existing management reads, partial notices, reconnect refresh, global feedback, create-team, and refresh behavior remain wired once and no tab change triggers a backend call. Test: `app/test/teamsScreen.test.tsx` call-count regressions.
- [ ] `npm --prefix app test`, `npm --prefix app run typecheck`, and `npm --prefix app run build` pass.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
