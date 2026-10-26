# P04-S20 — Dashboard board status panel

Status: To Do
Depends on: P04-S19
Architecture: [P04 design contract](../README.md#design-contract), §A (workspace registry), §C (team definitions), §D (board); renderer rules: ticket T-014 (allowlisted preload only, one `serve` process)

## Goal
Add the Board status panel to the dashboard from the `board.summary` data: current phase, counts per configured status, active/blocked/done totals, and a short list of high-priority active or blocked tickets, with its own loading, empty, error and retry states.

## Implement in this order
1. `app/src/renderer/dashboard/BoardPanel.tsx` using `useDashboardSection(dashboard.board, workspace.id)`; replaces the board placeholder in `DashboardHome` and joins its Refresh.
2. Ready view: phase name with "open"/"closed" text; a list (`<ul>`) of columns `title` + `count` rendered from `columns` in the returned order (no hard-coded status names; `kind` only drives an optional text marker); totals; ticket list keyed by `key` with key (monospace), title, status, priority, activity state text. "View board" calls `onNavigate('boards')`.
3. Empty state when every count is 0 and no tickets; error state maps the board-not-configured code (from S16 Evidence) to "No board configured for this workspace" with no Retry loop, other codes show the message with Retry.

## Done when
- [ ] Custom status ids/titles from the fake data appear unchanged; no software status name exists in the component source. Test: `app/test/boardPanel.test.tsx` (render + source grep).
- [ ] Loading, empty, not-configured, error+Retry and ready states render; Retry re-requests only the board. Test: `boardPanel.test.tsx`.
- [ ] A board failure leaves the Teams panel intact. Test: `dashboardHome.test.tsx`.
- [ ] "View board" selects Boards. Test: `boardPanel.test.tsx`.
- [ ] Validation: npm --prefix app test; npm --prefix app run typecheck; npm --prefix app run build.

Out of scope: ticket editing, moving, drag-and-drop, merge-ready special casing, phase switching.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
