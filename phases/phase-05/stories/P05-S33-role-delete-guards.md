# P05-S33 — Guard role deletion by references

Status: To Do
Depends on: P05-S30, P05-S32
Architecture: [Roles catalog assumptions](../README.md#open-questions-and-planning-assumptions)

## Goal
Delete only genuinely unused roles, with structured blockers for every supported reference source and conservative behavior whenever reference discovery is incomplete.

## Implement in this order
1. Add `delete_role(workspace, role_id, expected_roles_sha256, expected_instructions_sha256)` and a named `role.delete` dispatch command. Recompute S30 usage at mutation time using a fresh read connection; do not trust renderer-provided counts.
2. Return `ROLE_IN_USE` with structured saved-team/member, legacy roster, board rule, workflow stage, and live-runtime references when any blocker exists. Return `ROLE_USAGE_UNAVAILABLE` when a relevant source is invalid/unreadable or runtime state cannot be checked; both errors write nothing.
3. For an unused role, remove only its `roles.json` entry. Delete its instruction file only when it is the conventional `.agent-studio/roles/<id>.md` path and its SHA matches the confirmation token; preserve custom/shared paths and every skill file. Missing conventional files are harmless but reported in the result.
4. Keep historical stopped agents and frozen assignments intact; they are evidence, not mutable references. Ensure deleting an unused role cannot alter board routing, workflows, team definitions, permissions, agents, or SQLite state.
5. Add `tests/unit/test_p05_s33_role_delete.py` covering every blocker, partial scans, stale tokens, conventional/custom/shared instruction paths, missing files, and atomic failure.

## Done when
- [ ] Each current reference kind independently produces `ROLE_IN_USE` with source-specific details, and combined references are all returned in one response. No referenced role or instruction file is changed.
- [ ] Invalid/unreadable reference sources fail closed with `ROLE_USAGE_UNAVAILABLE`; stale catalog/instruction tokens return `CONFIG_CHANGED` and leave files unchanged.
- [ ] Successful deletion removes only the role and an unchanged conventional owned instruction file, preserves custom/shared files and all skills, and passes `python3 -m unittest tests.unit.test_p05_s33_role_delete`.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
