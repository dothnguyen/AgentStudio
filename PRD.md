# Agent Studio — Product Requirements Document

> Status: Draft rev 3: P00 backend proven; P01 configurable workflows
> Date: 2026-10-22
> Delivery: [ROADMAP.md](./ROADMAP.md)

## 1. Product promise

Agent Studio is a local command center for a team of AI coding agents. A user selects an existing workspace, starts agents using Codex, Claude Code, Antigravity CLI (`agy`), and/or OpenCode, assigns a task directly to an idle member or launches a workflow, and sees truthful team/task status while the team works. No provider is the default or privileged execution engine.

**P00 proves the backend and the Windows↔WSL boundary before any UI work.** A WSL CLI starts a coordinator daemon and a tmux session with exactly one pane per configured agent. The user attaches to that single tmux window to watch all workers live. A real two-provider workflow must complete, survive CLI disconnect and coordinator restart, and pass the live acceptance gate. Because the previous Electron + NTM attempt failed at the Windows↔WSL boundary, P00 also proves—first, in S01, without any UI—that a Windows process can drive the backend through one fixed `wsl.exe --exec` entry point with JSON over stdio. **P01 makes workflows configurable:** the operator writes a workflow definition in JSON or YAML (ordered stages, each with a role, a permission level, a prompt template, and where each outcome goes next) and tells the team to run it with one prompt. P02 then builds an Electron UI for commands and status. The UI opens/attaches native tmux for terminals; it does not embed or stream terminal panes.

## 2. User jobs

1. Configure a team roster with an independently selected provider and role for each agent.
2. Start the team in an existing folder and see one native tmux pane per member in one window.
3. Dispatch a direct task to an idle member. In P00 only one workspace-mutating assignment runs per workspace at a time; `read_only` tasks may run on other idle members alongside it.
4. Start a repeatable workflow that hands work between members and finishes automatically or explains why it stopped.
4a. (P01) Define my own workflow in a JSON or YAML file — stages in order, the role, permission, and prompt template of each, and where each verdict routes (e.g. QA fail → Developer, QA pass → TeamLead, TeamLead fail → Developer) — and run it against the team with one prompt.
5. Read team, agent, task, assignment, and workflow status from durable evidence—not from terminal text or pane idleness.
6. Detach/reattach the tmux view and restart the operator CLI or coordinator without losing work or duplicating dispatch.
7. Resolve a paused or uncertain assignment explicitly (retry, mark failed, or cancel).
8. Cancel or stop only Agent Studio-owned work and preserve diagnostics.

## 3. Architecture and authority

```text
Windows                         │  WSL distro (native Linux filesystem)
                                │
P00 spike: PowerShell ──────────┼─→ wsl.exe -d <distro> --exec ~/.local/bin/agent-studio <cmd | serve>
P01: Electron main (1 process) ─┼─→   Bash entry shim: login env → exec python3 -m agent_studio
Windows Terminal ───────────────┼─→ wsl.exe -d <distro> --exec tmux attach -t <owned session id>
                                │          │
                                │   CLI / serve (Python) ──writes──→ SQLite command inbox
                                │                                        │
                                │   Coordinator daemon (Python) ←────────┘ sole writer of state + events
                                │      ├─→ tmux session: N panes, one Bash worker shim per pane
                                │      │       └─→ assignment runner (Python) ──writes──→ report inbox
                                │      └─→ provider adapters: codex / claude / agy / opencode
```

