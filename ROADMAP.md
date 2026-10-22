# Agent Studio — Delivery Roadmap

> Status: Backend-first reboot, rev 3 (P01 = configurable workflows)
> Date: 2026-10-22
> Product requirements: [PRD.md](./PRD.md)

## Sequencing decision

**Prove the Windows↔WSL boundary first, then the WSL backend end to end with a fake provider, then real providers, before building any UI.** A Python coordinator daemon coordinates the team, WSL-local SQLite stores authoritative state, tmux displays one native pane per agent in a single window, and peer adapters support Codex, Claude Code, Antigravity CLI (agy), and OpenCode. Bash is used only at the edges: the `agent-studio` entry shim and the per-pane worker shim. The P00 operator uses a WSL CLI (and a PowerShell spike) and attaches to tmux directly. P01 replaces the hard-wired workflow with operator-written JSON/YAML workflow definitions, still CLI-only, so the UI is built on the final workflow model. P02 adds Electron for commands and status only, over one persistent `wsl.exe --exec agent-studio serve` connection; Open terminals attaches the existing tmux session in Windows Terminal. No phase streams tmux pane bytes into the app.

NTM and OrchestMux are retired from the new runtime path. Previous Phase 00 work is migration history, not evidence that this backend works. Its main lesson—the Windows↔WSL crossing failed—is now tested in the first story instead of discovered in P01.

| Phase | Outcome | Gate |
|---|---|---|
| P00 — Backend proof of concept | Proven Windows↔WSL boundary; configurable roster; N native tmux panes; direct idle-agent task; two-provider automatic workflow; durable status, resolution, and recovery. | Real gate in [P00-S12](./phases/phase-00/stories/P00-S12-live-gate.md) **passed 2026-10-22** with Codex + Claude Code; P00 closes when S10 (agy) and S11 (OpenCode) are Done or Blocked with a recorded gap. |
| P01 — Configurable workflows | Workflow definitions in JSON or YAML: ordered stages with role, permission, prompt template, and outcome routing; validation stages; bounded loops; `workflow start --definition` and `team.py run NAME "prompt"`. | Real three-role definition run in [P01-S10](./phases/phase-01/stories/P01-S10-live-gate.md); fake-adapter proof of fail → Developer loops and bounds. |
| P02 — Desktop Command Center | Electron setup, team/task/workflow status (including definition picker and route), dispatch, resolve, and Stop over `serve`; Open terminals attaches native tmux. | Fresh user can operate the proven backend without WSL CLI knowledge. |
| P03 — Reusable teams | Saved profiles, role instructions, multiple workspaces, and history. | Relaunch a saved mixed-provider team in a new folder. |
| P04 — Advanced coordination | Optional lead-assisted decomposition, parallel work isolation (e.g. per-agent worktrees), richer adapters, session resume, and review gates. | Concurrent tasks have traceable ownership and no workspace contamination. |

## P00 story order

| Order | Story | Why here |
|---|---|---|
| 1 | S01 WSL boundary, entry shim, coordinator daemon | Retests the failure that killed the last attempt before any logic exists. |
| 2 | S02 State and events | Single source of truth and write authority. |
| 3 | S03 tmux workers | N owned panes; delivery from state, not keystrokes. |
| 4 | S04 Adapter contract, permission policies, fake | One execution API; deterministic fake for everything after. |
| 5 | S05 Direct dispatch (fake) | First end-to-end path without waiting on any real CLI. |
| 6 | S06 Workflow with git diffs (fake) | Truth table and bounded repair proven deterministically. |
| 7 | S07 Recovery, resolve, scoped stop | Implementation work moved out of the gate story. |
| 8–11 | S08 Codex, S09 Claude Code, S10 agy, S11 OpenCode | Independent peers; any two Done unblock the gate. The others may finish later or be recorded Blocked with a capability gap. |
| 12 | S12 Live gate | Only P00 release gate. |

## P00 backend journey

