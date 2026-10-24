# Phase 04 — Workspace, team and board as independent components

> Status: Planned, rev 2 (2026-10-24: phases are database records with a default phase; S12 adds the board MCP server)
> Brief: [feature-workspace-team-board.md](../briefs/feature-workspace-team-board.md) (decisions recorded 2026-10-24, §5)
> Product: [PRD.md](../../PRD.md) · Delivery: [ROADMAP.md](../../ROADMAP.md) · Builds on: [P00 contract](../phase-00/architecture.md), [P01 contract](../phase-01/README.md#design-contract), [P03 board](../phase-03/README.md) (replaced here)

## Goal

The operator gets one human CLI: `agent-studio init` makes a workspace, `team add / add-member / start / ask / run-workflow` build and use a team with no board, and a generic, data-driven board (statuses, phases, tickets, rules) is worked by a team through `team run-board`. The hard-wired P03 software board is deleted and replaced in place; nothing is migrated.

The team and the board stay independent: the coordinator is only the glue between them, and the board code never names a role, a workflow or git.

## Open questions and the assumptions this plan uses

| # | Question | Assumption until answered |
|---|---|---|
| Q1 | ROADMAP lists P04 as "Advanced coordination", and PRD lists project/backlog management as a non-goal. | This work is phase 04 because the brief says so. The operator needs a ROADMAP/PRD rev-4 note; this plan does not write it. The board stays a work queue for agents, with no estimates, sprints or reporting. |
| Q2 | Where is the workspace registry kept? | In the WSL state dir (next to `state.db`), not in the workspace. `workspace.json` holds only `{id, name}`. |
| Q3 | The brief allows `board.json` or `boards/<id>.json` and `--board id`, but decision 1 says one board per workspace. | One board: `.agent-studio/board.json`. `run-board` has no `--board` flag. |
| Q4 | `.agent-studio/board.json` already holds the P03 software-board config. | S06 deletes the P03 reader. S07 defines the new format and rejects the old shape with `BOARD_CONFIG_INVALID`. The file in this repo is rewritten by hand when S07 lands. |
| Q5 | Which schema version do the new tables use? | `SCHEMA_VERSION` is 8 today. Each story that needs a schema change adds the next free version (S03 added `teams.def_id` / `agents.member_id` as 9; S06 drops the P03 tables, expected 10; S07 adds the generic tables including `phases`, expected 11; S08 adds the board-state pointer if S07 did not, expected 12). Stories say "next migration" and record the number in Evidence. |
| Q6 | What does `team add-member` do for `--provider` and `--role` it cannot check? | It writes the file, then prints `team validate` warnings; `team start` is where an invalid file fails (`TEAM_CONFIG_INVALID`). |
| Q7 | Member names vs ids. | The id is a slug of the name, unique in the team; the name is for people and panes. `--member` accepts either. |
| Q8 | Multiple teams in one workspace and the one-active-assignment-per-workspace rule from P00. | Unchanged: workspace-mutating work is serialized per workspace/worktree path as today. Several teams can run, but write-heavy work waits on that lock; read-only asks do not. |
| Q9 | `board.json` and the ticket store. | Tickets **and phases** live in the state DB (runtime data); the board config (statuses, `ticketFields`, rules) is the hand-editable file. Phases are managed only with `board phase ...` commands. |
| Q10 | Can Claude Code and Codex start the board MCP server and reach the command inbox from their sandboxes? | Unknown. S12 begins with a spike on the real CLIs and records the result; if one cannot, S12 says so and that provider is out of scope. |

## Epics → stories

| Epic | Story | Deliverable |
|---|---|---|
| A The new team (no board) | [P04-S01](./stories/P04-S01-workspace-init-and-resolution.md) | `init`, `workspace.json`, cwd resolution, `--workspace` override, output convention |
| | [P04-S02](./stories/P04-S02-team-definitions.md) | `team add/add-member/remove-member/list/show/validate/import-legacy` on `teams/<id>.json` |
| | [P04-S03](./stories/P04-S03-team-lifecycle-by-id.md) | `team start/stop/status` by id, several teams, member-named panes |
| | [P04-S04](./stories/P04-S04-ask-and-one-off-workflows.md) | `team ask`, `run-workflow`, `workflows`, `check`, `retry`, `blocked`, `resolve` |
| | [P04-S05](./stories/P04-S05-cutover-replace-team-py.md) | Cut-over: `team unpack/review/dev/fix/qa/final/commit/index`, `run-workflow --story`, `attach` by id, on `team.py`'s state files |
| B Clean slate | [P04-S06](./stories/P04-S06-remove-software-board.md) | Delivered with the new commands; tag, then delete the software board (code, tables, commands, tests, workflows, prompts), then `team.py` and the CLI-side `team.json` fallback |
| C The generic board | [P04-S07](./stories/P04-S07-generic-board-model.md) | Config-driven statuses, generic tickets, `ticket add/move/show/list/depend`, `board show` |
| | [P04-S08](./stories/P04-S08-board-phases.md) | Phases as database records with a protected default phase: `board phase add/list/show/edit/close/reopen/remove/set-current/clear-current`, `ticket add --phase`, `ticket phase` |
| | [P04-S09](./stories/P04-S09-board-rules-and-outcome-applier.md) | Rules schema and `board rules check`; apply a finished run to its ticket |
| | [P04-S10](./stories/P04-S10-scheduler-and-run-board.md) | Scheduler, `team run-board` / `stop-board`, caps, deps, workspace modes, `merge` action |
| | [P04-S11](./stories/P04-S11-recovery-limits-and-live-gate.md) | Lease recovery, usage limits, `board resume`, docs, live gate |
| D Agents use the board | [P04-S12](./stories/P04-S12-board-mcp-server.md) | `agent-studio mcp` stdio MCP server: agents add and list tickets and phases; spike first |

Order: S01 → S02 → S03 → S04 → S05 → S06 → S07 → (S08, S09 in parallel) → S10 → S11, and S12 after S08 (best after S10). S01–S05 give the new team and replace `team.py`; S06 is the clean slate; S07–S11 build the generic board with the new team.

## Constraints for implementers (self-hosting)

Until S05 the project is built with the current tooling (`team.py`, the `story-delivery` workflow, `scripts/validate.py`), which does not use the board. From S05 the operator builds the rest with the new commands instead of `team.py`.

1. Through S04, after every story: `agent-studio team start --workspace` with `.agent-studio/team.json`, `task direct`, `workflow start/show/retry`, `scripts/validate.py` and every `team.py` command still work. A change to any of them is backward compatible.
2. S05 is the cut-over: it ports the commands and leaves `team.py` in place. The operator verifies the new commands by finishing S05 (`qa`, `final`, `commit`) and delivering S06 end to end with them; `team.py` and its tests are deleted as the last step of S06 (it stays in git history).
3. S06 deletes the software board **and its tests**. Nothing the operator runs after S05 may call the software board; `team status` and the other new commands never do.
4. Every story leaves the unit suite and its own integration tests green. Deleting tests with their code is expected only in S06 (software board and `team.py`).
5. The engine (workflow, runner, providers, migrations up to version 8) is not rewritten. Schema changes are new migrations.
6. Tests use throwaway repos and temp state dirs (P00 [rules for implementers](../phase-00/stories/README.md#rules-for-implementers)). Mocks never prove a real provider.

## Design contract

Every P04 story targets this section as its "Architecture". The P00, P01 and P03 contracts still hold where not replaced: the coordinator is the only writer of state and events, the CLI writes only to the command inbox, runners write only to the report inbox, and no shell ever receives user text. A story that changes a rule here updates this section in the same change.

### A. Workspace

`agent-studio init` writes `.agent-studio/workspace.json` `{id, name}` (the id is a uuid written once and never changed) and registers it. Commands resolve the workspace by walking up from the current directory to the first `.agent-studio/workspace.json` (a `.agent-studio/` without that file is not a workspace); `--workspace PATH` overrides and must itself contain `workspace.json`. No match is `WORKSPACE_NOT_FOUND` with remediation `run agent-studio init`. No hidden global default. The resolver reads files only and never needs the registry.

The registry is the file `workspaces.json` in the state dir (`{"workspaces":[{id, name, path}]}`, one entry per canonical path, atomic replace), not part of `state.db`. `init` and `workspace list` run in the CLI process and are not dispatch commands. A registered path that no longer exists is shown as missing, never deleted silently.

### B. CLI output

New commands print the existing response envelope as JSON when `--json` is given (whether or not stdout is a terminal; `--pretty` still indents) and human text otherwise. `request` and `serve` stay JSON for machine callers. Errors carry the existing `{code, message, remediation}` shape; the human form prints them on stderr as `CODE: message` plus the remediation. Exit code is 0 on success and 1 on error in both modes.

### C. Team definitions

`.agent-studio/teams/<id>.json` is `{id, name, members:[{id, name, role, provider, model?, reasoning?}]}`; the file's `id` equals its file name. Team and member ids are slugs (`^[a-z0-9][a-z0-9-]{0,63}$`); a member id is the slug of its name, and `--member` accepts the id or the name (case-insensitive). The CLI reads and writes these same files (`teamdefs.py`; the definition commands run in the CLI process, not through dispatch), reading fresh before every write and keeping unknown keys, key order and two-space indentation (atomic replace). The database holds runtime only. Hand edits take effect at the next `team start`. Legacy `.agent-studio/team.json` is read-only until S06 deletes the CLI-side fallback: while `teams/` has no team it is shown as team `default` (`provider` ← `providerId`), and `team import-legacy` converts it once. Codes: `TEAM_EXISTS`, `TEAM_NOT_FOUND`, `TEAM_AMBIGUOUS`, `MEMBER_EXISTS`, `MEMBER_NOT_FOUND`, `TEAM_CONFIG_INVALID` (with `data.problems: [{path, message}]`).

Runtime (S03): `team start` reads and validates the definition in the CLI and sends the mapped roster with `teamDefId`; the coordinator stores it as `teams.def_id` and `agents.member_id` (NULL for legacy `team.json` and `--agent` starts), so a running team never re-reads its file. Several definitions can run in one workspace; one definition id has at most one team in `starting`/`running`/`stopping` (`TEAM_ALREADY_RUNNING`). `team stop` / `team status` take a definition id, or a runtime UUID as before. `team status` is a read-only query and never touches board code. `teams.find_agent` resolves `--member` (agent UUID, member id, or name, case-insensitive).

Use (S04): `team ask | run-workflow | workflows | check | retry | blocked | resolve` live in `teamcli.py` and are CLI wrappers over the existing dispatch commands (`team.status`, `snapshot`, `task.direct`, `workflow.list/validate/start/retry`, `assignment.resolve`); no dispatch or engine rule changes. They need the team `running` (`TEAM_NOT_RUNNING` otherwise, nothing written), map `--member` / `--bind ROLE=MEMBER` to agent ids with the `find_agent` rules, and `ask` takes `--policy read_only|workspace_write` (default `read_only`).

Story delivery (S05): `team unpack | review | dev | fix | qa | final | commit | index` live in `storycli.py` and run in the CLI process as operator-side glue (they run git, the validation command and `ctags`; agents are reached only through `task.direct`, `workflow.start` and the watch helpers). Per-story state stays in `team.py`'s files, `<state home>/agent-studio/project-team/<slug of workspace root>/story-<key>.json`, same keys, unknown keys kept, so a story begun with `team.py` continues. A command picks its member by role (`ROLE_UNBOUND` / `ROLE_AMBIGUOUS`, `--member` overrides). Codes added: `STORY_NOT_READY`, `WORKSPACE_DIRTY`, `TESTS_FAILED`, `NOT_COMMITTED`. `team attach` accepts a definition id.

### D. Board

`.agent-studio/board.json` holds `statuses` (`id`, optional `kind`: `initial`, `done`, `closed`), `ticketFields` and `rules`. Statuses are validated in code, not by an SQL CHECK. Nothing in board code names a role, a workflow, a status or git; rules carry all of that.

**Phases are database records, not configuration.** Each board has a `phases` table (`id` slug unique on the board, `name`, `description`, `position`, `status` open/closed, timestamps) managed only by `board phase` commands, so they can be added at any time. Every board has a **default phase** (`id: default`, name "Default", first position) created in the same transaction as the board's state row on first use; it cannot be removed or closed, but its name and description can be edited. Every ticket belongs to exactly one phase; `ticket add` without `--phase` uses the default phase. The board state holds one pointer, the **current phase**, set by `board phase set-current ID` (an open phase) and cleared by `board phase clear-current`; **when none is set, the default phase is current** ("effective current phase"). Changing the pointer never interrupts running work: it finishes and its outcome is applied, and new claims use the new phase. Phase changes write board events with who and when. Codes: `PHASE_NOT_FOUND`, `PHASE_EXISTS`, `PHASE_PROTECTED` (default phase), `PHASE_CLOSED`, `PHASE_NOT_EMPTY`.

### E. Rules and running

A rule is `{when:{status}, role, workflow, onPass, onFail, onBlocked?, maxRounds?, during?, cap?, requiresDeps?, workspace?: main|worktree|none, action?, priority?}`. Rules are validated at load against the roles file, the workflow definitions and the board statuses. A team runs the board with `team run-board`; only one team runs the board at a time. The scheduler offers only tickets of the effective current phase, and only to free members.

### F. Engine between S06 and S10

S06 cuts the engine's links to the P03 board without changing what it does on a database with no tickets. `task.direct` and `workflow.start` accept only the team's workspace; any other path is `WORKTREE_NOT_REGISTERED` and nothing is written. S10 restores the worktree check against the generic tickets. Usage limits stay in the engine: a `USAGE_LIMIT` report still marks the agent `limit_reached` (`agents.limit_reset_at`), and the agents-only `board.resume` command (`--agent ID | --all`) stays as the way to clear it. S11 extends it to `board resume --member M`. Every other `board.*` and `ticket.*` command, and `debug.ticket_worktree`, is removed in S06. `worktrees.py` and `gitws.py` stay for S10.

### G. Board MCP server (S12)

`agent-studio mcp` is a stdio MCP server (JSON-RPC 2.0 over stdin/stdout, standard library only) that an agent's own client launches. Tools: `ticket_add` (title, body, priority?, phase?, dependsOn?), `ticket_list`, `ticket_show`, `phase_list`, `board_show`. Every call is sent to the coordinator through the same validated command path as the CLI (`request` envelope with an idempotency key), so the coordinator stays the only writer and agents never open the database. The adapters generate a per-assignment MCP config only for members whose definition says `canAddTickets: true` (a new optional boolean in `teams/<id>.json`); the server's environment carries the assignment id and agent id. The coordinator checks that the assignment is active and its member may add tickets, records `createdBy` (member id, assignment id) on the ticket, enforces a per-assignment cap (default 10, `TICKET_CAP_REACHED`) and a duplicate check against open tickets of the same title (`TICKET_DUPLICATE`), and puts the ticket in the board's `initial` status in the requested phase (default phase when omitted). Providers without MCP support, and a provider whose spike fails (Q10), are out of scope; there is no file hand-off.
