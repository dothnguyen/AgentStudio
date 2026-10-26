# P04-S17 — Backend: bounded, safe `activity.recent`

Status: To Do
Depends on: none
Architecture: [P04 design contract](../README.md#design-contract), §A (workspace registry), §C (team definitions), §D (board); renderer rules: ticket T-014 (allowlisted preload only, one `serve` process)

## Goal
`events.after` is a global ascending cursor feed whose events carry raw `data` payloads and no workspace filter, so it is unsafe and unsuitable for a recent-changes panel. Add a read-only `activity.recent` that returns the newest meaningful events of one workspace, newest first, as an allowlisted projection with no payloads.

## Implement in this order
1. Discovery (record): `events` table (`seq`, `at`, `actor`, `name`, `entity`, `entity_id`, team/agent/task/assignment/workflow ids, `from_state`, `to_state`, `payload_json`) has no workspace column; workspace scoping goes through `teams.workspace` (team_id) and `tickets.workspace` via `ticket_events.event_seq`. List the event names in the journal (rg `emit`/event names in coordinator, teams, boardmodel) and choose an explicit allowlist: team started/stopped, assignment completed/blocked/failed, workflow finished/needs attention, ticket status changes, ticket merged.
2. Add `queries.recent_activity(conn, workspace, limit=15)`: select by allowlisted `name`, scoped to the workspace, `ORDER BY seq DESC LIMIT ?` (limit 1-20), using existing indexes (`events_by_team`); returns `{workspace, dbId, head, entries:[{id: <seq>, at, kind: team|assignment|workflow|ticket, name, summary, subject?:{type,id,label?}}]}`. `summary` is built by code from a fixed template plus ticket key / team name / status ids; never from `payload_json`, prompts, reports or provider output.
3. Register `"activity.recent": _activity_recent` in `dispatch.py` (workspace + optional limit).

## Done when
- [ ] Entries are newest first, bounded by `limit` (max 20), scoped to the workspace (an event from another workspace's team never appears), keyed by unique `id`. Test: new `tests/unit/test_p04_s17_recent_activity.py`.
- [ ] A payload containing a secret-looking string or prompt text never appears in any returned field. Test: same file.
- [ ] A non-allowlisted event name is excluded; an empty journal returns `entries: []`. Test: same file.
- [ ] Read-only: no new events or rows. Test: same file.
- [ ] Validation: python3 -m pytest <the new unit test file> tests/unit -q; python3 scripts/validate.py --touched.

Out of scope: pagination, filtering, search, push updates, renderer/IPC (S18).

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
