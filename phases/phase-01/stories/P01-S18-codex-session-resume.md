# P01-S18 — Codex session resume: verify the permission mapping (follow-up)

Status: Dropped (2026-10-22): the kanban board (phases/briefs/feature-kanban-board.md) makes agents stateless per ticket, so session continuity is not needed.
Depends on: P01-S11 (P01-S12 for the end-to-end check)
Architecture: [P01 design contract](../README.md#h-session-continuity-e4), section H; `backend/agent_studio/providers/codex/CONTRACT.md`

Not part of the P01 exit. It may end Blocked with the exact capability gap; until it is Done, Codex agents report `SESSION_CONTINUATION_UNSUPPORTED` and run fresh.

## Goal

Decide, from the installed CLI, whether `codex exec resume` can run a resumed task under the **current** task's policy with the same guarantees as `codex exec`. If it can, enable `resume` for the Codex adapter. If it cannot, record why and keep it off.

## Implement in this order

1. Inspect `codex exec resume --help` (0.163.0 or newer). The brief notes no `--sandbox` and no `--cd`, but `-c key=value`, `--model`, `--json`, `--skip-git-repo-check`, `--ephemeral`, and `-` for the prompt on stdin.
2. Candidate mapping:
   - a persisted first task drops `--ephemeral`;
   - a resume runs `codex exec resume <id> -` with `-c sandbox_mode=read-only|workspace-write`, the same approval/config flags as today, the workspace as the process working directory, and the prompt on stdin.
   - Does resume fork, or append in place? Record which (this sets `forkOnResume`).
3. Real-CLI checks, written like S08's evidence:
   - a resumed run recalls a word;
   - a `workspace-write` session resumed `read-only` cannot write;
   - a resumed `workspace-write` run cannot write outside the working directory;
   - the model is unchanged;
   - an unknown ID gives recognisable output before any turn (`PROVIDER_SESSION_MISSING`).
4. Only if every check passes: `session_support()` true, the mapping and argv tests, and a `CONTRACT.md` update. Otherwise: the story is Blocked with the observations, and a test pins `resume: false`.

## Done when

- [ ] `provider verify --provider codex --sessions` passes on the operator machine with evidence in `phases/phase-01/evidence/s18/`, **or** the story is Blocked with the failing check recorded and Codex still refuses resume.
- [ ] If the adapter does not fork: a test proves that the coordinator ends the row after a resumed Codex task that did not succeed (`unsafe_after_failure`).
- [ ] Tests: `tests/unit/test_p01_s18_codex_session.py`. All existing tests stay green.

## Evidence

(filled in when the story is done)
