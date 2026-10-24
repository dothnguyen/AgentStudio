# P04-S08 — Board phases

Status: To Do
Depends on: P04-S07 (generic board model)
Architecture: [P04 design contract](../README.md#design-contract), §D

## Goal
Tickets belong to a phase, the board has a current phase, and the operator changes it with `board phase set`. Later the scheduler only works tickets of the current phase.

## Implement in this order
1. Migration-free if possible: add `phase` to `tickets` in the S07 migration pattern (a new migration if S07 is already merged).
2. `phases` list and `currentPhase` in `board.json`; validate that `currentPhase` is a listed phase.
3. `ticket add --phase P` (default none = unphased); `ticket move`/`list` filter by phase.
4. `board phase list` and `board phase set <id>` (edits `board.json` through the same preserving writer as team files); `board show` marks the current phase.
5. Helper `ticket_in_scope(ticket, board)`: true if unphased or phase equals `currentPhase`. S10 consumes it.

## Done when
- [ ] An unknown phase is refused on `ticket add` and `phase set`. Test: unit.
- [ ] `phase set` keeps unknown keys and formatting in `board.json`. Test: unit.
- [ ] `ticket_in_scope` is correct for unphased, current and other phases. Test: unit.

## Evidence
(filled in when the story is done)
