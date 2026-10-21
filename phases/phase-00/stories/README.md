# Phase 00 — Provider-neutral agent-team proof of concept

Read [PRD.md](../../../PRD.md) and the [P00 implementation contract](../architecture.md) before starting any story. Old OrchestMux/NTM Phase 00 stories are superseded. Stories are small and sequential enough for an implementation agent to complete one at a time.

| Story | Deliverable | Depends on | Status |
|---|---|---|---|
| [S01](./P00-S01-wsl-boundary-and-coordinator.md) | Windows↔WSL boundary proof, entry shim, Python coordinator daemon, command inbox | — | Done |
| [S02](./P00-S02-durable-state-and-events.md) | SQLite schema, write authority, event journal | S01 | Done |
| [S03](./P00-S03-tmux-workers.md) | N owned tmux panes; coordinator claims + request files | S01–S02 | Done |
| [S04](./P00-S04-provider-contract-and-fake.md) | Adapter contract, permission policies, runner, deterministic fake | S02–S03 | Done |
| [S05](./P00-S05-direct-dispatch.md) | Direct-to-idle assignment (fake) | S04 | Done |
| [S06](./P00-S06-automatic-workflow.md) | Two-role workflow with git diffs and truth table (fake) | S05 | Done |
| [S07](./P00-S07-recovery-resolve-and-stop.md) | Restart reconciliation, `assignment.resolve`, scoped stop | S05–S06 | Done |
| [S08](./P00-S08-codex-adapter.md) | Codex adapter | S04, S05 | To Do |
| [S09](./P00-S09-claude-adapter.md) | Claude Code adapter | S04, S05 | To Do |
| [S10](./P00-S10-agy-adapter.md) | Antigravity CLI adapter | S04, S05 | To Do |
| [S11](./P00-S11-opencode-adapter.md) | OpenCode adapter | S04, S05 | To Do |
| [S12](./P00-S12-live-gate.md) | Real two-provider live gate | S01–S07 + any two of S08–S11 | To Do |

S08–S11 are independent peers and may proceed in parallel with S06–S07. Start with the two providers installed and authenticated on the target machine.

## Rules for implementers

1. Complete stories in dependency order. No provider is the default or privileged one.
2. Use the file/path suggestions unless an existing implementation establishes a clearer convention; if changed, update the architecture document and tests in the same change.
3. Keep every story `To Do` until its checklist has evidence. Mark `In Progress` while implementing, `Done` only after tests and the specified real check pass, or `Blocked` with the exact reason. Do not infer completion from code existing.
4. A fake-provider test never proves a real provider works. A successful `--version` never proves authentication or task completion.
5. Do not run a live provider test against the Agent Studio source checkout. Use a disposable git fixture workspace and review output for secrets before saving evidence.
6. Never stop or delete pre-existing tmux sessions, `.ntm` data, or user workspaces. The only permitted cleanup target is a verified run-owned fixture session/path.
7. Never put task or user text on a command line, in SQL text, or in a tmux target—on either side of the Windows↔WSL boundary.
8. If an installed provider lacks a required option, record its version and capability gap and mark that adapter Blocked rather than guessing flags, broadening permissions, or scraping its TUI.

## Shared adapter checklist (S08–S11)

Each adapter story adds only provider-specific steps on top of this list.

1. Record the installed version and the exact flags used per policy in `providers/<id>/CONTRACT.md`, verified against local `--help`, run through the entry shim's login environment.
2. `probe`: executable, version, capabilities, and authentication proven with a disposable read-only micro-task; missing login → `AUTH_REQUIRED`.
3. `prepare`: argv array, environment allowlist, prompt via stdin or private file. Map `read_only` and `workspace_write` to verified modes or refuse; never a bypass/unrestricted flag.
4. `parse`: normalize progress, attention/permission denial, final result, terminal outcome, usage, and session ID from raw output; never from the pane.
5. `cancel` / `reconcile`: by recorded PID + start time; uncertain → `reconciling`.
6. Fixtures captured from the installed version for success, failure, permission-blocked, malformed stream, missing final event, and nonzero exit.
7. Tests: shared contract suite; task text with shell syntax reaches the provider boundary unchanged; process killed midway → `reconciling`/`inconclusive`, never succeeded.
8. Real checks in a disposable git workspace: a `read_only` direct task and a `workspace_write` direct task (S05 path), each with visible pane progress and an authoritative normalized report.
9. Selectable by providerId, never a hard-coded default; no provider-specific branch in coordinator or workflow code.

## Phase exit

P00 is `Done` only when S12 records a real run with two **different** installed/authenticated providers chosen from Codex, Claude Code, Antigravity CLI, and OpenCode, the Windows boundary sequence, and deterministic coverage of the review-repair loop. The operator watches native tmux panes and reads durable, truthful status from the CLI or `serve`. Adapters not used in the gate are Done or Blocked with a recorded gap. **Do not begin P01 Electron work until S12 passes.**
