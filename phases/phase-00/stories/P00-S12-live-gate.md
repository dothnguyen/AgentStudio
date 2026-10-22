# P00-S12 — Real two-provider live gate

Status: Done (2026-10-22) — the live gate passed; P00's last exit condition (S10/S11 Done or Blocked with a recorded gap) is still open
Depends on: P00-S01 through P00-S07, and **any two** of P00-S08–S11 Done
Architecture: [P00 implementation contract](../architecture.md), sections B and H

## Goal

Prove the backend end to end with two distinct real providers, native tmux viewing from WSL and Windows Terminal, the Windows↔WSL boundary, truthful status, restart recovery, resolution, and scoped cleanup. This is the **only P00 release gate**. No Electron code before it passes. Recovery logic is implemented in S07; this story proves it against real providers.

## Implement in this order

1. Opt-in live smoke script with a uniquely named disposable git fixture workspace and session. Enumerate ready providers among `codex`, `claude`, `agy`, `opencode` (installed, authenticated, both policies mapped); select two **different** ones. Fewer than two → return a blocked gate listing exact missing capabilities; no fake or same-provider fallback.
2. WSL sequence: preflight → launch two-member team → verify exactly two panes → attach and watch → direct `read_only` task to one member → automatic workflow with Developer and Reviewer on different providers → detach/reattach → restart the coordinator during a controlled assignment → verify no duplicate provider execution → resolve any paused/reconciling assignment explicitly → scoped stop.
3. Windows sequence (PowerShell, `wsl.exe --exec agent-studio serve` only): `health`, `team.start`, `task.direct` with the hostile-text payload from S01, `snapshot`, `events.subscribe`; open the team in Windows Terminal via the returned attach command; kill the PowerShell caller and close all terminals past the idle timeout; reconnect and confirm the same run and status.
4. Re-run the fake-adapter repair-loop integration (fail → repair → pass; fail twice → failed). Do not depend on a model making a predictable mistake.
5. Run the S07 failure drills that need real providers: missing authentication, unsupported policy, provider killed mid-run, malformed/absent final event, timeout.
6. Save a redacted evidence bundle outside the repository by default: versions, provider IDs and policy mappings, idempotency keys, assignment IDs, event cursors, transitions, process identities and exits, terminal provider outcomes, base commit and diffs, validation output, tmux inventory before/after, Windows-side latencies, restart/stop results. Review for secrets before committing any fixture.

## Implementation

| Part | File | What it proves |
|---|---|---|
| WSL gate | `scripts/live/live_gate.py run` | PRD §8 points 1–8 against real providers, through the same `agent-studio` entry shim |
| Windows gate | `scripts/windows/live-gate-windows.ps1 -Phase Run`, then `-Phase Reconnect` | points 5 (Windows Terminal), 9 and 10, through `wsl.exe --exec agent-studio serve` only |
| Dry run | `tests/integration/test_s12_live_gate_dryrun.py` | the WSL gate's own logic, with stand-in `codex` / `claude` CLIs, isolated HOME, state and tmux |

WSL gate steps (each recorded PASS / FAIL / MANUAL / BLOCKED in `summary.json`):

1. `1a` health; coordinator started (restarted if it predates the current schema).
2. `1b` deep preflight of all four peers; picks the first two **different** providers whose authentication was proven
   by a real micro-task and that map both policies. Fewer than two → `BLOCKED` with each provider's reason; no fallback.
3. `1c` team of two (Developer on provider A, Reviewer on provider B) in a uniquely named fixture repo under
   `~/agent-studio-live/`; exactly two panes; tmux sessions on both servers before ⊂ after, exactly one new.
