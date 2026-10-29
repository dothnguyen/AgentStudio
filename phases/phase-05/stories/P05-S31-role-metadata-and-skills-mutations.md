# P05-S31 — Create roles and edit metadata and skills

Status: To Do
Depends on: P05-S29
Architecture: [Roles catalog assumptions](../README.md#open-questions-and-planning-assumptions)

## Goal
Add atomic role create and metadata/skill update commands while keeping the `roles.json` object key immutable and using an optional display name for safe user-facing rename.

## Implement in this order
1. Add `create_role(workspace, input, expected_sha256)` and `update_role(workspace, role_id, changes, expected_sha256)` in the role catalog backend. Create accepts optional slug `id` or derives one using the existing team/agent slug conventions, plus `name`, optional `description`, and ordered `skills`; update allowlists only `name`, `description`, and `skills` and never moves the map key.
2. Validate trimmed bounded names/descriptions, `SKILL_RE` ids, duplicate skill ids, stable-id collisions, and case-insensitive display-name collisions. Missing skills may be saved but return warnings; malformed catalogs and repairable duplicate legacy names remain inspectable, and updating one affected role may resolve its own name problem without rewriting peers.
3. Preserve role order, `instructions`, `directTask`, unknown role fields, top-level unknown fields, and custom formatting semantics except for the existing canonical JSON rewrite. Use `_check_expected`/atomic replace behavior; `CONFIG_CHANGED` returns the current roles SHA and writes nothing.
4. Replace `boardsettings.update_role`/`role.update` with the new narrow role commands or keep a backward-compatible adapter so `RoutingSettingsPanel` continues to work until S35 removes its description editor. Add `role.create` and `role.update` dispatch validation with structured field problems.
5. Cover operations in `tests/unit/test_p05_s31_role_mutations.py` and extend `tests/unit/test_p05_s11_board_settings.py` for compatibility during the transition.

## Done when
- [ ] Create assigns a unique immutable stable id and a conventional instruction path only when instructions are later saved; update changes display name/description/skills without changing any team, board, workflow, or runtime reference. Tests compare all referencing files byte-for-byte.
- [ ] Duplicate ids/names, empty/oversized fields, duplicate/bad skill ids, stale SHA, and invalid catalogs return actionable errors and leave every file unchanged.
- [ ] Existing `directTask`, `instructions`, custom role/top-level fields, role order, and missing configured skills survive round trips. Test: `python3 -m unittest tests.unit.test_p05_s31_role_mutations tests.unit.test_p05_s11_board_settings`.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
