# P00-S01 — WSL boundary, entry shim, and coordinator daemon

Status: To Do
Depends on: none
Architecture: [P00 implementation contract](../architecture.md), sections A–C

## Goal

Prove the Windows↔WSL crossing that broke the previous Electron + NTM attempt **before** any real logic exists, and stand up a Python coordinator daemon reachable from separate CLI invocations and from PowerShell. No Electron, team, tmux session, or provider is built here.

## Implement in this order

1. **Entry shim** `backend/bin/agent-studio` (Bash). Resolve its own absolute path, establish the user's login environment (re-exec under `bash --login` with its fixed path, or source the profile), then `exec python3 -m agent_studio "$@"`. It never inspects or rewrites arguments. Provide an install step that links it to `~/.local/bin/agent-studio`.
2. **Python package** `backend/agent_studio/` with `cli.py`, `serve.py`, `protocol.py`, and a minimal `state.py` creating migration 1 (`schema_migrations`, `commands`). S02 extends the schema. Force UTF-8 on stdin/stdout regardless of locale.
3. **Coordinator daemon.** `coordinator.start` detaches (`setsid`, stdio to private logs), takes an `flock` single-instance lock, and writes PID + start time. A second start reports the existing coordinator. `coordinator.stop` stops only the recorded process identity.
4. **Command inbox transport.** Clients insert `commands` rows and wake the coordinator; the coordinator writes the response into the row; clients wait with a bounded timeout and return `PENDING` (retryable, same key) on timeout. Implement a test-build-only `debug.echo` mutating command that round-trips its payload through the inbox.
5. **health** (backend version, protocol version, coordinator PID/uptime, lock state, resolved PATH directories, distro name, keep-alive status) and **infrastructure preflight** (workspace canonicalized via `wslpath` when a Windows path is given, tmux path/version, writable WSL-native state directory, warning for `/mnt/*` workspaces). Provider preflight arrives in S04 and S08–S11.
6. **serve.** Line-delimited JSON over stdio with per-request `id`, per-line error handling, and clean exit on stdin EOF.
7. Stable errors: `BAD_REQUEST`, `UNSUPPORTED_PROTOCOL`, `WORKSPACE_NOT_FOUND`, `TMUX_NOT_FOUND`, `BACKEND_UNAVAILABLE`, `PENDING`, `IDEMPOTENCY_CONFLICT`. Human-readable remediation, no task text or secrets.
8. **Windows boundary spike** `scripts/windows/boundary-spike.ps1`. From PowerShell, using only `wsl.exe -d <distro> --exec <abs path> <literal subcommand>`:
   - one-shot `health`;
   - `serve` session sending 100 `debug.echo` requests whose payloads contain single/double quotes, `$VAR`, backticks, `%PATH%`, `;`, `&&`, newlines, tabs, emoji, CJK, and a Windows path with spaces; verify byte-exact round trip;
   - record one-shot latency and serve round-trip latency (median/p95);
   - kill the PowerShell process mid-session and verify the coordinator PID is unchanged.
9. **WSL lifetime check.** With the coordinator running, close all Windows terminals and `wsl.exe` clients, wait longer than the distro idle timeout, reconnect, and compare coordinator PID + start time. If the distro shut down, choose, implement, and document a keep-alive; `health` must report whether it is active. Record the WSL version and settings used.
10. Document exact WSL install, start, health, preflight, stop, and spike commands. No dependency on NTM, OrchestMux, or Electron.

## Tests to write

- Unit: malformed JSON, missing `id`/idempotency key, unknown command, unsupported protocol, oversized field, Unicode, serve continuing after a bad line.
- Integration: two separate CLI invocations reach the same coordinator; identical idempotent retry returns the original response; conflicting reuse rejected; `PENDING` on stalled coordinator then success on retry with the same key.
- Negative preflight: missing workspace, tmux hidden via controlled PATH, unwritable state path.
- Shim: provider-style executable installed only on the login PATH (e.g. under a profile-added directory) is found when invoked through `wsl.exe --exec`.
- Windows: the spike script, run from PowerShell, passes.

## Done when

- [ ] Separate CLI invocations and a PowerShell `serve` session reach the same coordinator.
- [ ] Hostile payloads round-trip byte-exact from PowerShell through `wsl.exe --exec`.
- [ ] Killing the Windows caller and closing all terminals past the idle timeout leaves the coordinator running (with documented keep-alive if needed).
- [ ] Login-PATH executables resolve through the shim.
- [ ] Preflight fails before creating any tmux session; stdout is pure JSON; diagnostics contain no credentials.
- [ ] Evidence records distro, WSL version, commands, coordinator PID, protocol version, latencies, and negative-case codes.

Do not begin UI wiring here.
