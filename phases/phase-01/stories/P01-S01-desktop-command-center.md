# P01-S01 — Desktop Command Center over the proven backend

Status: To Do
Depends on: P00-S12 Done

## Goal

Let a fresh user operate the proven WSL coordinator from Electron. The UI shows team, agent, task, assignment, and workflow state, lets the user resolve paused work, and opens the existing tmux session in Windows Terminal for live viewing. It contains no terminal emulator.

## Implement in this order

1. Add Electron main, preload, renderer, and build/test configuration after reviewing the P00 protocol and S12 evidence. Context isolation on, Node integration off in the renderer, only named typed IPC methods exposed.
2. Electron main owns **one** long-lived child process: `wsl.exe -d <distro> --exec <absolute path>/agent-studio serve`, exactly as proven in P00-S01/S12. Spawn without a shell; put no task text, user text, or paths on the command line—everything goes as JSON lines on stdin. Supervise and restart it on exit; on reconnect fetch `snapshot` then `events.after` the last cursor. Never start a new team or task because a response was missed.
3. Setup/preflight: distro, workspace (Windows path sent as JSON data; WSL translates), provider capability/authentication and policy mapping, roster of N agents. Each member chooses its own provider and role; no default provider.
4. Team and task views: coordinator connection, pane liveness, agent availability, assignment state, task outcome, workflow stage/retry count, base commit/diff summary, validation result, diagnostics, and attention. Visually distinct states.
5. Controls: direct task (with policy), workflow start, assignment cancel, assignment resolve (retry / fail / cancel), scoped team stop. Show the accepted receipt first, then update from events. Keep idempotency keys stable across UI retries and app restarts.
6. Open terminals: get the validated owned session ID from the backend, then launch Windows Terminal with `wsl.exe -d <distro> --exec tmux attach-session -t <session id>`. If launch is unavailable, show a copyable command. Never pass task text to the terminal command line.
7. Confirm UI close/reopen leaves the coordinator, assignments, and tmux session running.

## Tests

- IPC rejects unknown commands, malformed payloads, arbitrary executables/paths, and oversized fields.
- `serve` child crash/restart, snapshot/cursor reconnect, and duplicate UI clicks never duplicate dispatch.
- Missing provider, offline pane, waiting input, reconciling, failed task, and disconnected backend are distinct visible states; resolve actions work from the UI.
- Open terminals targets only the validated run-owned session; an invalid or gone session gives an actionable error.
- Manual end-to-end: launch a team, dispatch a task, open the tiled tmux window, close/reopen the UI, see the same run and status.

## Done when

- [ ] A fresh user can operate the P00 backend without typing WSL CLI commands.
- [ ] The external tmux window shows one pane per team member; Electron displays status only.
- [ ] UI restart never restarts or duplicates the team.
- [ ] Renderer cannot access SQLite, shell, tmux, or WSL directly; main crosses into WSL only via the single `serve` process and the attach launch.
