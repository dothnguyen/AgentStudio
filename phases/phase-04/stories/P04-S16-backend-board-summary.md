# P04-S16 — Backend: read-only `board.summary`

Status: To Do
Depends on: none
Architecture: [P04 design contract](../README.md#design-contract), §A (workspace registry), §C (team definitions), §D (board); renderer rules: ticket T-014 (allowlisted preload only, one `serve` process)

## Goal
`board.show` returns every ticket of every phase, which is too much for headline counts, and `ticket.list` returns all tickets (the dispatch handler also drops its `phase` argument). Add a read-only `board.summary` returning the current phase, per-status counts with the configured status `kind`, and a short bounded list of the highest-priority active or blocked tickets. No software-specific status names appear in code.

## Implement in this order
1. Discovery (record): `boardmodel.phase_list` already returns `currentPhase` and, per phase, `counts` keyed by status id; `config_status_ids`/`load_config(workspace)` give statuses `{id, kind: initial|done|closed|null, name}`; `ticket_activity` yields `{state: working|not started|finished|blocked, note, agent, role}`; `BLOCKED_STATUS` is the reserved blocked column; `BOARD_CONFIG_INVALID`-style errors when `board.json` is absent or bad (record the exact code the dashboard must map to "board not configured").
2. Add `boardmodel.board_summary(conn, workspace, limit=5)` returning `{workspace, currentPhase:{slug,name,status}, columns:[{status, kind, title, count}] (current phase, configured order, blocked column only if non-empty), totals:{active, blocked, done}, tickets:[{key,title,status,priority,phase,activity:{state,agent?,role?}}] }`. `active` = tickets whose activity state is `working`; `blocked` = blocked column; `done` = statuses of kind `done`/`closed`; merge-ready is NOT a special total (no status name is assumed). `tickets` = blocked + working tickets of the current phase ordered by priority, created_at, key, at most `limit`; omit ticket body and event history.
3. Register `"board.summary": _board_summary` in `dispatch.py` with `_validate_board_show` args plus optional `limit` (1-10, default 5).

## Done when
- [ ] Counts equal `phase_list` counts for the current phase; kinds come from config; a custom status vocabulary works with no code change. Test: new `tests/unit/test_p04_s16_board_summary.py`.
- [ ] Empty board returns zero counts and `tickets: []`; absent/invalid `board.json` returns the existing error code. Test: same file.
- [ ] The ticket list is bounded by `limit`, ordered by priority, and contains no body/event fields. Test: same file.
- [ ] The command is read-only (event head and tables unchanged). Test: same file.
- [ ] Validation: python3 -m pytest <the new unit test file> tests/unit -q; python3 scripts/validate.py --touched.

Out of scope: fixing `ticket.list`'s ignored `phase` argument, the renderer/IPC (S18), board mutation.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
