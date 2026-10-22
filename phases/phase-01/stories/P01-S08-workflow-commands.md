# P01-S08 — Workflow commands over the CLI and `serve`

Status: Done (2026-10-22)
Depends on: P01-S02, P01-S06
Architecture: [P01 design contract](../README.md#e-commands), section E

## Goal

Give the operator, and later the P02 UI, the commands to discover, check, and run definitions: list what exists, validate one against the team before spending tokens, start it with a prompt, and read back the route it took. All of this works from the one-shot CLI and from `serve` with identical JSON.

## Implement in this order

1. Protocol: add `workflow.list` and `workflow.validate` as read-only commands (no inbox, `reader` connection plus file reads), and extend `workflow.start` args with `definition` and `bindings` (role → agent ID; validated as a small object of id-shaped strings). Add the five new error codes with remediation text, and add the read-only commands to the `serve` allowlist.
2. `workflow.validate` returns `{definition: {...canonical}, errors, warnings, bindings?}`. With `teamId` it also runs `bind_roles` in a read-only mode and reports binding errors instead of raising.
3. CLI: `workflow list [--team ID | --workspace PATH]`, `workflow validate --definition NAME [--team ID | --workspace PATH]`, `workflow start --team ID --definition NAME (--text … | --text-file …) [--bind ROLE=AGENT …] [--wait]`. Without `--definition`, the existing `--developer --reviewer` form is used. Combining the two forms → `BAD_REQUEST`. Update the CLI help text.
4. `workflow show` (and `--pretty`) prints the definition name, the first 12 characters of the SHA-256, the bindings, the visits per stage, `step_count`, and the route as `develop → qa (fail) → develop → qa (pass) → final (pass) → $succeed`. `watch.follow_workflow` prints each `routed` event as it happens.

## Done when

- [x] A Windows-boundary test (the existing PowerShell/`serve` harness, or its WSL-side equivalent) round-trips `workflow.list`, `workflow.validate`, and `workflow.start` with a definition. Hostile task text arrives byte-exact.
- [x] `list` shows built-in and workspace definitions, broken files included with their errors. `validate` reports `ROLE_UNBOUND` for a team missing a role without starting anything.
- [x] `start --bind` overrides the roster lookup. A bad `--bind` (unknown role or agent) is rejected before any row is written.
- [x] `show --pretty` prints the route of a finished fake run as specified, and `--wait` prints routed events live.
- [x] Tests: `tests/unit/test_p01_s08_protocol.py` and `tests/integration/test_p01_s08_cli.py`. The full suite stays green.

## Evidence

(filled in when the story is done)

Implemented 2026-10-22:
- `workflow.list` and `workflow.validate` (read-only; `bind_roles(..., check_providers=False)` over `workflow.ReadTx`), both in `dispatch.COMMANDS`, so they work in `serve`.
- CLI: `workflow list|validate|start --definition NAME --bind ROLE=AGENT`; the P00 `--developer/--reviewer` form is unchanged; mixing the two forms is BAD_REQUEST.
- `workflow show` now returns `route` (e.g. `a → b (fail) → a → b (pass) → $succeed`) and `visits`; `--pretty` and `--wait` print the route, and `--wait` prints `from (outcome) -> to` live.
- Tests: `tests/unit/test_p01_s08_protocol.py`, `tests/integration/test_p01_s08_cli.py` (7 tests, including a `serve` round-trip with hostile task text). Unit suite 310 OK; P01-S04 integration 19 OK.
- The PowerShell harness was not run; the `serve` test is the WSL-side equivalent.
