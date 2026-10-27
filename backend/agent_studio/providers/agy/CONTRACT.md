# agy adapter contract

Status: **blocked; placeholder retained** (discovery 2026-10-28). No Antigravity
capability has been verified against an installed client. The placeholder reports
unavailable with a not-implemented reason and `PROVIDER_NOT_FOUND` when neither
executable is found; an unverified executable yields `CAPABILITY_GAP`. It refuses
all policies and never starts a provider process or substitutes another provider.

## Discovery evidence

Agent Studio's `envresolve.resolve()` captured the default `login-interactive`
environment from `/bin/bash`, source `login-shell`, with no warnings. In that
environment `shutil.which("agy", path=env["PATH"])` and the same lookup for
`antigravity` both returned `None`. A separate `bash -lc` `command -v` lookup
also found neither. Thus there is no resolved executable or real path, version,
top-level help, headless help, or executable error output to record. `--version`
and `--help` were not run. Authentication is unknown; no micro-task or private
stdout/stderr capture was possible. A version alone would not prove authentication.
No real output fixtures or stand-in executable were made.

## Documentation leads, not installed-client verification

On 2026-10-28 the historical https://www.agy.dev/docs/cli/headless/ redirected
to the site homepage. The official [headless documentation](https://antigravity.google/docs/cli/headless/)
was accessible. It describes `-p` for a single non-interactive prompt, cached
credentials from an interactive `agy` session, `--output-format stream-json`
for NDJSON events, and JSON user events on stdin with `--input-format
stream-json`. It describes result status/error and usage fields, and says
permission requests can be soft-denied while the process exits zero. It also
describes `--model`, and `--effort` values low, medium and high. These are
documentation claims, not verified flags, settings or output for this machine.
The documentation states that workspace file writes are allowed by default;
this does not establish an enforceable Agent Studio read-only mapping. No
cancellation semantics have been verified. The documented
`--dangerously-skip-permissions` must never be used.

## Current contract and limitations

| Surface | Current status |
|---|---|
| Common argv, prompt transport, cwd, environment allowlist | None; placeholder does not execute |
| `read_only`, `workspace_write` | Both unsupported; no verified enforcement mapping |
| Model, reasoning, MCP | Unsupported; no verified run-scoped mapping |
| Version, authentication, deep probe | Unknown; deep probe unavailable |
| Events, terminal result, usage limit/reset | No parser or verified mapping |
| Cancellation and reconciliation | No agy process has been run; shared adapter mechanisms remain authoritative |
| Fixture provenance | No captures or hand-authored provider events; see `tests/fixtures/agy/README.md` |

## Live acceptance gate (unrun)

In a WSL login environment with an installed, authenticated client, resolve its
absolute and real paths; record version, top-level and headless help and official
documentation. Verify an enforceable read-only policy before any real adapter is
registered. In a disposable git workspace run deep preflight and provider verify,
then a direct assignment for each verified policy, a workflow stage and a clean
cancellation. Save sanitized preflight/verify summaries, snapshots, event IDs,
normalized reports and proof the cancelled process is gone. Verify both workspace
isolation and the actual policy enforcement. These operator checks remain unrun
because neither executable resolves in the login environment; authentication,
policy enforcement and live service behavior therefore remain unverified.
