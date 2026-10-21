# P00-S06 — Automatic provider-neutral two-role workflow

Status: To Do
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

- [ ] Deterministic tests prove pass, bounded repair, double failure, pause, and every truth-table row.
- [ ] Base commit, diffs, validation results, handoffs, and verdicts are durable with source assignment IDs.
- [ ] The workflow completes after the invoking CLI exits.
- [ ] No stage relies on pane text or provider-specific flags.
