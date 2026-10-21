# Provider adapters

Every provider — `codex`, `claude`, `agy`, `opencode`, and the test-only `fake` — is one package directory
here exposing `ADAPTER`, an instance of `base.Adapter`. The coordinator, runner, and workflow never contain
provider-specific code (a test fails if a provider name appears outside this folder and `schema.py`).

## What an adapter implements

| Method | Must | Must never |
|---|---|---|
| `capabilities()` | declare headless / structured progress / structured final / resume / interactive input; `"unsupported"` is explicit | claim a capability it has not verified |
| `policy_mapping()` | map `read_only` and `workspace_write` to the exact flags used, or `None` | map to an unrestricted / skip-permissions mode |
| `probe(env)` | report executable, version, auth (proved by a disposable read-only task), per-policy support | infer auth from `--version` |
| `_prepare(inp, env)` | return `Prepared(argv=[absolute exe, ...], env_allowlist, stdin_path, cwd)` | put task text in argv or build a shell string |
| `parse_line(line, state)` | translate one raw output line into `ParseState` and display events | read the tmux screen, raise on bad input |

`base.Adapter` provides the rest for everyone: policy refusal in `prepare`, the outcome rules in `finalize`,
`cancel` (signals only a matching recorded process group), and `reconcile` (`running` / `terminal` / `uncertain`).

## Outcome rules (`Adapter.finalize`, identical for every provider)

In order: cancel requested → `cancelled`; deadline → `failed TIMEOUT`; provider terminal error → `failed`;
provider terminal success + any permission denial → `waiting_input PERMISSION_DENIED`; + nonzero exit or
signal → `inconclusive CONTRADICTORY_EVIDENCE`; + malformed reviewer verdict → `inconclusive MALFORMED_VERDICT`;
otherwise `succeeded`. Without a terminal event: input request → `waiting_input`; denial → `waiting_input`;
signal → `failed PROVIDER_CRASHED`; unparseable output → `inconclusive MALFORMED_OUTPUT`; exit 0 →
`inconclusive NO_TERMINAL_EVENT`; nonzero → `failed PROVIDER_EXIT_<n>`.

The runner validates the report (`contract.validate_report`) before sending; the coordinator validates it
again before applying, rejects mismatched IDs, and applies a "success" that lacks the evidence as
`inconclusive` (assignment `reconciling`).

## The runner around an adapter

Private per-assignment folder `~/.local/state/agent-studio/runs/<assignmentId>/` (all `0600`):
`prompt.txt` (fed on stdin), `stdout.jsonl` (raw, capped by `outputBudgetBytes`, default 4 MiB),
`stderr.log` (capped at 256 KiB), `meta.json` (argv, cwd, env *names*, provider process identity, limits),
`result.json` (the normalized report). The provider runs in its own process group with `PR_SET_PDEATHSIG`,
so cancelling signals only its tree and a killed runner never leaves an orphaned CLI.

## Adding or implementing a provider (S08–S11)

1. Verify the installed CLI (`--version`, `--help`) and fill in its `CONTRACT.md`.
2. Replace the placeholder in `<id>/__init__.py` with a real adapter; keep fixtures of its actual output.
3. Run the shared contract tests plus provider fixtures; nothing outside this directory should change.

Contract examples: `tests/fixtures/contract/examples/`; scenario table: `tests/fixtures/contract/scenarios.json`.
