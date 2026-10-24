# Brief: workspace, team and board as independent components (re-baseline)

Status: Decisions made 2026-10-24 (section 5). The software board is REPLACED in place; ready for `team.py unpack`.

## 1. Goal (the operator's words, as commands)

```
cd /xxx/yyy; agent-studio init                                   # a workspace
agent-studio team add --name "Awesome dev team" --id dev-team    # a team in it
agent-studio team add-member --team dev-team --name Ryan --role "Team Lead" ...   # members
agent-studio team start | stop                                   # the team's agents (tmux panes)
agent-studio team ask  --team dev-team --member Ryan "..."       # ask a FREE member to do something
agent-studio team run-workflow --team dev-team refine-dev-qa ... # a one-off workflow, no board
agent-studio board config --statuses "backlog,dev-ready,qa-ready,review-ready,done,close-not-required" ...
agent-studio board phase set <phase>                             # the team only works tickets of the current phase
agent-studio team run-board | stop-board                         # the team works the board autonomously
```

Principles:
1. **Team and board are independent.** A team is useful with no board (ask a member, run a workflow). A board is
   just data (statuses, phases, tickets, rules); it does nothing until a team runs it.
2. **The coordinator is only the glue.** It sends tasks to agents through the team side and reads/updates tickets
   through the board side. Neither side calls into the other's internals.
3. **The board is generic.** Statuses, phases and the "who picks which status, what happens on pass / fail" rules are
   configuration. Nothing in the board code names `develop`, `qa`, a role, or git.
4. **The current software board is replaced, not kept.** There is one board implementation. It has not been used live
   (P03-S17 is still To Do), so nothing is migrated.

## 2. Where the project is today (P00-P03, as built)

| Concept | Today | Gap to the goal |
|---|---|---|
| Workspace | A path passed to every command; nothing is created or registered. `.agent-studio/` holds roles, workflows, `team.json`, `board.json` by convention. | No `init`; commands need `--workspace` instead of resolving it from the current directory. |
| Team | Created only at runtime by `team start --workspace` from a roster (`team.json` or `--agent`); UUID ids, agents addressed by id/ordinal. At most one running team per workspace. | No team definitions, no `team add`, `add-member`, `list`; no stable team/member ids; no several teams per workspace. |
| Ask a member | `task direct` (refuses a busy agent: `AGENT_BUSY`). | Exists; needs member names and a friendly command. |
| One-off workflow | `workflow start`, definitions in `.agent-studio/workflows`; `team.py review/dev/fix/qa/final` are operator glue. | Exists; glue should become real commands. |
| Board data | `tickets`, `ticket_deps`, `board_state` per workspace. **Statuses, columns, the pass/fail outcome table and the pick order are hard-wired** in `schema.py` (`TICKET_STATES` SQL CHECK, `BOARD_COLUMNS`, `BOARD_OUTCOMES`, `BOARD_PICK_*`); three ticket kinds with their own status sets. | Not configurable; a different status set means a code change and a migration. |
| Board phases | Phases exist only as documents (`phases/phase-NN`). | No phase on the board, no "current phase". |
| Board <-> team | The scheduler serves "the running team on the workspace"; `board run` needs it. Git worktrees, branch rounds and the squash merge are built into the board. | No explicit binding; git delivery cannot be turned off or reused for other work. |
| Human interface | JSON-only CLI (for Windows/Electron callers) plus the `team.py` helper. | Hand-driving means `team.py`; no single human CLI. |

**What stays as is:** coordinator, inbox, state/migrations, runner, provider adapters, tmux worker, roles, workflow
engine and definitions, validation, leases and crash recovery, usage limits. **What changes:** the board's data model
and scheduler (hard-wired -> data-driven), team creation, workspace resolution and the CLI surface.

## 3. Target model

**Workspace.** `agent-studio init` writes `.agent-studio/workspace.json` (`{id, name}`) and registers it. Every command
resolves the workspace by walking up from the current directory; `--workspace` stays as an override.

**Team (definition + runtime).**
- A team definition is a plain JSON file you can edit by hand: `.agent-studio/teams/<id>.json` with `{id, name,
  members:[{id, name, role, provider, model?, reasoning?}]}`. This is the only definition format the new commands
  write.
- `team add`, `add-member`, `remove-member`, `list`, `show` read and write **these same files** (no copy in the
  database, no hidden state). The CLI keeps unknown keys, key order and two-space indentation, so a hand edit and a
  command edit don't fight each other.
- **Legacy `.agent-studio/team.json`** is read-only and exists only until the new team replaces `team.py` (P04-S05): while
  `teams/` has no team and `team.json` exists, `team start` and `team list` use it as team `default`, and
  `team import-legacy` converts it once into `teams/<id>.json`. No command ever writes `team.json`; P04-S05 deletes the
  fallback together with `team.py`.
- Hand edits take effect at the next `team start` (the file is read fresh each time; a running team is not changed
  until restarted). `team validate [--team ID]` checks a file without starting anything: unique ids, known provider,
  role present in `roles.json`, model/reasoning accepted by the provider.
