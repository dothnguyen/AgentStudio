# P00-S08 — Codex provider adapter

Status: To Do
Depends on: P00-S04 (contract), P00-S05 (real direct-task check)
Architecture: [P00 implementation contract](../architecture.md), section F

Follow the **shared adapter checklist** in the [stories README](./README.md). This story lists only what is specific to Codex. It may be marked Blocked with a recorded capability gap; any two Done adapters unblock S12.

## Codex-specific steps

1. Inspect installed `codex --version` and `codex exec --help` inside the selected distro via the entry shim's login environment. Compare with [OpenAI's noninteractive surface](https://developers.openai.com/blog/codex-as-a-platform). Record exact version and flags in `providers/codex/CONTRACT.md`; do not reuse OrchestMux/NTM assumptions.
2. Candidate invocation: `codex exec` with JSON event output, prompt via stdin or private file.
3. Policy mapping: `read_only` → verified read-only sandbox; `workspace_write` → verified workspace-write sandbox with approvals that cannot block or broaden silently. Refuse any policy that would require a full-access/bypass flag.
4. Parse the JSON event stream for progress, approval-blocked, error, and final message; save thread/session ID for diagnosis.
5. Normalize success, failure, interruption, approval-blocked, missing final event, and nonzero exit.

## Codex-specific fixtures

Success, failure, approval-needed, truncated output, missing final event — captured from the installed version.

## Done when

- [ ] Shared checklist complete for providerId `codex`.
- [ ] Policy mapping recorded in `CONTRACT.md` and shown by preflight.