4. `2a` read_only direct task; identical retry (same idempotency key) returns the same assignment, no new one.
5. `2b` while the Developer writes, a second task to it → `AGENT_BUSY`; a second writer → `WORKSPACE_BUSY`.
6. `3` workflow (fix a seeded bug; validation = the fixture's unit tests): succeeded, both providers used, bug fixed;
   during it the operator is asked to attach / detach / reattach from WSL and Windows Terminal (`5`, MANUAL until
   confirmed).
7. `6` coordinator stopped and started while a slow task runs: the task ends terminal with exactly one
   "provider process started" and attempt 1; anything left `reconciling` is resolved explicitly (action `fail`).
8. `8` drills: missing authentication (real adapters probed with empty credential homes → `AUTH_REQUIRED` with the
   login command), missing provider (`PROVIDER_UNAVAILABLE`), unsupported policy (`BAD_REQUEST`, no unrestricted
   mode), timeout (`TIMEOUT`), provider process killed (`PROVIDER_CRASHED`, never succeeded), then the same agent
   succeeds again; malformed / missing final events come from the deterministic tests on captured real output.
9. `4` deterministic repair loop: `tests.integration.test_s06_workflow`.
10. `7` scoped stop: default tmux server, other Agent Studio sessions and `~/.ntm` identical to before; workspace kept.

The bundle `<state>/live-gate/<time>/` holds `summary.json` plus copies of every run and workflow directory;
secret-shaped strings are redacted (count printed). Review it before copying it into `phases/phase-00/evidence/s12/`.

Dry runs: the WSL gate passes every automated step with stand-ins (Linux VM and build container); the Windows script
passed both phases in the build container under PowerShell 7.4 with a `wsl.exe` stand-in (byte-exact hostile text
through `serve`, `task.show` and the provider prompt; same coordinator and team after reconnect). Found and fixed: a
one-sample latency list broke `Get-Percentile` under StrictMode.

## Evidence (operator machine, 2026-10-22)

WSL gate [`evidence/s12/20261022T010150Z/summary.json`](../evidence/s12/20261022T010150Z/summary.json):
**PASS, 11/11 steps**, Developer = Codex, Reviewer = Claude Code. Bundle reviewed: no secret-shaped strings.

| Step | Result |
|---|---|
| 1a–1c | coordinator up; both providers authenticated by real micro-tasks; 2 panes, existing tmux sessions untouched |
| 2a–2b | direct read_only task succeeded; identical retry returned the same assignment; `AGENT_BUSY`, `WORKSPACE_BUSY` |
| 3 | workflow `b1f62156…` succeeded: Codex fixed `calc.py` (diff 215 bytes, only `calc.py`), validation 2 tests OK, Claude verdict `pass` with findings |
| 5 | attach / detach / reattach from WSL and Windows Terminal confirmed by the operator |
| 6 | coordinator stopped while the task ran; after restart it succeeded with exactly one provider start, attempt 1 |
| 8 | `AUTH_REQUIRED` (both, with login command), `PROVIDER_UNAVAILABLE`, `BAD_REQUEST` (no unrestricted mode), `TIMEOUT`, `PROVIDER_CRASHED` after the provider was killed, then the agent succeeded again; malformed/missing final events: 71 deterministic tests OK |
| 4 | `test_s06_workflow`: review → repair → pass, and a second failure → failed |
| 7 | scoped stop: default tmux server, other Agent Studio sessions and `~/.ntm` unchanged; workspace kept |

Windows gate (Windows PowerShell 5.1.26100, keep-alive active)
[`live-gate-windows-evidence.json`](../evidence/s12/live-gate-windows-evidence.json) and
[`…-reconnect.json`](../evidence/s12/live-gate-windows-evidence-reconnect.json): all checks passed. Through
`serve` only: health, `team.start` (Codex + Claude), `task.direct` with all 13 hostile strings (656 characters)
→ `WINDOWS_OK`; the task text read back through `task.show` and the provider's prompt inside WSL had the same SHA-256
(`07e7007c…`); `events.after` returned the assignment's lifecycle. Latency p50: snapshot 4.9 ms, task.direct 24.6 ms,
health 258 ms, team.start 1.03 s. Reconnect from a new PowerShell 2 min 57 s later: same coordinator process
(pid 492614, same start time), team still running, task outcome unchanged, scoped stop succeeded and left the other
Agent Studio session in place. The gap is longer than WSL's default 60 s idle timeout, with the documented
keep-alive running; the longer unattended survival without any client was proven in S01.

## Operator run

Inside Ubuntu-24.04 (about 10–25 minutes; it pauses once to ask about attaching):

```bash
python3 /mnt/c/Works/Projects/AgentStudio/scripts/live/live_gate.py run --providers codex,claude
```

From Windows PowerShell in `scripts\windows` (a keep-alive must be running: `.\start-keepalive.ps1 -Distro Ubuntu-24.04`):

```powershell
.\live-gate-windows.ps1 -Distro Ubuntu-24.04 -Phase Run -OpenTerminal
# close every window and terminal, wait at least 5 minutes, open a new PowerShell:
.\live-gate-windows.ps1 -Distro Ubuntu-24.04 -Phase Reconnect
```

## Done when

- [x] All ten acceptance points in PRD §8 pass against real WSL/tmux/providers where specified.
- [x] One real workflow has two distinct installed/authenticated providers and an automatic handoff with recorded diff and validation.
- [x] Pane count matches the roster; detach/reattach (WSL and Windows Terminal) shows continuing activity.
- [x] Deterministic repair-loop tests prove exactly one retry and terminal second failure.
- [x] CLI disconnect, Windows caller exit, and coordinator restart preserve status without duplicate provider attempts.
- [x] Scoped stop leaves pre-existing tmux sessions, user workspaces, and `.ntm` data untouched.
- [ ] Adapters not used in the gate are Done or Blocked with a recorded gap (S10 agy and S11 opencode are still To Do; their placeholders refuse with `PROVIDER_UNAVAILABLE`); known unsupported modes and manual recovery steps are documented.

If a second provider is unavailable, S12 and P00 stay not Done. Report the blocker; do not start P01 UI implementation.
