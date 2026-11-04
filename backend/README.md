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
| | Schema v19 adds nullable `tickets.workflow_status` and an index on `(workspace, workflow_status)`. Board writes and scheduler ticks backfill legacy tickets transactionally, recording a `ticket.migrated` event for each converted ticket. |
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
The working ticket includes its board column as `status` and its workflow stage as `workflowStatus` (legacy
tickets without a separate workflow stage report their status for both).
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
- `board.settings.update {workspace, changes, expectedSha256?}` shallow-merges `changes` (keys
  `workflowStatuses`, `todoEntry`, `todoDefault`, `statuses`, `ticketFields`, `rules`, `leaseSeconds`,
  `baseBranch`, `agentTicketStatus`; `null` removes a key) into the raw `board.json`, validates it (schema,
  workflow references, protected routes) and writes atomically. Invalid edits
  (`BOARD_CONFIG_INVALID` with `data.problems`) and a stale `expectedSha256` (`CONFIG_CHANGED`) write nothing.
- `board.statuses {workspace}` returns ordered workflow statuses, their names (falling back to the ID), `hasName` indicating whether a name was supplied, kinds and derived types (`start`, `done`, `closed`, `startsWorkflow`, `whileRunning`, or `unused`), workflow references in `usedBy` (workflow name, title, and reference path), ticket counts, and the board file's `sha256`. Ticket counts use the legacy `status` when `workflow_status` is null. Kind takes precedence over workflow roles, and a workflow start takes precedence over its running role. A status referenced only by an outcome is `unused` as a workflow role but still has users.
- `status.add`, `status.rename`, `status.remove`, and `status.reorder` require `workspace` and `expectedSha256`. Add takes `id`, `name`, and `kind` (`none` or `done`); rename takes `id` and `name`; remove takes `id`; reorder takes all status `ids` exactly once. Removal of an initial or closed status or one referenced by a workflow or ticket returns `STATUS_IN_USE` with `usedBy` and `ticketCount`. IDs cannot be changed by rename. The CLI exposes these as `board status list|add|rename|remove|reorder`, with `--expected-sha256` on edits and `--kind` on add.
- `board.workflows {workspace}` reads workspace workflow definitions and returns board workflow summaries (`name`, `startsAt`, `whileRunning`, `role`, step IDs and kinds, `end`, and `limits`) and structured `problems` with workflow, path, and message. It checks status references, status kinds, duplicate start and running statuses, and agent workflow roles against the board and role catalog. Invalid definition files are reported as problems.
- Legacy board rules are converted in memory to workflows, retaining their loaded stages and routing settings; rule caps are discarded. Defining routing in both board rules and workflow files is reported as a problem. Missing rule workflow definitions are reported without discarding other converted rules.
- A board workflow with no role (only check and merge action steps) is run by the coordinator itself. After member claims it picks at most one ticket per workspace per tick, marks it with the workflow's `whileRunning` status claimed by `coordinator`, runs the steps in order (merge through the same squash-merge helper, check sets through the vetted command runner) and applies the pass/fail result through the normal outcome applier. A stopped board still finishes action workflows, so merges are never left half-done.
- `role.list {workspace}` returns a read-only role catalog with ordered roles, bounded instruction text, full-file tokens, skill availability, warnings, and structured problems. Each role includes bounded saved and live usage, an exact reference count, runtime connectivity, and fail-closed partial/blocking status. An absent saved team reference is valid; an invalid or unreadable team, board or workflow entry makes usage partial. Catalog validation and resolver warnings use the same catalog snapshot; invalid catalog contents are reported as data. Catalog, instruction, and warning-resolution reads use confined, nonblocking opens and reject non-regular files.
- `role.create {workspace, role, expectedSha256?}` creates a role with an immutable slug id and optional description and skills. `role.update {workspace, roleId, changes, expectedSha256?}` edits its display name, description, and ordered skills; null removes a name or description. Both return a SHA token and missing-skill warnings.
- `role.update {workspace, role, description, expectedSha256?}` changes only `roles.<id>.description`
  (`null` removes it); unknown roles give `ROLE_NOT_FOUND`.