- **Windows↔WSL boundary.** The previous attempt failed here: quoting parsed twice (Node → `wsl.exe` → shell), missing login environment/PATH so providers were not found, no TTY for tmux, processes dying with their `wsl.exe` parent, and UTF-16/path translation. The rule: Windows only ever invokes one fixed executable via `wsl.exe -d <distro> --exec <absolute path>`, which bypasses shell parsing. No task text, user text, or path is placed on a Windows-side command line; requests and responses are UTF-8 JSON over stdin/stdout. The only other crossing is launching `tmux attach` for a backend-validated owned session ID.
- **Bash at the edges, Python for logic.** `agent-studio` is a small Bash shim that establishes the user's login environment (so provider CLIs resolve exactly as in the user's own terminal) and execs the Python package. Each tmux pane runs a small Bash worker shim. The coordinator, state, protocol, workflow, reconciliation, and adapters are Python 3 standard library. No code builds SQL from strings or interpolates user text into a shell command.
- **Coordinator daemon.** One detached coordinator per WSL user owns scheduling, state transitions, and reconciliation. It is never a child of a `wsl.exe` call, CLI invocation, or UI process; losing any of those loses nothing. P00 tests whether the distro survives with no Windows terminal open and documents the keep-alive used.
- **Write authority.** SQLite on WSL's native filesystem is authoritative for Agent Studio tasks, assignments, workflow transitions, and events. The coordinator is the only writer of materialized state and events. The CLI/serve process writes only to the command inbox; assignment runners write only to the immutable report inbox. Snapshots are read-only queries. The selected project folder remains the source of code and documents, not an app-managed backlog.
- **tmux** owns persistent pane identity and native terminal viewing. The coordinator creates one pane per configured agent and prints an exact attach command. Pane output is observational, never a task-result protocol. There is no xterm.js, pane streaming, or tmux-screen parser in P00 or P01.
- **Providers.** Each provider has a peer adapter for discovery, capability/authentication checks, safe invocation, result normalization, permission mapping, cancellation, and recovery. All adapters map the same small permission vocabulary (`read_only`, `workspace_write`) or refuse it. An unsupported capability fails closed rather than triggering another provider or unrestricted mode.
- **Decisions.** The coordinator alone decides workflow transitions from validated provider/process/validation evidence. Runners submit immutable reports; the UI and tmux do not update task state.
- **P01** keeps this architecture. The coordinator's workflow engine runs any validated, frozen workflow definition instead of one hard-wired sequence (§6b).
- **P02** Electron main holds one long-lived `wsl.exe --exec agent-studio serve` process speaking line-delimited JSON. The renderer gets typed, allowlisted IPC only; it cannot read SQLite, launch arbitrary WSL commands, or stop the coordinator by closing a window.
- NTM and OrchestMux are not dependencies of the new runtime. Their old data/sessions are never silently modified.

See the [P00 architecture](./phases/phase-00/architecture.md) for boundary, command, database, pane, and adapter contracts.

## 4. Domain model and states

| Entity | Meaning |
|---|---|
| Workspace | User-selected existing directory. In P00 workflow runs require it to be a git repository. |
| Team | Roster of N agent instances and optional workflow role bindings. |
| Agent | One provider, role instructions, stable pane identity, capabilities, and availability. **Stateless between assignments in P00:** each assignment is a fresh headless provider invocation, and context (task, diff, findings) is passed explicitly. Provider session resume is optional. |
| Task | User goal, workspace, origin (direct/workflow), and final outcome. |
| Assignment | One idempotently identified attempt by one agent at one task/stage, with a permission policy. |
| Permission policy | `read_only` or `workspace_write`; mapped per adapter to a verified provider mode, or refused. |
| Workflow definition | (P01) Versioned JSON/YAML file in the workspace (or the built-in `developer-reviewer`): ordered stages with role, permission, prompt template, outcome routing, and visit/step bounds. Frozen into each run with its SHA-256. |
| Workflow run | Base commit, frozen definition and role bindings, stage sequence, per-stage diffs, routing decisions, visit/step counts, and final report. |
| Event | Append-only, sequenced evidence of an accepted command or transition. |

Task states: `queued`, `assigned`, `running`, `waiting_input`, `review`, `succeeded`, `failed`, `cancelled`. Assignment states add `claimed` and `reconciling`. Agent availability is separate: `starting`, `idle`, `busy`, `waiting_input`, `offline`, `error`. A live pane never proves an assignment succeeded; a quiet pane never proves an agent is idle.

## 5. Requirements

| ID | Requirement | P00 proof |
|---|---|---|
| R-01 | Preflight selected WSL distro, workspace, tmux, each selected provider's executable/capabilities/authentication. | Specific actionable failure; no partial session. |
| R-02 | Launch exactly the configured roster. | N agents produce N uniquely owned tmux panes in one window; test N=2 and N=3. |
| R-03 | Watch all workers live in one terminal window. | Native tmux tiled layout; detach and reattach while work continues. |
| R-04 | Direct task dispatch to a selected idle agent. | One durable receipt and result; busy agent or mutating workspace conflict is rejected explicitly; concurrent `read_only` task allowed. |
| R-05 | Automatic provider-neutral workflow. | Developer → Reviewer → bounded Developer repair/Reviewer recheck, decided by the truth table in §6. |
| R-06 | Trustworthy task and team status. | Provider/process/validation evidence and committed events determine outcomes. |
| R-07 | Durable recovery. | CLI disconnect and coordinator restart do not duplicate assignments. |
| R-08 | Scoped cancellation, stop, and resolution. | Only verified run-owned processes/sessions are affected; paused/uncertain work is resolved only by explicit operator command. |
| R-09 | Permission/attention honesty. | Blocked action becomes visible; no automatic unrestricted approval or silent policy broadening. |
| R-10 | Windows↔WSL boundary. | A Windows process drives the backend through `wsl.exe --exec` + JSON stdio; hostile task text round-trips byte-exact; backend survives the Windows caller exiting. |
| R-11 | Workspace change evidence. | Workflow records base commit and per-stage diff; Reviewer runs `read_only`. |
| R-12 | Later desktop command center. | P02 UI reads status/dispatches commands over `serve` and opens native tmux externally; no terminal streaming. |

