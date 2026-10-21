# P00-S05 — Direct dispatch to an idle agent

Status: Done
Depends on: P00-S04
Architecture: [P00 implementation contract](../architecture.md), sections C–F

## Goal

A user selects any idle team member, regardless of provider, sends one task with a policy, observes assignment and progress, and receives a durable normalized result. Proven end to end with the fake adapter; real-provider direct tasks are verified in S08–S11 and S12. No multi-stage workflow here.

## Implement in this order

1. `task.direct` (CLI and serve) with teamId, agentId, task text, policy, and idempotency key. Validate lengths, UUIDs, team membership, and that the agent's adapter supports the policy before accepting.
2. In one coordinator transaction: require agent `idle`; if policy is `workspace_write`, require no active mutating assignment or workflow in the workspace (`WORKSPACE_BUSY`); write task, assignment (`queued`), event, and command response. Return an `accepted` receipt with IDs.
3. Coordinator claims (`claimed`) and writes the request file; commit `running` only after runner start evidence. If the process fails to start, record a failed assignment with a diagnostic code.
4. Apply normalized progress and attention reports as events; the runner prints activity in the pane. Apply the final report only if assignmentId, agentId, providerId, and attempt match.
5. Completion rules: valid final result, compatible exit, no unresolved required permission denial. Return the agent to `idle` after a terminal assignment while preserving task result and report.
6. `assignment.cancel` for a direct task, with the cancel/complete race resolved once and a single terminal event.
7. `read_only` direct tasks may run on other idle agents while one mutating assignment is active. Never send keystrokes to a pane.

## Tests to write

- Dispatch through fixture adapters registered as each of the four provider IDs; identical state transitions.
- Busy agent, wrong team, unsupported policy, and mutating-workspace conflict return typed errors with no assignment.
- Concurrent `read_only` task on a second agent succeeds while a mutating task runs.
- Two concurrent dispatches to one idle agent → exactly one claim.
- Identical idempotent retry returns original IDs; conflicting reuse rejected; `PENDING` retry safe.
- Late, duplicate, or mismatched final report cannot complete the wrong task.
- CLI exit mid-task, then new CLI call: same status, no duplicate dispatch.

## Done when

- [x] Any idle configured agent can receive a direct task from CLI and serve.
- [x] Receipt, start event, progress events, and final result share the same IDs.
- [x] Agent availability and task outcome remain independent.
- [x] A quiet pane or send acknowledgment cannot mark a task succeeded.

## Evidence (2026-10-22)

- `python3 -m unittest discover -s tests -t .` → 156 tests OK: Ubuntu 22.04 / Python 3.10 / tmux 3.2a (in chunks) and Python 3.13 / tmux 3.4 in one run (174 s; one root-only skip). S05: `tests/integration/test_s05_direct.py` (14, run twice for stability) and `tests/unit/test_s05_cancel.py`.
- Every provider ID (codex, claude, agy, opencode via the debug-only fixture alias) takes the identical event path `created → claimed → running → succeeded`; receipt, events and the normalized final report carry the same task/assignment/agent/provider IDs.
- Typed errors with zero assignments created: `AGENT_BUSY`, `WORKSPACE_BUSY`, `AGENT_NOT_IN_TEAM`, `NOT_FOUND`, `TEAM_NOT_RUNNING`, `POLICY_UNSUPPORTED`, `BAD_REQUEST` (unknown policy, blank or oversized text).
- A `read_only` task completes on a second agent while a `workspace_write` task runs; two simultaneous dispatches to one agent → one accepted, one `AGENT_BUSY`, one claim.
- Idempotent retry returns the same receipt; conflicting reuse → `IDEMPOTENCY_CONFLICT`; `PENDING` while the coordinator is frozen, then the retry returns one task.
- Killing `task direct --wait` mid-run leaves the task running; a new `task show` sees it finish; one assignment. `--wait` with `--text-file -` keeps the text byte-identical.
- Cancel: running → `cancel_requested` → `cancelled` with exactly one terminal event, provider process gone, agent idle; `waiting_input` → cancelled and the agent can take new work; a queued assignment is cancelled and never runs; claimed-but-unpicked is pulled back from the inbox; four cancel-vs-completion races each produced exactly one terminal event with task and assignment agreeing.
- Receipt `accepted` is never success; a killed runner leaves the assignment `running` (S04).
- Design notes: the coordinator now applies reports before commands; `debugProviderOptions` and fixture aliases are debug-only.
