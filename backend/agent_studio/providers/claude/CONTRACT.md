# claude adapter contract note (P00-S09)

Verified against **Claude Code 2.1.307** (`claude --version`, `claude --help`, `claude auth status`, and real
`claude -p --output-format stream-json` runs). The real CLI was run with the exact argv below against a local
scripted Messages API (`tests/fixtures/claude/fake_anthropic_api.py`), so its permission engine, tool set and
stream format are real; the captured streams are the test fixtures. The probe re-checks the installed CLI's help
for every flag and refuses with `CAPABILITY_GAP` if one is missing.

| Item | Value |
|---|---|
| Tested version | Claude Code 2.1.307 |
| Executable resolution | `claude` on the **login-shell PATH**, absolute argv[0]; no shell |
| Flag check | `--help` must list `--print --output-format --verbose --permission-mode --permission-prompts --tools --allowedTools --strict-mcp-config --restricted --no-session-persistence --model --effort` and the modes `dontAsk`, `acceptEdits` |
| Login check (cheap probe) | `claude auth status` (JSON): `loggedIn` true and exit 0, else `AUTH_REQUIRED` |
| Authentication probe (`--deep`) | read-only micro-task "Reply with exactly AGENT_STUDIO_OK", cached 24 h per path+version |
| Common argv | `claude --print --output-format stream-json --verbose --no-session-persistence --strict-mcp-config --permission-prompts none --restricted` (stream-json in print mode requires `--verbose`); prompt on **stdin**; the workspace is the **working directory** |
| `read_only` | `--permission-mode dontAsk --tools Read,Grep,Glob --allowedTools Read,Grep,Glob` |
| `workspace_write` | `--permission-mode acceptEdits --tools Read,Grep,Glob,Edit,Write,NotebookEdit --allowedTools Read,Grep,Glob` |
| Never used | `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, `bypassPermissions`, `auto` mode, the `Bash` tool, `--add-dir` (checked in code and tests) |
| Model | `--model <alias or full name>` (`opus`, `sonnet`, `fable`, `claude-…`); same name check as other adapters |
| Reasoning | `--effort <level>`, level ∈ `low medium high xhigh max` (the CLI's own list) |
| Environment allowlist | base set + `ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL ANTHROPIC_MODEL CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CONFIG_DIR CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX AWS_REGION AWS_PROFILE ANTHROPIC_VERTEX_PROJECT_ID CLOUD_ML_REGION`, proxies, CA bundles. A parent Claude Code session's variables (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, …) are dropped. |

What the flags do (observed with the real CLI):

- `--tools` is the hard tool list: a tool outside it does not exist for the session ("No such tool available").
- `--restricted` removes code-running tools, confines the file tools to the working directory (a write outside it is
  denied: "--restricted confines the file tools to the working directory"), refuses bypass mode, and ignores user /
  project / local **settings files** (so a workspace `.claude/settings.json` cannot widen permissions). `CLAUDE.md`
  is still read.
- `dontAsk` denies anything not pre-approved; `acceptEdits` approves file edits inside the working directory.
- `--permission-prompts none`: nothing ever waits for an answer; a would-be prompt is denied.
- `--strict-mcp-config` with no `--mcp-config`: no MCP servers, so no extra tools.

Consequence: `workspace_write` agents can edit files but cannot run commands (no Bash); validation runs separately
(S06). Allowing commands needs its own verified mapping later.

## Output → normalized report

| Line | Meaning |
|---|---|
| `system/init` | `providerSessionId`, model, permission mode (shown in the pane) |
| `system/api_retry` | attention (non-terminal) |
| `system/permission_denied` | attention; kept as a denial if no final `result` arrives |
| `assistant` | text → progress and last message; `tool_use` → "tool Write <path>" |
| `user` `tool_result` with `is_error` | attention |
| `result` | **terminal**. Success = `subtype: success` and `is_error: false`; `result` text is the summary; `permission_denials` (authoritative) → `waiting_input / PERMISSION_DENIED`; usage and cost recorded. `is_error: true` (e.g. `terminal_reason: api_error`, exit 1) → `failed / PROVIDER_ERROR`, or `AUTH_REQUIRED` for "Not logged in · Please run /login" |
| others (`active_goal`, `autocompact_state`, `system/status`, …) | ignored |

A denied permission therefore never becomes `succeeded`, whatever the exit code. No `result` line → `inconclusive`.
Reviewer verdicts come from the last JSON line of the `result` text.

## On-machine evidence

`agent-studio provider verify --provider claude [--model M] [--reasoning R]`.
