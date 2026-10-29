# P05-S43 — Preserve live agent actions in member detail

Status: To Do
Depends on: P05-S42, P05-S22
Architecture: [Focused Teams views](../README.md#focused-teams-views-t-073)

## Goal
Move the existing live active-agent, assignment, quota-hold, switch, and resume experience into the focused member view without weakening cancellation safety. Keep frozen runtime eligibility and backend results authoritative while saved configuration remains a separate next-start concept.

## Implement in this order
1. Move the live controls from `TeamsScreen.tsx` into focused member-detail components while keeping one owning action controller for locks, polling, refresh serialization, timers, feedback, and unmount cleanup. Reuse `memberAgentActionsModel.ts`; do not duplicate switch eligibility logic in JSX.
2. Show Active agent from runtime provider/model/reasoning evidence, availability, stale/pending/last-switch status, quota holds with known reset time or “Reset time unknown”, and current assignment id/status/task id. When runtime is absent or unavailable, explain that live controls are unavailable instead of falling back to saved data.
3. List the frozen `configuredAgents` in runtime order for live switching/resume and separately label saved `agentOptions` as next-start configuration. Retain missing/removed frozen options and quota-only options for truthful recovery; inline, no-runtime, and single-option members expose no invalid switch target.
4. Preserve `team.member.switch` behavior and exact server errors. An idle eligible switch submits once and refreshes/polls for matching `lastSwitch`; provider unavailable, held, pending, pane-dead, not-idle, unconfigured, or missing-agent outcomes remain visible with remediation/data.
5. For an active assignment, retain the explicit modal naming the member, target, and exact assignment id. Require `cancelActive: true` with that id, re-confirm if the backend reports a changed assignment, trap/restore focus, support Escape, and never imply cancellation or switching completed before refreshed durable evidence.
6. Preserve `team.member.resume` semantics: clear only the named hold, say quota was not verified, distinguish active from inactive option, do not switch or interrupt an inactive option, and refresh availability from the backend.
7. Update `app/test/memberAgentActionsModel.test.ts`, `teamsScreen.test.tsx`, and `teamsLiveControls.test.tsx` for idle and assigned switches, changed-assignment confirmation, polling completion/failure/timeout, rapid clicks, pending switch, known/unknown resets, active/inactive resume, missing options, disconnect/unmount cleanup, and modal focus.

## Done when
- [ ] Member detail truthfully separates saved next-start options from frozen live options, active runtime data, holds, pending/last switch evidence, and assignment evidence. Test: `teamsScreen.test.tsx` and `memberAgentActionsModel.test.ts`.
- [ ] Every switch/resume disabled state and backend error remains safe and meaningful; repeated clicks issue one call and polling accepts only matching durable switch evidence. Test: `teamsLiveControls.test.tsx`.
- [ ] Switching during work requires fresh explicit confirmation of the exact assignment id, uses the existing safe cancellation request, and restores/traps focus correctly. Test: assigned-switch and dialog keyboard cases.
- [ ] Resume preserves active-versus-inactive behavior and states that quota is not verified. Test: active/inactive/unknown-reset component cases.
- [ ] `npm --prefix app test`, `npm --prefix app run typecheck`, and `npm --prefix app run build` pass.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
