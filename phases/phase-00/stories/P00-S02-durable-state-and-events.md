# P00-S02 — SQLite state, write authority, and event journal

Status: Done
Depends on: P00-S01
Architecture: [P00 implementation contract](../architecture.md), sections C–D

## Goal

Create the only source of truth for teams, agents, tasks, assignments, workflow runs, commands, worker reports, and ordered events, with explicit write authority. This story uses fake IDs and does not start tmux or a provider.

## Implement in this order

1. Extend `state.py` with migration 2. DB path from `XDG_STATE_HOME` or the WSL home; reject paths under `/mnt` or the selected workspace. Directory `0700`, DB `0600`. Foreign keys, busy timeout, WAL. Reject an unsupported future schema version.
2. Add the tables in architecture section D. Opaque UUIDs, UTC timestamps, event sequence as INTEGER PRIMARY KEY, validated provider and policy enums, validated UTF-8 JSON payloads. Process identity columns store PID, start time, and boot ID together.
3. Transaction helper: update a materialized row and append its event atomically. Explicit allowed-transition tables including `claimed`, `reconciling`, and workflow `paused`; invalid transitions return `INVALID_TRANSITION`.
4. Enforce write authority in code: only the coordinator module calls materialized-state writers; client code paths can insert `commands` only; runner code paths can insert `worker_reports` only. Add a test that fails if a client/runner path writes elsewhere.
5. Immutable `worker_reports` with uniqueness on `assignmentId` + report sequence. The coordinator applies reports; applying is idempotent.
6. `snapshot` (cursor plus separate team, agent, task, assignment, workflow sections) and `events.after` (ordered rows after a cursor). Both read-only. No event retention in P00.
7. Expose queries through validated CLI/serve commands. No arbitrary SQL or filesystem paths from arguments.

## Tests to write

- Migration from empty, repeated migration, unsupported future version.
- Duplicate idempotency key: identical payload → same receipt, no extra rows; conflicting payload rejected.
- Invalid transitions; agent idle while a completed task remains succeeded; pane liveness does not alter task state.
- Fault injected between row update and event insert rolls both back.
- Two readers plus the coordinator writer see a monotonic cursor and no half-written snapshot.
- Reopen after simulated crash: unfinished assignment remains explicit, never auto-succeeded.
- Duplicate/late report application is a no-op.

## Done when

- [x] Every accepted state change has exactly one event in the same transaction.
- [x] Write authority (coordinator / command inbox / report inbox) is enforced and tested.
- [x] Status survives process exit and restart on a WSL-native filesystem (full suite inside Ubuntu-24.04 / WSL2).
- [x] Duplicate commands cannot create duplicate assignments or events.
- [x] Snapshot and event cursor are consistent.

## Evidence (2026-10-21)

- Target machine: `python3 -m unittest discover -s tests -t .` inside Ubuntu-24.04 (WSL2, Python 3.12.3) → 109 tests OK in 70 s (`phases/phase-00/evidence/test-run-wsl-ubuntu-24.04.log`).

- `python3 -m unittest discover -s tests -t .` → 86 tests OK on Ubuntu 22.04 / Python 3.10.12 (non-root), and OK on Python 3.13 / SQLite 3.45.1 (root; one permission test skipped). The S01 boundary spike still passes against this code.
- Write authority is enforced by an SQLite authorizer per connection role (`tests/unit/test_store.py::WriteAuthority`), plus a source scan that fails if a module opens a connection with an unexpected role.
- Concurrency: one writer process creating 60 teams × 3 agents per transaction while two readers snapshot continuously — every snapshot had complete teams, a monotonic cursor, and `cursor == 4 × teams`.
- Crash: a process SIGKILLed between an `assignment → succeeded` update and COMMIT leaves the assignment `running` with no `assignment.succeeded` event and a clean `integrity_check`.
- Design change found while implementing: S01 committed a command's effect and its stored response separately; they are now one transaction (covered by `AtomicCommands`).
- Implementation: `backend/agent_studio/{schema,state,store,reports,queries,fixtures}.py`; commands `snapshot`, `events.after`, `debug.fixture`.

Do not implement Electron or a renderer-side database client.
