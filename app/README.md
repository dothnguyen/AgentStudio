# Agent Studio desktop app (Electron)

Isolated Electron project. The Python tooling (`scripts/validate.py`, `tests/`) does not use it.

The main process owns exactly one child: `wsl.exe [-d <distro>] --exec <entry> serve`, speaking
line-delimited JSON (`agent-studio/v1`). Boundary rules:

- The child is started with an argument array (never a shell or a joined command string).
- Only safe literals (`A-Z a-z 0-9 . _ / : @ + = ~ -`) may appear on the command line.
- All data travels as JSON on stdin; user text never appears on a command line.

## Prerequisites

- Windows 10/11 with WSL and a distro.
- Node 20+ on Windows.
- Inside WSL: `bash /mnt/c/Works/Projects/AgentStudio/backend/install.sh`

## Run

PowerShell:

```powershell
cd C:\Works\Projects\AgentStudio\app
npm ci
npm start
```

A window titled "Agent Studio" opens. The console logs `[serve] connecting`, then `[serve] connected`
(or `[serve] lost: <reason>`).

## Test

```
npm test
npm run typecheck
```

`npm run build` also runs `vite build` into `dist/renderer/`.

Both work on Windows or in WSL. In WSL skip the Electron binary: `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci`.
`node_modules` is platform-specific; re-run `npm ci` when you switch between Windows and WSL.

## Configure the distro and entry point

All connection settings live in `src/main/config.ts`. Sources, highest priority first:

1. Environment: `AGENT_STUDIO_DISTRO`, `AGENT_STUDIO_ENTRY`, `AGENT_STUDIO_REQUEST_TIMEOUT_MS`
2. `%APPDATA%\agent-studio-app\config.json`:
   ```json
   { "distro": "Ubuntu-24.04", "entryPath": "/home/me/.local/bin/agent-studio", "requestTimeoutMs": 30000 }
   ```
3. Defaults: the default WSL distro (no `-d`), `$HOME/.local/bin/agent-studio`, 30000 ms.

List distro names with `wsl -l -v`. Settings are re-read on every connect and Retry. Invalid values
(unsafe characters, relative `entryPath`, timeout outside 1000..600000) put the connection in `lost`
with a message naming the setting.

## Connection states

`connecting`, `connected`, `lost`. When the child dies, pending requests are rejected and the state
becomes `lost`. Nothing is re-sent or restarted automatically; `retry()` starts a new child.

The window shows Connecting, or Connection lost / Could not connect with the reason, Retry and
diagnostics (command, distro, last error). Retry reloads the window; main sees the reload
(`did-finish-load` after the first load) and, if the state is `lost`, calls `retry()`. The preload API
stays at the four calls of the brief.

## Live check (Windows + WSL)

Proves the real boundary: the app's main-process client starts the real `wsl.exe --exec agent-studio serve`
and issues `workspace.list`, headless (no Electron window).

Prerequisites: the backend is installed in WSL, and `npm ci` has been run on Windows (PowerShell).

```powershell
cd C:\Works\Projects\AgentStudio\app
npm ci
npm run live-check -- [--distro <name>] [--entry <path>] [--repo-wsl <path>] [--out <file>] [--keep]
```

Steps:

- setup: creates a throwaway `/tmp/agent-studio-live-*` state in WSL, removed afterwards unless `--keep` is given.
- connect: starts `serve` with that `XDG_STATE_HOME` (forwarded through `WSLENV`).
- temp-state: `health` must report the temp state dir before anything is written.
- clean-list: `workspace.list` on a clean state is empty.
- init / list-after-init: `agent-studio init` in WSL, then `workspace.list` returns that workspace.
- kill-serve: killing `serve` gives state `lost` with `serve exited (code ...`.
- no-auto-reconnect: requests fail with `NOT_CONNECTED` while lost.
- retry: Retry reconnects and returns the same list.
- wsl-missing / distro-missing / not-installed / distinct: each failure mode gives its own reason string.

It never starts the coordinator. The default evidence file is `scripts/windows/app-live-check-evidence.json`.
If the repository path has a space or another character outside `SAFE_ARG`, pass `--repo-wsl`.
