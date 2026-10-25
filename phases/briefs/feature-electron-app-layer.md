# Feature brief: Electron app layer for Agent Studio — first startup screen (workspaces)

Status: Draft 2026-10-25, ready for `unpack`. The first slice of the desktop app: a shell plus one screen. Everything
else in the app (teams, board, tickets, terminals) is later work and out of scope here.

## 1. Goal

Agent Studio is driven today only from the WSL command line. The goal is a Windows desktop app (Electron) over the
existing backend. This brief covers the app shell and its **first startup screen**:

- On startup the app shows the **registered workspaces** (the ones `agent-studio init` created and registered; the same
  list as `agent-studio workspace list`), each with its name and path, and a flag when its folder no longer exists.
- When there are **no workspaces**, the screen shows an empty state with one primary button, **Create workspace**,
  that creates one (the equivalent of `agent-studio init`) and then shows it in the list.
- When there are workspaces, the same **Create workspace** action stays available (secondary), and a workspace can be
  selected. What happens after selecting is a placeholder in this brief ("workspace opened" view with its name and
  path); the real workspace screens come later.

## 2. Principles (from PRD P02 and the P00 boundary work)

1. **The UI is a client of the backend, never a second backend.** It talks only to `agent-studio serve` (one
   long-lived `wsl.exe --exec agent-studio serve` process, line-delimited JSON). It does not read SQLite, read
   `.agent-studio/` files, parse tmux, or run arbitrary WSL commands.
2. **Typed, allowlisted IPC.** The renderer (no Node access, context isolation on) calls a small preload API; the main
   process maps each call to one allowed `serve` command. Closing the window loses nothing: the coordinator is a
   separate daemon (PRD).
3. **The backend owns the rules.** Workspace validation, registration and error codes come from the backend; the app
   shows them. No duplicated validation of paths or names in the renderer beyond "required".
4. **Windows and WSL paths are different things.** A workspace path is a WSL path (`/home/me/project`,
   `/mnt/c/Works/...`). Anything the user picks or types in Windows must be converted by one tested function.

## 3. Where the project is today

| Piece | Today | Gap |
|---|---|---|
| Workspace list / create | `agent-studio workspace list [--json]` and `init [--name] [--path]` exist as **CLI commands** (`workspace.py`: `list_workspaces`, `init`, a registry file in the state dir). | They are not `serve` commands, so the app cannot call them. Needs `workspace.list` and `workspace.init` over `serve` (same validation, same registry, same error codes). |
| Windows ↔ WSL boundary | Proven in P00 (`scripts/windows/*.ps1`, `AgentStudioWsl.psm1`): one fixed `wsl.exe --exec` entry, JSON over stdio, keep-alive checks. | No Electron code exists yet; the boundary must be reused, not re-invented. |
| `serve` protocol | Line-delimited JSON request/response with an `id` and the envelope `{protocol, id, ok, data | error}`. | Needs to be confirmed for connection loss, reconnect, and request timeouts from a long-lived client. |
| Electron app | None (the earlier desktop story draft was removed; see ROADMAP "P02 UI journey"). | Whole project skeleton: build, dev run, packaging, tests. |

## 4. Scope

### 4a. Backend (small, in Python, stdlib only)
- `workspace.list` over `serve`: the registry entries with `id`, `name`, `path`, `exists` (the folder is still there).
  Read-only; sorted as the CLI does.
- `workspace.init` over `serve` (`path`, optional `name`): the same behavior as `agent-studio init --path`, including
  `.agent-studio/workspace.json`, the registry entry, idempotence on an existing workspace, and its error codes
  (`BAD_REQUEST`, `WORKSPACE_*`). It must refuse a path that is not an existing directory and create nothing outside it.
- Both written through the existing command path rules (inbox for writes, reader for reads) and documented in
  `backend/README.md`. CLI and `serve` results must agree (one test compares them).

### 4b. Electron app (new `app/` directory)
- **Main process:** creates the window; owns the single `wsl.exe --exec agent-studio serve` child (distro and
  executable path resolved by the same logic the PowerShell module uses, configurable in one place); matches
  responses to requests by `id`; request timeout; restarts the child and re-issues nothing automatically when it
  dies (the renderer is told the connection state: `connecting`, `connected`, `lost`); starts the coordinator through
  `serve`/`agent-studio coordinator start` if it is not running (existing backend behavior, not new code).
- **Preload:** exposes only `workspaces.list()`, `workspaces.create({ path, name? })`, `workspaces.pickFolder()`,
  `connection.onChange(cb)`. Nothing generic (no `invoke(channel, anything)`).
- **Renderer:** the startup screen (4c). Plain, accessible UI; a small framework is allowed but not required
  (decision in section 8).
- **Create workspace flow:** a dialog with a folder field and an optional name. **Browse…** opens the native folder
  picker (`pickFolder`), the main process converts the Windows path to the WSL path (`C:\Works\x` →
  `/mnt/c/Works/x`; `\\wsl$\Ubuntu\home\me\x` → `/home/me/x`) with the tested converter; the user may also type a WSL
  path. Create calls `workspace.init`; success closes the dialog and the new workspace appears (selected); a backend
  error is shown inline with the backend's message and remediation, and nothing is added.

