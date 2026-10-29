# P05-S30 — Index saved and live role references

Status: To Do
Depends on: P05-S29, P05-S19
Architecture: [Roles catalog architecture](../README.md#verified-architecture-and-contract-gaps)

## Goal
Build a structured role-usage index that powers assigned-member details and makes destructive role operations fail closed when teams, routing, workflows, or a running roster still reference the stable role id.

## Implement in this order
1. Add a pure reference scanner in `backend/agent_studio/rolecatalog.py` (or `roles.py`) that accepts a role id and reports saved team definitions from `teamdefs.list_ids/load`, legacy `.agent-studio/team.json`, `board.json` agent rules, and every non-builtin workspace definition from `workflowdef.list_definitions`/the canonical loader. Include source kind, source id/path, team/member or rule/stage labels, and a bounded display label.
2. In the `role.list` dispatch handler, open the existing read-only state connection as `team.overview` does and add live runtime agent references for teams in `starting` or `running`; join stable `member_id`, team `def_id`/name, availability, and current assignment id/status without treating pane output as evidence.
3. De-duplicate the same member represented by a saved definition and its runtime while preserving both saved/live facts in one assigned-member entry. Keep completed/stopped historical runtime rows out of deletion blockers.
4. Return per-role `usage` with `members`, `boardRules`, `workflows`, `legacyRoster`, `liveRuntime`, `count`, `blocking`, and `partial`. If a team, board, workflow, legacy roster, or runtime source is missing/invalid/unavailable, add a source problem and set `partial`; never report “unused” when the scan is incomplete.
5. Add `tests/unit/test_p05_s30_role_references.py` and focused integration fixtures covering JSON and YAML workflows, duplicate member names, multiple members sharing a role, runtime-only members, invalid sources, and board rules whose workflow also names the role.

## Done when
- [ ] The index finds all listed saved/live reference kinds with stable ids and bounded labels; the same saved/live member renders once with both states. Tests cover two teams sharing a role and a non-default workflow stage.
- [ ] Invalid or unreadable source data produces `partial: true` and never `blocking: false`; disconnected runtime is communicated separately from saved references. Test: `python3 -m unittest tests.unit.test_p05_s30_role_references`.
- [ ] Built-in workflow role names are not treated as workspace-owned deletion blockers unless a saved board/workspace workflow or live member actually references that role.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
