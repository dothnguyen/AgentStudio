# P05-S32 — Save shared role instructions safely

Status: To Do
Depends on: P05-S31
Architecture: [Roles catalog assumptions](../README.md#open-questions-and-planning-assumptions)

## Goal
Edit the actual shared role instruction file with independent optimistic concurrency and prove that successful saves affect only assignments created afterward while in-flight requests retain frozen context evidence.

## Implement in this order
1. Add `update_instructions(workspace, role_id, text, expected_roles_sha256, expected_instructions_sha256)` in the role catalog backend and expose `role.instructions.update`. Require bounded valid UTF-8 text; reuse `_inside` and reject absolute, parent, or symlink-escaping configured paths.
2. For an existing valid `instructions` path, atomically replace that exact file and preserve the path. For a role without a path, select `.agent-studio/roles/<role-id>.md`, atomically create it, and update `roles.json`; create directories safely. Define blank text as a saved empty file, not deletion, so intent is never inferred.
3. Check both tokens before either write. If the roles file/path or instruction bytes changed since read, return `CONFIG_CHANGED` with fresh tokens and write nothing. Stage temporary files and restore/clean them on failure so the JSON never points to missing new content and partial writes are covered by fault-injection tests.
4. Preserve current `roles.context_for`, `tasks.build_request`, runner, and assignment evidence contracts. Add an integration test that creates assignment A, saves changed instructions, creates assignment B, and proves A retains the old text/SHA/source while B has the new values; team restart is not required.
5. Add `tests/unit/test_p05_s32_role_instructions.py` and `tests/integration/test_p05_s32_role_dispatch.py`; retain path/limit coverage in `tests/unit/test_s08_settings_roles.py` and provider context coverage in `tests/integration/test_s08_providers.py`.

## Done when
- [ ] Existing custom and conventional paths save in place; first save for a pathless role creates the conventional file and reference atomically. Tests cover empty, Unicode, size boundary, missing file, escaping symlink, stale role token, stale file token, and injected write failure.
- [ ] A save response says changes apply to new assignments; automated integration proves old assignment context is unchanged and the next assignment uses the new role context hash/content without a team restart.
- [ ] `python3 -m unittest tests.unit.test_p05_s32_role_instructions tests.integration.test_p05_s32_role_dispatch tests.integration.test_s08_providers` passes.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
