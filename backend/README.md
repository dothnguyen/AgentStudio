# Agent Studio WSL backend

Implemented so far: P00-S01 (entry shim, coordinator daemon, command inbox, `serve`, health, preflight, Windows
boundary scripts), P00-S02 (schema, role-enforced write authority, event journal, snapshot/events), and P00-S03
(one tmux window with one pane per agent, request-file delivery, pane liveness, attach, scoped stop), P00-S04
(provider adapter contract, real runner with evidence and limits, test-only fake provider), P00-S05
(direct tasks to idle agents, `task show`, `assignment cancel`), P00-S06 (Developer → Reviewer workflow),
and P00-S07 (restart reconciliation, `assignment resolve`, bounded stop). Recovery guide: [RECOVERY.md](RECOVERY.md). Contract: [architecture](../phases/phase-00/architecture.md).

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
| `agent_studio/runner.py` | Runs one assignment via its adapter: private evidence, output cap, deadline, cancel, validated report. |
| `agent_studio/providers/` | Adapter contract (`base.py`), registry, test-only `fake`, placeholders for the four real CLIs. See its README. |
| `agent_studio/tasks.py`, `watch.py` | `task.direct` acceptance rules and `assignment.cancel`; `--wait` follows the journal. |
| `agent_studio/workflow.py`, `gitws.py`, `validation.py` | Workflow engine and truth table; safe git diff capture; config + detached validator. |
| `agent_studio/reconcile.py`, `resolve.py` | Startup/periodic reconciliation; operator resolution (retry / fail / cancel). |
| `agent_studio/contract.py`, `report_rules.py` | Normalized-report validation; how the coordinator applies start/progress/final reports. |
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
agent-studio preflight --workspace ~/some/project --provider claude --provider codex --pretty
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
agent-studio debug assign --agent <agentId> --scenario slow --duration-ms 8000 --lines 8   # fake work to watch
#   other scenarios: success, provider_failure, permission_denied, crash, timeout (with --deadline-ms), ...
agent-studio task direct --team <teamId> --agent <agentId> --policy read_only --text "Summarise the README" --wait
#   fake agents: add --scenario slow --duration-ms 8000 to watch it run; --text-file PATH (or -) for long tasks
agent-studio task show --task <taskId> --pretty
agent-studio assignment cancel --assignment <assignmentId>
agent-studio assignment resolve --assignment <assignmentId> --action retry|fail|cancel   # see RECOVERY.md
agent-studio snapshot --team <teamId> --pretty           # status comes from here, never from pane text
agent-studio team stop --team <teamId>
```

From Windows, `team attach --print` (or the `team.start` receipt) gives a ready-made command, e.g.
`wt.exe -w new wsl.exe -d Ubuntu --exec /usr/bin/tmux -L agent-studio attach-session -t =as-1a2b3c4d5e6f7a8b`.

tmux keys (prefix `Ctrl-b`): `d` detach (the team keeps working) · `z` zoom/unzoom the current pane ·
arrows or `o` move between panes · `[` scroll back (`q` to leave) · `w` pick a window. Reattach with the same
`team attach` command. You can also list Agent Studio's sessions with `tmux -L agent-studio ls`; your own
`tmux ls` server is separate.

## Real providers: models, reasoning, roles and skills

Each agent can have its own model and reasoning level, and every agent follows the role configured in the
workspace. Settings the adapter has not verified are refused (`SETTING_UNSUPPORTED`) before any pane opens.

```bash
agent-studio team start --workspace ~/work/project \
    --agent codex:Developer:dev,model=gpt-5.1-codex,reasoning=high \
    --agent codex:Reviewer:rev,reasoning=medium
agent-studio provider verify --provider codex --model gpt-5.1-codex --reasoning high   # real runs, kept as evidence
agent-studio preflight --workspace ~/work/project --provider codex --role Developer --deep
```

Codex reasoning levels: `minimal low medium high xhigh`. Claude Code (`claude:Reviewer,model=sonnet,reasoning=high`): `--effort` levels `low medium high xhigh max`; Claude agents can read and edit files but never run commands (see `providers/claude/CONTRACT.md`). Without `--agent`, the roster comes from the workspace:

```
.agent-studio/team.json          {"version": 1, "agents": [{"providerId": "codex", "role": "Developer", "name": "dev",
                                                            "model": "gpt-5.1-codex", "reasoning": "high"}]}
.agent-studio/roles.json         {"version": 1, "roles": {"Developer": {"description": "Implements features",
                                                                       "instructions": "roles/developer.md",
                                                                       "skills": ["python-testing"]}}}
.agent-studio/roles/<Role>.md    instructions (used directly when roles.json does not list the role)
.agent-studio/skills/<name>/SKILL.md
```

The role description, instructions and listed skills are placed in front of every prompt for that agent (direct
tasks and workflow stages), frozen when the assignment is created. Paths cannot leave `.agent-studio`; sizes are
capped (16 KiB instructions, 32 KiB per skill, 96 KiB total) with warnings in the `team.start` / `task.direct`
receipts. The provider still reads its own native files (e.g. `AGENTS.md`) as usual. Provider details:
`agent_studio/providers/<id>/CONTRACT.md`.

## Run the Developer → Reviewer workflow

The workspace must be a git repository (clean, at least one commit) with a committed
`.agent-studio/workflow.json`, for example:

```json
{"version": 1, "validation": {"argv": ["python3", "-m", "unittest"], "timeoutMs": 600000}}
```

```bash
agent-studio workflow start --team <teamId> --developer <agentId> --reviewer <agentId> --text "Fix the add() bug" --wait
agent-studio workflow show --workflow <workflowRunId> --pretty
agent-studio workflow cancel --workflow <workflowRunId>
```

Artifacts per stage live in `~/.local/state/agent-studio/workflows/<id>/<nn>-<stage>/`
(`prompt.txt`, `diff.patch`, `untracked.txt`, `validation.out`, `validation.json`).

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