## Skills

Six direct commands manage reusable instruction files in `.agent-studio/skills/<id>/SKILL.md` and the role
lists in `roles.json`: `skill.list`, `skill.show`, `skill.create`, `skill.update`, `skill.delete` and
`skill.roles.update`. They share the skill id rule (`^[a-z0-9][a-z0-9._-]{0,63}$`), the 32 KiB per-skill
limit and the 96 KiB per-role context limit. `SKILL_NOT_FOUND` means the id or file does not exist,
`SKILL_EXISTS` means a create would overwrite an existing file, `SKILL_IN_USE` blocks a delete while a role
still lists the skill, and `CONFIG_CHANGED` means a SHA token (or the file, role list or roles formatting)
changed after it was read, so nothing was written.

- `skill.list {workspace}` returns the read-only skill catalog: `rolesSha256`, the skill/role context limits,
  sorted `skills`, and `problems`. Each skill has its id, `skills/<id>/SKILL.md` path, state
  (`ok|missing|unreadable|truncated`), title, full-file bytes and SHA-256, and the roles that list it with their
  `contextBytes` (instruction bytes plus their `ok` skills). A listed skill without a file is a `missing` item; a
  folder without `SKILL.md` that no role lists is omitted. Symlinks are never followed; a bad skill is reported in
  `problems` and never fails the request. A missing or invalid `roles.json` still lists the folders, with empty
  roles, a null `rolesSha256` and one problem.
- `skill.show {workspace, skill}` returns `{workspace, skill, text}` for one skill id; `text` is null unless the
  state is `ok` or `truncated` (the first 32 KiB). A bad id is `BAD_REQUEST`; an id with no folder that no role
  lists is `SKILL_NOT_FOUND`. The read commands are direct requests: they take no write lock and do not require
  a running coordinator.
- `skill.create {workspace, skill: {id, text}}` creates `.agent-studio/skills/<id>/SKILL.md` as exact UTF-8 text
  (empty allowed, at most 32 KiB), making the skill folders when they are missing and never through a symlink.
  A bad `skill.id`/`skill.text` is `BAD_REQUEST`; an existing file is `SKILL_EXISTS`, re-checked immediately
  before the atomic replace. It returns `{workspace, skill, text}` (the `SkillItem` and its text).
- `skill.update {workspace, skill, text, expectedSha256}` atomically replaces one `SKILL.md`, keeping its mode,
  and returns `{workspace, skill, text}`. A missing file is `SKILL_NOT_FOUND`; a symlink, directory, non-regular
  target, or a file larger than the 32 KiB limit is `BAD_REQUEST` (shorten an oversized file outside the app).
  A stale `expectedSha256` or a file changed before the replace is `CONFIG_CHANGED` with
  `data.skillSha256` (or null); identical bytes are a no-op that does not touch the file. Both writes are direct
  requests, must not read or write `roles.json`, and use a staged same-directory temp file plus atomic
  `os.replace`; temp files and newly created empty folders are removed on failure.
- `skill.delete {workspace, skill, expectedRolesSha256, expectedSha256}` removes `.agent-studio/skills/<id>/SKILL.md`
  and then the skill folder only when it is empty, returning `{workspace, deleted: {id, folder}, rolesSha256}` with
  `folder` `removed|kept`; other files in the folder are never touched. A role that lists the skill blocks the
  delete with `SKILL_IN_USE` and `data.roles` (the role ids). `expectedRolesSha256` is the `roles.json` SHA from
  `skill.list` (null only when the file is absent) and `expectedSha256` is the full `SKILL.md` SHA, or null when
  `skill.list` reports the file as `unreadable` or `truncated` (its catalog hash is absent or covers only the
  kept prefix, so it cannot be compared with the full file); either stale token,
  or a change found on the recheck immediately before removal, is `CONFIG_CHANGED` with
  `data.rolesSha256|skillSha256` and deletes nothing. A missing file is `SKILL_NOT_FOUND` (nothing to delete); a
  symlinked skills folder, skill folder or `SKILL.md` is `BAD_REQUEST`. The command never edits `roles.json`.
