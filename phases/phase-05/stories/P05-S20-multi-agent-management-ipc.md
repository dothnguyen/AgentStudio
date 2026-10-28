# P05-S20 — Expose typed multi-agent management IPC

Status: To Do
Depends on: P05-S12 (T-042), P05-S19
Architecture: [Multi-agent member options](../README.md#multi-agent-member-options--t-048)

## Goal
Extend the typed desktop boundary with named switch and resume methods and ordered member edits.

## Implement in this order
1. In `app/src/shared/management.ts`, add `agents?: string[]` to `TeamMemberConfig`, `ResolvedMember`, `MemberInput`, and `MemberChanges`; add `ResolvedAgentOption`, `RuntimeSwitchState`, quota hold and expanded `OverviewMember` types matching S19. Add `MemberSwitchResult` and `MemberResumeResult` matching the phase contract.
2. Add to `ManagementApi` `switchMemberAgent(workspaceId: string, teamDefId: string, memberId: string, agent: string, confirmation?: {cancelActive: true; assignmentId: string}): R<MemberSwitchResult>` and `resumeMemberAgent(workspaceId: string, teamDefId: string, memberId: string, agent: string): R<MemberResumeResult>`.
3. In `app/src/main/managementSpecs.ts`, add `stringArrayOfSlugs` only for non-empty `agents`, accepting it in add/update; reject duplicates and invalid entries. Map fixed `management:switchMemberAgent` to `team.member.switch` and `management:resumeMemberAgent` to `team.member.resume`. Validate confirmation as an exact object and flatten to `cancelActive`/`assignmentId`; reject unknown fields before invocation.
4. Expose only those named methods via `app/src/preload/preload.ts` and `app/src/shared/api.ts` as needed. No arbitrary commands or new authority.

## Done when
- [ ] Extend `app/test/managementIpc.test.ts` with `forwards_ordered_agents`, `rejects_empty_duplicate_or_invalid_agent_arrays`, `forwards_switch_without_confirmation`, `forwards_exact_assignment_confirmation`, `rejects_partial_or_extra_confirmation`, and `forwards_resume`; extend preload allowlist assertion and run typecheck.
- [ ] Run the applicable checks below; integration and live checks use the appropriate environment.

## Existing command contract
`team.member.switch` accepts only `workspace`, `teamDefId`, `memberId`, `agent`, `cancelActive`, `assignmentId`; its immediate result is `{teamId, memberId, agentId, activeAgent, provider}` and cancellation result is `{teamId, memberId, agentId, pendingAgent, assignmentId, cancellation}`. `team.member.resume` accepts only `workspace`, `teamDefId`, `memberId`, `agent` and returns `{teamId, memberId, agentId, option, cleared, activeAgent}`. Preserve these errors: "Member has an active assignment; confirm cancellation of this assignment to switch." (`error.data.assignmentId`); "A switch is already pending for this member."; "Agent '<id>' is on quota hold."; "That agent is already active; use board resume when its quota resets."; "The member's pane is not alive."; "Member must be idle or quota-limited before switching."; "Agent '<id>' is not configured for member '<id>'."; "Agent '<id>' is missing from the catalog." Provider failure is `PROVIDER_UNAVAILABLE`, "Provider '<provider>' is not ready: <reason>".

## Project validation commands
- `python3 -m unittest tests.unit.test_member_agent_switch tests.unit.test_p05_s10_management_read_model tests.unit.test_p04_s10_scheduler`
- `python3 -m unittest tests.integration.test_member_agent_switch`
- `python3 -m unittest discover -s tests -t .`
- `npm --prefix app test`
- `npm --prefix app run typecheck`
- `npm --prefix app run build`

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
