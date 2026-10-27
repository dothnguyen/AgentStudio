# P05-S12 — Teams management IPC

Status: To Do
Depends on: P05-S08, P05-S09, P05-S10, P05-S11
Architecture: [Teams management architecture](../README.md#architecture-and-gaps)

## Goal
Connect the new management reads and writes to the desktop app through typed, allowlisted preload and main-process IPC. Follow the existing `DashboardApi` boundary; `design/teams-screen-v1.png` does not define transport payloads.

## Implement in this order
1. Define shared request/response types for catalog, team, runtime, role and board settings; expose narrow preload methods.
2. Resolve the workspace id in main, validate arguments, call only named serve commands, and propagate structured errors; avoid arbitrary paths or command names from renderer input.
3. Add IPC/preload tests for happy paths, invalid inputs, stale workspace ids, and backend errors.

## Done when
- [ ] Renderer can invoke every management operation through typed methods. Test: app IPC/preload tests and typecheck.
- [ ] Malformed renderer input never reaches an unrestricted backend command. Test: app IPC tests.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
