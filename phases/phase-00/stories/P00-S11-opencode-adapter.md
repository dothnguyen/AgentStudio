# P00-S11 — OpenCode provider adapter

Status: Blocked (2026-10-25) — the adapter is implemented and verified against the installed CLI v2.1.4, but both permission policies stay `unsupported` (no injectable run-scoped permission configuration; see Evidence), so no run can be authorized. The gap is recorded in `providers/opencode/CONTRACT.md`; it unblocks the moment a mechanism exists.
Depends on: P00-S04 (contract), P00-S05 (real direct-task check)
Architecture: [P00 implementation contract](../architecture.md), section F

Follow the **shared adapter checklist** in the [stories README](./README.md). This story lists only what is specific to OpenCode. It may be marked Blocked with a recorded capability gap; any two Done adapters unblock S12.

## OpenCode-specific steps

1. Inspect installed `opencode` version/help via the entry shim; compare with the [OpenCode CLI documentation](https://opencode.ai/v2/docs/cli/commands/). Record exact flags and event shapes in `providers/opencode/CONTRACT.md`. Candidate: `opencode run` with JSON output.
2. Preflight distinguishes missing CLI, missing configured model/provider, and missing credentials.
3. Policy mapping: supply a run-scoped permission configuration for `read_only` and `workspace_write`; never rely on a permissive user default without showing and accepting it.
4. If there is no authoritative terminal event, document and test the equivalent (final response + exit + validation). Never infer completion from tmux idle.
5. Use server-backed mode only if required; record any server/session identity, and never stop a shared OpenCode server Agent Studio did not create.

## OpenCode-specific fixtures

Success, provider/model error, permission rejection, malformed event, missing final response, nonzero exit; ownership test for unrelated sessions/servers.

## Done when

- [x] Shared checklist complete for providerId `opencode` — except the policy mapping itself, which is the recorded gap (every other checklist item is implemented and tested; the checklist's "map … or refuse" is satisfied by refusing).
- [x] Cleanup never touches a non-owned OpenCode server or session — runs use `--standalone` (a private server that dies with the provider's process group); the shared background `opencode service` is never started, signalled, or stopped by Agent Studio.

## Evidence

- **Discovery (all against the installed binary, 2026-10-25):** opencode v2.1.4 (ELF, `~/.opencode/bin/opencode`, from `opencode-ai@1.2.27`; not on the login PATH). `run --help` verified: `--format json`, `--model provider/model#variant`, `--agent`, `--session`, `--standalone`, `--log-level`, `--auto` (auto-approves permissions — recorded as the bypass analog and put on the adapter's `NEVER` list). `auth list` verified: one `… stored` line per credential (an "OpenCode Go" credential is stored). `run --format json` verified: newline-delimited events; captured `step_start` (with `sessionID ses_…`) and `error` events (`provider.auth` 403, `provider.invalid-request` 400) — and **exit code 0 on provider errors**, so the error event is the only failure signal (fixtures: `tests/fixtures/opencode/captured-2.1.4-*.jsonl`, verbatim).
- **The gap (why Blocked):** `run --help` has no `--config` flag; `OPENCODE_CONFIG=<bad.json>` is silently ignored; `XDG_CONFIG_HOME` with a valid config changing `model` has no effect on the request (`debug paths` honours the var but the config sources do not); a project-root `opencode.json` lives in the workspace the agent may edit. The only injectable-free location is the global config shared with the user's interactive opencode — exactly what the story forbids without explicit acceptance. Additionally every model the credential can list fails upstream (`provider.auth` 403 "An active OpenCode Go subscription is required", or a workspace-privacy 400), so success/tool/permission events could not be captured. Full reasoning and the policy design to unblock: `providers/opencode/CONTRACT.md`.
- **Implemented:** `providers/opencode/adapter.py` — probe (executable via PATH then the installer fallback, version, flag check, `auth list`), `CAPABILITY_GAP` naming the gap after auth is checked; parse (`step_start`, `error` → terminal `AUTH_REQUIRED`/`PROVIDER_ERROR`, part shapes `text`/`tool`/`step-finish` per opencode's part model, malformed lines bounded, no terminal event → `inconclusive` never `succeeded`); prepare (argv shape fully built and pinned by tests, `--standalone --format json --log-level none`, prompt via stdin, NEVER = `--auto`/`--continue`; raises `POLICY_UNSUPPORTED` defensively — dispatch refuses earlier via the policy table); capabilities (`resume`/`interactiveInput` unsupported, no deep probe while no model runs).
- **Tests:** `tests/unit/test_p00_s11_opencode.py` (21 tests: settings/policies/capabilities, executable resolution incl. the real fallback, argv shape via a mocked policy mapping, NEVER-flag refusal, all probe states via a stand-in CLI (`tests/fixtures/opencode/bin/opencode`), real-CLI probe reporting the recorded gap, the two captured fixtures, malformed streams, and the documented success/tool shapes pinned for re-verification). Kept tests updated: the two placeholder pins now name `agy` (the remaining placeholder) and the registry test's implemented set is `{codex, claude, opencode}`.
- **Not done / next:** the shared checklist's real `read_only` + `workspace_write` direct tasks (impossible until the policy gap closes — the subscription wall also blocks any run), and the fixture set for success/permission shapes (documented in CONTRACT.md, pinned by tests as shapes to re-verify). Unblock path: a config-injection mechanism in a future opencode release, or the operator explicitly accepting a global permissions file.
- **Command log:** discovery with the real CLI (commands quoted in CONTRACT.md) → adapter + fixtures + tests → `python3 -m unittest tests.unit.test_p00_s11_opencode tests.unit.test_s04_contract …` green → full suite (see delivery log). Implemented by the operator's coding agent (ZCode), as in S06–S12.
