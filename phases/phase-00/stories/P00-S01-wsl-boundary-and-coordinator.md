# P00-S01 — WSL boundary, entry shim, and coordinator daemon

Status: In Progress — Linux-side implementation and tests complete; Windows checks (steps 8–9) pending on the target machine
Depends on: none
Architecture: [P00 implementation contract](../architecture.md), sections A–C

## Goal

Prove the Windows↔WSL crossing that broke the previous Electron + NTM attempt **before** any real logic exists, and stand up a Python coordinator daemon reachable from separate CLI invocations and from PowerShell. No Electron, team, tmux session, or provider is built here.

## Implement in this order

1. **Entry shim** `backend/bin/agent-studio` (Bash). Resolve its own absolute path without depending on PATH, locate Python by absolute path, then exec `backend/launch.py` with argv unchanged. It never inspects or rewrites arguments. Login-environment capture happens in Python for long-lived processes (architecture B.3). Provide an install step that links it to `~/.local/bin/agent-studio`.
2. **Python package** `backend/agent_studio/` with `cli.py`, `serve.py`, `protocol.py`, and a minimal `state.py` creating migration 1 (`schema_migrations`, `commands`). S02 extends the schema. Force UTF-8 on stdin/stdout regardless of locale.
3. **Coordinator daemon.** `coordinator.start` detaches (`setsid`, stdio to private logs), takes an `flock` single-instance lock, and writes PID + start time. A second start reports the existing coordinator. `coordinator.stop` stops only the recorded process identity.
4. **Command inbox transport.** Clients insert `commands` rows and wake the coordinator; the coordinator writes the response into the row; clients wait with a bounded timeout and return `PENDING` (retryable, same key) on timeout. Implement a test-build-only `debug.echo` mutating command that round-trips its payload through the inbox.
5. **health** (backend version, protocol version, coordinator PID/uptime, lock state, resolved PATH directories, distro name, keep-alive status) and **infrastructure preflight** (workspace canonicalized via `wslpath` when a Windows path is given, tmux path/version, writable WSL-native state directory, warning for `/mnt/*` workspaces). Provider preflight arrives in S04 and S08–S11.
6. **serve.** Line-delimited JSON over stdio with per-request `id`, per-line error handling, and clean exit on stdin EOF.
7. Stable errors: `BAD_REQUEST`, `UNSUPPORTED_PROTOCOL`, `UNKNOWN_COMMAND`, `WORKSPACE_NOT_FOUND`, `TMUX_NOT_FOUND`, `STATE_DIR_UNUSABLE`, `BACKEND_UNAVAILABLE`, `PENDING`, `IDEMPOTENCY_CONFLICT`, `UNSUPPORTED_SCHEMA`, `DEBUG_DISABLED`, `INTERNAL`. Human-readable remediation, no task text or secrets.
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

- [x] Separate CLI invocations reach the same coordinator (Linux, automated).
- [ ] A PowerShell `serve` session on Windows reaches the same coordinator — run `boundary-spike.ps1`.
- [ ] Hostile payloads round-trip byte-exact from PowerShell through the real `wsl.exe --exec` — run `boundary-spike.ps1` (passed in PowerShell 7 against a stand-in `wsl.exe`; real `wsl.exe` and Windows PowerShell 5.1 still required).
- [ ] Killing the Windows caller leaves the coordinator running — run `boundary-spike.ps1` (passed for a killed client process on Linux).
- [ ] Closing all terminals past the idle timeout leaves the coordinator running, with a documented keep-alive if needed — run `check-lifetime.ps1`.
- [x] Login-PATH executables (nvm-style, interactive-only `.bashrc`) resolve (automated).
- [x] Preflight fails before creating any tmux session; stdout is pure JSON; logs contain no payloads (automated).
- [ ] Evidence records distro, WSL version, commands, coordinator PID, protocol version, latencies, and negative-case codes — attach `boundary-spike-evidence.json` and `lifetime-evidence.json`.

## Evidence so far (2026-10-21)

- `python3 -m unittest discover -s tests -t .` → 49 tests OK on Ubuntu 22.04 / Python 3.10.12 (non-root) and OK on Python 3.13 (root; the permission test is skipped).
- `boundary-spike.ps1` under PowerShell 7.4.6 on Linux, with a stand-in `wsl.exe` that forwards `-d <distro> --exec …`: one-shot 13/13 and serve 100/100 hostile payloads byte-exact; malformed line → `BAD_REQUEST` with the session kept open; coordinator PID unchanged after the client was killed. Serve round-trip median ≈10 ms; one-shot median ≈110 ms (no `wsl.exe` start-up cost included).
- Found and fixed during testing: the shim depended on PATH for `readlink`/`dirname`, so a `wsl.exe --exec` call with a stripped PATH would fail before Python started.
- Not yet run: the real `wsl.exe`, Windows PowerShell 5.1, Windows Terminal, and WSL idle shutdown. These need the target Windows machine.

Do not begin UI wiring here.
