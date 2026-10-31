# P00-S11 — OpenCode provider adapter

Status: Done (2026-10-31) — re-verified against opencode v2.2.5. `OPENCODE_CONFIG_CONTENT` provides the run-scoped permission mapping that v2.1.4 lacked, so `read_only` and `workspace_write` are supported and real runs succeed (see Evidence). The older v2.1.4 gap and its replacement mechanism are recorded in `providers/opencode/CONTRACT.md`.
Depends on: P00-S04 (contract), P00-S05 (real direct-task check)
Architecture: [P00 implementation contract](../architecture.md), section F

Follow the **shared adapter checklist** in the [stories README](./README.md). This story lists only what is specific to OpenCode. It may be marked Blocked with a recorded capability gap; any two Done adapters unblock S12.

## OpenCode-specific steps

1. Inspect installed `opencode` version/help via the entry shim; compare with the [OpenCode CLI documentation](https://opencode.ai/v2/docs/cli/commands/). Record exact flags and event shapes in `providers/opencode/CONTRACT.md`. Candidate: `opencode run` with JSON output.
2. Preflight distinguishes missing CLI, missing configured model/provider, and missing credentials.
3. Policy mapping: supply a run-scoped permission configuration for `read_only` and `workspace_write`; never rely on a permissive user default without showing and accepting it.
4. If there is no authoritative terminal event, document and test the equivalent (final response + exit + validation). Never infer completion from tmux idle.
5. Use server-backed mode only if required; record any server/session identity, and never stop a shared OpenCode server Agent Studio did not create.

## OpenCode-specific fixtures

Success, provider/model error, permission rejection, malformed event, missing final response, nonzero exit; ownership test for unrelated sessions/servers.

## Done when

- [x] Shared checklist complete for providerId `opencode` — the policy mapping is now implemented with `OPENCODE_CONFIG_CONTENT` (last-match `permissions` rules), and the probe refuses with `CAPABILITY_GAP` if the installed CLI does not honour it.
- [x] Cleanup never touches a non-owned OpenCode server or session — runs use `--standalone` (a private server that dies with the provider's process group); the shared background `opencode service` is never started, signalled, or stopped by Agent Studio.

## Evidence

- **Discovery (against the installed binary, 2026-10-31):** opencode v2.2.5 (ELF, `~/.opencode/bin/opencode`). `run --help` verified `--format json`, `--model provider/model#variant`, `--agent`, `--session`, `--standalone`, `--log-level`; `--auto` is the bypass analog and stays in `NEVER`. `auth list` shows the stored DeepSeek credential.
- **The v2.1.4 gap and its fix:** v2.1.4 ignored `OPENCODE_CONFIG` (and `XDG_CONFIG_HOME`) and had no `--config` flag, so both policies were refused. v2.2.5 honours `OPENCODE_CONFIG_CONTENT`; the adapter proves it with a canary rule through `opencode debug --standalone agents` (cached with the binary mtime). Every run also sets `OPENCODE_DISABLE_PROJECT_CONFIG=1`, so a workspace `opencode.json` cannot widen an agent's own permissions. Full reasoning and the v2 rule model: `providers/opencode/CONTRACT.md`.
- **Policies:** `read_only` denies `edit`, `shell`, `execute`, `webfetch`, `websearch`, `external_directory`, and `question`; `workspace_write` allows `edit`, denies `external_directory` and the network/question actions, and denies `shell` unless `.agent-studio/permissions.json` opts in (`{"version":1,"opencode":{"commands":true}}`; read-only stages then get the shared read-only command allowlist). The project file enables it for this team.
- **Implemented:** `providers/opencode/adapter.py` — probe (executable via PATH then installer fallback, version, flag check, config-injection canary, `auth list`, deep probe), prepare (`--standalone --format json --log-level none`, prompt via stdin, per-run permissions and optional board MCP config, `NEVER` refusal), parse (`step_start`, `text`, `tool_use`, `step_finish` with only `reason: stop` terminal, `error` → `AUTH_REQUIRED`/`USAGE_LIMIT`/`PROVIDER_ERROR`, permission denials → `waiting_input`; v2.1.4 shapes still parsed), capabilities (`resume`/`interactiveInput` unsupported).
- **Real runs (2026-10-31, `--model deepseek/deepseek-flash`):** read-only reply `AGENT_STUDIO_OK`; `workspace_write` created `made.txt`; a denied edit returned `Permission denied: edit`; the default free model returned `provider.free-limit` 429. Verbatim streams: `tests/fixtures/opencode/captured-2.2.5-*.jsonl`.
- **Tests:** `tests/unit/test_p00_s11_opencode.py` (30 tests: settings/rules, argv and env injection, opt-in commands, MCP config, all probe states incl. a stand-in without injection, the real CLI, every captured fixture, intermediate-step handling, malformed streams, backward-compatible v2.1.4 shapes).
- **Command log:** discovery with the real CLI → adapter + fixtures + tests → `python3 -m unittest tests.unit.test_p00_s11_opencode …` green → full unit suite.
