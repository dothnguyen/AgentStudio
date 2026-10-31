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
| `agent_studio/boardmodel.py`, `boardsched.py`, `boardcli.py`, `mcpserver.py` | The generic board (P04): config-driven statuses, phases, tickets; the scheduler behind `team run-board`; the ticket/board CLI; the board MCP server. |
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

## Workspaces (init, workspace list, workspace.init, workspace.list)

- CLI: `agent-studio init [--name NAME] [--path PATH] [--json]` (path defaults to the current directory) and
  `agent-studio workspace list [--json]`.
- serve/request: `{"protocol":"agent-studio/v1","id":1,"command":"workspace.list","args":{}}` and
  `{"protocol":"agent-studio/v1","id":2,"command":"workspace.init","args":{"path":"/home/me/proj","name":"Optional"}}`.
  Over serve, `path` is required. Pass an absolute WSL path: a relative path resolves against the `serve`
  process's working directory.
- Results: list → `{"workspaces":[{"id","name","path","missing","exists"}]}` in registry order (`exists` = the
  folder's `.agent-studio/workspace.json` is still there). Init → `{"id","name","path","existed"}` (`path` is the
  resolved real path; `existed: true` when it was already initialised).
- Default name: the folder name (`basename` of the resolved path, `/` for the root). An empty `name` means the
  default. On an already-initialised folder the name is ignored and nothing is rewritten.
- Errors (all `BAD_REQUEST`): `Missing required argument 'path'.`, `Argument 'path' must not be empty.`,
  `Argument 'path' must be a string.`, `Argument 'name' must be a string.`,
  `--path <path> is not an existing directory` (same text as the CLI; nothing is created),
  `<marker> is not valid JSON: ...` / `<marker> must be a JSON object with string id and name` for a broken
  `workspace.json`, and `workspaces.json is unreadable: ...`. Neither command raises a `WORKSPACE_*` code;
  `WORKSPACE_NOT_FOUND` comes only from workspace resolution in other commands.
- These files are not in `state.db`, so the commands run without the coordinator and need no `idempotencyKey`.

## Agent catalog (P05-S08)

Reusable agent definitions live in `<workspace>/.agent-studio/agents.json` (hand-editable; the file is the only
source, a missing file is an empty catalog):

```json
{"version": 1, "agents": [{"id": "ada", "name": "Ada", "description": "Implements backend stories.",
                           "provider": "claude", "model": "opus", "reasoning": "high"}]}
```

- `id` (slug, unique) , `name` (at most 80 chars) and `provider` are required; `description` (at most 4000),
  `model` and `reasoning` are optional and checked by the provider adapter like team members. A definition holds no
  role (identity and role stay in the team file). Unknown keys are preserved by every write.
- Commands (direct file access, no coordinator, no `idempotencyKey`): `agentdef.list {workspace}` →
  `{workspace, version, agents, problems, editorOptions}`; `agentdef.create {workspace, agent}` → `{workspace, agent}` (id derived
  from the name when absent); `agentdef.update {workspace, agentDefId, changes}` → `{workspace, agent}` (a `null`
  `description`/`model`/`reasoning` removes it; the id cannot change); `agentdef.delete {workspace, agentDefId}` →
  `{workspace, deleted}`.
- `editorOptions.providers` lists production adapter model selection and reasoning capabilities, plus distinct models from valid saved entries in order. These suggestions do not indicate availability or authentication and are not an allowlist.
- Errors: `AGENT_CATALOG_INVALID` (`data.problems`), `AGENT_EXISTS`, `AGENT_NOT_FOUND`, `AGENT_IN_USE`
  (`data.teams`; a team member with `"agent": "<id>"` references an entry), `WORKSPACE_NOT_FOUND`, `BAD_REQUEST`.
  Failed requests leave every file unchanged. A broken `agents.json` is never rewritten.
- Team members will reference an entry with the key `"agent"` (resolved from P05-S09). Running teams keep their
  roster frozen in the state DB, so catalog edits never affect them.

## Teams management read model (P05-S10)

