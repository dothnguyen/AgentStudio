# P00 implementation contract — WSL-native, provider-neutral team (rev 2)

This document fixes the seams that all P00 stories share. Implementers may change internal function names, but not the ownership, boundary, protocol, state, or acceptance rules without updating the PRD and dependent stories first. P00 is a proof of concept: prefer a small number of explicit components over a framework, and do not build features no story tests.

## A. Layout, languages, and process ownership

```text
backend/bin/agent-studio               # Bash entry shim: login env → exec python3 -m agent_studio "$@"
backend/bin/agent-studio-worker        # Bash worker shim: one per tmux pane
backend/agent_studio/cli.py            # one-shot commands, JSON on stdout
backend/agent_studio/serve.py          # persistent line-delimited JSON over stdio (Windows callers)
backend/agent_studio/coordinator.py    # daemon: inbox processing, scheduling, transitions
backend/agent_studio/state.py          # sqlite3 migrations and transactions
backend/agent_studio/protocol.py       # validation and serialization
backend/agent_studio/workflow.py       # built-in two-role workflow and truth table
backend/agent_studio/reconcile.py      # startup and on-demand reconciliation
backend/agent_studio/runner.py         # assignment runner started by the worker shim
backend/agent_studio/providers/{codex,claude,agy,opencode}/
backend/agent_studio/providers/fake/   # deterministic tests only; never an operator choice
scripts/windows/boundary-spike.ps1     # P00 Windows-side boundary proof
tests/{unit,integration,live,windows}/
```

**Languages.** Python 3 standard library for all logic. Bash only for the two shims, which never handle user text: the entry shim passes its argv through `"$@"` unchanged and the worker shim receives only validated IDs.

**Processes.**
- *Coordinator* — one detached daemon per WSL user (`setsid`, stdio redirected to private log files, `flock` single-instance lock in the state directory). Only writer of materialized state and events. Never a child of a CLI, `serve`, `wsl.exe`, or UI process.
- *CLI / serve* — short-lived or persistent clients. Write only to the command inbox; read snapshots and events read-only.
- *Worker shim* — long-lived loop in each tmux pane. Waits for a request file in its agent's private inbox directory, starts the runner in the foreground of the pane, returns to idle. Makes no state decisions.
- *Runner* — runs one assignment through its adapter, prints readable progress to the pane, writes raw evidence files, and inserts immutable report rows. Because it is a child of the pane, not of the coordinator, it keeps running across coordinator restarts; its reports wait in the inbox.

**State location.** `$XDG_STATE_HOME/agent-studio` if set, else `$HOME/.local/state/agent-studio`, on WSL's native filesystem. Never under `/mnt/*`, in the selected workspace, or in `.ntm`. Directories `0700`, files `0600`. Store only run-scoped identifiers and local paths; never auth tokens or environment secrets. Workspaces under `/mnt/c` are allowed but preflight warns about performance and line-ending risk.

## B. Windows↔WSL boundary contract

The previous Electron + NTM attempt failed at this boundary. These rules are non-negotiable for P00 and P01:

1. Windows invokes exactly `wsl.exe -d <distro> --exec <absolute path to agent-studio> <fixed subcommand>`. `--exec` bypasses shell parsing. The subcommand is a literal from an allowlist (`health`, `serve`, …).
2. No task text, user text, workspace path, or provider argument appears on a Windows-side command line. All of it travels as UTF-8 JSON over stdin; responses come back as UTF-8 JSON on stdout; diagnostics on stderr. Windows callers must not depend on `wsl.exe`'s own (possibly UTF-16) messages for anything but launch failure. Responses are emitted as 7-bit ASCII JSON (non-ASCII characters as `\u` escapes) so no console code page can alter them; requests may be any UTF-8, and a leading or trailing UTF-8 BOM is tolerated.
3. The user's login environment is established before any provider or tmux is launched, so CLIs installed via nvm, pipx, or `~/.local/bin` resolve as they do in the user's terminal. The entry shim itself only locates Python (absolute paths, no PATH dependence) and execs it. Long-lived processes (coordinator; later workers) capture the environment once by running the user's shell as a login + interactive shell with a fixed script that prints `env -0` after a marker (`AGENT_STUDIO_ENV_MODE=login-interactive|login|inherit`). Interactive mode is needed because Ubuntu's `~/.bashrc`, where nvm adds itself, returns early for non-interactive shells. `health` reports the resolved PATH directories (Linux dirs listed, Windows interop dirs counted).
4. Windows paths supplied by a Windows caller are sent as JSON data and translated inside WSL (`wslpath`), then canonicalized and validated.
5. Terminal viewing is the only other crossing: `wsl.exe -d <distro> --exec tmux attach-session -t <session id>` where the session ID was returned and validated by the backend.
6. Losing the Windows caller loses nothing: the coordinator and tmux are not its descendants. WSL distro idle shutdown is tested in S01; the keep-alive used (if any is needed) is documented and checked by `health`.

