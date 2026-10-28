# P05-S21 — Edit ordered member agent options

Status: To Do
Depends on: P05-S14 (T-044), P05-S20
Architecture: [Multi-agent member options](../README.md#multi-agent-member-options--t-048)

## Goal
Edit saved ordered catalog membership without changing live state.

## Implement in this order
1. In `app/src/renderer/teams/teamEditModel.ts`, use `agents: string[]` in `MemberFormValues`; add pure `addAgentOption`, `removeAgentOption`, `moveAgentOption`, `validateAgentOptions`, and `memberChanges` behavior. Use exactly "Choose at least one agent.", "Each agent can appear only once.", and "Remove or replace missing catalog agents before saving."
2. In `app/src/renderer/teams/TeamEditForms.tsx`, replace the single select with ordered rows showing name, provider/model, reasoning, Default at index zero, and Move up, Move down, Remove buttons with agent-specific accessible labels. Add offers remaining catalog entries; buttons provide the keyboard path.
3. Open a single-catalog member as one option without rewriting it unless options change. Preserve inline provider/model/reasoning when editing name/role/canAddTickets; require a deliberate "Use catalog agents" action to convert. Preserve identity and role.
4. In `app/src/renderer/teams/TeamsScreen.tsx` and `teamsModel.ts`, separate "Saved options" from "Live agent"; when `appliesOnNextStart`, say "Saved configuration applies on the next team start; the running member is unchanged."

## Done when
- [ ] Extend `app/test/teamEditModel.test.ts` and `app/test/teamsScreen.test.tsx` with `ordered_add_remove_reorder_default`, `duplicate_and_missing_options_block_save`, `single_catalog_is_not_silently_rewritten`, `inline_member_preserves_provider_fields`, `preserves_role_identity_and_can_add_tickets`, and `saved_options_are_distinct_from_live_agent`. Assert keyboard operation and names for every reorder/remove control.
- [ ] Run the applicable checks below; integration and live checks use the appropriate environment.

## Project validation commands
- `python3 -m unittest tests.unit.test_member_agent_switch tests.unit.test_p05_s10_management_read_model tests.unit.test_p04_s10_scheduler`
- `python3 -m unittest tests.integration.test_member_agent_switch`
- `python3 -m unittest discover -s tests -t .`
- `npm --prefix app test`
- `npm --prefix app run typecheck`
- `npm --prefix app run build`

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
