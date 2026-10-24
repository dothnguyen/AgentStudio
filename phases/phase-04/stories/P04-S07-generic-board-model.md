# P04-S07 — Generic board model

Status: To Do
Depends on: P04-S06 (software board removed)
Architecture: [P04 design contract](../README.md#design-contract), §B, §D

## Goal
A board is data: statuses from `board.json`, generic tickets and a phase table in the state DB, and commands to add, move, show and list tickets. Every board has a protected default phase and every ticket belongs to a phase. Nothing in the code names a status, a role or git.

## Implement in this order
1. `board.json` loader and validator: unique status ids, exactly one `initial`, at least one `done`, optional `closed`, `ticketFields`. The old P03 shape is rejected with `BOARD_CONFIG_INVALID` (Q4).
2. The next migration adds `board_state` (workspace, current phase id or NULL, timestamps), `phases` (id, workspace, slug, name, description, position, status open/closed, timestamps; unique slug per workspace), `tickets` (key, title, body, `phase_id` NOT NULL, status, priority, assignee, lease fields, `created_by` member/assignment or NULL, timestamps), `ticket_deps`, `ticket_events`. No SQL CHECK on `status`. S08 adds the phase commands.
3. Transition validator in code: a move is allowed only to a configured status; a `done` or `closed` ticket is terminal unless the operator moves it explicitly with `--force`. Every move writes an event.
4. Commands: `ticket add | move | show | list | depend` (dependency cycles refused) and `board show` (tickets grouped by status, in configured order). Human and `--json` output.
5. Keys are `T-001`, `T-002` per workspace.
6. First use of any board or ticket command creates the board's `board_state` row and its default phase (`slug: default`, name "Default", position 0) in one transaction; later calls find it. Every ticket added in this story goes to the default phase (S08 adds `--phase`).

## Done when
- [ ] Two different `board.json` status sets work without a code or schema change. Test: unit with both.
- [ ] Moving to an unknown status or a stale terminal state is refused with a clear code. Test: unit.
- [ ] Dependency cycles are rejected; `board show` lists columns in config order. Test: unit.
- [ ] The first `ticket add` on an empty workspace creates the default phase and puts the ticket in it; a second call creates nothing new. Test: unit.
- [ ] A static test confirms the board modules contain no role, workflow or git names. Test: unit.

## Evidence
(filled in when the story is done)
