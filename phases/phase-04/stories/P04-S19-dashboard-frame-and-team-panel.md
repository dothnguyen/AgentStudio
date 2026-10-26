# P04-S19 — Dashboard frame, refresh protocol and team status panel

Status: To Do
Depends on: P04-S14, P04-S18
Architecture: [P04 design contract](../README.md#design-contract), §A (workspace registry), §C (team definitions), §D (board); renderer rules: ticket T-014 (allowlisted preload only, one `serve` process)

## Goal
Replace the Home placeholder with the Workspace Dashboard: a header (workspace name, path, connection state, Refresh, optional last-updated) and the first panel, Team status. This story also builds the reusable independent-section loader that S20/S21 reuse, with the stale-response and unmount protection used on the startup screen.

## Implement in this order
1. `app/src/renderer/dashboard/useDashboardSection.ts`: `useDashboardSection(load, workspaceId)` returning `{state: loading|ready|error, data, error, reload}`; a sequence counter ignores any response from an older call, an earlier workspace, or after unmount; `reload` while a request is in flight is a no-op (no duplicate request). Pattern reference: `WorkspacesScreen.tsx` load sequencing.
2. `DashboardHome.tsx` (props: `workspace`, `dashboard: DashboardApi`, `connection: ConnectionStatus`, `onNavigate(sectionId)`): header with `<h1>`, monospace path with `title`, connection badge using the existing `ConnectionState` wording plus text (not color alone), Refresh button (`aria-busy` while loading) that reloads all sections through each section's `reload`, and "Last updated" only from the time the last successful response arrived in the renderer. Mount via `WorkspaceShell`'s Home section; `WorkspaceShell` passes the connection status from one `useConnection` subscription.
3. `TeamsPanel.tsx`: `<section aria-labelledby>` with loading status, empty state ("No teams defined"), error `role="alert"` with its own Retry, and ready view: defined teams with running/stopped text badges, member totals, availability counts using the backend's actual vocabulary labelled verbatim, active-assignment count, `problems` shown as "Definition has problems"; "View teams" button calls `onNavigate('teams')`.
4. Board and Activity areas remain labelled placeholders in the frame (replaced by S20/S21).

## Done when
- [ ] Opening a workspace shows the dashboard with real data from a fake `DashboardApi` and exactly one `teams` request. Test: `app/test/dashboardHome.test.tsx`.
- [ ] Loading, empty, error (with Retry that re-requests only teams) and ready states render. Test: `app/test/teamsPanel.test.tsx`.
- [ ] A stale response (older reload, previous workspace, after unmount) never overwrites newer state; Refresh while loading issues no second request. Test: `app/test/useDashboardSection.test.tsx`.
- [ ] "View teams" selects the Teams section inside the same shell. Test: `dashboardHome.test.tsx` with the shell.
- [ ] Connection state wording matches the startup screen text; the panel never calls mutating APIs (fake exposes only read calls). Test: `dashboardHome.test.tsx`.
- [ ] Validation: npm --prefix app test; npm --prefix app run typecheck; npm --prefix app run build.

Out of scope: board/activity panels, polling (manual refresh only), responsive polish (S22).

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
