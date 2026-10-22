# P00-S09 — Claude Code provider adapter

Status: Done (2026-10-22)
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

- [x] Shared checklist items 1–7 and 9 for providerId `claude` (see `providers/claude/CONTRACT.md`).
- [x] A denied permission never becomes succeeded from exit code or a quiet pane (`result.permission_denials`, or stream denials without a result → `waiting_input / PERMISSION_DENIED`; tested on real captured output).
- [x] Per-agent model (`--model`) and effort (`--effort low|medium|high|xhigh|max`) and the workspace role context, as in S08.
- [x] `agent-studio provider verify --provider claude` passes on Ubuntu-24.04 with an authenticated Claude Code (default model and `--model sonnet --reasoning medium`).
- [x] One `read_only` and one `workspace_write` `task direct` with `claude:Reviewer:rev,model=sonnet,reasoning=medium` in `~/scratch/s08`, watched in the pane; both succeeded (operator report, 2026-10-22).

## Evidence (build environment)

- Real Claude Code 2.1.307 inspected; the real CLI run with the adapter's exact argv and environment against a local
  scripted Messages API: read reply, write in `workspace_write`, write unavailable in `read_only`, write denied when
  not pre-approved (`permission_denials`), write outside the workspace denied by `--restricted`, Bash unavailable,
  API error (`is_error`, exit 1), `--model`/`--effort` reaching the request. Captures are in `tests/fixtures/claude/`.
- `RealClaudeAgainstLocalApi` tests repeat this wherever the CLI is installed; a stand-in `claude` drives the
  coordinator/tmux/runner path (mixed Codex + Claude team, verify, API error, logged out).
- Full suite: 266 tests OK in the build container; OK in the Cowork Linux VM.
- Not reproducible here: a real logged-out run (handled from `auth status` and the "Not logged in · Please run
  /login" result text).

## Evidence (operator machine, Ubuntu-24.04, 2026-10-22)

Claude Code 2.1.307 at `~/.nvm/versions/node/v24.22.0/bin/claude`, logged in with claude.ai, deep probe authenticated.
Checked for secrets: none.

| Run | Model (from `system/init`) | read_only reply | workspace_write file | read_only write attempt | reviewer verdict |
|---|---|---|---|---|---|
| [`20261022T003500Z-claude`](../evidence/s09/20261022T003500Z-claude/summary.json) (default) | claude-opus-5-5 | ok, 2.4 s | created, 5.5 s | no file; "my tools are read-only (Glob, Grep, Read)", 3.7 s | pass, 3.8 s |
| [`20261022T003538Z-claude`](../evidence/s09/20261022T003538Z-claude/summary.json) (`--model sonnet --effort medium`) | claude-sonnet-5-5 | ok, 3.7 s | created, 4.6 s | no file, 4.1 s | pass, 4.8 s |

The init events show `permissionMode` `dontAsk` for read-only checks and `acceptEdits` for the write check, and the
`sonnet` alias resolving to `claude-sonnet-5-5`, so the settings reached the CLI.

## How this was closed (operator, inside Ubuntu-24.04)

```bash
claude --version && claude auth status        # install: npm install -g @anthropic-ai/claude-code ; login: claude auth login
agent-studio provider verify --provider claude --pretty
agent-studio provider verify --provider claude --model sonnet --reasoning high --pretty
```

Then copy the `evidenceDir` into `phases/phase-00/evidence/s09/` and run one `task direct --wait` per policy with a
`claude:Reviewer` agent while attached to the team.
