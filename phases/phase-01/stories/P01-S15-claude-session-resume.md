# P01-S15 — Claude Code session resume, verified on the real CLI

Status: To Do
Depends on: P01-S11
Architecture: [P01 design contract](../README.md#h-session-continuity-e4), section H; [P00 contract](../../phase-00/architecture.md) §F; `backend/agent_studio/providers/claude/CONTRACT.md`

## Goal

The Claude adapter declares `resume` and `forkOnResume` only after the installed CLI proves four things:

- a resumed run continues the conversation;
- a resumed run gets a new session ID while its parent stays unchanged;
- a resumed run obeys the **current** task's narrower tool set and permission mode;
- a missing session is recognised before any turn runs.

If the real CLI does not honour the narrower policy on resume, this story ends **Blocked**. In that case the adapter keeps `resume: false` (fail closed), and Claude agents behave like Codex agents (`unsupported`).

## Implement in this order

1. Inspect `claude --help` (2.1.307 or newer) in the login environment for `--resume`, `--fork-session` and `--no-session-persistence`. Add `--resume` and `--fork-session` to the probe's flag check (`CAPABILITY_GAP` if they are missing).
2. `prepare`:
   - an unkeyed task keeps `--no-session-persistence`;
   - a persisted task (`persist_session`) drops it;
   - a resume adds `--resume <id> --fork-session`.
   - Model, effort, `--restricted`, `--strict-mcp-config`, `--permission-prompts none`, `--permission-mode`, `--tools` and `--allowedTools` stay as they are for the current policy.
   - The session ID is validated as a UUID before it goes into argv.
3. Parse the real output of a resume with an unknown ID and add a fixture. Classify it as `PROVIDER_SESSION_MISSING` only if no assistant or tool turn happened. Record which `session_id` (`system/init` vs `result`) a forked resume reports, and use that one.
4. `toolUses` from `assistant` `tool_use` blocks. Confirm `usageNormalized` (`input_tokens + cache_creation_input_tokens` → input, `cache_read_input_tokens` → cached) against a real resumed run.
5. `provider verify --provider claude --sessions` adds these checks, with evidence written like S09's:
   - (a) a fresh persisted run is told a random word; a resumed run repeats it; its ID differs from the parent's.
   - (b) a second resume of the **parent** does not know a word given only in the fork.
   - (c) a `workspace_write` session that created a file, resumed `read_only` and asked to write: no file, read-only tools in `system/init`, mode `dontAsk`.
   - (d) resume of a random UUID → the runner falls back to fresh, with the warning in the report.
   - (e) `system/init` model and effort on resume equal the requested ones.
6. Update `CONTRACT.md`: the flags, the observed session-ID behaviour, the missing-session output, the usage mapping, and the dated verify run.

## Done when

- [ ] Unit tests on captured real fixtures: the argv for unkeyed / fresh-persisted / resume × `read_only` / `workspace_write` (no bypass flag, no `Bash`, no `--add-dir`, a non-UUID ID refused), missing-session classification, forked-ID extraction, `toolUses`, usage.
- [ ] `agent-studio provider verify --provider claude --sessions --pretty` passes on the operator's Ubuntu-24.04 with an authenticated Claude Code. Checks (a)–(e) pass, with evidence copied to `phases/phase-01/evidence/s15/` and checked for secrets.
- [ ] If check (c) fails: the story is marked Blocked with the exact observation, `session_support()` stays false, and a test pins that.
- [ ] Tests: `tests/unit/test_p01_s15_claude_session.py`. `RealClaudeAgainstLocalApi` gets a resume case wherever the CLI is installed. All existing tests stay green.

## Evidence

(filled in when the story is done. Mocks and the local scripted API do not prove the real provider; the operator-machine verify run does)
