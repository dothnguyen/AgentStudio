# P05-S07 — Responsive and accessibility finish

Status: To Do
Depends on: P05-S02, P05-S03, P05-S04, P05-S05, P05-S06
Architecture: [P05 architecture](../README.md#architecture)

## Goal
Finish the reference-inspired layout as one coherent Home screen and prove it remains usable at supported narrow widths and across all data states.

## Implement in this order
1. Tune `app/src/renderer/styles.css`, `shell/WorkspaceShell.tsx`, `dashboard/DashboardHome.tsx`, `BoardPanel.tsx`, `TeamsPanel.tsx`, and `ActivityPanel.tsx`: four summary cards, wide Board beside Team, full-width Activity, consistent tokens/icons/spacing/borders/focus, no large accidental blank regions; reflow at the app minimum width. Check long workspace/path/phase/team/ticket strings and localized timestamps. Use only the existing `DashboardApi.teams/board/activity` and `ConnectionStatus` contracts in `app/src/renderer/api.ts`; keep loading, error/retry, empty, and unavailable states distinct.
2. Audit landmarks, one `h1`, panel `h2`s, table/list semantics, status text alongside color, accessible names, reduced motion, keyboard order, and focus for Refresh, Retry, navigation and Switch workspace. Keep all loading/error/empty states visible and usable.
3. Extend `app/test/dashboardStyles.test.ts`, `dashboardA11y.test.tsx`, `workspaceShell.test.tsx`, and relevant component tests; run `npm --prefix app test`, `npm --prefix app run typecheck`, `npm --prefix app run build`; record screenshot/visual evidence against `design/workspace-dashboard-v2.png` at desktop and supported narrow width.

## Done when
- [ ] Home follows reference hierarchy/proportions and has no accidental blank regions; desktop and narrow-width visual evidence is recorded. Test: screenshots/visual review.
- [ ] No clipping, overlap, or horizontal page scroll with worst-case strings/timestamps and loading/error/zero states. Tests: `dashboardStyles.test.ts` plus visual review.
- [ ] Heading/landmark structure, focus, semantic feed/counts, accessible status names and contrast/reduced-motion expectations pass. Test: `dashboardA11y.test.tsx`.
- [ ] Existing behavior tests remain and all app tests, typecheck and production build pass. Tests: `npm --prefix app test`, `npm --prefix app run typecheck`, `npm --prefix app run build`.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