- `skill.roles.update {workspace, skill, roles, expectedRolesSha256}` sets exactly which roles list a skill in
  one atomic `roles.json` write and returns `{workspace, skill, roles, added, removed, rolesSha256}`. `roles` is
  the complete, unique wanted set (possibly empty); every id must exist (`ROLE_NOT_FOUND` names the first
  unknown one, duplicates are `BAD_REQUEST`). New ids are appended to a role's `skills` list (creating it when
  absent), unwanted ids are removed while keeping the other entries and an empty array, and roles already in
  the wanted state are unchanged. Adding a skill whose `SKILL.md` is missing is `SKILL_NOT_FOUND` (no new
  dangling references); removing a missing skill is allowed. `expectedRolesSha256` is the `roles.json` SHA from
  `skill.list` (null only when the file is absent); a stale token, or a change found immediately before the
  replace, is `CONFIG_CHANGED` with `data.rolesSha256` and writes nothing. A no-op leaves the file untouched;
  the same formatting and atomic replace as `role.update` are used, and `SKILL.md`/instruction files are never
  touched.

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
agent-studio assignment resolve --assignment <assignmentId> --action retry|fail|cancel [--answer TEXT]   # see RECOVERY.md
agent-studio snapshot --team <teamId> --pretty           # status comes from here, never from pane text
agent-studio team stop --team <teamId>
```

Stopping a team also stops its running board, retaining the team as the last board runner. The
`team.stop` result includes `boardStopped` to indicate whether it stopped the board; the CLI prints
`Board stopped.` when true. An already-stopped team also repairs a board still marked running for it.
Stopping the board prevents new claims while finished runs continue to be applied.

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

Codex reasoning levels: `minimal low medium high xhigh`. Claude Code (`claude:Reviewer,model=sonnet,reasoning=high`): `--effort` levels `low medium high xhigh max`; Claude agents can read and edit files but never run commands (see `providers/claude/CONTRACT.md`). Without `--agent`, the roster comes from a saved team definition in `.agent-studio/teams/` (`agent-studio team start --team ID`).

For machine callers, `team.start` with `workspace` and `teamDefId` builds the roster from the saved team and uses its name by default. A non-empty explicit roster takes precedence; an invalid saved team returns its validation problems.

The rest of the workspace configuration:

```
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

The generic board is configured per workspace in `.agent-studio/board.json` (workflow statuses with kinds
`initial`/`done`/`closed`, `ticketFields`, optional `leaseSeconds` and `baseBranch`). Version 4 boards have no
`rules`: every route lives in a workflow file under `.agent-studio/workflows/`. Tickets live in the
state DB and always belong to a phase; the default phase is worked when no other is current.

`boardworkflow.show` reports `start.allowed` and `start.default` from `board.json`.
`boardworkflow.save` optionally accepts `start` (both boolean fields) and
`expectedBoardSha256`; it validates both files and rolls back the workflow if the board
write fails. Setting a default moves it to that workflow; disallowing a start clears its
default. Changing a start preserves the old entry when another workflow uses it.
Deleting a workflow removes its start entry and clears its default. An empty
entry list and a null default are permitted, including when tickets remain in Todo.

