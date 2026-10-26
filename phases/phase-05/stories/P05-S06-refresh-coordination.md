# P05-S06 — Truthful dashboard refresh coordination

Status: To Do
Depends on: P05-S02, P05-S03, P05-S04, P05-S05
Architecture: [P05 architecture](../README.md#architecture)

## Goal
Make the redesigned dashboard's refresh and timestamp accurate across all sections, including partial failure, duplicate clicks, and workspace changes.

## Implement in this order
1. Refine `app/src/renderer/dashboard/DashboardHome.tsx` and, only if needed, `useDashboardSection.ts`: one Refresh calls `DashboardApi.teams`, `.board`, `.activity` once each; block duplicate in-flight refreshes; record the last complete successful update only after all three current-workspace results succeed. Keep previous successful time on partial failure and clearly label mixed/stale cards.
2. Preserve per-section Retry, independent loading/error/empty states, latest-response sequencing, StrictMode deduplication, workspace-switch reset, and connection-state text; do not add a backend command or optimistic success time. Keep the timestamp and controls readable at narrow widths through `app/src/renderer/styles.css`.
3. Extend `app/test/dashboardHome.test.tsx` and `useDashboardSection.test.tsx` with deferred promises for partial failure, retry, double click, switch/unmount, and stale late responses.

## Done when
- [ ] One Refresh makes one call per section and duplicate in-flight clicks make no extra calls. Test: `dashboardHome.test.tsx`.
- [ ] “Last updated” changes only after a complete successful current-workspace load; partial failure keeps prior time and names stale/unavailable content. Test: `dashboardHome.test.tsx`.
- [ ] Old workspace or superseded responses never repaint metrics/panels or update the timestamp; per-section Retry remains independent. Tests: `useDashboardSection.test.tsx`, `dashboardHome.test.tsx`.
- [ ] Refresh/Retry retain native keyboard behavior, focus visibility, and accessible busy/error announcements. Tests: `dashboardA11y.test.tsx`.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
