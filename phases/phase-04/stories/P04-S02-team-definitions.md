# P04-S02 — Team definitions

Status: To Do
Depends on: P04-S01 (workspace resolution, output helper)
Architecture: [P04 design contract](../README.md#design-contract), §B, §C

## Goal
The operator creates and edits teams with `team add`, `add-member`, `remove-member`, `list`, `show`, `validate` and `import-legacy`, all reading and writing the hand-editable files `.agent-studio/teams/<id>.json`. A hand edit and a command edit never fight each other.

## Implement in this order
1. Definition module: load, validate and save a team file. Saving preserves unknown keys, key order and two-space indentation (round-trip test with a hand-edited fixture).
2. `team add --name N --id ID`: refuses an existing id (`TEAM_EXISTS`). Ids are slugs; member ids are slugs of the name, unique in the team (Q7).
3. `team add-member --team T --name N --role R --provider P [--model M] [--reasoning X]` and `remove-member`. Both print `team validate` warnings after writing (Q6).
4. `team list` and `team show [--team ID]`; the default team is the only one, otherwise `--team` is required (`TEAM_AMBIGUOUS`).
5. `team validate [--team ID]`: unique ids, known provider, role present in `roles.json`, model/reasoning accepted by the provider; nothing is started. Errors are `TEAM_CONFIG_INVALID` with a path to the bad field.
6. Legacy fallback: while `teams/` has no team and `team.json` exists, `team list` and `show` present it as team `default` (read-only). `team import-legacy` converts it once into `teams/<id>.json`. No command writes `team.json`.
7. `team start` is not changed in this story.

## Done when
- [ ] A command edit keeps a hand-added unknown key, key order and indentation. Test: unit round-trip.
- [ ] `validate` reports each rule violation (duplicate id, unknown provider, missing role, bad model) with a field path. Test: unit.
- [ ] The legacy fallback is read-only and `import-legacy` writes a valid team file once, refusing a second run. Test: unit.
- [ ] Human and `--json` output for every command. Test: unit.
- [ ] The existing `team start` with `team.json` still works. Test: existing suites stay green.

## Evidence
(filled in when the story is done)
