# P05-S04 — Team status and aggregate presence panel

Status: To Do
Depends on: P05-S01
Architecture: [P05 architecture](../README.md#architecture)

## Goal
Show team runtime, member count, aggregate availability, and active-assignment state in a compact card without implying the API exposes individual agents.

## Implement in this order
1. Reshape `app/src/renderer/dashboard/TeamsPanel.tsx` and `styles.css` around `DashboardTeams.teams[]`, each `runtime.status`, `memberCount`/definition `members`, `availability`, `activeAssignments`, `problems`, and `truncated`. Lead with running teams but keep every returned team discoverable; use aggregate presence labels instead of invented portraits.
2. Preserve loading, no-team, stopped/no-runtime, definition-problem, error/retry, and truncated-list states; maintain View teams through `onNavigate('teams')`. Do not infer member identity or that every member is available from an absent runtime.
3. Extend `app/test/teamsPanel.test.tsx` for multiple teams, each runtime state, aggregate availability, long names, truncation, retry, and keyboard navigation.

## Done when
- [ ] Status, member/availability counts and assignments equal `team.list` data; stopped and no-runtime teams are not reported as actively available. Test: `teamsPanel.test.tsx`.
- [ ] Empty/loading/error/retry/truncated states and team definition problems are clearly labelled. Test: `teamsPanel.test.tsx`.
- [ ] View teams enters the existing Teams section; card headings, lists, and status labels are screen-reader usable and keyboard controls show focus. Tests: `teamsPanel.test.tsx`, `dashboardA11y.test.tsx`.
- [ ] Multiple teams and long names wrap at narrow widths without overflowing the panel. Tests: `dashboardStyles.test.ts`, final visual check in S07.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
