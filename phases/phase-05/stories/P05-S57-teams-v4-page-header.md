# P05-S57 — Team page header, actions and tabs identical to v4

Status: In Progress
Depends on: P05-S55
Architecture: [Teams overview v4 fidelity](../README.md#teams-overview-v4-fidelity)

## Design reference (authoritative)
- `design/teams-overview-v4.png` — implement the header area **as identical to the image as possible**.
- `design/teams-overview-v4.html` — exact markup and styles (from the breadcrumb down to the tab rule).

## Current vs design
| Element | Current | v4 |
|---|---|---|
| Breadcrumb | Workspace / Teams | Workspace / Teams / **<team name>** (12 px, muted links, current item `#e7e9ec`) |
| Title | page H1 "Teams" + subtitle "Manage team membership…", then a boxed panel with an H2 team name | no "Teams" H1 or subtitle; H1 = team name (22 px/600, -0.01em) with a runtime status pill beside it (dot + "Running", pill bg per tone) |
| Meta row | runtime id and definition only inside the Team status card | one row under the title: "Team id" + mono chip (`dev-team`); divider; "Runtime" + mono id shortened to first 8 … last 8 characters with a copy-to-clipboard icon button; divider; green check + "Definition valid" (problems: warning icon + "Definition has N problems") |
| Actions | Refresh button in the page header; "Team actions" card with Rename team / Delete team | top right: 34×34 icon Refresh button, "Rename" button, 34×34 "⋯" menu button whose menu holds **Delete team**; the "Team actions" card is removed |
| Container | everything inside a bordered `dashboard-panel` | no outer box; content max-width 1120 px, padding 28/40/48 |
| Tabs | boxed buttons | text tabs (500 weight), 22 px gap, active tab text `#e7e9ec` with 2 px `#5b9cff` underline, inactive `#a3a9b2`, 1 px `#23262c` rule under the row |

## Implement in this order
1. In `TeamsScreen.tsx` and `TeamOverviewPanel.tsx`, move team identity, status and actions into a page header component matching the reference. Keep `teams-detail-title` (or an equivalent stable id) on the H1 for focus management.
2. Rename keeps its existing inline `TeamNameForm` (shown under the header) and all validation, pending, error and focus behaviour. Delete moves into the ⋯ menu (accessible menu button: `aria-haspopup`, `aria-expanded`, arrow keys, Escape returns focus) and keeps the existing confirmation scoped to the exact team, the `canEditTeam` / running-team restrictions and focus restoration. When a team cannot be edited, show the menu item disabled with the reason.
3. Refresh becomes the icon button with `aria-label="Refresh"`; keep its pending/announce behaviour.
4. Copy button writes the full runtime id and announces "Runtime id copied". The runtime id and team id come from returned data; when absent show nothing rather than placeholders.
5. Restyle `TeamViewTabs.tsx` to the underline tabs; ARIA tab behaviour unchanged.
6. Update `teamsScreen.test.tsx`, `teamEdit.test.tsx`, `teamEditEdges.test.tsx` for the new locations (Rename button, Delete via menu) and the removed "Team actions" section.

## Done when
- [ ] Header, meta row, actions and tabs match `design/teams-overview-v4.png`. Test: render the selected team and assert breadcrumb, H1 + pill, meta row content, icon Refresh, Rename, menu with Delete team, and that no "Team actions" section or "Teams" H1 remains.
- [ ] Rename and delete keep validation, confirmation, restrictions, pending locks and focus restoration. Test: existing mutation suites, updated.
- [ ] `npm --prefix app test`, `npm --prefix app run typecheck`, `npm --prefix app run build` pass.

## Evidence
Implemented in `TeamPageHeader.tsx` (new), `TeamsScreen.tsx`, `TeamOverviewPanel.tsx`, `MembersView.tsx`, `TeamEditForms.tsx`, `teamsModel.ts`, `styles.css`.
Tests: `app/test/teamPageHeader.test.tsx`, `app/test/teamPageHeaderModel.test.ts`; updated `teamsScreen`, `teamEdit`, `teamEditEdges`, `workspaceShell`, `teamsA11y` (Delete moved into the More menu via `chooseDeleteTeam()`; team name is now the H1; Team actions heading removed; Rename/menu live in the header).
Final `test-all` result: pending.
