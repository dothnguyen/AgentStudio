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

The startup window uses a compact dark workbench layout. It supports keyboard navigation throughout,
shows visible focus outlines, and disables nonessential loading animation when the operating system's
reduced-motion preference is enabled.

Opening a workspace shows its dashboard. The header reports the current connection state and the time
the latest team response reached the renderer. Team and Board status load independently; Refresh asks
both settled sections to reload without duplicating a request that is already in flight; callers wait
for that request to finish, and responses
from an older workspace or loader are ignored. The Board panel shows the current phase, configured
status counts, totals, and the high-priority active or blocked ticket projection. Recent activity remains
a labelled placeholder until its panel is implemented.

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

`StartupScreen` owns the renderer's single connection subscription and passes the subscribed status
into the connected workspace tree. A lost connection therefore unmounts the workspace dashboard, and
late dashboard responses are ignored.

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

The Teams screen includes worktree and routing settings from the workspace board configuration. Operators can edit existing routes and role descriptions; saves check the configuration version and reload the latest settings. If a refresh reports invalid board or roles configuration, open drafts cannot be saved until the configuration is valid again. Configuration conflicts require an explicit reload before retrying. If the reload fails, the editor retains the draft and offers a retry; a successful write is reported only after fresh settings load.

The typed management API accepts ordered catalog agent IDs when adding or updating a member.
Named switch and resume calls resolve the workspace in the main process and submit coordinator
commands with fresh idempotency keys. Switching an active assignment requires its exact ID and
an explicit cancellation confirmation; backend errors and cancellation results are passed through.

Team member editing shows saved catalog options in order, with the first as the default for the next team start. Inline members can be explicitly converted to catalog options. Live agent details remain separate from saved configuration.

The Agents screen loads the saved catalog and team usage independently, reports connection and configuration problems, and browses saved agent configurations, with search, provider and reasoning filters, and saved team-member references. Saved agents can be created, edited, and duplicated using backend-provided provider options. Deleting a saved definition requires confirmation and is blocked when saved team-member references are known; the backend also checks references when usage is incomplete or changes. Deletion does not change team membership or live runtime. Other saved changes apply on a future team start; live agent controls remain in Teams.

The agent form scrolls within the viewport when needed. If a pending save fails after its form is cancelled, the failure remains visible on the Agents screen.

An open agent draft and selection remain available during a catalog refresh. Saving is unavailable until the refresh succeeds, and catalog validation problems must be repaired on disk before saved agents can be changed. Keyboard focus stays within the form until it is closed; validation focuses the first invalid field.

When a form is cancelled while disconnected, focus returns to its action after reconnection and a successful catalog refresh, unless the user has moved focus elsewhere.

When a form is cancelled while its invoking action is disabled by a pending save or a lost connection, focus moves to Search and returns to the action when it is available again, provided focus has not moved elsewhere.

Saved values are displayed with their original whitespace. When a new submission fails client validation, its validation message replaces any previous server error in the form.

The Teams view shows each running catalog member's live agent options and quota holds
from runtime state. Switch requests with an active assignment require confirmation of
its exact ID. Resume clears a recorded hold; it does not verify provider quota. Saved
options apply on the next team start and do not determine live switch eligibility.
Reset times without a valid explicit time zone are shown as unknown. Concurrent
member switch requests refresh independently until their results appear or polling
reaches its limit.

### Deleting a role

The Roles screen offers **Delete role** for the selected role only when its usage was scanned completely and shows no references, its catalog and instruction version tokens are present, and the backend connection is ready. The confirmation dialog states whether the instruction file is removed (conventional, unshared file) or preserved (custom or shared file). The backend rescans usage on delete; if it reports `ROLE_IN_USE`, every reference group is listed and nothing is changed — there is no force-delete or reference rewrite. The role list updates only after the delete succeeds and Roles reloads; if the reload fails, further role changes stay disabled until Roles is retried.

The Teams Members tab presents a compact roster of returned member identity, role, live or saved agent, availability, and current work. Select a member to view its details and controls; returning to the roster restores focus to that member. A member that disappears on refresh returns to the roster with an explanatory notice.

The selected team’s Overview shows its definition, runtime, returned-member availability, coordinator and live-state status, and board runner relationship. Member counts identify truncated results. Team rename and delete and board run and stop are available in Overview; team creation remains in the team browser.
