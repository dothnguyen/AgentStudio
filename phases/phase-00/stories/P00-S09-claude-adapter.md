# P00-S09 — Claude Code provider adapter

Status: To Do
Depends on: P00-S04 (contract), P00-S05 (real direct-task check)
Architecture: [P00 implementation contract](../architecture.md), section F

Follow the **shared adapter checklist** in the [stories README](./README.md). This story lists only what is specific to Claude Code. It may be marked Blocked with a recorded capability gap; any two Done adapters unblock S12.

## Claude Code-specific steps

1. Inspect installed `claude --version` and `claude --help` in the distro via the entry shim's login environment. Compare with [Anthropic's CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage). Record exact version and flags in `providers/claude/CONTRACT.md`.
2. Candidate invocation: `claude -p` with `--output-format stream-json` (plus `--verbose` if the installed version requires it for streaming), prompt via stdin.
3. Policy mapping: `read_only` → verified plan/read-only permission mode or a read-only tool allowlist; `workspace_write` → verified edit-accepting mode restricted to the workspace with an explicit tool allowlist. Never substitute `--dangerously-skip-permissions`.
4. Parse stream events and the final result message: error subtype, interruption, permission denials, usage, session ID.
5. Missing login → `AUTH_REQUIRED`, not a generic timeout.

## Claude Code-specific fixtures

Final success, error result, permission denied, missing final result, corrupted JSON line, nonzero exit.

## Done when

- [ ] Shared checklist complete for providerId `claude`.
- [ ] A denied permission never becomes succeeded from exit code or a quiet pane.