| ID | P01 requirement | P01 proof |
|---|---|---|
| R-13 | Workflow definitions in JSON or YAML. | Both formats load into the same model; every invalid definition is rejected statically with a file/path/line error; no third-party parser. |
| R-14 | Stage = role + permission + prompt template + outcome routing. | Fake-adapter runs prove QA fail → Developer, QA pass → TeamLead, TeamLead fail → Developer, and both bounds (`maxVisits`, `maxSteps`). |
| R-15 | Run a workflow with one prompt. | `workflow start --definition NAME --text …` (CLI and `serve`) and `team.py run NAME "prompt"`; real three-role run in the P01 gate. |
| R-16 | P00 guarantees hold for definition runs. | Frozen definition, restart without duplicate dispatch, resolve/cancel, one writer per workspace, `read_only` stages write nothing; P00 workflow form still works. |

## 6. P00 workflow and test contract

P00 supports a configurable roster; the built-in workflow binds two distinct members to Developer and Reviewer roles. Either role may use any of the four providers.

- **Workspace.** The Developer works in a disposable fixture workspace that is a git repository. At run start the coordinator records the base commit; after every Developer stage it captures the diff against base as a stage artifact. That diff is the Reviewer's input and part of the repair context. Rollback (reset to base) is offered only for disposable fixture workspaces.
- **Policies.** Developer stages run `workspace_write`; Reviewer stages run `read_only`.
- **Validation.** After each Developer stage the coordinator runs the configured deterministic validation command and records exit code and bounded output separately from any model verdict. The Reviewer still runs when validation fails so its findings can accompany the validation output into repair.
- **Decision truth table** (retry budget = 1 repair):

| Developer result | Validation | Reviewer verdict | Next |
|---|---|---|---|
| failed / inconclusive / waiting_input | — | — | Workflow paused; operator resolves (retry, fail, cancel). |
| succeeded | pass | pass | Workflow succeeded. |
| succeeded | pass | fail | Repair if budget remains, else workflow failed. |
| succeeded | fail | any valid verdict | Repair if budget remains, else workflow failed. |
| succeeded | any | malformed / inconclusive | Workflow paused; operator resolves. |

- **Providers.** All four adapters have fixture-based contract tests. The live gate uses **two different installed/authenticated real providers** chosen at run time; if fewer than two are ready the gate is blocked, not weakened. Adapters whose installed CLI lacks a required capability may be recorded as Blocked with their exact gap without blocking the gate.
- **Determinism.** A test-only fake adapter forces the review-failure/repair path; the real two-provider smoke proves dispatch, handoff, native terminal activity, and final status without requiring an LLM to make a predictable mistake.
- **Safety.** One workspace-mutating assignment per workspace at a time; a busy target or conflicting mutation is rejected, not silently queued. All task text is data, never shell code. Unattended execution requires an explicit scoped policy in a disposable workspace; there is no unrestricted/yolo mode in P00. Every attempt has a deadline and bounded output. An uncertain outcome is `reconciling` or `failed`, never invented success.

## 6b. P01 configurable workflows

