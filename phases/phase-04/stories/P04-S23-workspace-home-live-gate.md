# P04-S23 — Workspace home live gate (Windows + WSL)

Status: To Do
Depends on: P04-S22
Architecture: [P04 design contract](../README.md#design-contract), §A (workspace registry), §C (team definitions), §D (board); renderer rules: ticket T-014 (allowlisted preload only, one `serve` process)

## Goal
Prove the workspace home on the real Electron app against the real WSL backend: no mocks. Records evidence for the parent acceptance criteria of T-014.

## Implement in this order
1. Prepare a throwaway workspace with one team definition (stopped), one started fake-provider team, a configured `board.json` with a few tickets, and one empty workspace. Use the existing live helpers (`app/src/live/liveCheck.ts`, `liveSupport.ts`) where they fit; extend them only to open a workspace and read dashboard text if needed.
2. Operator run on Windows with `npm --prefix app run build` output: select a workspace → shell with Home dashboard; check team, board, activity panels show real values; switch Teams/Boards/Configuration and back; click Refresh; stop the backend (or break `board.json`) to see a panel error and Retry recover; Switch workspace and re-enter; create a new workspace and enter its shell; confirm only one `agent-studio serve` process exists (WSL `pgrep -fc 'agent-studio serve'`).
3. Record observed values next to the backend source (`team status`, `board show` CLI output) and screenshots/notes under `phases/phase-04/evidence/`.

## Done when
- [ ] Every checklist item in step 2 passes on Windows + WSL with results recorded. Test: operator run, notes in Evidence.
- [ ] Dashboard values equal the CLI's `team status --json` and `board show` for the same workspace. Test: operator comparison.
- [ ] Dashboard interactions leave the event journal head unchanged (check `events.after` head before/after). Test: operator command.
- [ ] `npm --prefix app test`, `npm --prefix app run typecheck`, `npm --prefix app run build`, and `python3 scripts/validate.py --touched` pass.

Out of scope: new features; defects found are filed as new tickets.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
