# P00-S04 — Adapter contract, permission policies, runner, and deterministic fake

Status: To Do
Depends on: P00-S02, P00-S03
Architecture: [P00 implementation contract](../architecture.md), section F

## Goal

Define one provider-neutral execution API and permission vocabulary before any real CLI adapter, and build a fake provider covering every outcome. Everything from S05 onward is proven with this fake first. The fake is test-only and cannot appear in an operator-configured team.

## Implement in this order

1. Provider IDs `codex`, `claude`, `agy`, `opencode`, plus `fake` in test builds only. Capability fields: headless execution, structured progress, structured final result, resume, supported policies (`read_only`, `workspace_write`), interactive input. Unsupported is an explicit value.
2. Typed input: assignmentId, agentId, providerId, attempt, canonical workspace, prompt-file path, role instructions, model (optional), policy, deadline, output byte budget, provider session ID (optional).
3. Adapter operations `probe`, `prepare`, `start`, `parse`, `cancel`, `reconcile`. `prepare` returns an argv array and an environment allowlist; never a shell string containing task text. Each adapter must declare its per-policy mapping in a contract note and refuse unmapped policies.
4. Normalized report exactly as in architecture section F. Reject unknown status, mismatched IDs, or missing fields.
5. `runner.py`: started by the worker shim for one assignment; writes private request/result/evidence files, starts the provider process, records PID + start time, prints readable progress to the pane, captures raw stdout/stderr with limits, and inserts immutable reports. It keeps working if the coordinator is down; reports wait in the inbox. No terminal-output API.
6. Fake scenarios: success, provider failure, zero-exit permission denial, malformed final JSON, no final event, crash, waiting input, timeout, cancel, slow-run (for restart tests), and a scripted reviewer verdict (pass/fail/malformed). All driven through the same runner and report inbox as real adapters.
7. Probe only selected providers at launch; never auto-install or substitute. Record version, capabilities, and policy mapping at assignment start.

## Tests to write

- Contract tests for every input/output field and every invalid report.
- Prompt with quotes, newlines, Unicode, and shell metacharacters reaches the fake unchanged and is never executed by a shell.
- Zero exit without valid final evidence is not `succeeded`.
- Duplicate or late report cannot finish a different assignment.
- Cancellation, timeout, and waiting input have distinct statuses.
- Unmapped policy is refused at `prepare` and at preflight.
- Fake rejected by production `team.start`.

## Done when

- [ ] Fake assignments flow through worker shim, runner, report inbox, coordinator, and snapshot.
- [ ] Results are authoritative without reading tmux screen content.
- [ ] Adding a provider requires only a new directory under `providers/`, no workflow or coordinator change.
- [ ] Contract fixtures document successful and failed normalized reports.

Do not grant unrestricted permissions to make a fake or real run pass.
