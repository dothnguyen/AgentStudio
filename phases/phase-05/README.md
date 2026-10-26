# Phase 05 — Workspace dashboard redesign v2

## Goal

Redesign Home into the compact operational overview in [the visual reference](../../design/workspace-dashboard-v2.png), while preserving the dark theme, navigation, and read-only dashboard behavior. Operators should scan real workspace, team, board, and activity data quickly at desktop and narrow widths.

## Open questions and assumptions

- **Question:** Should “open” and “completed” cover every board phase? **Assumption:** No; `board.summary` returns the effective current phase only, so cards say “Current phase” and derive open from non-`done`/`closed` columns and completed from `done`/`closed` columns. No cross-phase value is claimed.
- **Question:** Should the five pictured agent portraits and a phase description be shown? **Assumption:** No; `team.list` exposes aggregate availability, member count, and assignment count, but not individual identities/presence; `board.summary` has phase name/status but no description. Use aggregate presence labels and phase name/status. Do not invent portraits or copy.
- **Question:** Which team should the panel emphasize when several exist? **Assumption:** Show a compact list of all returned teams, led by running teams, with a truncation notice when `team.list` says so. Never imply a single team represents the workspace.
- **Question:** What counts as “last updated”? **Assumption:** The last complete successful refresh of all three sections; keep the prior timestamp when any section fails and label partial/stale data clearly. This needs coordinated response tracking in the renderer, not a new backend command.

## Architecture

The existing renderer uses `WorkspaceShell.tsx` and `navModel.ts` for navigation, `DashboardHome.tsx` for composition, `useDashboardSection.ts` for per-section loading and stale-response protection, and `TeamsPanel.tsx`, `BoardPanel.tsx`, `ActivityPanel.tsx` for read-only content. `DashboardApi` in `app/src/renderer/api.ts` exposes `teams(workspaceId)`, `board(workspaceId)`, and `activity(workspaceId)`, mirrored in `app/src/shared/api.ts`; existing IPC maps those to `team.list`, `board.summary`, and `activity.recent`. The Home activity panel calls `activity.recent` with `{ limit: 15, kinds: ['ticket'] }`, so it lists ticket events only (moved, outcome applied, merged); the backend filters by kind before applying `limit`, and callers that omit `kinds` still get all kinds (`team`, `assignment`, `workflow`, `ticket`). Preserve these contracts and the allowlisted preload surface. `board.summary` contains current phase, configured status columns with counts/kinds, totals, and a bounded ticket projection; `team.list` contains up to 50 definitions, optional runtimes, aggregate availability, and `truncated`; `activity.recent` contains bounded entries with `summary`, `kind`, and ISO `at`. The sketch's numbers are illustrative; every rendered value must come from these responses or be explicitly unavailable.

Use the current CSS tokens and responsive foundations in `app/src/renderer/styles.css`. Keep one main landmark, one Home `h1`, panel `h2`s, text alongside status colors, native buttons for navigation/refresh/retry, and independent section errors. Existing destination placeholders remain outside scope.

## Epics → stories

| Epic | Story | Outcome |
|---|---|---|
| Shell and identity | [P05-S01](./stories/P05-S01-shell-and-header.md) | Compact sidebar and overview header |
| Scan metrics | [P05-S02](./stories/P05-S02-summary-metrics.md) | Four truthful summary cards |
| Operational panels | [P05-S03](./stories/P05-S03-board-status.md) | Current-phase board progress and counts |
| | [P05-S04](./stories/P05-S04-team-status.md) | Team runtime and aggregate availability |
| | [P05-S05](./stories/P05-S05-activity-feed.md) | Structured recent activity feed |
| State integrity | [P05-S06](./stories/P05-S06-refresh-coordination.md) | Truthful full-refresh timestamp and race handling |
| Finish | [P05-S07](./stories/P05-S07-responsive-accessibility.md) | Narrow-width and accessibility polish; full validation |

Dependencies allow the three panels to land independently after the shell, while the final validation story follows the whole layout.
