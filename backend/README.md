# Agent Studio WSL backend

P00-S01 scope: entry shim, Python coordinator daemon, command inbox, `serve`, health, infrastructure
preflight, and the Windows boundary scripts. Contract: [architecture](../phases/phase-00/architecture.md).

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
agent-studio debug echo --text 'hello'     # debug coordinators only
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
