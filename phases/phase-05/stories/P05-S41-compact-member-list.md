# P05-S41 — Add the compact member list

Status: To Do
Depends on: P05-S39
Architecture: [Focused Teams views](../README.md#focused-teams-views-t-073)

## Goal
Make the Members view a compact, readable roster that shows who each member is, their assigned role, active live agent, availability, and current work. A row opens the focused member view without mixing full forms and live controls into the roster.

## Implement in this order
1. Extract the current member-row formatting from `TeamsScreen.tsx` and `teamsModel.ts` into a focused member-list component. Keep `OverviewMember` as the only source and retain helpers for member name, role state, presence tone/label, live agent text, and current work.
2. Render columns/fields for member name, assigned role display name plus stable id when available, active runtime agent, availability, and current assignment/ticket. Use saved default agent only as a clearly labelled saved fallback when no runtime exists; never label a saved option as active.
3. Represent `idle`, `busy`, `waiting_input`, `limit_reached`, `offline`, stopped/not-started, stale, and unavailable states with text as well as color. Show ticket key/title or assignment goal/id only when supplied, and preserve explicit unavailable reasons and missing role/agent diagnostics.
4. Make each member an accessible link-style button that opens the selected member detail using the S39 view state. Support Enter/Space, visible focus, a clear current selection, stable member-id preservation across refresh, and a truthful fallback if a selected member disappears.
5. Keep Add member discoverable at the Members-view level but leave the form implementation to S42. Show member truncation and an empty-roster message without sample data.
6. Update `app/test/teamsScreen.test.tsx`, `teamsLiveControls.test.tsx`, `teamsModel.test.ts`, and fixtures in `app/test/teamsFixtures.ts` for saved-versus-live values, every availability/work state, missing values, long labels, truncation, selection, and removed-member refresh.

## Done when
- [ ] Each roster item shows only returned member identity, role, active live agent (or labelled saved fallback), availability, and current work, with no invented data and no role-owned permission/agent claim. Test: `teamsScreen.test.tsx` and `teamsModel.test.ts`.
- [ ] Availability/work cases remain distinguishable without color, and missing, stopped, stale, partial, and unavailable evidence has meaningful copy. Test: `teamsLiveControls.test.tsx` fixture matrix.
- [ ] Keyboard activation opens the exact stable member, and refresh/removal cannot leave a detail view pointing at another member. Test: `teamsScreen.test.tsx`.
- [ ] `npm --prefix app test`, `npm --prefix app run typecheck`, and `npm --prefix app run build` pass.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
