# P04-S21 — Dashboard recent activity panel

Status: To Do
Depends on: P04-S19
Architecture: [P04 design contract](../README.md#design-contract), §A (workspace registry), §C (team definitions), §D (board); renderer rules: ticket T-014 (allowlisted preload only, one `serve` process)

## Goal
Add the Recent activity panel from `activity.recent`: a compact newest-first list of up to 15 entries with description, type and time, keyed by event id, with independent loading, empty, error and retry states.

## Implement in this order
1. `app/src/renderer/dashboard/ActivityPanel.tsx` using `useDashboardSection(dashboard.activity, workspace.id)`; replaces the activity placeholder.
2. Render an ordered list keyed by `entry.id`; each item has `summary`, a text type label (team / assignment / workflow / ticket), and a `<time dateTime>` element with a locale-formatted value; render exactly what the API returns, never raw JSON.
3. Empty state "No recent activity"; error `role="alert"` with Retry for this panel only.

## Done when
- [ ] Entries render in the order returned with stable keys (no React key warnings in the test console); at most the bounded count is shown. Test: `app/test/activityPanel.test.tsx`.
- [ ] Loading, empty, error+Retry, ready states; Retry re-requests only activity. Test: `activityPanel.test.tsx`.
- [ ] An activity failure does not hide Teams/Board panels. Test: `dashboardHome.test.tsx`.
- [ ] Validation: npm --prefix app test; npm --prefix app run typecheck; npm --prefix app run build.

Out of scope: pagination, filters, search, live push, links into tickets.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
