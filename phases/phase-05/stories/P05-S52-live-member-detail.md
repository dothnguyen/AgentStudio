# P05-S52 — Make live state primary in member detail

Status: In Progress
Depends on: P05-S51
Architecture: [Teams overview and member detail refresh](../README.md#teams-overview-and-member-detail-refresh-t-083)

## Goal
Recompose member detail around a focused Live section that makes the active agent, availability, assignment, frozen live options, switch outcomes, and quota recovery easy to understand. Preserve the exact active-assignment cancellation confirmation and backend-controlled switching/resume behavior.

## Implement in this order
1. Inspect `app/src/renderer/teams/MemberDetailPanel.tsx`, `MemberLiveAgentActions.tsx`, `memberAgentActionsModel.ts`, `TeamsScreen.tsx` action/polling controller, and `app/test/teamsLiveControls.test.tsx`. Keep one owner for locks, timers, matching switch evidence, confirmation generations, reconnect behavior, and unmount cleanup.
2. Move the Live section immediately below the member header/breadcrumb and show returned active agent provider/model/reasoning, availability, pane/stale state, current assignment/ticket, pending target, and last switch result without repeating a second active-agent/availability/work summary elsewhere in the detail.
3. Present live agent options only from the runtime's frozen `configuredAgents` plus truthful quota-only recovery entries. Distinguish active, switchable, held, missing-catalog, unavailable-provider, pending, pane-dead, and ineligible options with text; when runtime or eligibility evidence is unavailable, explain why controls are unavailable and do not fall back to saved options.
4. Preserve idle switching and durable outcome polling exactly: one typed `team.member.switch` request, matching member/target/signature evidence, bounded polling, truthful pending/failed/timeout/disconnect copy, and no optimistic claim that the active agent changed.
5. Preserve the active-assignment confirmation modal naming the member, target agent, and exact assignment id. Submit `cancelActive: true` with that id only after confirmation, re-confirm a changed assignment id, trap/restore focus, support Escape, and close safely when team/member/workspace selection changes.
6. Preserve per-option Resume behavior: clear only the named quota hold, say quota was not verified, distinguish active from inactive options, never switch or cancel work as a side effect, and refresh availability from backend evidence.
7. Update `app/test/memberAgentActionsModel.test.ts`, `teamsLiveControls.test.tsx`, and `teamsScreen.test.tsx` for the new hierarchy and all existing switch, assignment-change, polling, hold, resume, stale, missing, disconnect, cleanup, and modal-focus cases.

## Done when
- [ ] Member detail has one primary Live section showing only returned runtime/assignment evidence and no duplicated or saved-as-live values. Test: `teamsScreen.test.tsx` and `teamsLiveControls.test.tsx` structure/copy cases.
- [ ] Frozen options, disabled reasons, pending/last outcomes, quota holds, and unavailable states remain truthful and each switch/resume request is submitted at most once. Test: `memberAgentActionsModel.test.ts` and `teamsLiveControls.test.tsx`.
- [ ] Switching during work still requires fresh confirmation of the exact assignment id, re-confirms changed work, and preserves dialog trapping/restoration and selection-change cleanup. Test: assigned-switch keyboard and race cases.
- [ ] Resume clears only the requested hold, never silently switches or cancels, and reports refreshed backend state without claiming quota verification. Test: active/inactive/unknown-reset cases.
- [ ] `npm --prefix app test`, `npm --prefix app run typecheck`, and `npm --prefix app run build` pass.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
