# P05-S54 — Finish Teams v4/v6 states, accessibility, and responsiveness

Status: To Do
Depends on: P05-S49, P05-S50, P05-S51, P05-S52, P05-S53
Architecture: [Teams overview and member detail refresh](../README.md#teams-overview-and-member-detail-refresh-t-083)

## Goal
Complete automated regression coverage and layout polish for the sidebar navigation, integrated Overview roster, and live/saved member detail. Ensure the redesign remains truthful, keyboard accessible, focus-safe, and usable across narrow windows, long real data, connection changes, and workspace changes.

## Implement in this order
1. Audit the implemented delta against the T-083 state matrix in `app/test/teamsScreen.test.tsx`, `teamsLiveControls.test.tsx`, `workspaceShell.test.tsx`, `teamEdit*.test.tsx`, `teamsFixtures.ts`, and `app/src/renderer/styles.css`. Do not add a live/manual acceptance gate or mockup sample data.
2. Add fixtures for zero/one/many teams, zero/one/many members, truncated/partial overview, invalid definition, stopped/starting/running/error runtime, board stopped/running-for-this/running-for-other/unavailable, every member presence/work state, missing role/agent references, quota holds, pending/failed switch, and loading/stale/error/disconnected reads.
3. Prove keyboard operation and focus order for workspace Teams, nested team rows, New team, Overview/Routing tabs, filters, member rows, Back, Live switch/resume, saved Edit/Save/Discard, role deep link, and destructive confirmations. Assert current/selected/expanded/modal semantics, labelled controls/status announcements, focus restoration, Escape behavior, and no color-only status.
4. Add stale-response and identity regressions for rapid team/member/workspace changes, refresh reorder/removal, connection loss/recovery, in-flight create/edit/delete, switch polling, and unmount. Responses from a previous workspace or member must never overwrite current selection, feedback, Live state, or saved form state.
5. Refine responsive CSS using existing tokens: keep the sidebar/nested team list usable, let summary cards and roster collapse without horizontal page overflow, retain a scrollable region only where a table truly needs it, keep dialogs within the viewport, wrap long ids/names/errors, and maintain visible `:focus-visible` indicators and reduced-motion behavior.
6. Run the full renderer test, typecheck, and production build commands after focused suites; fix regressions without weakening assertions for the behavior preserved from T-073.

## Done when
- [ ] Automated fixtures cover the listed team, board, member, catalog, partial, stale, error, and connection states with truthful real-data rendering and no illustrative fallback content. Test: `app/test/teamsScreen.test.tsx`, `teamsLiveControls.test.tsx`, and `teamsFixtures.ts`.
- [ ] All navigation, filtering, detail, live, saved, and confirmation controls are keyboard operable with correct names/state, visible focus, deterministic restoration, and non-color status text. Test: React keyboard/focus/ARIA assertions.
- [ ] Workspace/team/member races and stale responses cannot leak selection, feedback, form data, or live outcomes into the new context. Test: deferred-promise and rerender regressions.
- [ ] Wide, medium, and narrow CSS contracts avoid page-level horizontal overflow, keep dialogs bounded, and preserve readable summaries/roster/detail with long content and reduced motion. Test: class/style assertions plus production build.
- [ ] `npm --prefix app test`, `npm --prefix app run typecheck`, and `npm --prefix app run build` pass.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
