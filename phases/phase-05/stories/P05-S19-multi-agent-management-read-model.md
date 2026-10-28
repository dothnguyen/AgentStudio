# P05-S19 — Expose multi-agent management read model

Status: To Do
Depends on: P05-S10 (T-040), P05-S18
Architecture: [Multi-agent member options](../README.md#multi-agent-member-options--t-048)

## Goal
Expose saved ordered options and richer runtime through the existing `team.overview` read.

## Implement in this order
1. Change `backend/agent_studio/teamview.py` functions `_runtime_agents(conn, team_id)`, `_member(cfg_member, agent_row, roles_map, catalog, team_state, conn, workspace)`, and `overview(conn, workspace, coordinator_running, runtime_error)`.
2. Return `agentMode: "ordered_catalog" | "single_catalog" | "inline"`, `agentOptions: ResolvedAgentOption[]`, and `defaultAgent: string | null` for every configured member. `ResolvedAgentOption` is `{id: string, name: string | null, provider: string | null, model: string | null, reasoning: string | null, description: string | null, state: "ok" | "missing"}`. Preserve missing references in saved order.
3. Extend runtime with `configuredAgents`, `activeAgent`, `quotaHolds`, `pendingAgent`, `lastSwitch`, provider/model/reasoning, assignment evidence and `stale`. Runtime comes from the database; saved values come from definition/catalog. Follow the phase contract and preserve inline and single-catalog behavior.

## Done when
- [ ] Saved and runtime data remain distinct, including missing references, quota holds and pending switches.
- [ ] Add/extend `tests/unit/test_p05_s10_management_read_model.py` with `test_ordered_options_resolve_in_saved_order`, `test_missing_option_is_explicit`, `test_saved_edit_differs_from_frozen_runtime`, `test_runtime_quota_and_pending_switch_fields`, and `test_inline_and_single_catalog_compatibility`.
- [ ] Run the applicable checks below; integration and live checks use the appropriate environment.

## Project validation commands
- `python3 -m unittest tests.unit.test_member_agent_switch tests.unit.test_p05_s10_management_read_model tests.unit.test_p04_s10_scheduler`
- `python3 -m unittest tests.integration.test_member_agent_switch`
- `npm --prefix app test`
- `npm --prefix app run typecheck`
- `npm --prefix app run build`

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