`team.overview {workspace}` (direct read: no coordinator needed, no `idempotencyKey`) returns
`{workspace, coordinator: {running}, runtimeState: {available, error}, roles: {state, message},
catalog: {state, message}, teams, truncated, partial}`. Each team has `id`, `name`, `definition`
(`state`: `valid|problems|unreadable|missing`, `problems`), `runtime` (`state`:
`not_started|starting|running|stopped|error|disconnected|unavailable`, `teamId`, `status`), `members` and
`membersTruncated`. Each member has `memberId`, `name`, `role`, `roleDescription` (from `roles.json`) with
`roleState` (`defined|undefined|unavailable`), `source` (`catalog|inline|runtime`), `agentDefId`/`agentDefState`
(`ok|missing|unavailable`), the definition's `provider/model/reasoning`, the frozen `runtime` roster entry (or
`null`), `presence` (an agent availability, or `not_in_runtime|not_started|stopped|error|disconnected|unavailable`)
and `work`: `{state: "working", assignment, ticket}`, `{state: "none"}` or `{state: "unavailable", reason}`.
Saved configuration also exposes `agentMode` (`ordered_catalog|single_catalog|inline`), `defaultAgent`,
and ordered `agentOptions` with catalog details and an `ok|missing` state. Missing references remain in
place. The nested runtime reports frozen `configuredAgents`, `activeAgent`, `quotaHolds`, `pendingAgent`,
`lastSwitch`, actual provider/model/reasoning, and the newest active `assignment`. Its `stale` flag is true
when the effective team state is not starting or running; saved catalog edits do not change runtime evidence.
Work comes only from the state DB (assignments, tasks, workflow runs, tickets) and is never inferred from
tmux or pane output. Configuration or runtime problems never fail the request; they appear as states
(`partial: true`). Bounds: 50 teams, 16 members per team, 200-char text, 2000-char role description.

## Board settings (P05-S11)

Direct commands (no coordinator, no `idempotencyKey`; writes happen in the request process):

- `board.settings {workspace}` returns `{workspace, board, statuses, rules, actionRules, worktree,
  protectedRoutes, roles, workflows, runner}`. `board` and `roles` carry `state` (`ok|invalid|missing`),
  `sha256`, `message`; a missing or broken file is a state, never an error. `runner.status` is one of
  `unavailable|not_bound|stopped|team_not_running|disconnected|running`.
- `board.settings.update {workspace, changes, expectedSha256?}` shallow-merges `changes` (keys `statuses`,
  `ticketFields`, `rules`, `leaseSeconds`, `baseBranch`, `agentTicketStatus`; `null` removes a key) into the raw
  `board.json`, validates it (schema, rules check, protected routes) and writes atomically. Invalid edits
  (`BOARD_CONFIG_INVALID` with `data.problems`) and a stale `expectedSha256` (`CONFIG_CHANGED`) write nothing.
- `role.list {workspace}` returns a read-only role catalog with ordered roles, bounded instruction text, full-file tokens, skill availability, warnings, and structured problems. Each role includes bounded saved and live usage, an exact reference count, runtime connectivity, and fail-closed partial/blocking status. An absent legacy roster is valid; an invalid or unreadable entry at its path, including a directory, makes usage partial. Catalog validation and resolver warnings use the same catalog snapshot; invalid catalog contents are reported as data. Catalog, instruction, and warning-resolution reads use confined, nonblocking opens and reject non-regular files.
- `role.create {workspace, role, expectedSha256?}` creates a role with an immutable slug id and optional description and skills. `role.update {workspace, roleId, changes, expectedSha256?}` edits its display name, description, and ordered skills; null removes a name or description. Both return a SHA token and missing-skill warnings.
- `role.update {workspace, role, description, expectedSha256?}` changes only `roles.<id>.description`
  (`null` removes it); unknown roles give `ROLE_NOT_FOUND`.

Protected routes: when a board has the `merge-conflict` or `plan-merge-conflict` status, it must keep it, with a
rule `when.status == <id>` whose `role` is `TeamLead`. Live controls are the existing `board.run` and
`board.stop`; `board.settings` reports the truthful runner state.

## Run a team and watch it (inside WSL)

Operators can update an unclaimed ticket body without moving it:

```bash
agent-studio ticket edit T-048 --body-file /path/to/description.md
agent-studio ticket edit T-048 --body 'Additional details' --mode append
```

Use `--expected-body-sha256` with the SHA-256 of the body read earlier to reject stale edits. `--body-file -`
reads standard input. Edits are recorded as operator ticket events; claimed tickets and oversized bodies are
rejected without changing them. Agent MCP `ticket_update` retains its existing assignment-based permissions.

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
                                                                       "skills": ["python-testing"],
                                                                       "directTask": {"workspace": "worktree",
                                                                         "mergeOnSuccess": true,
                                                                         "baseBranch": "main",
                                                                         "onMergeConflict": "merge-conflict"}}}}
