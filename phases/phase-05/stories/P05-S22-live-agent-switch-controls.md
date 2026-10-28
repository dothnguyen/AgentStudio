# P05-S22 — Control live member agent switches and holds

Status: To Do
Depends on: P05-S15 (T-045), P05-S20, P05-S21
Architecture: [Multi-agent member options](../README.md#multi-agent-member-options--t-048)

## Goal
Add live switch and resume actions over S20 while keeping the team running.

## Implement in this order
1. Change `app/src/renderer/teams/TeamsScreen.tsx` and add `app/src/renderer/teams/memberAgentActionsModel.ts`. Show active option, actual runtime provider/model, availability, assignment, each hold with formatted reset or "Reset time unknown", pending target and last result. Never infer runtime from saved defaults or pane title.
2. Enable switch only for a running, connected, non-stale member without a pending switch and an eligible frozen runtime option that is neither active nor held. Offer resume for each held option, including inactive options; inline members have no controls. Surface provider failures and all exact backend errors from the phase contract.
3. On active-assignment BAD_REQUEST, open a dialog naming member, target and exact `error.data.assignmentId`. Cancel sends nothing; confirm sends that exact id. A changed assignment requires new consent; never auto-confirm. Return focus accessibly.
4. Disable duplicates while in flight or pending. After acceptance refresh `team.overview` until completed/failed or the normal refresh limit; retain truthful pending on timeout. Optimistic state may say only "Requesting…".
5. Resume success distinguishes `cleared` true/false and never claims quota verification; clearing an inactive hold leaves activeAgent and assignment unchanged.

## Done when
- [ ] Add `app/test/memberAgentActionsModel.test.ts` and extend `app/test/teamsScreen.test.tsx` with `eligible_and_disabled_switch_states`, `exact_assignment_confirmation_and_decline`, `stale_confirmation_requires_new_consent`, `duplicate_switch_blocked`, `pending_completed_and_failed_results`, `inactive_resume_does_not_switch_or_interrupt`, `active_resume_makes_available_when_backend_reports_it`, `all_held_and_unknown_reset_display`, `disconnected_stale_missing_and_permission_errors`, and `keyboard_accessible_dialog_focus_return`.
- [ ] Run the applicable checks below; integration and live checks use the appropriate environment.

## Existing command contract
`team.member.switch` accepts only `workspace`, `teamDefId`, `memberId`, `agent`, `cancelActive`, `assignmentId`; its immediate result is `{teamId, memberId, agentId, activeAgent, provider}` and cancellation result is `{teamId, memberId, agentId, pendingAgent, assignmentId, cancellation}`. `team.member.resume` accepts only `workspace`, `teamDefId`, `memberId`, `agent` and returns `{teamId, memberId, agentId, option, cleared, activeAgent}`. Preserve these errors: "Member has an active assignment; confirm cancellation of this assignment to switch." (`error.data.assignmentId`); "A switch is already pending for this member."; "Agent '<id>' is on quota hold."; "That agent is already active; use board resume when its quota resets."; "The member's pane is not alive."; "Member must be idle or quota-limited before switching."; "Agent '<id>' is not configured for member '<id>'."; "Agent '<id>' is missing from the catalog." Provider failure is `PROVIDER_UNAVAILABLE`, "Provider '<provider>' is not ready: <reason>".

## Project validation commands
- `python3 -m unittest tests.unit.test_member_agent_switch tests.unit.test_p05_s10_management_read_model tests.unit.test_p04_s10_scheduler`
- `python3 -m unittest tests.integration.test_member_agent_switch`
- `npm --prefix app test`
- `npm --prefix app run typecheck`
- `npm --prefix app run build`

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