The [P01 design contract](./phases/phase-01/README.md#design-contract) is authoritative; this is the product summary.

- **Definition.** `.agent-studio/workflows/<name>.json|.yaml|.yml`, `version: 1`, an ordered `stages` list. Agent stages name a roster `role`, a `permission` (`read_only` | `workspace_write`), a `prompt` or `promptFile` template, and `next` routing: `{done}` for work stages, `{pass, fail}` for verdict stages. `type: validation` stages run the workspace's deterministic test command and route on `pass`/`fail`. Targets are stage ids, `$succeed`, or `$fail`.
- **Bounds.** Every stage has `maxVisits` (default 1, max 10) and every definition `maxSteps` (default 20, max 100); exceeding either fails the run with the reason. `passRequires` makes a verdict `pass` count only if the named validation passed.
- **Prompts.** Templates use `{{task}} {{diff}} {{validation}} {{findings}} {{summary}} {{stage}} {{visit}}`; data expands once into bounded sections, the task is always included, and verdict stages always get the fixed JSON-verdict footer.
- **Run.** `workflow start --team ID --definition NAME --text …` binds each role to the team's agent with that role (or `--bind`), freezes the definition and bindings, and runs stages one at a time. Agent failures, malformed verdicts, and validation errors pause for operator resolution exactly as in §6.
- **Compatibility.** The §6 workflow is the built-in `developer-reviewer` definition; its truth table is unchanged.
- **Gate.** Unit and fake-adapter tests prove parsing, routing, and bounds. P01 is Done only after a real three-role definition run (Developer, validation, QA, TeamLead) in a disposable fixture.

## 7. Operator experience by phase

**P00 CLI:** `health`, `preflight`, `coordinator start|stop`, `team.start`, `team.attach`, `team.status`, `team.stop`, `task.direct`, `workflow.start`, `snapshot`, `events`, `assignment.cancel`, `assignment.resolve`, and `serve` (persistent JSON stdio for Windows callers). Team start returns the tmux session ID and exact attach commands for both a WSL shell and Windows Terminal. tmux provides tiled panes, zoom, scrolling, copying, detach, and reattach. Status distinguishes coordinator health, pane liveness, agent availability, assignment status, task status, and workflow stage.

**P01 CLI additions:** `workflow list`, `workflow validate --definition NAME`, `workflow start --definition NAME --text … [--bind ROLE=AGENT]`, and `workflow show` with definition, bindings, visits, and the route taken. The project helper adds `team.py run NAME "prompt"`.

**P02 UI:** setup/provider selection, roster, workflow definition picker, task/workflow timeline, direct dispatch, attention and resolution, stage/retry count, diagnostics, and safe Stop. An Open terminals action opens Windows Terminal attached to the existing tmux session; no in-app terminal widget or output stream. Status comes from backend snapshots/events over `serve`. Closing/reopening the UI does not affect the team.

## 8. P00 acceptance gate

P00 is Done only after real evidence proves:

1. Fresh preflight and launch of a configured roster; exactly one pane per agent and no collision with existing tmux sessions.
2. Direct dispatch to an idle agent; identical retry does not dispatch twice; busy agent and mutating-workspace conflict are rejected.
3. Automatic handoff between **two different real providers**, with a final result matched to provider, diff, and deterministic validation evidence.
4. Deterministic fake-adapter integration covers failed review → repair → passing review and second failure → terminal failure, each with bounded attempts.
5. A user can attach to one tmux window (from WSL and from Windows Terminal), see every agent's live work, detach, and reattach without stopping the team.
6. Coordinator restart reconciles in-flight assignments without replaying a completed or still-running attempt.
7. Scoped stop leaves pre-existing tmux sessions and non-owned data untouched.
8. Missing provider/authentication, unsupported permissions, malformed result, dead worker, and timeout each produce a truthful status and a working recovery command.
9. A PowerShell caller drives `health`, `team.start`, `task.direct`, and `snapshot` through `wsl.exe --exec agent-studio serve`; task text with quotes, `$`, backticks, newlines, emoji, and CJK arrives byte-exact.
10. The coordinator and team survive the Windows caller exiting and all Windows terminals closing for longer than the WSL idle timeout, using the documented keep-alive.

Unit tests and mocked integration tests support but cannot replace the real two-provider smoke. **No Electron UI implementation begins until this gate passes.** A failed gate remains In Progress or Blocked, not Done.

## 9. Non-goals

P00 does not include Electron UI, embedded terminal rendering, terminal-output streaming, visual workflow editing, autonomous planning, multi-user/cloud service, providers beyond the four named CLIs, interactive reply to provider prompts, or a project/backlog database. P01 adds configurable workflow definitions but not parallel stages, text/expression conditions, stages that run arbitrary commands, or visual editing. P02 adds the UI but still does not embed terminals. AI-generated code is not guaranteed correct; the workflow adds validated handoffs and explicit evidence.

## 10. Delivery

[ROADMAP.md](./ROADMAP.md) defines sequencing. [P00 stories](./phases/phase-00/stories/README.md) detail backend work and the live gate. Configurable workflows are [P01](./phases/phase-01/README.md) ([stories](./phases/phase-01/stories/README.md)). UI work starts in P02.
