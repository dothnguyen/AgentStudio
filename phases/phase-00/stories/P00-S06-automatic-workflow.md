# P00-S06 — Automatic provider-neutral two-role workflow

Status: Done
Depends on: P00-S05
Architecture: [P00 implementation contract](../architecture.md), section G

## Goal

Run the built-in workflow automatically: Developer implements, coordinator captures the diff and runs deterministic validation, Reviewer inspects `read_only`, and one failed review routes back for repair. Decisions follow the PRD §6 truth table. Proven with the fake adapter; the real two-provider run happens in S12.

## Implement in this order

1. `workflow.start` with teamId, task text, Developer agentId, Reviewer agentId, validation command (from a fixed per-workspace config, not free text on the command line), and idempotency key. Require two different agents, a git workspace, a clean tree (or fixture acknowledgment), and no active mutating work.
2. Persist the workflow run with `baseCommit`, retry budget 1, and a start event before dispatch. Stages: `developer`, `reviewer`, `developer_repair`, `reviewer_recheck`. Developer stages use `workspace_write`; Reviewer stages use `read_only`. Provider IDs come from agents, never from stage code.
3. Prompts = fixed role templates + bounded user task + stage inputs, all passed as data files. Never interpolate text into Bash, SQL, tmux targets, or the validation command.
4. After a successful Developer stage: capture `git diff <baseCommit>` plus untracked file list (bounded) as an artifact, run the validation command in the workspace with a deadline, and record exit code and bounded output.
5. Dispatch Reviewer with task, diff, and validation output. Expect `{verdict, findings}`. Apply the truth table: success, repair, failed, or `paused`. A Developer failure/inconclusive/waiting result pauses the workflow rather than advancing.
6. Repair prompt = template + task + current diff + findings + validation output. Agents are stateless; session resume is optional.
7. Deadlines per assignment and overall. No unbounded retry and no policy broadening.
8. Snapshot/events expose stage, attempt, retry count, current agent, base commit, diff artifact path, validation result, last finding, and transition reason. Workflow and task final statuses agree.

## Tests to write

- Fake: Developer ok → validation pass → Reviewer fail → repair ok → Reviewer pass; exactly four attempts, one retry.
- Fake: Reviewer fails twice → `failed`, no fifth attempt.
- Each truth-table row, including validation fail + reviewer pass, and malformed verdict → `paused`.
- Reviewer attempted write is blocked by `read_only` mapping (fake simulates denial) and surfaced.
- Dirty tree rejected; non-git workspace rejected.
- Cross-provider routing with fixture provider IDs; workflow code has no provider-specific branch.
- Text in task/findings containing shell syntax never reaches a shell.

## Done when

- [x] Deterministic tests prove pass, bounded repair, double failure, pause, and every truth-table row.
- [x] Base commit, diffs, validation results, handoffs, and verdicts are durable with source assignment IDs.
- [x] The workflow completes after the invoking CLI exits.
- [x] No stage relies on pane text or provider-specific flags.

## Evidence (2026-10-22)

- `python3 -m unittest discover -s tests -t .` → 171 tests OK: Ubuntu 22.04 / Python 3.10 / tmux 3.2a / git 2.34 (in chunks) and Python 3.13 / tmux 3.4 in one run (247 s; one root-only skip). S06: `tests/integration/test_s06_workflow.py` (10) and `tests/unit/test_s06_parts.py` (7).
- Developer ok → validation fail → Reviewer fail → repair → validation pass → Reviewer pass: `succeeded`, exactly four stage attempts and assignments, retry count 1; handoffs chain `fromAssignmentId → toAssignmentId`; verdict and validation events carry their source assignment IDs; base commit equals `git HEAD` at start; diffs, validation output and prompts are files on disk.
- Reviewer fails twice → `failed` with the repair budget reason and last finding; no fifth attempt after waiting.
- Truth table: pass+pass → succeeded in two stages; pass+fail → repair; fail+pass → repair ("validation failed"); fail+fail → repair then failed. Pauses: Developer `PROVIDER_ERROR`, `NO_TERMINAL_EVENT`, `PERMISSION_DENIED`; Reviewer malformed or missing verdict (`MALFORMED_VERDICT`). A Reviewer write attempt is denied by `read_only`, surfaced as `PERMISSION_DENIED`, and nothing is written.
- Preconditions: `WORKSPACE_DIRTY`, `SAME_AGENT`, `WORKSPACE_BUSY` (both directions), `WORKSPACE_NOT_GIT`, `WORKFLOW_CONFIG_INVALID`; cancel of a running workflow → workflow and task `cancelled`, agents idle; overall deadline → `failed` and the stage cancelled.
- Cross-provider: codex developer + claude reviewer, and opencode developer + agy reviewer (fixture aliases); the provider-name guard test covers `workflow.py`.
- Shell safety: task text and reviewer findings containing `$(...)`, backticks, `&&`, `rm -rf ~` appear literally in prompts and never run (no canary files); validation argv `$(...)` is printed, not executed; git ignores planted `core.fsmonitor`, `diff.external`, and `core.pager` commands.
- A `workflow start --wait` killed mid-run: the workflow still advanced through its stages.
- Design notes: workflow tasks are owned by the engine (stage reports no longer move them); validation runs in a detached process; `workflow.cancel` added because paused runs hold the workspace until `assignment.resolve` (S07).
