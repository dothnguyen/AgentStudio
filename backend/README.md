# Agent Studio WSL backend

Implemented so far: P00-S01 (entry shim, coordinator daemon, command inbox, `serve`, health, preflight, Windows
boundary scripts), P00-S02 (schema, role-enforced write authority, event journal, snapshot/events), and P00-S03
(one tmux window with one pane per agent, request-file delivery, pane liveness, attach, scoped stop). Contract: [architecture](../phases/phase-00/architecture.md).

## Layout

| Path | Role |
|---|---|
| `bin/agent-studio` | Bash entry shim. The only file Windows ever executes (`wsl.exe --exec`). Passes argv through unchanged. |
| `launch.py` | Python entry; puts only `backend/` on `sys.path` (never the caller's cwd). |
| `agent_studio/coordinator.py` | Detached daemon: `flock` single instance, PID + start time + boot ID identity, processes the command inbox. |
| `agent_studio/client.py`, `inbox.py` | Clients insert into the `commands` table and wait for the coordinator's response. |
| `agent_studio/serve.py` | Line-delimited JSON over stdio for Windows callers. |
| `agent_studio/envresolve.py` | Captures the login + interactive shell environment so nvm/pipx-installed CLIs resolve. |
| `agent_studio/ops.py` | `health`, `preflight`. |
| `agent_studio/schema.py` | Entities, enums, allowed transitions, DDL (single source for SQL CHECKs and Python checks). |
| `agent_studio/state.py` | Connections by role (`coordinator`/`client`/`runner`/`reader`) with an SQLite authorizer; migrations. |
| `agent_studio/store.py` | Coordinator-only `Store`/`Tx`: every row change writes exactly one event in the same transaction. |
| `agent_studio/reports.py` | Immutable worker-report inbox and exactly-once application. |
| `agent_studio/queries.py` | `snapshot` and `events.after` (read-only, one consistent read transaction each). |
| `agent_studio/tmuxctl.py` | tmux on Agent Studio's own server (`tmux -L agent-studio`); IDs only, never indices or keystrokes. |
| `agent_studio/teams.py` | `team.start` / `team.stop`, claim + request-file delivery, redelivery, pane-liveness monitor. |
| `bin/agent-studio-worker` | Bash loop in each pane: inbox → active → `agent-studio runner` → done. No state decisions. |
| `agent_studio/runner.py`, `report_rules.py` | Runs one assignment and reports; how the coordinator applies start/progress/final reports. |
| `../scripts/windows/` | PowerShell module, boundary spike, lifetime check, keep-alive. |

Requirements inside WSL: bash, Python 3.8+ (standard library only), tmux, util-linux. Nothing to `pip install`.

## Install (inside the WSL distro)

```bash
cd /mnt/c/Works/Projects/AgentStudio      # or a clone in the WSL filesystem (faster)
bash backend/install.sh                    # links ~/.local/bin/agent-studio
```

If git converted the shim to CRLF you'll see `bad interpreter: /bin/bash^M`; `.gitattributes` prevents this
for fresh checkouts, otherwise run `sed -i 's/\r$//' backend/bin/agent-studio`.

## Operate (inside WSL)

```bash
agent-studio health --pretty
agent-studio coordinator start             # idempotent; add --enable-debug for debug.echo
agent-studio preflight --workspace ~/some/project --pretty
agent-studio snapshot --pretty            # works even when the coordinator is stopped
agent-studio events --after 0 --limit 50 --pretty
agent-studio debug echo --text 'hello'     # debug coordinators only
agent-studio debug fixture --agents 3      # debug only: fake team/task/assignment with real events
agent-studio coordinator stop
```

Every command prints exactly one JSON response on stdout (exit 0 = ok, 1 = error); diagnostics go to stderr.
Machine callers use `agent-studio request` (one JSON request on stdin) or `agent-studio serve` (one per line):

```json
{"protocol":"agent-studio/v1","id":1,"command":"debug.echo","idempotencyKey":"any-unique-key","args":{"text":"..."}}
```

State lives in `${XDG_STATE_HOME:-~/.local/state}/agent-studio` (directory `0700`, files `0600`): `state.db`,
`coordinator.json` (identity), `runtime.json` (resolved PATH summary), `coordinator.log`.

Environment capture: `AGENT_STUDIO_ENV_MODE=login-interactive` (default), `login`, or `inherit`.

## Run a team and watch it (inside WSL)

```bash
agent-studio coordinator start --enable-debug            # debug: allows the test-only `fake` provider
agent-studio team start --workspace ~/scratch/demo --agent fake:developer:Dev --agent fake:reviewer:Rev --pretty
#   -> teamId, one paneId per agent, and attach commands
agent-studio team attach --team <teamId>                 # this terminal becomes the tmux window
agent-studio debug assign --agent <agentId> --duration-ms 8000 --lines 8   # stub work you can watch
agent-studio snapshot --team <teamId> --pretty           # status comes from here, never from pane text
agent-studio team stop --team <teamId>
```

From Windows, `team attach --print` (or the `team.start` receipt) gives a ready-made command, e.g.
`wt.exe -w new wsl.exe -d Ubuntu --exec /usr/bin/tmux -L agent-studio attach-session -t =as-1a2b3c4d5e6f7a8b`.

tmux keys (prefix `Ctrl-b`): `d` detach (the team keeps working) · `z` zoom/unzoom the current pane ·
arrows or `o` move between panes · `[` scroll back (`q` to leave) · `w` pick a window. Reattach with the same
`team attach` command. You can also list Agent Studio's sessions with `tmux -L agent-studio ls`; your own
`tmux ls` server is separate.

## Windows boundary checks (PowerShell, from `scripts\windows`)

```powershell
wsl.exe -l -v                                   # find your distro name
.\boundary-spike.ps1 -Distro Ubuntu             # writes boundary-spike-evidence.json
.\check-lifetime.ps1 -Distro Ubuntu -Phase Record
#   close every WSL terminal / VS Code WSL window, wait 5+ minutes
.\check-lifetime.ps1 -Distro Ubuntu -Phase Verify
.\start-keepalive.ps1 -Distro Ubuntu [-RegisterAtLogon]   # only if Verify reports NOT SURVIVED
```

If PowerShell refuses to run the scripts, use `powershell -ExecutionPolicy Bypass -File .\boundary-spike.ps1 -Distro Ubuntu`.

## Tests (inside WSL, from the repo root)

```bash
python3 -m unittest discover -s tests -t .
```
