# P03-S01 — Ticket store, statuses and transition table

Status: To Do
Depends on: — (P01 S01–S09 engine as built)
Architecture: [P03 design contract](../README.md#design-contract), §A (board scope), §B (data and statuses), §J (events)

## Goal

Tickets become durable coordinator state. Schema v7 adds `tickets`, `ticket_deps` and `ticket_events`. `tickets.py` holds the one transition table (from, to, actor) and the functions that create, move, block, unblock and cancel a ticket inside a `store.Tx`. Every change writes a `ticket_events` row and a `ticket.*` event to the existing stream. No commands, agents or git yet: this story is store-level only.

## Implement in this order

1. `state.py`: `SCHEMA_VERSION = 7`, `MIGRATIONS[7]` creating the three ticket tables and the two board tables (`board_state`, `board_locks`, unused until S07/S13) from §B (with `CHECK`s on `kind`, `status`, `severity`, the unique `(workspace, key)` index, and the `ticket_deps` primary key with a `CHECK (ticket_id <> blocked_by_ticket_id)`), then `PRAGMA foreign_key_check`. Add the `Entity` entries in `schema.py`.
2. `tickets.py`:
   - status constants and `TRANSITIONS`, a table of `(from, to, actor)` exactly as §B lists it;
   - `next_key(tx, workspace)` (`T-001`, …);
   - `create(tx, workspace, kind, fields)`, which sets the entry status (`ready_unpack` / `refine` / `triage`, or `backlog` when asked);
   - `move(tx, ticket, to, actor, reason)`, which rejects anything not in the table (`TICKET_TRANSITION_INVALID`) and an operator move of a ticket whose `run_id` is active (`TICKET_BUSY`);
   - `block(…)`, which stores `return_status`, and `unblock(…)`, which goes back to it;
   - `cancel(…)`;
   - `add_deps(tx, ticket, keys)` / `remove_deps(…)` with cycle detection (`TICKET_DEPENDENCY_CYCLE`), and `deps_merged(tx, ticket) -> bool`.
3. Each write appends `ticket_events` and calls the existing event writer with the §J name, `ticketId` and `key`.

## Done when

- [ ] Migration from a v6 database (fixture built by the existing migration tests) gives v7 with all five tables, keeps every v6 row, and `foreign_key_check` is empty. Test: `tests/unit/test_p03_s01_migration.py`.
- [ ] Every `(from, to, actor)` row in `TRANSITIONS` is accepted, and a generated sample of pairs not in the table is refused with `TICKET_TRANSITION_INVALID`. Coordinator-only targets (`in_*`, `*ing`, `ready_merge`, `merged`, `unpacked`, `done`) are refused for `actor="operator"`. Test: `tests/unit/test_p03_s01_transitions.py`.
- [ ] `block` then `unblock` returns to the stored column. Unblocking a ticket that is not `blocked` is refused. A terminal ticket accepts no transition.
- [ ] Keys are sequential per workspace and independent across two workspaces.
- [ ] Dependencies: a 3-ticket cycle is refused, and so is a self-edge. `deps_merged` is true only when every blocker is `merged`.
- [ ] Every write produces one `ticket_events` row and one `events` row with the §J name (asserted via `events.after`).
- [ ] The extended guard test: `tickets.py` contains no role name, stage id or provider id (`tests/unit/test_p01_s05_guard.py` file list extended). All existing tests stay green.

## Evidence

(filled in when the story is done)