.agent-studio/roles/<Role>.md    instructions (used directly when roles.json does not list the role)
.agent-studio/skills/<name>/SKILL.md
```

The role description, instructions and listed skills are placed in front of every prompt for that agent (direct
tasks and workflow stages), frozen when the assignment is created. Paths cannot leave `.agent-studio`; sizes are
capped (16 KiB instructions, 32 KiB per skill, 96 KiB total) with warnings in the `team.start` / `task.direct`
receipts. The provider still reads its own native files (e.g. `AGENTS.md`) as usual. Provider details:
`agent_studio/providers/<id>/CONTRACT.md`.

`directTask` is an optional per-role policy for one-off `team ask` / `task direct` work. With `workspace: worktree`,
the coordinator creates a unique task branch and runs the agent there while MCP board tools continue to target the
team's canonical workspace. With `mergeOnSuccess: true`, a successful final report makes the coordinator commit the
worktree, squash-merge it into `baseBranch`, record `task.worktree_created` / `task.worktree_merged`, and remove the
worktree. A merge conflict or dirty/wrong-branch main checkout fails the task and preserves the branch and worktree.
When `onMergeConflict` names a board status, an actual Git conflict also creates a priority-zero recovery ticket in
the current phase, registered to that branch/worktree. A board rule can assign that status to a conflict-resolution
workflow and return it to the appropriate merge action after resolution.
The task's permission is unchanged: pass `--policy workspace_write` when the agent must edit files.

### Escalating repeated workflow failures

An agent workflow rule can set `"onFailureLimit": {"count": 3, "status": "need-escalate"}`.
After three failed runs for that rule, the ticket moves to the configured status instead of the normal
`onFail` status. A successful run clears the failure count, and escalation starts a fresh count for the
next cycle. Paused or cancelled runs do not increment it. The destination needs its own board rule;
the separate `maxRounds` setting continues to block tickets when its limit is reached.

### Switching a member's AI agent

Define reusable options in `.agent-studio/agents.json`, then replace a team member's single `agent` or inline
`provider` with an ordered list of catalog IDs in `.agent-studio/teams/<team-id>.json`:

```json
{"id":"dev", "name":"dev", "role":"Developer", "agents":["codex-primary", "claude-backup"]}
```

Existing single-agent and inline member definitions continue to work. The first option is used initially. The
`teamdef.member.add` and `teamdef.member.update` serve commands also accept an `agents` array; `teamdef.show`
returns the options. While the team is running, switch a member with:

```bash
agent-studio team switch-agent --team my-team --member dev --agent claude-backup
agent-studio team status --team my-team --json
```

The ordered options are frozen when the team starts; saved definition edits apply on the next start.
`team.status` reports the frozen list as `configuredAgents` and the latest switch event as `lastSwitch`.

The equivalent coordinator command is `team.member.switch` with `workspace`, `teamDefId`, `memberId` and `agent`.
When an option reports a usage limit, the coordinator records its quota hold and tries the next configured option.
If every option is on hold or unavailable, the member remains `limit_reached` and cannot receive assignments.
Known reset times are checked automatically. When an agent's quota becomes available and its reset time was unknown,
clear that specific hold without changing the active agent or interrupting work:

```bash
agent-studio team resume --team my-team --member dev --agent claude-backup
```

The command records the operator's decision; it does not verify provider quota or switch agents. If the resumed option
is the active one and the member was quota-held, the member becomes idle. Holds and the selected option persist in
coordinator state across team starts.

For a manual switch with active work, the CLI asks whether to cancel the displayed assignment. `--cancel-active`
explicitly confirms cancellation for non-interactive use. The coordinator waits for cancellation to complete before
switching; a cancelled board ticket returns to its prior status, retains its worktree and is reserved for the same
member's next run. Direct tasks are cancelled but are not automatically recreated. The equivalent API confirmation
uses `cancelActive: true` together with the exact `assignmentId` shown in `team.status`, preventing a stale
confirmation from cancelling a different assignment. A declined confirmation makes no change.

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

## The board and its MCP server (P04)

The generic board is configured per workspace in `.agent-studio/board.json` (statuses with kinds
`initial`/`done`/`closed`, `ticketFields`, `rules`, optional `leaseSeconds` and `baseBranch`). Tickets live in the
state DB and always belong to a phase; the default phase is worked when no other is current.

```bash
agent-studio board rules check --workspace ~/work/project      # validate board.json against roles + workflows
agent-studio ticket add --workspace ~/work/project --title "Fix the flake" --priority 10
agent-studio team run-board --team <teamId>                    # bind the running team and start claiming
agent-studio team stop-board --team <teamId>                   # stop claiming; running work finishes
agent-studio board show --workspace ~/work/project --pretty    # phases (current marked) with status columns
```

The rules decide who works which status and what happens on pass/fail/blocked; agent rules may set
`createdTicketStatus`, while action rules may set `onPassCreatedTickets: {from, to}` to hold tickets created by a
workflow and promote them only after its follow-up action succeeds. `ticket apply KEY RUN` feeds a finished workflow
run through the rules (the board's scheduler does this itself for its claims). Recovery: see
[RECOVERY.md](RECOVERY.md), section "The generic board (P04)".

**Agents adding tickets over MCP.** A member with `"canAddTickets": true` in `teams/<id>.json` gets a per-assignment
MCP server (`agent-studio mcp`, stdio JSON-RPC, standard library only) when the board works one of its tickets: the
Claude adapter adds `--mcp-config <per-assignment file>` to its usual `--strict-mcp-config` (so *only* this server is
visible), the Codex adapter passes the equivalent `mcp_servers.agent-studio.*` config overrides. The server exposes
six tools — `ticket_add`, `ticket_update`, `ticket_list`, `ticket_show`, `phase_list`, `board_show` — and every call rides the same
validated command path as the CLI: agents never touch the database, and the coordinator stays the only writer.
`ticket_add` from an agent is checked by the coordinator: the assignment must be active and its member allowed
(`FORBIDDEN`); a worktree assignment still targets the team's canonical board; the ticket lands in the claiming
rule's `createdTicketStatus`, falling back to `agentTicketStatus`, and the requested phase (default when omitted). The
an open ticket with the same title is refused
(`TICKET_DUPLICATE`), and a retried call with the same idempotency key returns the first result. Members without the
switch get no MCP server and their assignments are unchanged.

## Delegated commands (P06)

Agents run inside their provider's sandbox, so environment work such as `npm ci` is declined and would pause the
run with `PERMISSION_DENIED`. A workspace can instead offer a catalog of vetted commands in
`.agent-studio/commands.json` (committed; read once at workflow start and frozen into the run, like `workflow.json`;
no file = feature off). An agent requests one with the MCP tool `delegated_command_request` (or, without MCP, an
`AGENT_STUDIO_DELEGATE {"command": ..., "params": {...}, "reason": ...}` line in its final message) and ends its
turn. The stage attempt parks as `delegating`, the ticket keeps its status and claim, the coordinator runs the
command in the run's workspace (argv only, no shell, detached, with a timeout and capped output), and then
re-dispatches the same stage on the same visit with its original prompt plus `PREVIOUS_SUMMARY` and `DELEGATED`
sections holding each result.

```json
{"version": 1,
 "defaults": {"timeoutMs": 900000, "network": false, "approval": "auto", "maxPerVisit": 2, "maxPerRun": 6,
              "trackedChanges": "forbid"},
 "onDenialWithRequest": "delegate",
 "commands": {
   "app-deps-install": {"description": "Install the app's npm dependencies", "argv": ["npm", "ci"], "cwd": "app",
                        "env": {"ELECTRON_SKIP_BINARY_DOWNLOAD": "1"}, "network": true,
                        "roles": ["Developer", "SeniorDeveloper", "QA"]},
   "app-dev-dependency-add": {"description": "Add one dev dependency", "argv": ["npm", "install", "--save-dev", "{package}"],
                              "cwd": "app", "params": {"package": {"pattern": "[a-z0-9._-]+", "maxLength": 100}},
                              "approval": "human", "trackedChanges": "allow", "roles": ["Developer"]}}}