- Runtime = today's team/agents tables, keyed by the definition's ids so panes, logs and commands say `Ryan`.
- `team start|stop|status` act on one team (default: the only one). Several teams may run in one workspace.

**Board (data).** `.agent-studio/board.json` (or `boards/<id>.json`):
```json
{ "statuses": [ {"id":"backlog","kind":"initial"}, {"id":"dev-ready"}, {"id":"qa-ready"}, {"id":"review-ready"},
                {"id":"done","kind":"done"}, {"id":"close-not-required","kind":"closed"} ],
  "phases":   [ {"id":"p1","name":"Foundation"}, {"id":"p2","name":"UI"} ],
  "currentPhase": "p1",
  "ticketFields": ["title","body","priority","dependsOn"] }
```
Tickets: key, title, body, phase, status, priority, dependencies, assignee, lease, events. Kinds and per-kind status sets
become optional templates, not a schema rule.

**Board rules (who works what).** Part of the board config, validated against the team's roles and the workflow
definitions:
```json
{ "rules": [
  {"when":{"status":"dev-ready"},"role":"Developer","workflow":"dev","workspace":"worktree",
   "onPass":"qa-ready","onFail":"dev-ready","onBlocked":"blocked","maxRounds":3},
  {"when":{"status":"qa-ready"},"role":"QA","workflow":"qa","onPass":"review-ready","onFail":"dev-ready"},
  {"when":{"status":"review-ready"},"role":"Team Lead","workflow":"review","onPass":"done","onFail":"dev-ready"} ] }
```
Optional per-rule keys: `during` (status while running), `cap` (parallel limit), `requiresDeps`, `workspace`
(`main` | `worktree` | `none`), `action` (a coordinator-only step such as `merge`, no agent), `priority` ordering.

**Running.** `team run-board --team dev-team [--board id]` binds a team to a board and starts the scheduler tick for the
pair; `stop-board` stops claiming (running work finishes). The scheduler only offers tickets whose phase is the
board's `currentPhase` (or unphased). `board phase set <id>` changes it. A team not running a board is free for
`ask` and `run-workflow`.

**What the generic board must keep from the software board** (all optional, driven by rules), so replacing it loses no
capability the operator relies on: an isolated git worktree and branch per ticket (`workspace: worktree`), a
coordinator `merge` action (no agent), per-rule parallel caps, dependencies between tickets, a round limit with
blocking, usage-limit release (`board.resume`), and lease/crash recovery. Triage, unpack and bug-file templates are not
carried over; the ticket body and ordinary workflows cover them.

**Reuse.** Keep the engine, `worktrees.py` / `gitws.py`, provider adapters, runner, roles, workflows and validation.
Rebuild the ticket store, board config, scheduler and outcome applier on the generic model.

**Agents add tickets through an MCP server (P04-S12).** There is no file hand-off: `agent-studio mcp` is a stdio MCP server
that the agent's own client launches, and each tool call goes to the coordinator through the same validated command path as
`ticket add` (with an idempotency key), so the coordinator stays the only writer. The adapters generate a per-assignment MCP
config (Claude: `--mcp-config` replaces the current `--strict-mcp-config` default only for roles allowed to add tickets, with
`mcp__agent-studio__*` added to the allowlist; Codex: `mcp_servers.*` overrides). The server's environment carries the
assignment and agent id, so every ticket records who created it and in which run. Guardrails: tickets land in the board's
initial status, a per-run cap (default 10), a duplicate check against open titles, the board's normal validation, and a
per-role `canAddTickets` switch in the team definition. Whether each client can start the server and reach the state
directory from its sandbox is unverified and is the spike that opens S12.

## 3b. Constraints for the implementing team (self-hosting)

Until P04-S05 the project is built with the current tooling (`team.py unpack/review/dev/fix/qa/final/commit`, the
`story-delivery` workflow, `scripts/validate.py`), which does **not** use the board. From P04-S05 the operator runs the
**new team and commands instead of `team.py`**, and the remaining stories are built with them. So:
1. Through S04 these must keep working after every story: `agent-studio team start --workspace` with
   `.agent-studio/team.json`, `task direct`, `workflow start/show/retry`, `scripts/validate.py` and the `team.py`
   commands. S05 replaces the last of them.
2. S05 is the cut-over: it ports every `team.py` command the operator uses to `agent-studio team ...` (same behaviour:
   the saved per-story state, the unit-tier `fix`/`qa`/`final`, the integration gate at `commit`, the lead's commit
   message), deletes `team.py` and the `team.json` fallback, and the operator verifies the new team on one real story
   before S06 starts.
3. S06 (removal of the software board) deletes its code, tables, commands, **tests**, built-in `board-*` workflows and
   prompts. Nothing the operator runs after S05 may depend on the software board, so `team status` and the other new
   commands never call it.
4. Each story leaves the unit suite green and its own integration tests passing; deleting tests with their code is
   expected only in S06.
