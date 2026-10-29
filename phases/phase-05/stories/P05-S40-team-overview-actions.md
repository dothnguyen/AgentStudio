# P05-S40 — Build the focused team overview and actions

Status: To Do
Depends on: P05-S39
Architecture: [Focused Teams views](../README.md#focused-teams-views-t-073)

## Goal
Give the selected team a compact Overview that explains definition, runtime, member, and board status and keeps common team and board actions discoverable. Preserve every existing backend restriction and result rather than inferring whether an operation is safe.

## Implement in this order
1. Extract the selected-team header and overview composition from `TeamsScreen.tsx` into focused components under `app/src/renderer/teams/`; reuse `teamsModel.ts`, `boardControlModel.ts`, `TeamNameForm`, and `WriteFeedbackView` rather than duplicating status or error mapping.
2. Render the team display name/stable id, definition state/problems, runtime state/id, member count/truncation, aggregate member availability derived only from returned members, coordinator/runtime availability, and the current board-runner relationship (this team, another team, stopped, unbound, disconnected, or unavailable). Do not invent a description or aggregate omitted members.
3. Keep New team in the browser/header and move Rename team and Delete team into the selected-team Overview action area. Preserve `canEditTeam`, running-team notes, confirmation, write locking, `appliesOnNextStart`, problem suffixes, post-success selection, and all authoritative mutation errors.
4. Keep `BoardControl` on Overview and preserve `board.run`/`board.stop` behavior: exact runtime team id, disabled states, rapid-click locking, pending-not-success feedback, stopped-board explanation, another-team conflict, reconnection behavior, and refresh of both overview and board settings after any result.
5. Add compact responsive styling in `app/src/renderer/styles.css` using existing tokens, with no fixed sample names, counts, or statuses.
6. Reorganize `app/test/teamsScreen.test.tsx`, `teamEdit.test.tsx`, `teamEditEdges.test.tsx`, `teamsLiveControls.test.tsx`, and `boardControlModel.test.ts` to address the Overview panel and retain create/rename/delete and board-control regression cases.

## Done when
- [ ] Overview truthfully distinguishes definition, team runtime, coordinator, and board-runner states, including another-team, stopped, disconnected, unavailable, partial, and truncated cases. Test: focused `teamsScreen` and `teamsLiveControls` component cases.
- [ ] Create, rename, and delete retain current validation, active-team restrictions, confirmation, refresh/selection, next-start copy, and backend error feedback. Test: `teamEdit.test.tsx` and `teamEditEdges.test.tsx`.
- [ ] Run/stop sends the existing typed calls once, uses the selected runtime id, never reports a pending/error outcome as success, and disables unsafe or duplicate submissions. Test: `teamsLiveControls.test.tsx` and `boardControlModel.test.ts`.
- [ ] `npm --prefix app test`, `npm --prefix app run typecheck`, and `npm --prefix app run build` pass.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
