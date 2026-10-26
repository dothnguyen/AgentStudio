# P05-S03 — Board status panel with phase progress

Status: To Do
Depends on: P05-S01
Architecture: [P05 architecture](../README.md#architecture)

## Goal
Make board progress scannable through the current phase, completion fraction, compact status counts, and View board action.

## Implement in this order
1. Reshape `app/src/renderer/dashboard/BoardPanel.tsx` and `styles.css` around `DashboardBoard.currentPhase`, all `columns` (`status`, `title`, `count`, `kind`), and bounded `tickets`; calculate fraction from column counts and `done`/`closed` kinds, with a labelled zero-total state. Keep custom status names and any bounded high-priority ticket detail without promising all tickets.
2. Preserve `useDashboardSection` loading/error/retry and `BOARD_CONFIG_INVALID` empty-config handling. Keep View board wired to existing `onNavigate('boards')`; do not request phase descriptions or all-phase totals, which `board.summary` does not provide.
3. Extend `app/test/boardPanel.test.tsx` for zero/custom/many statuses, long phase/ticket text, progress semantics, all states, and navigation.

## Done when
- [ ] Current phase name/status, fraction, progress, and every configured status count are accurate and readable without color. Test: `boardPanel.test.tsx`.
- [ ] Loading, empty board/config, error with Retry, and bounded ticket details are truthful. Test: `boardPanel.test.tsx`.
- [ ] View board is a keyboard-operable native control that selects Boards in `WorkspaceShell`; heading/label/progress have useful screen-reader names. Tests: `boardPanel.test.tsx`, `dashboardA11y.test.tsx`.
- [ ] Count grid reflows without clipping long names or creating horizontal page scroll. Tests: `dashboardStyles.test.ts`, final visual check in S07.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
