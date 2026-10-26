# P05-S01 — Compact workspace shell and overview header

Status: To Do
Depends on: None
Architecture: [P05 architecture](../README.md#architecture)

## Goal
Match the reference's compact sidebar and header without changing workspace selection, section navigation, connection reporting, or dashboard requests. Keep the existing Home content visible until later stories replace its layout.

## Implement in this order
1. Update `app/src/renderer/shell/WorkspaceShell.tsx`, `navModel.ts`, and `styles.css`: product identity, workspace selector presentation using existing `Workspace` name/path and `onSwitchWorkspace`, icon-backed Home/Teams/Boards/Configuration buttons, current-section text and `aria-current`, Switch workspace near the bottom. Keep native buttons and destination placeholders.
2. Update `app/src/renderer/dashboard/DashboardHome.tsx` and CSS: breadcrumb, one “Workspace overview” `h1`, workspace identity, existing `ConnectionStatus` wording, Refresh, and timestamp location. Keep `DashboardApi.teams/board/activity(workspace.id)` and current `useDashboardSection` behavior; no new IPC.
3. Extend `app/test/workspaceShell.test.tsx` and `dashboardHome.test.tsx` for navigation, workspace switch, connection states, long names/paths, and initial loading/section error visibility.

## Done when
- [ ] Sidebar identity, icon/text navigation, bottom Switch workspace, breadcrumb, and overview heading match the reference hierarchy. Tests: `workspaceShell.test.tsx`, `dashboardHome.test.tsx`.
- [ ] Keyboard Tab/Enter/Space reach and activate native controls; visible focus, `aria-current`, main/nav landmarks, and readable labels remain. Test: `workspaceShell.test.tsx`.
- [ ] Existing connection wording, refresh action, successful-time display, and independent loading/error/empty sections remain truthful; long workspace names/paths wrap or truncate with accessible full text. Tests: `dashboardHome.test.tsx`, `dashboardA11y.test.tsx`.
- [ ] Narrow desktop sidebar/header keep actions reachable without horizontal page scroll. Test: `dashboardStyles.test.ts`; final visual check in S07.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
