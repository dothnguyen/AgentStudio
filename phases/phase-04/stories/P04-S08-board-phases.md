# P04-S08 — Board phases

Status: To Do
Depends on: P04-S07 (generic board model: `phases` table, default phase, `board_state`)
Architecture: [P04 design contract](../README.md#design-contract), §D

## Goal
Phases are database records managed by commands. The operator adds phases, puts tickets in them, and makes one the current phase; the scheduler (S10) works only the effective current phase, which is the default phase when none is set.

## Implement in this order
1. Phase service (coordinator side, through dispatch commands like the S07 ticket commands): `add`, `list`, `show`, `edit`, `close`, `reopen`, `remove`, `set-current`, `clear-current`. Slugs follow the contract (`^[a-z0-9][a-z0-9-]{0,63}$`); `add --id ID --name N [--description D] [--before ID]` appends or inserts at a position and renumbers; `PHASE_EXISTS` on a duplicate id.
2. The default phase is protected: `remove` and `close` of it are `PHASE_PROTECTED`; `edit` may change its name and description only. `remove ID` of another phase needs no tickets, or `--move-to OTHER` (an open phase, possibly the default); otherwise `PHASE_NOT_EMPTY`, nothing written. A closed phase cannot be set current or receive tickets (`PHASE_CLOSED`); `reopen` undoes `close`.
3. Current phase: `set-current ID` (open phase only) stores the pointer in `board_state`; `clear-current` clears it. `effective_current_phase(board)` returns the pointer's phase, or the default phase when it is NULL or points at a phase that is no longer open (a `close` of the current phase clears the pointer in the same transaction). Writes a board event with who and when; never touches running work.
4. Tickets: `ticket add --phase ID` (default phase when omitted; unknown is `PHASE_NOT_FOUND`); `ticket phase KEY ID` moves a ticket to another open phase (refused while the ticket is claimed or running: `TICKET_BUSY`); `ticket list --phase ID`; `ticket show` and `board show` print the phase; `board show` groups tickets by phase (current marked) and by status within it.
5. `board phase list` and `show ID` print each phase with its status, current marker, and ticket counts per configured status. Human and `--json` output.
6. Helper `ticket_in_scope(ticket, board)`: true when the ticket's phase is the effective current phase. S10 consumes it.

## Done when
- [ ] A new board has exactly one phase, `default`, which is current; `add`, `edit`, `close`, `reopen`, `remove` behave as step 1–2 and every change writes an event. Test: unit.
- [ ] The default phase cannot be removed or closed (`PHASE_PROTECTED`); `remove` of a non-empty phase needs `--move-to` and moves its tickets; an unknown or closed target is refused with nothing written. Test: unit.
- [ ] `ticket add` without `--phase` lands in the default phase; with `--phase` in that phase; unknown phase is `PHASE_NOT_FOUND`; `ticket phase` moves a ticket and refuses a busy one. Test: unit.
- [ ] `set-current` and `clear-current` change the effective current phase; with no pointer the default phase is current; closing the current phase falls back to the default. `ticket_in_scope` is correct for current, other and default phases. Test: unit.
- [ ] Changing the current phase leaves a claimed or running ticket alone. Test: unit with a claimed ticket.
- [ ] `board show` groups by phase and marks the current one; CLI and `--json` outputs agree. Test: unit/integration.

## Evidence
(filled in when the story is done)
