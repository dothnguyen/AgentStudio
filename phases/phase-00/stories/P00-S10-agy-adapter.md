# P00-S10 — Antigravity CLI (agy) provider adapter

Status: To Do
Depends on: P00-S04 (Done: adapter contract), P00-S05 (Done: real direct-task path)
Architecture: [P00 implementation contract](../architecture.md), section F

## Goal

Replace the fail-closed `agy` placeholder with an Antigravity CLI adapter that uses the installed client through the same provider, runner, report, cancellation and reconciliation contracts as Codex and Claude. The adapter exposes only authentication, settings and permission capabilities proven against the installed CLI; an unverified policy remains unsupported and never falls back to another provider or a broader mode.

The installation blocker is removed. On 2026-10-28 Agent Studio's WSL login shell resolved `/home/dothn/.local/bin/agy`, and `agy --version` returned `1.4.8`; top-level help exposed `--print`, `--input-format`, `--output-format`, `--sandbox`, `--mode`, `--model`, `--effort` and `--print-timeout`. These observations permit implementation to resume but do not by themselves prove cached authentication or an enforceable `read_only`/`workspace_write` mapping.

## Implement in this order

1. Re-run discovery through Agent Studio's resolved login environment and record the executable path/real path, v1.4.8 help, authentication result and official documentation access date in `backend/agent_studio/providers/agy/CONTRACT.md`. Capture a sanitized read-only micro-task in a disposable git repository; do not run a live task in the Agent Studio checkout.
2. Prove each policy independently before registering it. In particular, do not equate `--mode=plan` with filesystem read-only or `--sandbox` with workspace-only writes: verify actual enforcement and record the exact argv. Return `None` for any policy without a run-scoped, fail-closed mapping, and never use `--dangerously-skip-permissions` or persistent user/workspace permission changes.
3. Implement `backend/agent_studio/providers/agy/adapter.py` using the existing `Adapter`, `AssignmentInput`, `Prepared` and `ParseState` interfaces. Resolve the executable from the supplied `PATH`; inspect/version/probe with bounded output; validate only observed model/effort values; pass task text through the private stdin/file path; set `cwd` to the canonical workspace; and allowlist environment variable names without logging values.
4. Build the non-interactive argv from verified flags. Use documented structured output (`--output-format stream-json`) and a prompt transport compatible with the runner's private input. Reject unknown settings, unsupported policies and forbidden bypass flags before process start. Keep `Adapter.finalize`, `cancel` and `reconcile` unless captured evidence requires a narrowly documented provider-specific override.
5. Parse only documented or captured JSON event shapes. Record the init conversation ID, bounded progress/text and JSON-safe usage; decide from the terminal `result.status`, not exit code. Map provider error/auth/quota, `CANCELED`, `INTERRUPTED`, `WAITING`, permission soft-denial, malformed stream, missing terminal event and contradictory exit/result evidence to the existing normalized diagnostics. A zero exit or `SUCCESS` event with a required denial never succeeds.
6. Register `AgyAdapter` in `backend/agent_studio/providers/agy/__init__.py`. Do not add provider-specific branches to the coordinator, runner, workflows, report rules, reconciliation, quota/failover, schema or UI; `agy` already travels through those generic paths. Keep session resume unsupported in this story.
7. Add sanitized captured fixtures under `tests/fixtures/agy/` for every observed outcome and label hand-authored cases honestly in its `README.md`. Add a deterministic stand-in executable only for automated integration paths; it must record prompt hash/byte count rather than prompt content and must never call the real service.
8. Replace the placeholder tests in `tests/unit/test_s10_agy.py` with discovery, auth, exact-argv/policy, settings, hostile-prompt transport, parser, denial, quota, cancellation and reconciliation coverage. Expand `tests/integration/test_s10_agy.py` to prove registry/team preflight, direct task, one generic workflow stage, generic quota handling and cancellation/reconciliation for capabilities actually implemented.
9. Run the focused and shared suites. Then use `provider verify --provider agy` plus direct tasks for every supported policy, one workflow stage and one cancellation in a disposable repository. Sanitize and record the real evidence in the provider contract and `phases/phase-00/evidence/s10/`; if authentication or a policy cannot be proved, record that exact capability gap without inventing behavior.