```

- `roles` lists who may ask (none = nobody); a workflow stage may narrow it with `delegates: [ids]` (`[]` = off).
  A `read_only` stage only gets commands with `trackedChanges: "forbid"`.
- `{param}` tokens fill whole argv elements only; each value must match its `pattern`, may not start with `-`, and
  every declared param is required. `cwd` must resolve inside the workspace.
- `network: false` only withholds the proxy variables; the coordinator itself has no network sandbox.
- `trackedChanges: "forbid"` (default) fails the request when tracked files change (untracked files such as
  `node_modules` are fine); `"allow"` lets the change into the stage's diff.
- `approval: "human"` waits for `agent-studio command approve|reject --request ID`.
- `maxPerVisit` / `maxPerRun` count every request, rejected ones too, so an agent cannot loop.
- `onDenialWithRequest: "delegate"` (default): an assignment that was denied a permission but also filed a request
  delegates instead of pausing; `"pause"` keeps the old behaviour.
- The prompt of a stage that may delegate gets a `DELEGATED_COMMANDS` section listing what it may ask for (use
  `{{delegated_commands}}` in a template to place it).

```bash
agent-studio command catalog --workspace PATH           # the catalog the next run will freeze
agent-studio command requests --workflow RUN_ID          # what a run asked for, and the results
agent-studio command approve --request ID                # or: reject --request ID --reason TEXT, cancel --request ID
```

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