1. From PowerShell, drive `wsl.exe --exec agent-studio serve` with hostile text; close every Windows terminal and confirm the coordinator survives.
2. Run preflight in the chosen WSL distro and select installed/authenticated providers.
3. Configure N agent members, launch N owned tmux panes in one window, and attach directly (WSL shell and Windows Terminal) to watch them.
4. Dispatch a direct task to an idle member and observe its result through CLI status/events.
5. Run Developer → Reviewer automatic handoff with two distinct real providers, with base commit, diffs, and validation recorded.
6. Exercise the review-failure/repair loop deterministically with the fake adapter, separately from the live provider smoke.
7. Detach/reattach tmux, restart the coordinator during a controlled attempt, reconcile without duplicate dispatch, and resolve any paused assignment explicitly.
8. Stop only the proof-owned team; retain sanitized evidence.

The [P00 implementation contract](./phases/phase-00/architecture.md) defines boundary, state, command, tmux, and provider seams. [P00-S01 through P00-S12](./phases/phase-00/stories/README.md) are the backend task breakdown. Every story starts To Do and is Done only with its own evidence. The phase exit is the live gate in S12, not a mock or a successful pane send.

## P01 story order

| Order | Story | Why here |
|---|---|---|
| 1 | S01 Definition model, JSON, static validation | Pure code; every later story consumes the model. |
| 2–3 | S02 YAML subset, S03 Prompt templates | Independent of each other; no engine changes. |
| 4 | S04 Schema rebuild, role binding, start | P00 CHECK constraints must go before free-form stage ids exist. |
| 5 | S05 Routing and bounds | The brief's loops (QA fail → Developer, TeamLead fail → Developer). |
| 6 | S06 Validation stages, built-in definition | One engine; P00 workflow re-expressed and legacy path removed. |
| 7–8 | S07 Recovery/resolve/cancel, S08 Commands | Independent; both need the single engine. |
| 9 | S09 `story-delivery.yaml` and `team.py run` | Uses the feature on this project. |
| 10 | S10 Live gate | Only P01 release gate. |

## P01 operator journey

1. Write `.agent-studio/workflows/<name>.yaml` (or `.json`): stages, roles, permissions, prompt templates, routing.
2. `agent-studio workflow validate --definition <name> --team ID` — static errors and role binding, nothing started.
3. `team.py run <name> "prompt"` (or `agent-studio workflow start --definition <name> --text …`), watch panes in tmux.
4. `workflow show` gives the frozen definition, bindings, visits, and the route taken; paused stages resolve with `assignment.resolve`.

See the [P01 overview and design contract](./phases/phase-01/README.md) and [stories](./phases/phase-01/stories/README.md).

## P02 UI journey

P02 starts only after P01 passes. Electron wraps the proven `serve` protocol in typed IPC and adds setup/provider selection, a workflow definition picker, task and workflow controls, a status timeline showing the route, attention/resolution, diagnostics, and Open terminals. The UI does not read SQLite directly or parse tmux output. (The earlier desktop story draft is in git history at `f43349d:phases/phase-01/stories/P01-S01-desktop-command-center.md`; it will be re-planned as P02 stories.)

## Deferred

Visual workflow editor, autonomous planning, interactive reply to provider prompts, providers beyond the four named CLIs, hosted collaboration, cloud sync, and project/backlog management. Project/backlog management remains a product non-goal unless the PRD changes intentionally.

## Revision 3 notes (2026-10-22)

- Configurable workflows (previously P03 "Workflow library") become P01, from [the feature brief](./phases/briefs/feature-configure-workflow.md); the desktop command center moves to P02, reusable teams to P03.
- The P01 desktop story was removed; the UI will consume definition runs over `serve` in P02.

## Revision 2 notes (2026-10-21)

- Coordinator moved from Bash to Python; Bash kept for entry and worker shims. The Windows↔WSL boundary is now an explicit contract and the first story.
- CLI→coordinator transport defined (SQLite command inbox); write authority restated (coordinator: state; CLI: command inbox; runners: report inbox).
- Direct dispatch and workflow are proven with the fake before real adapters; real adapters no longer block each other; recovery split from the gate (S07).
- Workflow gains git base commit, per-stage diffs, a read-only Reviewer, and a decision truth table.
- Added `assignment.resolve`, a shared permission vocabulary, PID + start-time process identity, and agent statelessness.
- Removed speculative protocol features (event retention/`CURSOR_EXPIRED`, separate `requestId` for one-shot CLI calls, fixed 1 MiB envelope limit).
