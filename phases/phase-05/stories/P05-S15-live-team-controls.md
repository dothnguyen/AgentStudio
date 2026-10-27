# P05-S15 — Live team state and board controls

Status: To Do
Depends on: P05-S10, P05-S11, P05-S12, P05-S13
Architecture: [Teams management architecture](../README.md#architecture-and-gaps)

## Goal
Show each member’s availability and current work, plus selected-team start/stop board controls backed by real runner state. Match `design/teams-screen-v1.png` conceptually; never fabricate activity.

## Implement in this order
1. Render runtime and assignment states with text and status color; refresh on actions and connection changes.
2. Connect board run/stop to narrow IPC calls, show pending and terminal results, and prevent duplicate submissions.
3. Test idle/busy/waiting/offline, stopped/disconnected board, success/error, and race handling.

## Done when
- [ ] Availability and current work match runtime evidence or state unavailable. Test: component tests.
- [ ] Run/stop actions reflect backend outcome and remain safe on rapid repeated clicks. Test: component and IPC tests.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
