# P05-S29 — Project the workspace role catalog

Status: To Do
Depends on: P05-S10, P05-S24
Architecture: [Roles catalog architecture](../README.md#verified-architecture-and-contract-gaps)

## Goal
Provide one bounded, read-only backend projection for Roles that preserves the current `roles.json`, instruction-file, and skill semantics while exposing enough structured state for a truthful catalog/detail screen.

## Implement in this order
1. In `backend/agent_studio/roles.py` (or a focused `rolecatalog.py` called from it), add `list_roles(workspace)` without weakening `load_config` or `context_for`. Return workspace, catalog `state`, `sha256`, ordered `items`, catalog-level `problems`, and an `availableSkills` list derived only from safe immediate `.agent-studio/skills/<id>/SKILL.md` folders.
2. Project each role as `{id, name, description, instructions, skills, warnings, problems}`. `name` is the optional trimmed `spec.name` or the id; `instructions` contains the configured relative path, bounded UTF-8 text, SHA-256/bytes when readable, and `state: ok|none|missing|invalid|truncated`; each configured skill contains its id and `state: ok|missing` in saved order.
3. Reuse `_inside`, `_read`, `LIMITS`, `SKILL_RE`, and `context_for` warnings. Never follow escaping symlinks, expose absolute paths, read arbitrary files, or hide missing/truncated instruction and skill warnings. Preserve unknown role fields in storage but do not expose them as editor fields.
4. Extend role config validation to accept optional non-empty bounded `name`; report case-insensitive duplicate explicit/display names as structured catalog problems keyed by stable ids. Keep legacy roles without names readable and distinguish invalid JSON/schema (catalog unavailable) from per-role repairable problems.
5. Add a named `role.list` request in `backend/agent_studio/dispatch.py`. Use the existing canonical workspace checks and add unit coverage in `tests/unit/test_p05_s29_role_catalog.py`, retaining `tests/unit/test_s08_settings_roles.py` for compatibility.

## Done when
- [ ] `role.list` returns stable file order, stable ids, display names, descriptions, bounded instruction text/tokens, ordered skill states, available skills, resolution warnings, and no absolute path. Tests cover missing catalog, empty catalog, conventional/custom instruction paths, missing files/skills, truncation, invalid UTF-8, and escaping symlinks.
- [ ] Existing `roles.json` without `name` remains valid and displays the id; duplicate normalized names are explicit problems and do not collapse entries. Test: `python3 -m unittest tests.unit.test_p05_s29_role_catalog tests.unit.test_s08_settings_roles`.
- [ ] Read operations make no writes and do not alter `context_for` output/hashes for an unchanged workspace. Test snapshots files before/after and compares role context fixtures.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
