# P05-S10 — Teams management read model

Status: To Do
Depends on: P05-S08, P05-S09
Architecture: [Teams management architecture](../README.md#architecture-and-gaps)

## Goal
Provide the Teams screen with workspace team/member details, role descriptions, provider/model, availability, and current-work state sourced from configuration and durable runtime evidence. Reference `design/teams-screen-v1.png`; its sample data is not a fixture contract.

## Implement in this order
1. Add a bounded read command joining team definitions/catalog, `roles.json`, and runtime `team.status`/assignment evidence by stable ids.
2. Return explicit unavailable/stale states for stopped teams, disconnected runtime, missing definitions, and partial results; avoid inferring work from tmux or pane output.
3. Test multi-team membership, active and idle/waiting/offline members, assignment linkage, and missing configuration.

## Done when
- [ ] The projection identifies each member and its current work or an explicit no-work/unavailable state. Test: backend unit/integration tests.
- [ ] Role text and provider/model originate from actual workspace data, with bounded output and honest errors. Test: backend tests.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