Version 3 uses `workflowStatuses` in place of `statuses`, with exactly one
`initial`, at least one `done`, and at most one `closed` kind. `todoEntry` lists
agent rule `when` statuses; `todoDefault` is an entry or null. Agent rules require `during`;
action rules may provide it. Each `during` must be a distinct kindless workflow status that no rule
uses as `when`. The parser exposes the fixed Kanban columns and workflow routing metadata; board
execution uses this schema. Loading a version 2 file upgrades it in memory:
the initial status becomes `none`, `done` becomes `merged`, and `close` becomes `closed` when they
have the corresponding terminal kinds. Rule references are updated, active statuses are added,
and the parsed configuration exposes the old-to-new status mapping as `upgradedFrom`. The file is
not changed. A compatible existing active status is reused; if its ID is already assigned to a
rule or a status with a kind, a unique suffixed ID is generated. Run `agent-studio board upgrade [--dry-run] [--workspace PATH]` to persist the upgrade and print
the mapping. The command backs up the original under `.agent-studio/backups/`; a dry run writes
nothing. The persisted v3 `upgradedFrom` mapping remains available to later ticket migration. If a required renamed ID is already in use, the existing status receives a
unique suffixed ID and references follow the mapping.
For a v3 board, the same command converts each rule to a v2 board workflow file and writes a v4 board without rules. Shared workflow names receive a status suffix; merge workflows use `merge-<startsAt>`. Prompt files remain referenced in place. Existing workflow files and the board are backed up before replacement. A dry run lists the files to be written, and a v4 board is already upgraded. Version 4 keeps the v3 statuses and todo settings and routes through workflow files.

A version 4 board workflow declares `startsAt`, `whileRunning`, an optional `role` (no role means the coordinator
runs it), `workspace` (`main`/`worktree`), `syncBase`, `waitForDependencies`, `createdTickets`, `end`
(`pass`, `fail`, optional `blocked`) and `limits`. Its `steps` are one of:
`agent` (prompt file, `access: read|write`, optional `delegates`; the workflow's role is the agent), `check`
(a check set from `commands.json`, selected by the changed paths), `action: merge` (the coordinator squash-merges
the ticket branch), or `approval` (waits for an operator). `onPass` defaults to the next step or `end-pass`;
`onFail` defaults to `end-fail`; a check can retry an earlier agent step with
`onFail: {retry: implement, max: 3, then: end-fail}`. `passRequires: [tests]` on an agent step makes its pass
count only when that check step passed. This workspace's develop, senior-develop and QA workflows use those
steps: `implement` → `tests` (`checks: code`, retry 3), and `qa_tests` → `tests` → `qa` (`passRequires:
[tests]`, with a failed check routed to the verdict).

The workflow transition helper records both the workflow status and its derived Kanban column, along
with a `ticket.workflow_changed` event. Blocked tickets retain their current column; claimed `during`
statuses use `in-progress`, and other working statuses retain `in-progress` or otherwise use `todo`.
### Run results

Every finished or paused run of a claimed ticket has exactly one of five results, resolved from the
ticket's `during` or `when` workflow status and transitioned to its configured target:

- `pass` — the run succeeded; the ticket moves to the workflow's `end.pass` target (or `onPass` for a v3
  rule).
- `fail` — the run failed for a reason about the work; the ticket moves to `end.fail` (or `onFail`), the
  workflow's round is counted and its `limits.failuresInARow` limit applies.
- `blocked` — the run was paused without an infrastructure code, or ended by a step or visit limit; the
  ticket moves to `end.blocked.status` (default `blocked`, or v3 `onBlocked`) and its return status is
  `end.blocked.returnTo` (default the workflow's `startsAt`, or the rule's `when` status for a v3 rule).
  The workflow's round is counted. A `limits.maxRuns` round limit also blocks.
- `paused` — infrastructure trouble: usage limit, provider, runner or validation-process codes listed in
  `boardmodel.PAUSE_CODES`. The claim is released back to `startsAt`, the Kanban column stays, and no
  round or failure is counted. The event is `ticket.run_paused`, and the run is ended `failed` with reason
  `ended by the board: paused`. The scheduler can claim the ticket again later.
- `cancelled` — the run was cancelled. The claim is released back to `startsAt` unless the operator moved
  the ticket, and nothing is counted. The event is `ticket.run_cancelled`.

