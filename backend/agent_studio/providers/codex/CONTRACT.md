# codex adapter contract note (P00-S08)

Verified against **codex-cli 0.163.0** (`codex --version`, `codex exec --help`, `codex login status`, and real
`codex exec --json` output). The adapter re-checks the installed CLI's `exec --help` for every flag below at probe
time and refuses with `CAPABILITY_GAP` if any is missing; it never guesses a flag.

| Item | Value |
|---|---|
| Tested version | codex-cli 0.163.0 |
| Executable resolution | `codex` on the **login-shell PATH** (envresolve), absolute path in argv[0]; no shell |
| Install check | `codex --version` must succeed (a broken node install is reported as such, not as a flag gap) |
| Flag check | `exec --help` must list `--json --sandbox --model --config --skip-git-repo-check --ephemeral --color --cd` |
| Login check (cheap probe) | `codex login status`: exit 0 = logged in ("Logged in using ChatGPT" / "...an API key"); "Not logged in", exit 1 → `AUTH_REQUIRED` |
| Authentication probe (`--deep`) | read-only micro-task in a temp dir: "Reply with exactly AGENT_STUDIO_OK"; cached 24 h per path+version in `provider-probes.json` |
| Common argv | `codex exec --json --color never --ephemeral --skip-git-repo-check --cd <workspace> … -` (prompt on **stdin** from the private `prompt.txt`) |
| `read_only` | `--sandbox workspace-write -c approval_policy="never" -c sandbox_workspace_write.network_access=false`: Codex's read-only sandbox forbids temp files, which tests need. The runner fingerprints the workspace (git HEAD, tracked diff, untracked files) before and after and fails the report with `READ_ONLY_VIOLATION` if it changed. Nothing is reverted automatically. |
| `workspace_write` | `--sandbox workspace-write -c approval_policy="never" -c sandbox_workspace_write.network_access=false` |
| Never used | `--dangerously-bypass-approvals-and-sandbox`, `danger-full-access`, `--full-auto`, `--yolo` (asserted in code and tests) |
| Model | `--model <name>`; name must match `^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$` (codex validates the model itself at run time) |
| Reasoning | `-c model_reasoning_effort="<level>"`, level ∈ `minimal low medium high xhigh` (the values codex 0.163.0 accepts; anything else is refused by Agent Studio because codex does not validate it) |
| Environment allowlist | base set + `CODEX_HOME OPENAI_API_KEY CODEX_API_KEY OPENAI_BASE_URL OPENAI_ORGANIZATION OPENAI_PROJECT` proxy vars, `SSL_CERT_FILE/DIR` |

## Output → normalized report

`exec --json` writes one JSON object per line:

| Event | Meaning for Agent Studio |
|---|---|
| `thread.started {thread_id}` | `providerSessionId` |
| `turn.started` | progress |
| `item.started/updated/completed {item}` | progress by `item.type`: `agent_message` (last one = final summary), `reasoning`, `command_execution` (`status: declined` → permission denial → `waiting_input`), `file_change` (failed → attention), `mcp_tool_call`, `web_search`, `todo_list`, `error` (attention only) |
| `turn.completed {usage}` | **terminal success**; usage recorded |
| `turn.failed {error}` | terminal failure → `failed / PROVIDER_ERROR` |
| top-level `error {message}` | **not terminal** — codex also uses it for "Reconnecting... n/5"; shown as attention |

Older `{"id":…,"msg":{…}}` output (`session_configured`, `agent_message`, `task_complete`, `error`) is also understood.
Reviewer stages read the verdict from the last JSON line of the final message (`{"verdict":"pass"|"fail","findings":[…]}`).

Without network, codex 0.163.0 keeps reconnecting and never exits on its own (captured in
`tests/fixtures/codex/captured-0.163.0-network-unreachable.jsonl`); the assignment deadline ends it → `failed / TIMEOUT`.

## Cancel / reconcile

Shared base behaviour: SIGTERM to the recorded process group (PID + start time + boot ID), `result.json` decides
after a restart; anything uncertain → `reconciling`. `--ephemeral` means codex keeps no session to resume.

## On-machine evidence

`agent-studio provider verify --provider codex [--model M] [--reasoning R]` runs, in disposable git repos:
deep probe → `read_only` reply → `workspace_write` creates a file → `read_only` write attempt leaves the tree
untouched → reviewer verdict parsed. Raw output is kept under `<state>/provider-verify/<time>-codex/`.
