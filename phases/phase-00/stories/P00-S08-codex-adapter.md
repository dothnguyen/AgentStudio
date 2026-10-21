# P00-S08 — Codex provider adapter

Status: Done (2026-10-22)
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

## Added scope (operator request)

- Per-agent **model** and **reasoning level** for every adapter (`validate_settings`, `model_selectable`, `reasoning_levels`); unverified values refused before panes open.
- Every agent follows the **workspace role/description/skills** (`.agent-studio/roles.json`, `roles/<role>.md`, `skills/<name>/SKILL.md`, optional `team.json`), frozen into each assignment. See architecture §F "Per-agent settings and workspace roles".

## Done when

- [x] Shared checklist items 1–7 and 9 for providerId `codex` (contract note, probe incl. login + deep micro-task, argv/env allowlist/stdin prompt, verified sandbox mapping with no bypass flag, JSONL parsing, shared cancel/reconcile, fixtures and tests).
- [x] Policy mapping recorded in `CONTRACT.md` and shown by preflight (`policies` lists the exact flags per policy).
- [x] Model/reasoning per agent and workspace roles/skills reach the provider (integration tests against a codex stand-in that records argv and stdin).
- [x] `agent-studio provider verify --provider codex --model gpt-5.6-sol --reasoning medium` passed on Ubuntu-24.04 (evidence below).
- [x] One `read_only` and one `workspace_write` `task direct` in a disposable repo (`~/scratch/s08`) with the operator attached to the pane.

## Evidence (build environment)

- Real codex-cli 0.163.0 inspected in the build container: every flag above present in `exec --help`; `login status` → "Not logged in" exit 1 / "Logged in using an API key" exit 0; a real `exec --json` run without network captured as `tests/fixtures/codex/captured-0.163.0-network-unreachable.jsonl` (reconnect `error` events are non-terminal; the deadline ends the run).
- Real-binary tests (`RealCodexBinary`) run wherever `codex` is installed; skipped otherwise.
- Full suite: **239 tests OK** in the build container (codex installed) and OK in the Cowork Linux VM (real-binary class skipped there).
- Fixtures: success/failure/declined/malformed/missing-terminal/nonzero-exit/legacy-format are synthesized in `tests/unit/test_s08_settings_roles.py` from the documented 0.163.0 event shapes; only the network-failure stream is a live capture. Replace or extend with captures from the verify run (its `stdout.jsonl` files) when closing this story.

## Evidence (operator machine, Ubuntu-24.04, 2026-10-22)

[`evidence/s08/20261021T233010Z-codex/`](../evidence/s08/20261021T233010Z-codex/summary.json): codex-cli 0.163.0 at
`~/.nvm/versions/node/v24.22.0/bin/codex` (found through the login-shell PATH), deep probe authenticated,
model `gpt-5.6-sol`, reasoning `medium` (both visible in each `meta.json` argv). Checked for secrets: none.

| Check | Policy | Result | Time |
|---|---|---|---|
| read_only_reply | read_only | succeeded, `AGENT_STUDIO_OK` | 3.7 s |
| workspace_write_creates_file | workspace_write | succeeded, file created with the expected content | 8.3 s |
| read_only_blocks_write | read_only | file **not** created; stderr: `patch rejected: writing is blocked by read-only sandbox` | 4.9 s |
| reviewer_verdict | read_only | succeeded, verdict `{"verdict":"pass","findings":[]}` parsed | 287.5 s |

Findings: (1) the reviewer turn produced 17 output tokens and 0 reasoning tokens but took 287.5 s, all of it waiting
on the service with no events, close to verify's old 300 s per-check limit — now 600 s, and verify prints each check,
its limit and, on failure, the end of stderr (real assignments default to 30 min). (2) codex reported the blocked
read-only write only on stderr, not as a `declined` item, so the outcome is decided from the workspace (unchanged)
and the final message; the shared rules are unaffected.

**Direct tasks (operator, 2026-10-22 23:44 UTC):** team with `codex:Developer:dev,model=gpt-5.6-sol,reasoning=medium`.
`workspace_write` task "Add a NOTES.md with one line: hello" → assignment `bcba69f0`: queued → claimed → running →
progress (codex thread, `files: add /home/dothn/scratch/s08/NOTES.md`, final message) → **succeeded** in 9 s; the
`read_only` summary task ran first on the same agent. Also found while running it: a coordinator started before
migration 5 is refused with `BACKEND_UNAVAILABLE` "older schema" plus the restart remedy, as designed.

## How this was closed (operator, inside Ubuntu-24.04)

```bash
codex --version && codex login status          # install: npm install -g @openai/codex ; then: codex login
agent-studio provider verify --provider codex --pretty
agent-studio provider verify --provider codex --model <model you use> --reasoning high --pretty
```

Then copy `<state>/provider-verify/<time>-codex/` (the path is in the output, `evidenceDir`) into `phases/phase-00/evidence/s08/` after checking it for secrets, and run one `task direct --wait` per policy on a disposable repo while attached to the team.
