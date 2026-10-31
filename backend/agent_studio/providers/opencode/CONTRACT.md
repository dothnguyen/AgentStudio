# opencode adapter contract note (P00-S11)

Status: **implemented and verified for runs** against the installed CLI, opencode **v2.2.5**. Both policies are
mapped with a per-process `OPENCODE_CONFIG_CONTENT` permissions list; the workspace's own project configuration is
disabled for the run. Nothing below is guessed: every flag and config behaviour was checked against the real binary.

| Item | Value |
|---|---|
| Tested version | `opencode v2.2.5` (`opencode --version`) |
| Executable resolution | login `PATH` first, then the installer default `~/.opencode/bin/opencode` |
| `run` flags used | `run --standalone --format json --log-level none [--model provider/model]` (all verified in `opencode run --help`) |
| Prompt channel | stdin (private prompt file); `run`'s message argument is never used, so no user text reaches a command line |
| Authentication probe | `opencode auth list` → one `… stored` line per credential |
| Deep probe | read-only micro-task "Reply with exactly AGENT_STUDIO_OK", cached 24 h per path+version |
| Permission injection | `OPENCODE_CONFIG_CONTENT` (a JSON document merged by the config loader), verified with a canary rule through `opencode debug --standalone agents`; `OPENCODE_DISABLE_PROJECT_CONFIG=1` ignores the workspace's `opencode.json` |
| `read_only` rules | deny `edit`, `shell`, `execute`, `webfetch`, `websearch`, `external_directory`, and `question` |
| `workspace_write` rules | allow `edit`, deny `external_directory`, `webfetch`, `websearch`, and `question`; `shell` denied unless the workspace opts in |
| Opt-in commands | `.agent-studio/permissions.json` `{"version": 1, "opencode": {"commands": true}}` → allow all `shell` commands for `workspace_write`; for `read_only` only the read-only command allowlist (`READ_COMMANDS`) |
| Never used | `--auto` (auto-approves permissions: the bypass analog), `--continue` / `-c`, `--session` |
| Output format | `run --format json`: newline-delimited JSON events on stdout |
| Terminal event | `step_finish` with `part.reason == "stop"`. A `step_finish` with `reason: "tool-calls"` is an intermediate step, not the end. A provider `error` event is the only failure signal — **the CLI can exit 0 on a provider error** |
| Session identity | `sessionID` on every event, `ses_…`; sessions are never resumed by Agent Studio (`resume: unsupported`) |
| Cancel / reconcile | by recorded PID + start time like the other adapters; the run's `--standalone` server is a child of the provider process group and dies with it. Agent Studio never touches the shared background `opencode service` |
| MCP | the Agent Studio board server is added under `mcp.servers.agent-studio` (`type: local`, `codemode: false`) for assignments that enable it, with the per-assignment identity in `environment` |

## Captured events (real, v2.2.5)

Success (`tests/fixtures/opencode/captured-2.2.5-success.jsonl`):

```json
{"type":"step_start","timestamp":1793451566652,"sessionID":"ses_…","part":{"type":"step-start",…}}
{"type":"text","timestamp":1793451566673,"sessionID":"ses_…","part":{"type":"text","text":"AGENT_STUDIO_OK",…}}
{"type":"step_finish","timestamp":1793451566673,"sessionID":"ses_…","part":{"type":"step-finish","reason":"stop",
 "cost":0.000434904,"tokens":{"input":2792,"output":7,"reasoning":0,"cache":{"read":3968,"write":0}}}}
```

Tool use (`captured-2.2.5-write-success.jsonl`) carries `part.type: "tool"`, `part.tool`, and a `part.state` object
with `status` (`completed` / `error`), `input`, `output` or `error`. A policy block is a state with
`"status": "error"` and `"error": "Permission denied: edit"` (`captured-2.2.5-permission-denied.jsonl`), which the
adapter records as a denial (`waiting_input / PERMISSION_DENIED`). Multiple steps mean multiple `step_finish`
events; only the final `stop` is terminal.

Provider errors (`captured-2.1.4-provider-auth-403.jsonl`, `captured-2.2.5-free-limit.jsonl`) are terminal even
when the CLI exits 0: `provider.auth` → `AUTH_REQUIRED`; a `*limit*` type, status 429, or limit wording →
`USAGE_LIMIT` with `retryAfterMs` / reset hints normalised to `limitResetAt`; anything else → `PROVIDER_ERROR`.

The older v2.1.4 shapes (`{"type":"part","part":{…}}`, `state` as a status string) are still parsed, so old
fixtures and streams keep working.

## Permissions design

v2 evaluates an ordered rule list and the **last matching rule wins**. The default base policy starts with
`{"action": "*", "resource": "*", "effect": "allow"}`, so Agent Studio appends its rules after it:

- `read_only` denies every mutating or networked action. `edit`, `shell`, and `execute` are denied; `external_directory`
  keeps reads and tool paths inside the workspace; `question` is denied because headless runs cannot answer.
- `workspace_write` allows edits (resources for files inside the workspace are relative, so `*` covers them) and keeps
  `external_directory` denied, so an edit cannot escape the workspace. Shell is denied unless the workspace opts in.
- `OPENCODE_DISABLE_PROJECT_CONFIG=1` is set on every run. Without it a `workspace_write` agent could edit the
  workspace's `opencode.json` and widen its own rules.

The config-injection check is part of `probe`, not a version guess: the adapter runs
`opencode debug --standalone agents` with a canary rule and reports `CAPABILITY_GAP` when the rule is absent. This
keeps the old v2.1.4 behaviour (no injection → refuse both policies) without hard-coding versions.

## On-machine evidence

- `tests/unit/test_p00_s11_opencode.py` (30 tests) covers settings, rules, argv, opt-in commands, MCP config,
  all probe states (including a stand-in without config injection), the real installed CLI, and every captured
  fixture.
- Real runs on 2026-10-31 with `--model deepseek/deepseek-flash`: read-only reply succeeded; a `workspace_write` run
  created `made.txt`; a denied edit produced `Permission denied: edit`; a default free model returned
  `provider.free-limit` 429. Those streams are the fixtures above.
- `agent-studio provider verify --provider opencode [--model M]` runs the four shared checks (read-only reply,
  workspace write, read-only write block, reviewer verdict) through the same adapter and runner.
