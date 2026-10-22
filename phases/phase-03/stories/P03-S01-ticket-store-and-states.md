# P03-S01 — Ticket store, statuses and transition table

Status: To Do
Depends on: — (P01 S01–S09 engine as built)
Architecture: [P03 design contract](../README.md#design-contract), §A (board scope), §B (data, statuses and the transition table), §J (events)

## Goal

Tickets become durable coordinator state. Schema v7 adds `tickets`, `ticket_deps` and `ticket_events` (plus the two board tables, unused until S07/S13). `schema.py` holds the one transition table (from, to, actor) as `TICKET_TRANSITIONS`, and `tickets.py` holds the functions that create, move, block, unblock and cancel a ticket and edit its dependencies inside a `store.Tx`. Every change writes one `ticket_events` row and one `ticket.*` event to the existing stream. No commands, agents or git yet: this story is store-level only (the CLI and `serve` commands are S02).

## Implement in this order

1. `protocol.py`: error-code constants `TICKET_NOT_FOUND`, `TICKET_TRANSITION_INVALID`, `TICKET_BUSY`, `TICKET_DEPENDENCY_CYCLE` (the other §I codes belong to later stories).
2. `schema.py`:
   - `TICKET_KINDS = ("feature", "story", "bug")`, `TICKET_SEVERITIES = ("blocker", "major", "minor")`, `TICKET_STATES` (the 21 statuses of §B), `TICKET_TERMINAL = ("merged", "done", "cancelled")`, `TICKET_WORKING` with each working status's pick queue(s), `TICKET_OPERATOR_TARGETS`, `KIND_STATUSES`, and `TICKET_TRANSITIONS`: a frozenset of `(from, to, actor)` built from the §B table rows exactly (claim, release, outcomes, plan gate, late outcome, move, block, cancel). Unblock is not a row: it is the rule "`blocked` → stored `return_status`".
   - `Entity("ticket", "tickets", "status", …)` with `initial = {backlog, ready_unpack, refine, triage}`, `transitions` = the union of `TICKET_TRANSITIONS` ignoring the actor, plus `blocked` → every status that can be a `return_status` (every non-terminal, non-working status), `ref_col=None` (events carry the ticket id in `entity_id`), and `columns` = every §B column except `id`, `status`, `created_at`, `updated_at`.
   - `MIGRATION_7` with the five tables of §B:
     - `tickets`: `id` uses the `ID` check; `workspace`, `key`, `kind`, `title`, `status` NOT NULL; `CHECK`s on `kind`, `status`, `severity` (NULL allowed); `CHECK ((status = 'blocked') = (return_status IS NOT NULL))`; `priority INTEGER NOT NULL DEFAULT 100`; `dev_rounds`, `test_rounds`, `review_rounds INTEGER NOT NULL DEFAULT 0`; `parent_ticket_id → tickets(id)`, `run_id` and `applied_run_id → workflow_runs(id)`, `assignee_agent_id → agents(id)`; `duplicate_of` is a ticket key (TEXT, no FK; S08); `UNIQUE INDEX tickets_key ON tickets (workspace, key)` and an index on `(workspace, status)`.
     - `ticket_deps (ticket_id → tickets, blocked_by_ticket_id → tickets, PRIMARY KEY (ticket_id, blocked_by_ticket_id), CHECK (ticket_id <> blocked_by_ticket_id))`.
     - `ticket_events` with the §B columns and `_immutable("ticket_events")`.
     - `board_state (workspace TEXT PRIMARY KEY, status CHECK IN ('running','paused'), reason, config_json, review_streak INTEGER NOT NULL DEFAULT 0, updated_at)` and `board_locks (workspace, name, ticket_id → tickets, created_at, PRIMARY KEY (workspace, name))`.
3. `state.py`: `SCHEMA_VERSION = 7`, `MIGRATIONS[7] = schema.MIGRATION_7`, then `PRAGMA foreign_key_check` (fail the migration if it returns rows, like v6).
4. `tickets.py` (store-level, every function takes an open `store.Tx`; `actor` is `"coordinator"` or `"operator"`, anything else → `INTERNAL`):
   - `TRANSITIONS = schema.TICKET_TRANSITIONS` and the status constants re-exported for readers;
   - `get(tx, workspace, key) -> dict` (`TICKET_NOT_FOUND`);
   - `next_key(tx, workspace)`: `T-` + (highest number used in that workspace + 1), zero-padded to at least 3 digits (`T-001`, …, `T-999`, `T-1000`);
   - `create(tx, workspace, kind, fields, hold=False) -> dict`: entry status `ready_unpack` / `refine` / `triage` by kind, or `backlog` when `hold` is true (a bug with `hold` → `TICKET_TRANSITION_INVALID`, bugs have no `backlog`); unknown kind → `TICKET_TRANSITION_INVALID`; `fields` may hold only `Entity.columns` (other columns rejected by the existing `_check_columns`); returns the row;
   - `move(tx, ticket, to, actor, reason=None)`: refuses with `TICKET_TRANSITION_INVALID` (data `{key, from, to, actor}`) any `(from, to, actor)` not in `TRANSITIONS` or any `from`/`to` not in `KIND_STATUSES[kind]`; for `actor="operator"` refuses with `TICKET_BUSY` (data `{key, runId}`) when `run_id` names a workflow run in `queued`, `running` or `paused`. `to="blocked"` behaves as `block`, `to="cancelled"` as `cancel`;
   - `block(tx, ticket, actor, reason)`: stores `return_status` (the current status, or the pick queue for a working status: `in_dev` → `ready_dev`, `refining` → `refine`, …) and `blocked_reason`;
   - `unblock(tx, ticket, actor)`: only from `blocked` (else `TICKET_TRANSITION_INVALID`), back to `return_status`, clearing `return_status` and `blocked_reason`; the operator `TICKET_BUSY` rule applies;
   - `cancel(tx, ticket, actor, reason=None)`: any non-terminal → `cancelled`. It does not look at `run_id` (the S02 command cancels the run first);
   - `add_deps(tx, ticket, keys)` / `remove_deps(tx, ticket, keys)`: keys are looked up in the ticket's workspace (`TICKET_NOT_FOUND` otherwise); a self-edge or an edge that would close a cycle → `TICKET_DEPENDENCY_CYCLE` (data `{key, cycle: [keys]}`) and nothing is written; edges already present / absent are ignored, and a call that changes nothing writes nothing;
   - `deps_merged(tx, ticket) -> bool`: true when every blocker is `merged` (true when there are none).
5. Each write goes through `tx.create` / `tx.transition` / `tx.note` (one `events` row) and appends one `ticket_events` row with that event's `seq`. Names and payloads, per §J: create → `ticket.created {ticketId, key, kind, status}`; move / block / unblock / cancel → `ticket.moved {ticketId, key, from, to, by, reason}` (`by` = the actor); `add_deps` / `remove_deps` → `ticket.depends {ticketId, key, on: [the full blocker key list after the change]}`.
6. Guard: add `tickets.py` to the clean-file list in `tests/unit/test_p01_s05_guard.py` (a new test method, same `hits(tree(...)) == []` check).

## Done when

- [ ] Migration: a v6 database (the `v5_database` fixture from `tests/unit/test_p01_s04_migration.py`, then `MIGRATIONS[6]` applied and recorded) migrated with `state.migrate` reaches version 7 with all five tables, keeps every v6 row (`dump` of `teams`, `agents`, `tasks`, `workflow_runs`, `stage_attempts`, `assignments` equal before and after), `PRAGMA foreign_key_check` is empty, and the `CHECK`s refuse a bad `kind`, `status`, `severity`, a duplicate `(workspace, key)`, a self-edge in `ticket_deps`, and an `UPDATE` on `ticket_events`. Test: `tests/unit/test_p03_s01_migration.py`.
- [ ] Transitions: every `(from, to, actor)` row in `TRANSITIONS` is accepted for a ticket of a kind whose path holds both statuses; **every** other triple over `TICKET_STATES × TICKET_STATES × {coordinator, operator}` is refused with `TICKET_TRANSITION_INVALID` and leaves the row unchanged. Coordinator-only targets (`in_*`, `*ing`, `ready_merge`, `merged`, `unpacked`, `done`) are refused for `actor="operator"` through `move`. A status off the kind's path (e.g. a story → `ready_unpack`, a bug → `backlog`) is refused. An operator move or unblock of a ticket whose `run_id` is a `running` workflow run → `TICKET_BUSY`; the same move by the coordinator, or after the run is `cancelled`, is accepted. Test: `tests/unit/test_p03_s01_transitions.py`.
- [ ] Block: `block` then `unblock` returns to the stored column (from `ready_test` → `ready_test`; from `in_dev` → `ready_dev`); `return_status` is cleared after. Unblocking a ticket that is not `blocked` → `TICKET_TRANSITION_INVALID`. A ticket in `merged`, `done` or `cancelled` accepts no transition, `block` or `cancel`. Test: `tests/unit/test_p03_s01_transitions.py`.
- [ ] Create: entry statuses are `ready_unpack` / `refine` / `triage` by kind, `backlog` with `hold` (and a held bug is refused). Keys are sequential per workspace (`T-001`, `T-002`, `T-003`) and independent across two workspaces (both start at `T-001`). Test: `tests/unit/test_p03_s01_tickets.py`.
- [ ] Dependencies: a 3-ticket cycle (A→B, B→C, then C→A) is refused with `TICKET_DEPENDENCY_CYCLE` and writes nothing; so is a self-edge; a key from another workspace → `TICKET_NOT_FOUND`. `deps_merged` is true with no deps, false while any blocker is not `merged`, true once all are. Test: `tests/unit/test_p03_s01_tickets.py`.
- [ ] Events: every write function (`create`, `move`, `block`, `unblock`, `cancel`, `add_deps`, `remove_deps`) produces exactly one `ticket_events` row and one `events` row with the §J name, `entity = "ticket"`, `entity_id` = the ticket id and `key` / `ticketId` in the payload, asserted through `queries.events_after`; `ticket_events.event_seq` points at that event; a refused call and a no-op deps call write none. Test: `tests/unit/test_p03_s01_tickets.py`.
- [ ] Guard: `tickets.py` contains no role name, stage id or provider id (new method in `tests/unit/test_p01_s05_guard.py`). `python3 -m unittest discover -s tests -t .` stays green (the version pins in `tests/unit/test_p01_s04_migration.py` lines 63, 71, 131, 133 become 7 — they assert the latest version — and nothing else in that file changes).

## Evidence

(filled in when the story is done)