## C. Commands and transport (protocol v1)

**Transport.** A client inserts a row into the `commands` table (idempotency key, command, validated args, payload hash, status `pending`) and wakes the coordinator (signal or FIFO; polling at ≤250 ms is an acceptable fallback). The coordinator processes inbox rows in order inside transactions and writes the response into the same row. The client waits up to a bounded timeout for the response; on timeout it returns `{ok:false, code:"PENDING", retryable:true, idempotencyKey}` so a retry with the same key is safe. Read commands (`health`, `snapshot`, `events`) query the DB read-only and do not go through the inbox, except that `health` also checks the coordinator lock/PID.

**One-shot CLI.** `agent-studio <command> [--json-args <file|->]` emits exactly one UTF-8 JSON response on stdout.

**serve.** One JSON object per line in each direction. Requests carry an `id` that the matching response echoes; `events.subscribe` makes `serve` push event lines tagged with `seq`. A malformed line gets a `BAD_REQUEST` response with `id:null` and the connection stays open. Field lengths (task text, findings) are validated per field.

```json
{"protocol":"agent-studio/v1","id":"7","command":"task.direct","idempotencyKey":"uuid","args":{"teamId":"uuid","agentId":"uuid","taskText":"…","policy":"read_only"}}
{"protocol":"agent-studio/v1","id":"7","ok":true,"data":{"receipt":"accepted","taskId":"uuid","assignmentId":"uuid"}}
{"protocol":"agent-studio/v1","event":{"seq":43,"name":"assignment.started","teamId":"uuid","agentId":"uuid","assignmentId":"uuid","data":{}}}
```

**Commands.** `health`, `preflight`, `coordinator.start`, `coordinator.stop`, `snapshot` (`teamId?`, `includeStopped?`), `events.after` (`cursor`, `limit` ≤ 1000, `teamId?`, `dbId?`), `team.start`, `team.attach`, `team.stop`, `task.direct`, `workflow.start`, `snapshot`, `events.after`, `events.subscribe` (serve only), `assignment.cancel`, `assignment.resolve`. Debug coordinators (`--enable-debug`) also accept `debug.echo` and `debug.fixture`; these are for tests and the boundary spike only. Mutating commands require an idempotency key: same key + identical payload returns the original receipt; same key + different payload returns `IDEMPOTENCY_CONFLICT`. Responses are `ok` with typed `data`, or `{code,message,retryable}`. Receipts distinguish `accepted`, `assigned`, and `started`; never generic success for queued work. `team.attach` is interactive in a TTY and otherwise returns the exact WSL and Windows Terminal attach commands.

`assignment.resolve` takes `assignmentId` and `action ∈ {retry, fail, cancel}`. It is the only way out of `waiting_input` and `reconciling`. `retry` creates a new attempt (new assignment ID, same stage) and may carry an explicitly different policy that the operator chose; it never reruns an attempt that may still be running.

Rejected everywhere: arbitrary shell commands, paths outside the canonical workspace for worker execution, unknown provider IDs, unsanitized tmux targets, and the fake provider outside test builds.

## D. Database and state machine

Tables: `schema_migrations`; `teams`; `agents`; `tasks`; `workflow_runs`; `stage_attempts`; `assignments`; `commands` (inbox + idempotency); `worker_reports` (immutable inbox); `events` (INTEGER PRIMARY KEY sequence, UTC timestamp, actor, entity IDs, name, JSON payload). Foreign keys on, explicit transactions, busy timeout, WAL (WSL-local only), versioned migrations.

**Identifiers.** All entity IDs are lowercase UUID v4. The team ID doubles as the run ID: one team row per launched team. A `meta` row holds a random `db_id`; `snapshot` and `events.after` return it, and a client that passes a `dbId` from another database (or a cursor past the head) gets `CURSOR_INVALID` and must take a new snapshot.

**Write authority** is enforced by SQLite, not convention. Every connection is opened with a role; non-coordinator roles get an authorizer callback that denies other writes, DDL, ATTACH, and pragma changes.

| Role | May write | Used by |
|---|---|---|
| `coordinator` | everything, migrations | coordinator daemon only |
| `client` | `INSERT INTO commands` | CLI / serve mutating commands |
| `runner` | `INSERT INTO worker_reports` | assignment runner (S04) |
| `reader` | nothing (`mode=ro`, `query_only`) | `snapshot`, `events.after` |