Rounds are keyed by the workflow name; hitting `limits.maxRuns` blocks with `ROUND_LIMIT:<workflow>` and
the consecutive-failure limit routes to its configured status with `FAILURE_LIMIT:<workflow>`, resetting
after a pass. A failed run's findings are appended under `## Findings from <workflow>, round N`, and
`limits.onFailPriority` sets the ticket priority after a fail.

A paused run waiting for input is left alone. A blocked result records `end.blocked.returnTo` (default
`startsAt`) as the return status. The `ticket.outcome_applied` event reports the workflow statuses and
carries the workflow name (with the existing outcome fields), and replaying a run is a no-op.
The mutating `ticket.workflow` command accepts `workspace`, `key`, `to`, and optional `reason`.
It changes an unclaimed ticket in `todo` or `in-progress` to a different kindless workflow status,
excluding `blocked` and rule `during` statuses, while preserving the column.
`ticket.move` takes a Kanban column as `to`, with optional `workflowStatus` (CLI `--workflow`), `reason`, and `force`
(CLI also accepts `--workflow-status` as an alias). Moving to todo uses a configured todo entry,
defaulting to `todoDefault`; in-progress requires a rule's waiting status. Backlog resets the
workflow and round/blocking state. Done uses the first done status unless another is specified;
closed uses the configured closed status. Leaving done or closed requires force and a target of
todo or backlog. Each move records both column and workflow change events.

```bash
agent-studio board rules check --workspace ~/work/project      # validate board.json against roles + workflows
agent-studio ticket add --workspace ~/work/project --title "Fix the flake" --priority 10
agent-studio team run-board --team <teamId>                    # bind the running team and start claiming
agent-studio team stop-board --team <teamId>                   # stop claiming; running work finishes
agent-studio board show --workspace ~/work/project --pretty    # phases (current marked) with column and workflow counts
agent-studio ticket list --workspace ~/work/project --summary  # no bodies; dependsOn + openDependsOn per ticket
```

`ticket.list` takes an optional boolean `summary` (default `false`; CLI `--summary`). With `summary: true` every
ticket keeps its usual fields (`key`, `title`, `status`, `priority`, `phase`, `phaseName`, `assignee`, `branch`,
`rounds`, `blockedReason`, `returnStatus`, `activity`, `updatedAt`) but has no `body`, and gains `dependsOn` (all
dependency keys) and `openDependsOn` (the dependency keys whose status is not a done/closed kind). The default
output is unchanged. `status` filters by column; `workflowStatus` (CLI `--workflow-status`) filters by workflow status.
Both filters combine with `phase` and `summary`. `unassigned: true` returns only tickets with no phase (it cannot be
combined with `phase`). Tickets expose the column as `status` and the workflow state as
`workflowStatus`. `phase.list` and `phase.show` count columns; `board.show` returns per-phase `columns` and
`workflow` count maps, a `columnWorkflow` breakdown, and `waitingApproval`, `needsInput`, `blocked`, and `paused` ticket counts without ticket lists. Ticket reads include `waitingApproval` (`workflowRunId`, `stage`, `ask`, `since`) for an active approval, `needsInput` for a pending question, and `paused` (`reason`, `at`) after a run pause until the next claim; each is null when absent. `ticket workflow KEY ID [--reason TEXT]` changes the workflow status; operator MCP clients can use `ticket_workflow`. `board.settings` exposes `workflowStatuses`, `todoEntry`, `todoDefault`,
and each rule’s `during` value.

`ticket.show` still returns the ticket with `dependsOn` and `dependents` key lists, and adds `links`
(`{dependsOn, dependents}`) for the ticket page's Dependencies card: each item is `{key, title, status, phase}`
with `phase` as the phase slug. A dependency or dependent whose ticket row no longer exists keeps its stored id as
`key` and reports null `title`, `status` and `phase` instead of failing the command. `events` is still the newest
50 (`EVENTS_SHOWN`) events oldest first, and `eventsTruncated` is true when the ticket has more than that.

