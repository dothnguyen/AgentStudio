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