`events`, `worker_reports`, and `report_applications` are append-only (triggers abort UPDATE/DELETE). Reports are unique on `assignment_id` + `report_seq`; an identical resubmission is a no-op and a different one is `REPORT_CONFLICT`. The coordinator applies each report exactly once, recording the outcome in `report_applications` (a handler rejection such as `INVALID_TRANSITION` is recorded as `rejected:<code>` without changing state).

**Atomicity.** Every row change writes exactly one event in the same transaction (`store.Tx`). A command's state changes, events, and stored response commit in **one** transaction, so a crash can never leave a change without its receipt (which would replay it on restart) or a receipt without its change. Events record the actor (`operator` for commands, `runner` for applied reports, `coordinator` for its own decisions) plus `command_seq` / `report_id` for traceability.

| Object | States and essential transitions |
|---|---|
| Agent | `starting → idle → busy → idle`; `busy → waiting_input`; any nonterminal → `offline`/`error` on verified loss. |
| Assignment | `queued → claimed → running → succeeded/failed/cancelled`; `running → waiting_input`; uncertain after restart → `reconciling`. `waiting_input`/`reconciling` leave only via `assignment.resolve` or proven evidence. |
| Task | `queued → assigned → running → review → succeeded/failed/cancelled`; direct tasks may skip review. |
| Workflow run | `queued → running → paused → running`; `→ succeeded/failed/cancelled`. Current stage and retry count are separate fields. |

**Claiming.** The coordinator, not the worker, moves an assignment to `claimed` and then writes a request file (`0600`) into that agent's private inbox directory. `running` is committed only after the runner reports process identity and start evidence.

**Process identity** = PID + process start time (from `/proc/<pid>/stat`) + boot ID. A PID alone is never identity.

**Concurrency.** At most one assignment with `workspace_write` per workspace. `read_only` assignments may run concurrently on other idle agents. Direct dispatch to a busy agent → `AGENT_BUSY`; a mutating request while the workspace has an active mutating assignment or workflow → `WORKSPACE_BUSY`. No silent queueing.

Agent availability is not a task state. A live process or pane does not prove an assignment is running; an idle pane does not prove success; exit code zero alone does not prove the work passed validation. Store provider-declared outcome and independently checked evidence separately.

## E. tmux and terminal rules

All Agent Studio sessions live on a **dedicated tmux server**, `tmux -L agent-studio` (override with `AGENT_STUDIO_TMUX_SOCKET`), so the user's own tmux server is never touched and `kill-server` is never needed. Each team gets a unique run-scoped tmux session (`as-<first 16 hex of teamId>`) with **one window and exactly N panes for N agents**: create the first pane, split once per additional agent, select `tiled`. No operator pane. Record session ID, window ID, pane ID, pane PID + start time, agent ID, and a run ownership marker (tmux user option). Every later action rechecks marker and pane identity; never use pane index alone. Stop only verified owned sessions; if identity is ambiguous return `CLEANUP_INCOMPLETE` and preserve the session. Never `tmux kill-server`.

Panes keep `remain-on-exit on` so a dead worker stays visible, and show a title bar with name, provider and role.

**Delivery lifecycle.** The coordinator claims a queued assignment for an idle agent with a live pane (one at a time per agent), commits, and only then writes `agents/<agentId>/inbox/<assignmentId>.request` (`0600`). The worker shim moves it to `active/` **before** running it and to `done/` afterwards, so a restarted worker never re-runs a request. A claimed assignment whose request file is in none of the three folders was never seen by a worker and is safely rewritten (redelivery). The runner's `start` report (PID + start time + boot ID) is the only path from `claimed` to `running`.

**Liveness.** Every ~2 s the coordinator compares each live agent's recorded pane ID and pane-process identity with the server's pane list. A missing pane, an exited pane process, or a changed identity marks the agent `offline` (`agent.pane_dead` with a reason) and its in-flight assignment `reconciling`; a lost session marks the team `error`. Pane state never changes a task outcome.

**Stop.** `team.stop` verifies the session's `@agent_studio_team` and `@agent_studio_owner` options and that it contains only panes Agent Studio created, then kills only that session (by `$id`), cancels the team's active assignments and tasks, and marks agents `offline`. Any mismatch records `team.error` and returns `CLEANUP_INCOMPLETE` with the session preserved. The response includes the session inventory before and after.

Never use `tmux send-keys` to deliver a task. Panes show readable worker/runner progress only. Operators watch via `team.attach` or the returned attach command (WSL shell or Windows Terminal). No pane-output stream, xterm.js, or terminal-byte protocol in P00/P01. Terminal data is never parsed for task/question/result records.

## F. Provider adapter contract

Provider IDs: `codex`, `claude`, `agy`, `opencode` (peers), `fake` (test builds only). Role and stage never imply a provider.

