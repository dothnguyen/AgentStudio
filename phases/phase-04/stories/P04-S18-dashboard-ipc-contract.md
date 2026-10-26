# P04-S18 — Dashboard read API: shared types, preload and IPC

Status: To Do
Depends on: P04-S15, P04-S16, P04-S17
Architecture: [P04 design contract](../README.md#design-contract), §A (workspace registry), §C (team definitions), §D (board); renderer rules: ticket T-014 (allowlisted preload only, one `serve` process)

## Goal
Expose three read-only dashboard calls to the renderer through the existing allowlisted preload and validated main-process IPC, with typed results, so panels never see Electron or raw `serve` access. The renderer passes a registered workspace id; main resolves its path from `workspace.list` so the renderer cannot send arbitrary paths.

## Implement in this order
1. `app/src/shared/api.ts`: add `DashboardTeams`, `DashboardBoard`, `DashboardActivity` types mirroring S15/S16/S17 responses exactly, and `AgentStudioApi.dashboard { teams(workspaceId: string); board(workspaceId: string); activity(workspaceId: string) }`, each `Promise<Result<…>>`.
2. `app/src/main/ipc.ts`: add channels `dashboard:teams|board|activity` to `CHANNELS`; each handler requires exactly one non-empty string argument (else `BAD_ARGS`), resolves the id against `workspace.list` (unknown id → `WORKSPACE_NOT_FOUND` error Result; `exists === false` → `WORKSPACE_MISSING`), then calls `team.list`, `board.summary`, `activity.recent` with fixed args (limit 5 / 15) via `client.request`; errors map through `fromError`/`fromResponse`. No write command may be reachable.
3. `app/src/preload/preload.ts`: duplicate the channel names in `PRELOAD_CHANNELS` and add the `dashboard` namespace to `buildApi`; `app/src/renderer/api.ts`: extend `Window.agentStudio` and add `getDashboardApi()` with the same missing-preload error pattern.

## Done when
- [ ] Each handler rejects zero, two, non-string and empty arguments with `BAD_ARGS` and sends nothing to `serve`. Test: `app/test/ipc.test.ts`.
- [ ] A valid id issues exactly the expected command and args and returns the data; unknown/missing workspace give the named error codes; transport errors are retryable. Test: `ipc.test.ts`.
- [ ] Preload channel constants equal the main ones (existing equality test extended) and `buildApi` forwards each call. Test: `preload.test.ts`, `rendererApi.test.ts`.
- [ ] No handler can call a mutating command (test asserts the set of command names used). Test: `ipc.test.ts`.
- [ ] Validation: npm --prefix app test; npm --prefix app run typecheck; npm --prefix app run build.

Out of scope: renderer panels, polling, caching, backend changes.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
