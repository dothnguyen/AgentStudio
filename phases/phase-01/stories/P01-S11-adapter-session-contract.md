# P01-S11 — Adapter session contract, fake resume, resume prompt, and fallback

Status: To Do
Depends on: — (P00 adapter contract, P00-S04)
Architecture: [P01 design contract](../README.md#h-session-continuity-e4), section H (runner, fallback, usage, report `session` block); [P00 contract](../../phase-00/architecture.md) §F

## Goal

Give the adapter contract and the runner everything a resumed task needs, without any coordinator changes yet. Adapters declare whether they can resume and fork, and `prepare` adds the resume flags while keeping the current policy flags. The runner turns a frozen `request.session` block into either the full prompt or the short resume prompt, and re-runs once fresh when the provider no longer has the session. Every report gets normalized usage. The fake adapter gains real (file-backed) resume so that later stories can prove all of this deterministically.

The tests write `request.session` by hand (`{key, mode, resumeFrom, persist, reason}`, §H); the coordinator only starts writing it in S12.

## Implement in this order

1. `providers/base.py`:
   - `Adapter.session_support() -> {"resume": bool, "forkOnResume": bool}`, default both false.
   - `capabilities()["resume"]` is `True` when `session_support()["resume"]` is true and `"unsupported"` otherwise. Every adapter that overrides `capabilities()` (fake, claude, codex) follows this rule; a test checks it for every registered adapter.
   - `AssignmentInput.provider_session_id` (already present, unused) becomes the session to resume. Add `persist_session: bool = False`.
   - `prepare` refuses a resume (`provider_session_id` set) on an adapter whose `session_support()["resume"]` is false: `SESSION_UNSUPPORTED`, before `_prepare` is called (defence in depth).
   - `ParseState.tool_uses: Dict[str, int]` (empty by default), filled by adapters that can see tool calls.
2. New diagnostic constant `PROVIDER_SESSION_MISSING` in `base.py`. An adapter may set it as the code of a failed terminal (`{"ok": False, "code": "PROVIDER_SESSION_MISSING"}`) only when the provider refused to load the session **before running any turn** (no progress, tool use or assistant text was parsed). `finalize` reports it as `failed` with that `diagnosticCode`.
3. Usage:
   - `Adapter.normalize_usage(raw: Optional[dict]) -> {inputTokens, cachedInputTokens, outputTokens} | None`. Base returns `None`. All three values are non-negative ints; `None` whenever the provider reported no usage (never zeros invented).
   - `finalize` adds `usageNormalized` (the result, or `null`) and `toolUses` (`st.tool_uses`, or `null` when empty) to every report. `refusal_report` in `runner.py` sets both to `null`. The raw `usage` stays as it is.
   - Mappings (uncached input / cache reads / output):
     - `fake`: `inputTokens` / `cachedInputTokens` / `outputTokens` as the fake reports them (step 4).
     - `claude`: `input_tokens + cache_creation_input_tokens` / `cache_read_input_tokens` / `output_tokens` (the same mapping S15 confirms on the real CLI).
     - `codex`: `input_tokens − cached_input_tokens` (Codex's `input_tokens` includes the cached part; floor 0) / `cached_input_tokens` / `output_tokens`.
   - Add the mapping row to `fake`, `claude` and `codex` `CONTRACT.md`.
   - Report validation lives in `contract.validate_report`: `usageNormalized` is `null` or an object of exactly those three non-negative ints; `toolUses` is `null` or an object of at most 100 string keys (≤ 100 chars) to non-negative ints; `session` (step 5) is absent or an object whose `mode` is one of `none`, `unsupported`, `fresh`, `resume`. Anything else → `BAD_REPORT`.
4. Fake CLI (`fake_cli.py`) and adapter:
   - New CLI flags: `--session-dir DIR`, `--persist`, `--resume ID`, `--fork`, `--force-session-missing`, `--tool-use NAME=N` (repeatable).
   - Session store: one JSON file per session ID in `--session-dir` (`{id, parent, turns: [{promptSha256, promptBytes, sandbox}]}`), created with mode 0600 in a 0700 directory. The adapter passes `--session-dir` = `AGENT_STUDIO_FAKE_SESSION_DIR` from the `env` it is given, else `<state dir>/fake-sessions/` (from `paths.ensure_state_dir()`); the env var itself is not passed through to the CLI. Add `AGENT_STUDIO_FAKE_SESSION_DIR` to `envresolve.KEEP_FROM_CALLER` next to `AGENT_STUDIO_FAKE_POLICIES`, so the coordinator-driven tests of S12–S14 can use it.
   - Fresh run: a new ID `fake-<12 hex>`. With `--persist`, it writes a session file with this one turn; without it, nothing is written (so that ID can never be resumed).
   - `--resume ID`: loads the file. With `--fork`, it writes a **new** ID whose turns are the parent's plus this turn, and the parent file is unchanged; without `--fork`, it appends to the same file. The adapter always passes `--fork` with `--resume` (it declares `forkOnResume`), matching Claude's `--fork-session`.
   - The `init` event adds `resumedFrom` (the resumed ID or `null`) and `priorTurns` (number of the parent's turns, 0 when fresh); `session` is the new ID when forked; `sandbox` stays the sandbox of **this** invocation (so a resumed run with a narrower policy shows it, and `--write` under `read-only` is still a `tool_denied`).
   - The `result` event's `usage` becomes `{inputTokens: <prompt bytes>, cachedInputTokens: <sum of promptBytes of the parent's turns, 0 when fresh>, outputTokens: 42}`, and `toolUses` from `--tool-use` when given.
   - Unknown ID (no file), or `--force-session-missing`: the CLI prints only `{"type": "result", "status": "error", "code": "session_not_found", "summary": "..."}` (no `init`, no progress) and exits 1. The adapter maps that to `PROVIDER_SESSION_MISSING` under the step 2 rule.
   - Adapter `_prepare`: `persist_session` → `--persist`; `provider_session_id` → `--resume ID --fork`, after checking the ID matches `fake-[0-9a-f]{12}` (`BAD_REQUEST` otherwise; nothing unchecked reaches argv). Provider options: `toolUses: {name: int}` → `--tool-use` flags; `forceSessionMissing: true` → `--force-session-missing` (tests only, to force a second missing session). Policy flags are added exactly as today, from `inp.policy`.
   - `session_support()` = `{resume: true, forkOnResume: true}`. `parse_line` fills `st.tool_uses` from the result's `toolUses`.
5. Runner (`runner.py`):
   - Read `request.session` (absent → `mode: none`). `provider_session_id` = `resumeFrom` when `mode` is `resume`, else `None`; `persist_session` = `persist` (false for `none` and `unsupported`). Pass both into `AssignmentInput`.
   - Prompt for `none`, `unsupported` and `fresh`: exactly today's bytes (role context or today's `(no role configuration)` block, then `\n` when that text is non-empty, then the stage prompt file or the TASK block). Keep today's code path for this; do not re-implement it.
   - Prompt for `resume`: the session note, the role line, a blank line, then the stage prompt file or the TASK block (no role context, no skills). Byte for byte:
     ```
     ===== AGENT STUDIO SESSION =====
     You are continuing your earlier session for KEY.
     Files may have changed since you last read them; re-read anything you rely on.
     Your permission for this task is POLICY.
     ===== END SESSION =====
     You are ROLE: DESCRIPTION.

     ```
     `KEY` = `request.session.key`, `POLICY` = the request's policy, `ROLE` = the request's `role`. `DESCRIPTION` is the text after `Description: ` on that line of `roleContext.text` (first line only, at most 200 characters, one trailing `.` dropped); without a description the line is `You are ROLE.`; with an empty `role` it is `You are the assigned agent.`
   - The report gets `session` when the request has a `session` block: `{mode, resumeFrom}` (`resumeFrom` `null` unless `resume`), plus `fallbackFrom` and `warning` after a fallback (step 6). Unkeyed requests (no block) get no `session` field, so P00 reports are unchanged.
6. Fallback in the runner, only when `mode` is `resume` and the report's `diagnosticCode` is `PROVIDER_SESSION_MISSING`:
   - Not when the run was cancelled, or the cancel marker exists before the re-run starts: the first report stands (`cancelled`).
   - Check the cancel marker and the remaining deadline (below) **before** moving anything; when either stops the re-run, the first run's files stay where they are.
   - Move `prompt.txt`, `stdout.jsonl`, `stderr.log` and `meta.json` to `runs/<id>/resume-attempt/` (0700).
   - Run once more, fresh: the full prompt (as for `fresh`), the same model, reasoning and policy, `persist_session` true, no `provider_session_id`, and `deadline_s` = the request's deadline minus the time already spent since the first provider start. If less than 1 s remains, there is no re-run and the first report stands.
   - The report is the re-run's, with `session` = `{mode: "fresh", resumeFrom: null, fallbackFrom: <the resumeFrom ID>, warning: "PROVIDER_SESSION_MISSING"}`. If the re-run also ends `PROVIDER_SESSION_MISSING`, it is reported as `failed` like that; there is never a second re-run.

## Done when

- [ ] Session support: an adapter without it refuses a resume in `prepare` with `SESSION_UNSUPPORTED` (unit test with a stub adapter). `claude` (until S15), `codex`, `agy` and `opencode` report `resume: "unsupported"` and `session_support()` both false; `fake` reports `resume: true` and both flags true. For every registered adapter, `capabilities()["resume"]` agrees with `session_support()`.
- [ ] Fake (CLI + adapter, `AGENT_STUDIO_FAKE_SESSION_DIR` set to a temp dir): a fresh persisted run, then a resumed run, reports `resumedFrom` = the first ID, `priorTurns: 1` and a new ID; the parent file is byte-identical afterwards; resuming the parent again gives `priorTurns: 1` again. A fresh run without `persist_session` writes no session file, and resuming its ID gives `PROVIDER_SESSION_MISSING`. A resume ID not matching `fake-[0-9a-f]{12}` is refused in `prepare`.
- [ ] A session started `workspace_write` and resumed `read_only`: the resumed argv carries `--sandbox read-only`, the `init` event echoes `read-only`, and a `writeFile` option gives `waiting_input` / `PERMISSION_DENIED` with no file written.
- [ ] Prompts: the `resume` prompt equals the template in step 5 byte for byte (with and without a role description) and contains no `===== AGENT STUDIO ROLE` or `===== SKILL` block. For `none` (no `session` block), `unsupported` and `fresh`, `prompt.txt` is byte-identical to what the unchanged P00 code path writes for the same request (golden test, direct task and workflow `promptFile`).
- [ ] Fallback (integration, fake, unknown resume ID): exactly one re-run in the same assignment; `runs/<id>/resume-attempt/` holds the four first-run files and `runs/<id>/` the re-run's; the report is the re-run's `succeeded` with `session.fallbackFrom` and `warning: "PROVIDER_SESSION_MISSING"`; the re-run's `meta.json` `deadlineSeconds` is below the request's deadline. With `forceSessionMissing`, the re-run's missing session is reported `failed` / `PROVIDER_SESSION_MISSING` and no third run happens. A cancel marker written before the run → `cancelled`, no `resume-attempt/` directory; a cancel marker that appears after the first run and before the re-run → the first report stands and no re-run starts (unit test of the runner's fallback step with the marker created between the two runs). With a remaining deadline under 1 s (request `deadlineMs` below 1000 with an unknown resume ID), the first report stands and no `resume-attempt/` directory exists.
- [ ] Usage: `usageNormalized` is correct for `tests/fixtures/claude/success.jsonl`, for a new `tests/fixtures/claude/usage_cached.jsonl` (a copy of `success.jsonl` with nonzero cache counts, marked synthetic in `tests/fixtures/claude/README.md`), for the Codex `turn.completed` usage from `tests/fixtures/codex/bin/codex` plus one line with nonzero `cached_input_tokens`, and for fake fresh and resumed runs (`cachedInputTokens` = prior prompt bytes). It is `null`, never zeros, when no usage was reported (e.g. `claude/missing_result.jsonl`, fake `provider_failure`). Fake `toolUses` from the provider option appears in the report.
- [ ] Report validation: `contract.validate_report` accepts the new fields and rejects a malformed `usageNormalized`, `toolUses` and `session.mode` with `BAD_REPORT`.
- [ ] Tests: `tests/unit/test_p01_s11_session_contract.py` (adapters, fake CLI sessions, prompt rendering, usage, report validation) and `tests/integration/test_p01_s11_runner_resume.py` (the real runner through `tests/runner_harness.py`, with hand-written `request.session` blocks, no coordinator). All existing tests stay green.

## Evidence

(filled in when the story is done)