5. The engine (workflow, runner, providers, state migrations up to the current version) is not rewritten; schema changes
   are new migrations.

## 4. Proposed phase (P04), delivery order

Team without a board is usable first; the board generalisation follows.

| Story | Content |
|---|---|
| P04-S01 | **Workspace init and resolution**: `init`, `workspace.json`, cwd resolution, `--workspace` override, registry; the output convention (human text on a terminal, `--json` for machines; `request`/`serve` unchanged) for every new command. |
| P04-S02 | **Team definitions**: `team add / add-member / remove-member / list / show / validate / import-legacy` on hand-editable files `.agent-studio/teams/<id>.json`; edits preserve unknown keys and formatting; stable team + member ids; legacy `team.json` read-only fallback. |
| P04-S03 | **Team lifecycle by id**: `team start|stop|status` on a definition; runtime keyed by ids; several teams per workspace; pane/agent names from member names. |
| P04-S04 | **Ask and one-off workflows**: `team ask` (free members only, `--wait`), `team run-workflow` (bind roles to members), `team workflows`, `team check`, `team retry`, `team blocked` / `team resolve`. |
| P04-S05 | **Cut-over: the new team replaces `team.py`**: `team unpack / review / dev / fix / qa / final / commit` and `team index` with the same behaviour and per-story state as `team.py`; delete `team.py` and the `team.json` fallback; verify on one real story. |
| P04-S06 | **Remove the software board**: delete its code, tables (migration), commands, built-in board workflows/prompts and tests; tag the old code in git first. |
| P04-S07 | **Generic board model**: new tables, statuses from `board config` validated in code (no SQL status CHECK), generic `ticket add/move/show/list/depend`, `board show`. |
| P04-S08 | **Board phases**: phase entity, `ticket.phase`, `currentPhase`, `board phase set/list`. |
| P04-S09 | **Board rules and outcome applier**: rules schema + validation (`board rules check`), apply a finished workflow run to the ticket (`onPass`/`onFail`/`onBlocked`, round limits, blocking). |
| P04-S10 | **Scheduler and `team run-board` / `stop-board`**: team<->board binding, claim, lease, phase filter, caps, dependencies, free-member rule; ticket workspace modes `main` / `worktree` and the `merge` action. |
| P04-S11 | **Recovery, limits and live gate**: lease expiry and crash recovery, usage-limit release and `board resume`, docs, a live run of the board on a real project. |
| P04-S12 | **Board MCP server for agents**: `agent-studio mcp` (stdio MCP server) exposing `ticket_add`, `ticket_list`, `ticket_show`, `board_show`; first step is a spike with the real Claude Code and Codex CLIs (can they launch it, reach the command inbox from their sandbox, and are the tools callable under the adapters' allowlists); per-assignment config generated by the Claude and Codex adapters; agent identity and run recorded on every ticket (`createdBy`); tickets land in the board's initial status; per-run cap and duplicate-title check; a per-role `canAddTickets` switch; providers without MCP support are out of scope (no file hand-off). |

S01-S05 deliver "the new team", usable on this project without any board, and replace `team.py` (S05 is the cut-over).
S06 is the clean slate; S07-S11 build the generic board with the new team. S12 lets agents add tickets to it through an MCP server
(after S07 for `ticket add`; best after S10 so the tickets it creates are picked up by a running board).

## 5. Decisions (made 2026-10-24)

1. **One board per workspace.** Many teams may exist and run, but one team runs the board at a time; the others stay free
   for `ask` / `run-workflow`.
2. **Definitions are hand-editable files** `.agent-studio/teams/<id>.json` (git-trackable); the CLI edits the same files; the state DB holds only runtime. `team.json` is a read-only legacy fallback until the S05 cut-over deletes it with `team.py`.
3. **CLI output** is human-readable on a terminal and JSON with `--json`; `request` and `serve` stay JSON for machine callers.
4. **The software board is replaced in place** by the generic board (S06 deletes it, S07-S11 build the new one), after the new team has replaced `team.py` (S05). Worktree-per-ticket
   and merge are kept as optional generic rule features; software-board tickets are not migrated; the team builds all of
   this with the existing `team.py` workflow on `.md` stories.

## 6. Risks

- Deleting the software board (S06) removes about sixteen stories of tested code; tag it in git first, and keep the
  engine tests untouched so a regression in the shared layers is still caught.
- The self-hosting rule (section 3b) is the main hazard: a change to `team start`, `task direct` or `workflow start`
  can stop the team that is building the change. Keep those paths backward compatible through S04, and treat S05 as a
  cut-over with a rollback (`team.py` stays in git history and is only deleted after one real story succeeds).
- Dropping SQL status CHECKs trades database guarantees for validation in code; keep a transition validator and tests
  per board config.
- Rules that name roles and workflows need load-time validation, or a misconfigured board fails only when a ticket arrives.
- The generic board must really cover worktree isolation, merge, caps and recovery (S10/S11), or replacing the software
  board loses them.
- Several teams on one machine multiply provider usage; limits stay per agent.
