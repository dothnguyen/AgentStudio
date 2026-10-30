# P05-S50 — Redesign the compact team overview and actions

Status: To Do
Depends on: P05-S48
Architecture: [Teams overview and member detail refresh](../README.md#teams-overview-and-member-detail-refresh-t-083)

## Goal
Reshape the selected team's Overview into compact status, board-control, and member-availability summaries while preserving rename, deletion, board run/stop, Routing access, and every existing safety restriction. Display only returned workspace data and distinguish unavailable, stale, partial, stopped, and conflicting states in text as well as color.

## Implement in this order
1. Inspect `app/src/renderer/teams/TeamOverviewPanel.tsx`, `BoardControl`, `boardControlModel.ts`, `teamsModel.ts`, `TeamViewTabs.tsx`, and the focused overview/live-control tests. Retain the existing derived-state helpers and typed management calls rather than recreating backend authority in JSX.
2. Replace the current definition/runtime fact grid with compact summary cards/rows for Team status, Board, and Member availability. Include stable team identity and returned definition/runtime/coordinator evidence where useful, but avoid repeating raw ids or diagnostics in every card; expose definition problems and partial/truncated qualifications near the affected summary.
3. Keep Board Run and Stop within the Board summary and preserve the current runtime team id, another-team conflict, stopped/unbound/unavailable states, rapid-click lock, pending wording, reconnection refresh, and exact result/error feedback from `boardControlModel.ts`.
4. Keep Rename and Delete in a compact selected-team actions area. Preserve `canEditTeam`, active-team restrictions, confirmation scoped to the exact team, applies-on-next-start copy, definition problems, successful selection fallback, failed-write focus restoration, and authoritative backend errors.
5. Reduce child navigation to Overview and Routing. Retain the existing accessible tab implementation and workspace-wide Routing label/copy; removing Members from the tabs must not remove member access, which S51 places on Overview.
6. Update `app/src/renderer/styles.css` using existing tokens so the summaries use the available width, collapse cleanly at narrow widths, and do not rely on mockup sample counts, statuses, or messages.
7. Update `app/test/teamsScreen.test.tsx`, `teamsLiveControls.test.tsx`, `teamEdit.test.tsx`, `teamEditEdges.test.tsx`, and `boardControlModel.test.ts` for the new hierarchy and the full existing status/action matrix.

## Done when
- [ ] Overview renders compact, truthful Team status, Board, and Member availability summaries from returned data, including stale, partial, truncated, stopped, unavailable, and another-team states. Test: `teamsScreen.test.tsx` and `teamsLiveControls.test.tsx` fixture matrices.
- [ ] Rename, delete, Run board, and Stop board retain current validation, confirmation, write locks, backend restrictions, selection/refresh behavior, and result feedback. Test: existing focused mutation and board-control suites.
- [ ] Only Overview and Routing remain as child tabs, with keyboard/ARIA behavior unchanged and no loss of workspace-wide routing access. Test: tab navigation cases in `teamsScreen.test.tsx`.
- [ ] `npm --prefix app test`, `npm --prefix app run typecheck`, and `npm --prefix app run build` pass.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
