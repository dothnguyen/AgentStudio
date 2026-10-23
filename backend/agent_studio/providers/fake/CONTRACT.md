# fake adapter contract note (test-only)

The fake provider is a real child process (`fake_cli.py`) driven through the same runner, report inbox, and
coordinator path as the real CLIs. Only debug coordinators (`--enable-debug`) accept it.

| Item | Value |
|---|---|
| Version | `fake 1.0 (test-only)` |
| Executable | `python3 -I providers/fake/fake_cli.py` (absolute paths) |
| Prompt | stdin from the private prompt file; never on the command line |
| `read_only` | `--sandbox read-only` (a write attempt becomes a `tool_denied` event) |
| `workspace_write` | `--sandbox workspace-write` |
| Output | JSON lines: `init`, `progress`, `file_written`, `tool_denied`, `input_required`, `result` |
| Terminal event | `{"type":"result","status":"success"|"error",...}`, optional `verdict` |
| Narrowing for tests | `AGENT_STUDIO_FAKE_POLICIES=read_only` makes `workspace_write` unsupported |

Scenario → normalized outcome (asserted by `tests/fixtures/contract/*.json`):

| Scenario | status | diagnosticCode |
|---|---|---|
| success, slow, flood, verdict_pass, verdict_fail | succeeded | — |
| provider_failure | failed | PROVIDER_ERROR |
| usage_limit | failed | USAGE_LIMIT (`limitResetAt` `2030-01-01T15:00:00Z`) |
| usage_limit_no_reset | failed | USAGE_LIMIT (no reset time) |
| permission_denied (exit 0, result "success") | waiting_input | PERMISSION_DENIED |
| malformed_final | inconclusive | MALFORMED_OUTPUT |
| no_final (exit 0) | inconclusive | NO_TERMINAL_EVENT |
| crash (SIGKILL) | failed | PROVIDER_CRASHED |
| waiting_input | waiting_input | INPUT_REQUIRED |
| timeout (deadline reached) | failed | TIMEOUT |
| any, cancelled by signal to the runner | cancelled | CANCELLED |
| nonzero_success (result "success", exit 3) | inconclusive | CONTRADICTORY_EVIDENCE |
| verdict_malformed | inconclusive | MALFORMED_VERDICT |