The workflows decide which status starts work and what happens on pass/fail/blocked. A board workflow's
`createdTickets` holds tickets created while its run is working; a workflow's
`end.pass.releaseCreatedTickets: {from, to}` releases the ticket's children from `from` to `to` only when that
workflow passes (a fail never releases). Children record their `parent_ticket_id`, so a later workflow can release
tickets an earlier one created. Legacy rules may set `createdTicketStatus` and
`onPassCreatedTickets: {from, to}`; they are converted to the same workflow fields. `ticket apply KEY RUN` feeds a
finished workflow run through the rules (the board's scheduler does this itself for its claims). Recovery: see
[RECOVERY.md](RECOVERY.md), section "The generic board (P04)".

Merge rules select tickets by workflow status and use their `during`, `onPass` and `onFail` workflow statuses.
Created-ticket release also compares workflow statuses. Operator tickets start at the initial workflow status in
backlog; agent-created tickets use the running workflow's `createdTickets`, the agent default, or the initial
status, with the board column derived from that workflow status.

The scheduler picks unassigned tickets in the todo or in-progress column by their workflow status; backlog
tickets are not claimed. Workflows are considered by priority and name; claims move tickets to their whileRunning status and the in-progress column. Any free member of the workflow role can claim a ticket. Dependencies are finished when their column is done or closed; workflows may wait for them.
Structured workflow end directives can release tickets created by the parent on pass (never on fail), and specify the
return status used when a blocked ticket is unblocked.

**Agents adding tickets over MCP.** A member with `"canAddTickets": true` in `teams/<id>.json` gets a per-assignment
MCP server (`agent-studio mcp`, stdio JSON-RPC, standard library only) when the board works one of its tickets: the
Claude adapter adds `--mcp-config <per-assignment file>` to its usual `--strict-mcp-config` (so *only* this server is
visible), the Codex adapter passes the equivalent `mcp_servers.agent-studio.*` config overrides. The server exposes
six tools — `ticket_add`, `ticket_update`, `ticket_list`, `ticket_show`, `phase_list`, `board_show` — and every call rides the same
validated command path as the CLI: agents never touch the database, and the coordinator stays the only writer.
`ticket_add` from an agent is checked by the coordinator: the assignment must be active and its member allowed
(`FORBIDDEN`); a worktree assignment still targets the team's canonical board; the ticket lands in the running
workflow's `createdTickets`, falling back to `agentTicketStatus`, records its `parent_ticket_id`, and the requested
phase (default when omitted). An open ticket with the same title is refused
(`TICKET_DUPLICATE`), and a retried call with the same idempotency key returns the first result. Members without the
switch get no MCP server and their assignments are unchanged.

## Using Agent Studio from your own MCP clients (operator mode)

`agent-studio mcp --operator` serves the board to Claude Code, Codex, OpenCode or any MCP client you run yourself
(no assignment needed). It is read-only by default; add `--allow-writes` to also offer `ticket_add`, `ticket_move`,
`ticket_depend`, `ticket_phase`, `ticket_unblock`, `ticket_retry`, `command_approve` and `command_reject`. There is no free-form
command tool: every call is one of these fixed tools and goes through the same validated command path as the CLI.
`--workspace PATH` pins the workspace (default: `AGENT_STUDIO_WORKSPACE`, else the workspace at or above the
directory the client starts the server in; each tool also takes a `workspace` argument).
Read tools: `workspace_list`, `board_show`, `phase_list`, `ticket_list`, `ticket_show`, `team_overview`,
`workflow_show`, `command_requests`, `command_catalog`, `checkset_list`.

`agent-studio mcp --print-config` prints the setup lines for each client (with the `wsl.exe -d <distro> -e ...`
form for clients running on Windows).

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
- Optional `checkSets` maps ids matching `[a-z][a-z0-9-]{0,63}` to objects with a non-empty `run` list. Each rule
  names a catalog `command` and 1–20 relative `when` globs (using `*`, `**` and `?`, without `..`). Optional
  `otherwise` names a catalog command and `reuseIfTested` is a boolean defaulting to false. The catalog loader
  validates and freezes these definitions; defining one does not itself run commands. `select_checks` accepts the
  result of `changed_paths(workspace)` and selects matching commands in rule order without duplicates, or
  `otherwise` when none match. Unknown changes select every rule's command. `**` crosses directories (and `**/`
  can match zero directories); `*` and `?` stay within a path segment. A workflow check step runs the selected
  commands in order through the delegated command runner, stopping on failure and routing to `next.fail`. Commands
  in a check set cannot require parameters. With `reuseIfTested`, a command is recorded as reused when its newest
  run succeeded on the current workspace fingerprint. The following agent receives the check results in `{{validation}}`.