### 4c. The startup screen — states
| State | What the user sees |
|---|---|
| Connecting | "Connecting to Agent Studio…" with a spinner; no buttons. |
| Connection failed / lost | Message with the reason (WSL not found, distro not running, backend not installed, `serve` exited), **Retry**, and a short diagnostics block (what was run, last error). No workspace UI. |
| Loaded, no workspaces | Centered empty state: title, one sentence ("A workspace is a project folder Agent Studio works in"), primary **Create workspace** button. |
| Loaded, workspaces | A list (name, path, small "folder missing" badge when `exists` is false), click selects; **Create workspace** button above the list; **Refresh**. |
| Workspace selected | Placeholder view: name and path and a **Back** link. Missing-folder workspaces cannot be opened (message). |
| Creating | Dialog with progress; the button is disabled while the call runs; double-submit cannot create twice. |

## 5. Out of scope

- Teams, members, board, tickets, workflows, task status, resolution — later screens.
- Terminal embedding or streaming tmux bytes (never; "Open terminals" attaches the native tmux, later).
- Removing or renaming a workspace, editing a workspace, anything that deletes files.
- Auto-updates, installers beyond a local package build, code signing, macOS/Linux builds.
- Provider setup and authentication.

## 6. Constraints

1. Python backend work stays standard-library only and follows the P04 rules (coordinator is the only writer; schema
   changes only as new migrations — none are expected here).
2. The renderer has `nodeIntegration: false`, `contextIsolation: true`, no remote content, a strict CSP, and never
   receives a Node or Electron object.
3. No user text is put on a command line or in a shell string: the main process starts `wsl.exe` with an argument array
   and sends data only as JSON on stdin.
4. Tests use throwaway state (a temp `XDG_STATE_HOME` in WSL) and a fake `serve` for UI tests; mocks do not prove the
   real boundary, so one live check runs the real app against the real backend.

## 7. Acceptance (what "done" means for this brief)

1. With a clean state, the app starts, shows the empty state with **Create workspace**, and nothing else.
2. Creating a workspace from a Windows folder (via Browse… and via a typed WSL path) registers it
   (`agent-studio workspace list` in WSL shows it, `.agent-studio/workspace.json` exists) and it appears in the app
   without a restart.
3. With two workspaces registered by the CLI, the app lists both; deleting one folder outside the app and pressing
   Refresh shows the "folder missing" badge.
4. Creating an already-registered path is not an error and does not duplicate it; an invalid path shows the backend
   message and adds nothing.
5. Killing the `serve` process shows "connection lost" with Retry; Retry reconnects; closing the app leaves the
   coordinator and any running team untouched.
6. Unit tests: path converter (Windows drive, `\\wsl$`, UNC, trailing slashes, spaces, non-ASCII, rejected forms);
   main-process request/response matching, timeout and reconnect; preload exposes exactly the allowlisted calls.
   Backend tests: `workspace.list` / `workspace.init` over `serve` equal the CLI. UI tests against a fake `serve`
   for every state in 4c. One live gate on Windows + WSL for items 1–5.

## 8. Open questions (the unpack step should list its assumptions)

1. **Renderer stack:** plain TypeScript + DOM, or React/Vite? Suggested default: TypeScript + React + Vite, because
   later screens (board, tickets) are far more complex; keep the first slice small either way.
2. **Packaging:** `electron-builder` NSIS installer, or run-from-source (`npm start`) for now? Suggested default:
   run-from-source plus a portable build script; installer later.
3. **Distro and install detection:** how does the app find the right WSL distro and the `agent-studio` shim when
   there are several distros? Suggested default: a setting (default: the distro of the last successful connection,
   else the default distro), shown in the diagnostics block.
4. **Folder picker for WSL-only folders:** the Windows picker can browse `\\wsl$\<distro>\…`; is that enough, or do we
   also need a typed field only? Suggested default: both, as in 4b.
5. **Name for the workspace:** default to the folder name (as `agent-studio init` does) and allow editing; confirm the
   CLI's default.
6. **Sort order / persistence:** most recently opened first, or registry order? Suggested default: registry order now;
   "recent" later.

## 9. Risks

- The earlier Electron + NTM attempt failed at the Windows ↔ WSL boundary; reuse the P00 boundary work and keep the
  main-process connection code small, with the live gate early (first story), not last.
- WSL can stop when no Windows terminal is open (the P00 keep-alive work); the app must treat "backend not reachable"
  as a normal state, not a crash.
- Path conversion bugs (drive letters, case, spaces, `\\wsl$` vs `\\wsl.localhost`) create workspaces in the wrong
  place; one function, many tests, and the backend rejects non-directories.
- Electron adds a Node toolchain to a Python-only repository: keep it isolated under `app/` with its own lockfile, and
  keep `scripts/validate.py` and the existing test tiers unchanged for the Python side.