## Error contract

| Condition | Required result |
|---|---|
| Executable absent | `PROVIDER_NOT_FOUND`; no process starts |
| Required headless/structured surface absent | `CAPABILITY_GAP` |
| Cached authentication absent/expired | `AUTH_REQUIRED`; team start creates no pane |
| Unverified policy or setting | `POLICY_UNSUPPORTED` / `SETTING_UNSUPPORTED` before process start |
| Permission denial, even with exit 0 or terminal success | `waiting_input`, `PERMISSION_DENIED` |
| Headless approval/input request or terminal `WAITING` | `waiting_input`, `INPUT_REQUIRED` |
| Provider quota/rate limit | `failed`, `USAGE_LIMIT`; reset time only when provider evidence validates it |
| Malformed-only stream / no terminal result | `inconclusive`, `MALFORMED_OUTPUT` / `NO_TERMINAL_EVENT` |
| Terminal success plus nonzero exit | `inconclusive`, `CONTRADICTORY_EVIDENCE` |
| Agent Studio cancellation wins | `cancelled`, `CANCELLED`, exactly one terminal assignment event |
| Process gone after restart without a saved result | reconciliation remains uncertain; never redispatch or invent success |

## Done when

- [ ] `backend/agent_studio/providers/agy/CONTRACT.md` records the tested executable/path/version, official sources, cached-auth proof, exact common and per-policy argv, prompt/cwd/environment handling, model/effort values, event mapping, cancellation semantics, limitations and fixture provenance. Test: compare the recorded flags with `agy` v1.4.8 help and the sanitized captures.
- [ ] Every supported policy has a verified, run-scoped mapping; every unverified policy is `None` and is refused before process start. Test: `python3 -m unittest tests.unit.test_s10_agy` asserts exact argv, forbidden-flag absence, unsupported-policy refusal and byte-exact hostile prompt transport.
- [ ] Structured events normalize success, provider/auth/quota failures, denial/input requests, cancellation/interruption, malformed/missing terminal output and contradictory evidence without using exit code as success. Test: the captured-fixture parser cases in `tests.unit.test_s10_agy` assert exact status, diagnostic, session, usage and optional reset fields.
- [ ] `agy` is selectable through existing registry/team/direct/workflow paths with no generic provider-specific branch. Test: `python3 -m unittest tests.integration.test_s10_agy` covers unavailable/auth refusal, supported settings, direct task, generic workflow handoff, generic quota behavior and cancellation/reconciliation using the deterministic stand-in.
- [ ] Shared regressions pass. Test: `python3 -m unittest tests.unit.test_s04_contract tests.unit.test_s07_reconcile tests.unit.test_p03_s11_usage_classifier` and `python3 -m unittest tests.integration.test_s04_runner tests.integration.test_s05_direct tests.integration.test_s06_workflow tests.integration.test_member_agent_switch`.
- [ ] The complete suite passes. Test: `python3 -m unittest discover -s tests -t .`.
- [ ] Real WSL evidence is recorded from a disposable repository: deep preflight/provider verification, one direct task per supported policy, one workflow stage and one clean cancellation; `read_only` leaves the repository unchanged and any `workspace_write` mapping cannot write outside its allowed scope. Test: inspect the sanitized summaries, snapshots/events and normalized results under `phases/phase-00/evidence/s10/` and link them from `CONTRACT.md`.
- [ ] If authentication or either policy remains unavailable, the adapter reports the precise capability gap and the story evidence distinguishes implemented support from the unsupported surface; no fake fixture is presented as proof of the real provider.

## Evidence

(Filled in when the story is done: commands run, results and links to sanitized evidence files.)
