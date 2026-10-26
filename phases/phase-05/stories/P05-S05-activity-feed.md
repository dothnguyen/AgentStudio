# P05-S05 — Compact recent activity feed

Status: To Do
Depends on: P05-S01
Architecture: [P05 architecture](../README.md#architecture)

## Goal
Turn recent activity into a full-width, aligned Event/Type/Time feed while preserving the bounded read result and exact event meaning.

## Implement in this order
1. Reshape `app/src/renderer/dashboard/ActivityPanel.tsx` and `styles.css` using `DashboardActivity.entries[]` (`id`, `summary`, `kind`, ISO `at`) and existing `formatActivityTime`; keep newest response order and the 15-entry display cap. Use semantic table or equivalent labelled column relationships and `<time dateTime>`; keep full event text accessible when visually truncated.
2. Preserve loading, empty, error/retry and section refresh behavior. Show the returned count/scope honestly; do not invent unseen events or relative times.
3. Extend `app/test/activityPanel.test.tsx` for every kind, localized/long timestamps and summaries, 15-entry bound, semantic columns, invalid date fallback, all states, and keyboard Retry.

## Done when
- [ ] Event, Type, and Time align and remain associated for screen readers; each row uses API summary/kind/time and machine-readable time. Tests: `activityPanel.test.tsx`, `dashboardA11y.test.tsx`.
- [ ] Empty/loading/error/retry and bounded-list states are truthful and only activity retry calls `DashboardApi.activity`. Test: `activityPanel.test.tsx`.
- [ ] Long events/timestamps do not clip or force horizontal page scroll at narrow widths; Retry shows keyboard focus. Tests: `dashboardStyles.test.ts`, final visual check in S07.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
