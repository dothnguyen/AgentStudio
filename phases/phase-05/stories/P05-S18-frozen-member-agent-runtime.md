# P05-S18 — Freeze member agent runtime options and project switch results

Status: To Do
Depends on: P05-S09 (T-039)
Architecture: [Multi-agent member options](../README.md#multi-agent-member-options--t-048)

## Goal
Close only runtime freezing and switch-result projection; retain the existing switching and failover implementation.

## Implement in this order
1. In `backend/agent_studio/schema.py`, migrate `agents` with `configured_agents_json TEXT`: null for legacy/inline runtimes, exact start-time id array for ordered catalog runtimes.
2. In `backend/agent_studio/teams.py`, have `team_start` write it and have `switch_member_agent`, `resume_member_agent`, `handle_quota_limit`, and `recover_expired_quotas` use the frozen runtime list. Definition edits apply only after restart.
3. In `backend/agent_studio/teamstatus.py`, add `configuredAgents: string[] | null` and `lastSwitch: null | {state: "pending" | "completed" | "failed", requestedAgent: string, assignmentId: string | null, code: string | null, message: string | null, at: string}`. Derive the latest result from pending columns and `agent.switch_requested`, `agent.option_switched`, and `agent.switch_failed` events.
4. Preserve command arguments, returns, exact errors, events, quota behavior and coordinator-only writes. Apply the restart selection and hold rules in the phase contract.

## Done when
- [ ] Frozen eligibility survives definition edits until restart; existing failover, exhaustion, resume, cancellation, board recovery and persistence remain intact.
- [ ] Extend `tests/unit/test_member_agent_switch.py` with `test_running_options_are_frozen_until_restart`, `test_status_projects_completed_switch`, `test_status_projects_pending_switch`, `test_status_projects_failed_switch`; retain scheduler tests.
- [ ] Extend `tests/integration/test_member_agent_switch.py` with `test_definition_edit_applies_to_switching_only_after_restart`.
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