**Permission vocabulary.**

| Policy | Meaning | Adapter obligation |
|---|---|---|
| `read_only` | May read the workspace and run read-only tools; no file writes, no network beyond the provider's own API. | Map to a verified read-only/plan/sandboxed mode, or refuse. |
| `workspace_write` | May edit files inside the canonical workspace; no writes outside it; no unrestricted shell or network. | Map to a verified scoped mode (e.g. workspace sandbox, allowlisted tools), or refuse. |

There is no unrestricted policy in P00. Each adapter records the exact provider flags/config it uses per policy in its contract note, and preflight shows that mapping.

**Operations.**
1. `probe` — executable path, version, capabilities, per-policy support, and authentication proven by a disposable read-only micro-task (never by `--version`).
2. `prepare` — validate workspace/model/policy; return argv array, environment allowlist, and private prompt file/stdin. Never a shell string containing task text. Refuse unsupported combinations.
3. `start` — bounded attempt; capture PID + start time, stdout/stderr to private files with byte limits, provider session ID if available, elapsed time.
4. `parse` — normalize progress, attention/permission denial, final answer, terminal provider outcome, usage. Never parse the tmux screen.
5. `cancel` — signal only the recorded process identity; distinguish requested cancellation from crash.
6. `reconcile` — after restart, decide from process identity and durable output whether the attempt is running, terminal, or uncertain. Never auto-dispatch an uncertain attempt.

**Normalized report.**

```json
{"protocol":"agent-studio/assignment/v1","assignmentId":"uuid","agentId":"uuid","providerId":"agy","attempt":1,"policy":"workspace_write","status":"succeeded","providerSessionId":"optional","exitCode":0,"summary":"...","artifacts":[],"attention":null,"evidence":{"outputPath":"private/path","providerTerminalEvent":true,"validation":[]}}
```

`status ∈ {succeeded, failed, cancelled, waiting_input, inconclusive}`. Success requires a valid final report, matching IDs, a compatible terminal provider outcome, acceptable exit status, and no unresolved required permission denial. Missing or contradictory evidence is `inconclusive` or `failed`. Headless permission prompts or soft denials normalize to `waiting_input` (blocked by policy) or `failed` with a reason; P00 does not implement interactive reply.

Starting points—**verify against installed `--help`/version in each adapter story; links may be stale**:

| Provider | Candidate noninteractive surface | Source |
|---|---|---|
| Codex | `codex exec` with JSON events; sandbox modes | [OpenAI](https://developers.openai.com/blog/codex-as-a-platform) |
| Claude Code | `claude -p --output-format stream-json`; permission mode / allowed tools | [Anthropic](https://docs.anthropic.com/en/docs/claude-code/cli-usage) |
| Antigravity CLI | headless mode with stream-json; check terminal `result.status`, not exit code | [Antigravity](https://www.agy.dev/docs/cli/headless/) |
| OpenCode | `opencode run --format json`; verify terminal-event semantics | [OpenCode](https://opencode.ai/v2/docs/cli/commands/) |

## G. Workflow and deterministic testing

Built-in workflow: `developer → reviewer → (repair budget 1) developer_repair → reviewer_recheck → final`.

- `workflow.start` requires a git workspace with a clean tree (or explicit acknowledgment for fixtures). The coordinator records `baseCommit`.
- After each Developer stage: capture `git diff <baseCommit>` (bounded; plus list of untracked files) as a stage artifact, then run the configured validation command; record exit code and bounded output.
- Reviewer runs `read_only` with the task, diff, and validation output as data files; returns `{verdict: pass|fail, findings: [...]}`.
- Decisions follow the truth table in PRD §6. `paused` workflows wait for `assignment.resolve`.
- Repair prompt = fixed template + task + current diff + reviewer findings + validation output. Agents are stateless; provider session resume is optional and never required for correctness.

Automated tests use the fake adapter to force `review fail → repair → pass` and `review fail twice → failed`. The real smoke uses two different authenticated providers and does not rely on an LLM making a particular mistake.

## H. Recovery and quality gate

Coordinator startup: acquire lock → migrate → read unfinished commands and assignments → enumerate only owned tmux sessions → verify pane/process identity (PID + start time + boot ID) → apply pending reports → reconcile provider output → append an event for every decision. Uncertain → `reconciling` with a diagnostic; operator uses `assignment.resolve`. Never retry because a client response was missed; clients re-read snapshot/events by cursor.

P00 acceptance requires focused unit tests, deterministic integration tests, the Windows boundary spike, and one recorded live run with **two distinct real providers** on WSL. Fewer than two ready providers → gate blocked with missing capabilities listed. Mocks and screenshots never mark a story Done.
