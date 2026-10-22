# Feature brief: keep each agent's context for the length of a workflow run

## Problem

Every task an agent receives starts a brand-new provider process (`claude -p ... --no-session-persistence`,
`codex exec ... --ephemeral`). The pane's worker stays up between tasks, but the provider remembers nothing, so each
task begins by re-reading the story, the code and the docs. Within one story that is slow, repeats token spend on
the same files, and makes later rounds worse: in a fix round the developer no longer remembers its own
implementation, and QA no longer remembers what it already reported.

## Goal

Within one **workflow run** (one story's cycle), each agent continues its own conversation from task to task instead of
starting cold. Between runs, and after a team restart, agents start fresh.

A "workflow run" here means the whole story cycle as the operator drives it today:
`team review` (lead) -> `team dev` (built-in workflow: dev -> tests -> QA -> one repair) -> `team fix` / `team qa`
rounds -> `team final` (lead) -> `team commit`. Each agent (lead, dev, QA) keeps its **own** session; agents never
share a conversation.

## Required behaviour

1. **Session scope = a session key.** Every task can carry an optional session key.
   - Stages of a built-in workflow use the workflow run ID automatically.
   - `task.direct` accepts an optional `sessionKey` (short text, validated like other IDs); `scripts/team/team.py`
     passes the story key, so `review`, `dev`, `fix`, `qa` and `final` for one story share a key. The workflow run
     inside `team dev` must use that same key (so `workflow.start` needs to accept an explicit `sessionKey` too).
   - No key = today's behaviour (fresh, nothing persisted).
2. **Per agent, per key.** The coordinator records `(agent, sessionKey) -> providerSessionId` from each finished
   task's result. The next task for that agent with the same key resumes that provider session. Different agents,
   or different keys, never resume each other's sessions.
3. **Freeze at assignment creation.** As with model/reasoning/role context today, the session to resume is decided
   and written into the request when the assignment is created; the runner only follows it.
4. **Permissions still per task.** A resumed session runs with the permission flags of the *current* task's policy
   (a read_only task on a session that earlier wrote files still cannot write). This must be proven with the real CLI,
   not assumed.
5. **Resume note.** A resumed task's prompt starts with a short note: this continues your earlier session; files may
   have changed since you read them, re-read anything you rely on. The full role/skill block is not repeated on a
   resumed task (it is already in the conversation) - only a one-line role reminder.
6. **Ending a session.** A key's sessions end when the operator commits the story (`team commit`), when the team is
   stopped or restarted, or on demand: `team reset <role|all> [STORY]` (and a matching backend command). Ended
   sessions are never resumed.
7. **Safe fallback.** If a resume fails because the provider no longer has the session (expired, deleted, other
   machine), the task is retried once as a fresh session, the result says so (warning + event), and the key is
   re-pointed to the new session. A resume never silently changes model, reasoning or policy.
8. **Failed or cancelled tasks.** Decide and document whether the next task resumes from a session whose last task
   failed, timed out or was cancelled mid-run (see open questions).
9. **Visibility.** `snapshot` / `task show` show, per agent, the active session key, the provider session ID, how
   many tasks it has carried, and its latest token usage. Add `team usage [STORY]` to `team.py`: input, cached and
   output tokens per agent per story, from the usage every result already records, so fresh vs resumed can be
   compared.

## Provider facts already checked (installed CLIs, 2026-10-22)

- **Claude Code 2.1.307:** `-r, --resume <session-id>` works with `--print`; sessions are only saved when
  `--no-session-persistence` is **not** passed, so a keyed task must drop that flag. `--fork-session` exists (new ID
  when resuming). Our policy flags (`--permission-mode`, `--tools`, `--allowedTools`, `--restricted`, ...) are
  per invocation. Not yet verified: that `--resume` honours a *narrower* `--tools` set than the session started
  with, and which `session_id` the resumed run reports.
- **Codex 0.163.0:** `codex exec resume [SESSION_ID] [PROMPT]` exists (`-` reads the prompt from stdin) but does
  **not** accept `--sandbox` or `--cd`; it accepts `-c key=value`, `--model`, `--json`, `--skip-git-repo-check`,
  `--ephemeral`. A resumed Codex task would need `-c sandbox_mode=...` and the process working directory instead -
  a different permission mapping that must be verified against the real CLI before it is used. Until then Codex
  agents keep today's fresh behaviour and report "session continuation unsupported".

## Constraints (from PRD / architecture)

- Same safety rules as everything else: no task text on a command line, no bypass flags, policy mapping verified
  against the installed CLI, adapters own all provider specifics (no provider branches in coordinator/workflow).
- Durable state in SQLite with events (new table + migration), and restart reconciliation must not resume a session
  for an attempt it is not sure about.
- Real-provider evidence for the Claude path (a `provider verify`-style check: resume works, a read_only resumed task
  cannot write, a missing session falls back to fresh).

## Out of scope

- One long-running provider process per agent (stream-json input): permission flags would be fixed for the process
  lifetime and crash recovery gets much harder.
- Sharing context between agents.
- Keeping context across stories or across team restarts.
- Codex resume, until its permission mapping is verified (record it as a gap or a follow-up story).

## Success measures

- In a story with at least one fix round, the developer's fix task resumes the session from `team dev` (same provider
  session ID recorded) and starts with fewer file reads than a fresh fix task.
- `team usage` shows input/cached/output tokens per agent for that story, for a fresh vs resumed comparison.
- A new story, `team reset`, `team commit` and `team stop`/`start` each give a fresh session (tested).
- No regression in the existing suite; deterministic tests with the stand-in CLIs; real Claude evidence.

## Open questions for the team lead

1. Where does this belong: a new phase (e.g. a backend-enhancements phase before the P01 desktop UI), or stories added
   to an existing phase? P00's exit is still open on S10/S11.
2. After a failed / timed-out / cancelled task: resume that session (it holds useful partial work) or start fresh?
3. Should QA keep its session across fix rounds (remembers its findings) or review each round fresh (unbiased)?
   Default proposal: keep, with `team reset qa STORY` available.
4. Should the built-in workflow's repair round resume the developer's session automatically (proposal: yes, same key)?
5. Cap on session size or task count before an automatic fresh start, given usage limits?
