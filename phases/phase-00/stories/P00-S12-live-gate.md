# P00-S12 — Real two-provider live gate

Status: To Do
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

## Done when

- [ ] All ten acceptance points in PRD §8 pass against real WSL/tmux/providers where specified.
- [ ] One real workflow has two distinct installed/authenticated providers and an automatic handoff with recorded diff and validation.
- [ ] Pane count matches the roster; detach/reattach (WSL and Windows Terminal) shows continuing activity.
- [ ] Deterministic repair-loop tests prove exactly one retry and terminal second failure.
- [ ] CLI disconnect, Windows caller exit, and coordinator restart preserve status without duplicate provider attempts.
- [ ] Scoped stop leaves pre-existing tmux sessions, user workspaces, and `.ntm` data untouched.
- [ ] Adapters not used in the gate are Done or Blocked with a recorded gap; known unsupported modes and manual recovery steps are documented.

If a second provider is unavailable, S12 and P00 stay not Done. Report the blocker; do not start P01 UI implementation.
