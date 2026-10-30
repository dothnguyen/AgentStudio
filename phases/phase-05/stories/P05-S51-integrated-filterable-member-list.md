# P05-S51 — Integrate a filterable member list into Overview

Status: To Do
Depends on: P05-S50
Architecture: [Teams overview and member detail refresh](../README.md#teams-overview-and-member-detail-refresh-t-083)

## Goal
Put the selected team's real member roster directly on Overview and remove the separate Members tab. Make the roster easy to scan and filter while preserving add-member behavior, stable member selection, truthful saved-versus-live values, and access to focused member details.

## Implement in this order
1. Inspect `app/src/renderer/teams/MembersView.tsx`, `MemberList.tsx`, `teamsModel.ts`, `TeamEditForms.tsx`, `TeamOverviewPanel.tsx`, and their tests/fixtures. Recompose these existing parts under Overview rather than keeping a hidden Members panel or duplicating a second roster.
2. Render the roster below the compact summaries with columns/fields for member name, role, active live agent, availability, and current work. Keep the existing labelled saved-default fallback only when no live runtime exists; never present a saved catalog option as active.
3. Add local filters with a labelled text query over returned member name/id, role, live agent, and current-work text plus an availability selector built from the returned presence categories. Filtering must be case-insensitive, must not fetch or mutate data, must preserve the backend order, and must say when no returned members match; a truncated roster must say filtering covers only returned rows.
4. Keep Add member at roster level and reuse `MemberForm`, existing agent/role catalog states, validation, ordered-option semantics, write locks, next-start timing, result feedback, and focus restoration. Runtime-only or uneditable teams must not expose an invalid Add action.
5. Make each stable member row open member detail directly from Overview. Preserve selection by `{teamKey, memberId}` across refresh, clear it when switching teams/workspaces, return focus to the invoking row on Back, and show the existing truthful missing/truncated notice when a selected member disappears.
6. Remove obsolete `members` values from `TeamsChildView`, `TeamViewTabs`, and selection transitions. Ensure refresh, reconnect, role deep links, and Back do not accidentally return to a nonexistent tab.
7. Update `app/test/teamsScreen.test.tsx`, `teamsModel.test.ts`, `teamEdit.test.tsx`, `teamEditEdges.test.tsx`, and `teamsLiveControls.test.tsx` for integrated placement, filter combinations/reset, every presence/work state, saved/live distinction, truncation, add-member flows, selection/removal, and keyboard focus.

## Done when
- [ ] Overview contains the one member roster and there is no Members tab or duplicate hidden roster. Test: structural/role assertions in `app/test/teamsScreen.test.tsx`.
- [ ] Text and availability filters operate only on returned data, preserve order, cover real displayed fields, and explain zero matches and truncated scope. Test: focused filter/model cases.
- [ ] Rows truthfully show role, active live agent or labelled saved fallback, availability, and current work; opening, refreshing, switching teams, Back, and member disappearance preserve stable identity and focus. Test: `teamsScreen.test.tsx`, `teamsModel.test.ts`, and `teamsLiveControls.test.tsx`.
- [ ] Add member retains current validation, catalog/unavailable behavior, ordered options, next-start messaging, mutation locks, and exact backend feedback. Test: `teamEdit.test.tsx` and `teamEditEdges.test.tsx`.
- [ ] `npm --prefix app test`, `npm --prefix app run typecheck`, and `npm --prefix app run build` pass.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
