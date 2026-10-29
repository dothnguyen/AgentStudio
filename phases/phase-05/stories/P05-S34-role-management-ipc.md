# P05-S34 — Expose typed role management IPC

Status: To Do
Depends on: P05-S29, P05-S30, P05-S31, P05-S32, P05-S33, P05-S12
Architecture: [Roles catalog architecture](../README.md#verified-architecture-and-contract-gaps)

## Goal
Expose role list/create/update/instruction-save/delete through typed, named Electron IPC while preserving workspace-id resolution and preventing renderer-controlled paths or arbitrary backend commands.

## Implement in this order
1. Define exact role catalog, instruction state, skill state, usage/reference, problem, mutation input/result, and error-data types in `app/src/shared/management.ts`; add `roles`, `createRole`, `updateRole`, `updateRoleInstructions`, and `deleteRole` to `ManagementApi`.
2. Replace the old description-only `updateRole` signature compatibly across callers. Renderer requests carry stable role ids, allowlisted editable values, and SHA tokens only; they never carry a filesystem path, workspace path, backend command name, or claimed usage result.
3. Add fixed channels/specs in `app/src/main/managementSpecs.ts`, handlers through the existing management IPC registration, and preload methods/constants in `app/src/preload/preload.ts`. Resolve workspace ids in main and forward only `role.list`, `role.create`, `role.update`, `role.instructions.update`, and `role.delete`.
4. Update the renderer API guard in `app/src/renderer/api.ts` and fixtures in `app/test/teamsFixtures.ts` (or a focused role fixture). Preserve structured backend errors including `CONFIG_CHANGED`, `ROLE_IN_USE`, `ROLE_USAGE_UNAVAILABLE`, `ROLES_CONFIG_INVALID`, and field problems.
5. Extend `app/test/managementSpecs.test.ts`, `app/test/managementIpc.test.ts`, `app/test/preload.test.ts`, and `app/test/rendererApi.test.ts` for happy paths, exact forwarding, malformed arrays/objects/tokens, stale workspace ids, backend errors, and channel parity.

## Done when
- [ ] Every Roles operation is available through one typed named method and fixed backend command; exact forwarding tests prove renderer data cannot choose paths or commands.
- [ ] Invalid ids, empty/oversized fields, duplicate skill ids, missing/stale SHA tokens, unknown keys, and malformed confirmations are rejected before backend invocation where shape validation applies.
- [ ] `npm --prefix app test -- managementSpecs managementIpc preload rendererApi` and `npm --prefix app run typecheck` pass; the preload exposes no broad file or command API.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
