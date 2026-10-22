# P01-S11 — Adapter session contract, fake resume, resume prompt, and fallback

Status: To Do
Depends on: — (P00 adapter contract, P00-S04)
Architecture: [P01 design contract](../README.md#h-session-continuity-e4), section H (runner, fallback, usage); [P00 contract](../../phase-00/architecture.md) §F

## Goal

Give the adapter contract and the runner everything a resumed task needs, without any coordinator changes yet. Adapters declare whether they can resume and fork, and `prepare` adds the resume flags while keeping the current policy flags. The runner turns a frozen `request.session` block into either the full prompt or the short resume prompt, and re-runs once fresh when the provider no longer has the session. Every report gets normalized usage. The fake adapter gains real (file-backed) resume so that later stories can prove all of this deterministically.

## Implement in this order

1. `providers/base.py`:
   - `Adapter.session_support() -> {"resume": bool, "forkOnResume": bool}`, default both false. `capabilities()["resume"]` reports it.
   - `AssignmentInput.provider_session_id` (already present, unused) becomes the session to resume. Add `persist_session: bool = False`.
   - `prepare` refuses a resume on an adapter without support (`SESSION_UNSUPPORTED`, defence in depth).
2. New diagnostic `PROVIDER_SESSION_MISSING`. An adapter may set it as a failed terminal only when the provider refused to load the session **before running any turn** (no tool use, no assistant text).
3. `Adapter.normalize_usage(raw) -> {inputTokens, cachedInputTokens, outputTokens} | None`. `finalize` adds `usageNormalized` and optional `toolUses {name: count}` to the report. Add both, plus `session`, to report validation (`reports.py` / `report_rules.py`). Implement normalization for `fake`, `claude` and `codex` from their existing captured fixtures, and add the mapping row to each `CONTRACT.md`.
4. Fake CLI and adapter: `--resume ID` with optional `--fork`. Sessions are files under the run's private state (or `AGENT_STUDIO_FAKE_SESSION_DIR` in tests). A session holds earlier prompt hashes, the policy of each turn, and a counter used for cached tokens. Its output reports `resumedFrom`, `priorTurns`, the session ID (new when forked) and the sandbox or policy of **this** invocation. An unknown ID gives the "missing session" output. `session_support()` = `{resume: true, forkOnResume: true}`. Fake `toolUses` come from a provider option.
5. Runner (`runner.py`):
   - Read `request.session` (absent → `mode: none`).
   - Prompt: for `none`, `unsupported` and `fresh`, today's role context plus the task. For `resume`: the fixed `===== AGENT STUDIO SESSION =====` note (key, "files may have changed, re-read what you rely on", this task's policy), then the one-line role reminder `You are ROLE: <first line of the role description>.`, then the task.
   - Pass `persist_session` and `provider_session_id` to `prepare`.
6. Fallback in the runner: on `PROVIDER_SESSION_MISSING`, move `prompt.txt`, `stdout.jsonl`, `stderr.log` and `meta.json` to `runs/<id>/resume-attempt/`. Then run once fresh with the full prompt, the same model, reasoning and policy, persistence on, and **the remaining** deadline. The report's `session` = `{mode: "fresh", fallbackFrom, warning: "PROVIDER_SESSION_MISSING"}`. A cancel during the first run never triggers the fallback.

## Done when

- [ ] An adapter without session support refuses a resume request in `prepare` (`SESSION_UNSUPPORTED`). `codex`, `agy` and `opencode` report `resume: unsupported`. `fake` reports both flags true.
- [ ] Fake: a fresh persisted run, then a resumed run, reports `resumedFrom` = the first ID, `priorTurns: 1` and a new (forked) ID. Resuming the parent again does not see the forked turn.
- [ ] A session started `workspace_write` and resumed `read_only` runs with the read-only argv (the fake echoes the sandbox it got), and the fake refuses writes.
- [ ] The resume prompt has the session note and one role line, and no `===== AGENT STUDIO ROLE` or `===== SKILL` block. Fresh and unkeyed prompts are byte-identical to today's.
- [ ] Missing session → exactly one fresh re-run in the same assignment, evidence of both runs on disk, and the report says `fallbackFrom` with the warning. A second `PROVIDER_SESSION_MISSING` (impossible on a fresh run, forced in a test) is reported as failed, not retried. A cancel during the first run → `cancelled`, no re-run. The deadline covers both runs.
- [ ] `usageNormalized` is correct for the captured `fake`, `claude` and `codex` fixtures, and absent (not invented) when the provider reports no usage.
- [ ] Tests: `tests/unit/test_p01_s11_session_contract.py` (adapters, prompt rendering, usage) and `tests/integration/test_p01_s11_runner_resume.py` (runner with fake requests, no coordinator). All existing tests stay green.

## Evidence

(filled in when the story is done)
