# P05-S02 — Four real-data summary metrics

Status: To Do
Depends on: P05-S01
Architecture: [P05 architecture](../README.md#architecture)

## Goal
Add compact cards for running teams, active assignments, open tickets, and completed tickets, using only the three existing dashboard section results.

## Implement in this order
1. Add a summary component under `app/src/renderer/dashboard/` and compose it in `DashboardHome.tsx` with `styles.css`; read `DashboardTeams.teams[].runtime.status/activeAssignments` and `DashboardBoard.columns[].count/kind` from `app/src/renderer/api.ts` and `app/src/shared/api.ts`. Count only current-phase tickets; open excludes `done`/`closed`, completed includes them. Do not sum the bounded `tickets` projection or `activity.entries`.
2. Represent loading, zero, independent API errors, and `DashboardTeams.truncated` as distinct states; suppress or mark any team-derived total that cannot be guaranteed across the truncated list. Keep other successful cards usable during a section error/retry and on refresh.
3. Add focused `app/test/summaryMetrics.test.tsx` and extend `dashboardHome.test.tsx` with ready/zero/partial-error/loading/truncated fixtures and independent request assertions.

## Done when
- [ ] Each card has an accessible heading/label, value, scope note, and text status; no zero or illustrative count appears for unavailable data. Tests: `summaryMetrics.test.tsx`.
- [ ] Running teams and assignments derive from returned runtimes; open/completed derive from all current-phase status columns including custom statuses and `done`/`closed` kinds. Tests: `summaryMetrics.test.tsx`.
- [ ] Cards use existing `DashboardApi.teams` and `.board` results with no extra fetch or mutating API. Test: `dashboardHome.test.tsx`.
- [ ] Static cards add no tab stops; their labels and state text read correctly to a screen reader, and the row wraps cleanly at narrow widths without color-only meaning. Tests: `dashboardStyles.test.ts`, `dashboardA11y.test.tsx`.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