- `{param}` tokens fill whole argv elements only; each value must match its `pattern`, may not start with `-`, and
  every declared param is required. `cwd` must resolve inside the workspace.
- `network: false` only withholds the proxy variables; the coordinator itself has no network sandbox.
- `trackedChanges: "forbid"` (default) fails the request when tracked files change (untracked files such as
  `node_modules` are fine); `"allow"` lets the change into the stage's diff.
- `approval: "human"` waits for `agent-studio command approve|reject --request ID`.
- `maxPerVisit` / `maxPerRun` count every request, rejected ones too, so an agent cannot loop.
- `onDenialWithRequest: "delegate"` (default): an assignment that was denied a permission but also filed a request
  delegates instead of pausing; `"pause"` keeps the old behaviour.
- `passRequiresCommands: [ids]` on a verdict stage (stage definitions): a `pass` counts only if one of those
  commands succeeded in the same workflow run on exactly the code the stage hands over (HEAD, tracked changes and
  untracked files are fingerprinted after each delegated run). Otherwise the pass becomes a `fail` with a BLOCKER
  finding and the event `workflow_run.pass_rejected`. When a stage lists
  `[test-all, test-backend, test-ui]`, the files the branch changed (committed since it left
  the base branch, uncommitted, untracked) pick the one that must have passed - only `app/` changed: `test-ui`
  (`scripts/validate.py --ui`); only `backend/` and `tests/`: `test-backend` (`--backend`: unit + all integration
  modules, no app); both, neither, or unknown: `test-all`. `scripts/` counts as both. `test-all` is accepted for any
  change, and a stage listing other commands keeps "any one of them" semantics. Board workflows use a `check` step
  instead: `.agent-studio/workflows/board-develop.yaml`, `board-senior-develop.yaml` and `board-qa.yaml` run
  `checks: code`, and QA's verdict step declares `passRequires: [tests]` so a failed check cannot pass. In this
  workspace `code` maps `app/` changes to `test-ui`, `backend/` and `tests/` changes to `test-backend`, and other
  changes to `test-unit`, reusing a command that already passed on the same code.
- The prompt of a stage that may delegate gets a `DELEGATED_COMMANDS` section listing what it may ask for (use
  `{{delegated_commands}}` in a template to place it).

```bash
agent-studio command catalog --workspace PATH           # the catalog the next run will freeze
agent-studio checkset list --workspace PATH              # check rules and command descriptions
agent-studio command requests --workflow RUN_ID          # what a run asked for, and the results
agent-studio command approve --request ID                # or: reject --request ID --reason TEXT, cancel --request ID
```

The read command `checkset.list` (also MCP `checkset_list`) returns `checkSets` with their `id`, `run`,
`otherwise` (null when absent), and `reuseIfTested`, plus command IDs and descriptions and a `problems` list.
An absent catalog gives empty lists; an invalid catalog gives empty data and its validation problem.


**Session resume.** When a stage that delegated commands is re-dispatched, a provider that can resume (opencode:
`opencode run --session <id>`) gets its own session back and is sent only the commands' results (the
`DELEGATED` section plus a short note), not the task again. The session id is recorded in the stage attempt when the
stage delegates. The full prompt is kept as `prompt-full.txt` beside the short one and is used as-is for any provider
that cannot resume. Set `"resumeSession": false` in `.agent-studio/commands.json` to turn it off.

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
