# P03-S02 — Ticket commands over the CLI and `serve`

Status: Done (2026-10-23)
Depends on: P03-S01
Architecture: [P03 design contract](../README.md#design-contract), §B, §I (commands and errors), §J

## Goal

The operator can create and manage **story** tickets without agents: `ticket.create / show / list / move / block / unblock / cancel / depend`. The mutating commands go through the command inbox like every P00 mutating command (dispatch validator → `client.submit` → coordinator handler in one transaction); `show` and `list` are read-only and read the database directly, like `workflow.show`. The CLI and `serve` return identical JSON. A story ticket gets its dependencies from the story's `Depends on:` line unless `dependsOn` or `noDeps` overrides it, and the receipt shows what was parsed. Feature tickets (`briefPath` + `outDir`) are S10 and bug tickets (`text` + `attachments`) are S08; this story builds the shared path check they reuse.

## Implement in this order

1. `protocol.py`: the error-code constant `STORY_PATH_INVALID`.
2. `dispatch.py` validators and `COMMANDS` entries for the §I `ticket.*` commands except `approve`, `start` and `retry` (S10/S05/S12). Every command takes `workspace`, canonicalised with `ops.canonical_workspace` (`WORKSPACE_NOT_FOUND`); `key` / keys in `dependsOn`, `on`, `remove` must match `^T-\d{3,}$`; other shape errors → `BAD_REQUEST`.
   - mutating, through `_inbox(...)` (idempotency key required, P00 rule): `ticket.create`, `ticket.move`, `ticket.block`, `ticket.unblock`, `ticket.cancel`, `ticket.depend`;
   - read-only, through `_reader()` and a `queries.py` function (no inbox, no idempotency key): `ticket.show`, `ticket.list`;
   - `ticket.create` args: `kind` (only `"story"` here, the default; `feature` / `bug` → `BAD_REQUEST` until S10/S08), `storyPath` (required), `title?` (≤ 200 bytes), `dependsOn?` [keys], `noDeps?` (bool; together with `dependsOn` → `BAD_REQUEST`), `priority?` (integer 0–1000, default 100);
   - `ticket.move`: `key`, `to` (one of `schema.TICKET_STATES`), `reason?` (≤ 500 bytes); `ticket.block`: `key`, `reason` (required, ≤ 500 bytes); `ticket.unblock`: `key`; `ticket.cancel`: `key`, `reason?`; `ticket.depend`: `key`, `on?` [keys], `remove?` [keys], at least one of them non-empty;
   - `ticket.list`: `status?` (in `TICKET_STATES`), `kind?` (in `TICKET_KINDS`).
3. Path rule, `tickets.check_workspace_path(workspace, rel) -> str` (a pure function, reused by S08/S10), run by the coordinator handler at apply time: `rel` is relative (not absolute, no `..` component, no backslash), `realpath(workspace/rel)` is inside `realpath(workspace)` (so a symlink escape is refused), it is an existing regular file and ends in `.md`. Any failure → `STORY_PATH_INVALID` with data `{path, reason}`. It returns the normalised relative path (POSIX separators), which is what `story_path` stores.
4. Dependency parsing in `tickets.py`:
   - `parse_depends(text) -> [ids]` (pure): finds the first line starting with `Depends on:` and returns every `P\d{2}-S\d{2}` match on it, in order, without duplicates (`—`, `P01 S01–S09` and other text give nothing);
   - `resolve_depends(tx, workspace, ids) -> {"resolved": [keys], "unresolved": [ids]}`: an ID resolves when exactly one non-`cancelled` `story` ticket in the workspace has a `story_path` whose file stem is the ID or starts with `<ID>-`; none or several → unresolved;
   - `story_title(text, stem)`: the text after `# ` on the first line starting with `# `, stripped, cut to 200 characters; no heading → the file stem.
5. Coordinator `HANDLERS` (in `coordinator.py`, calling the S01 functions in the command's transaction, `actor="operator"`):
   - `ticket.create`: path check, read the story file (UTF-8), `tickets.create(tx, workspace, "story", {title, story_path, priority})`, then deps: `noDeps` → none; `dependsOn` → exactly those keys (`TICKET_NOT_FOUND` rolls back the whole command); otherwise the resolved keys of the `Depends on:` line, added with `add_deps`. Receipt: `{ticket: <row>, dependsOn: [keys], parsed: {ids, resolved, unresolved}, warnings: [{code: "DEPENDS_UNRESOLVED", id}]}` (`parsed` and `warnings` describe the story's line even when it was overridden; unresolved IDs are warnings, never errors);
   - `ticket.move` / `ticket.block` / `ticket.unblock` → `tickets.move` / `block` / `unblock`; receipt `{ticket: <row after>}`;
   - `ticket.cancel`: when `run_id` names a workflow run in `queued`, `running` or `paused`, first `workflow.cancel(tx, {"workflowRunId": run_id}, ctx)` in the same transaction, then `tickets.cancel`; receipt `{ticket: <row after>, run: <workflow.cancel result or null>}`;
   - `ticket.depend` → `add_deps(on)` then `remove_deps(remove)`; receipt `{ticket: <row>, dependsOn: [keys after]}`.
6. `queries.py`: `ticket_detail(conn, workspace, key)` → `{dbId, cursor, ticket, dependsOn: [keys], dependents: [keys], events: [the last 50 ticket_events rows, oldest first]}` (`TICKET_NOT_FOUND`), and `ticket_list(conn, workspace, status=None, kind=None)` → `{dbId, cursor, tickets: [rows]}` ordered by `priority`, then `created_at`, then `key`. Rows use `row_to_json`, as `workflow_detail` does.
7. CLI (`cli.py`, plus the usage text): `agent-studio ticket create --workspace PATH --story PATH [--title T] [--depends KEY ...] [--no-deps] [--priority N] [--key K]`, `ticket show|list|move|block|unblock|cancel|depend` with `--workspace`, a positional `KEY` where the command has one, and flags named like the args (`--to`, `--reason`, `--status`, `--kind`, `--on KEY ...`, `--remove KEY ...`). `--depends`, `--on` and `--remove` are repeatable. Mutating subcommands take `--key` (default: a new UUID), like `workflow start`.

## Done when

- [x] Path rule: `check_workspace_path` accepts `phases/x.md` and refuses `../x.md`, an absolute path, a symlink inside the workspace pointing outside it, a missing file, a directory and a `.txt` file, each with `STORY_PATH_INVALID`. Test: `tests/unit/test_p03_s02_parse_depends.py`.
- [x] Parsing: `parse_depends` on `Depends on: P03-S01, P03-S04 (x)` → `["P03-S01", "P03-S04"]`; on `Depends on: — (P01 S01–S09 engine as built)` and on text with no such line → `[]`. `resolve_depends` with one story ticket whose `story_path` stem is `P03-S01-ticket-store-and-states` and IDs `["P03-S01", "P03-S99"]` → `{resolved: ["T-001"], unresolved: ["P03-S99"]}`; a `cancelled` match does not resolve. `story_title` returns the heading or the stem. Test: `tests/unit/test_p03_s02_parse_depends.py`.
- [x] Create (handler level, a temp workspace with fixture story files `phases/phase-03/stories/P03-S01-a.md` and `P03-S02-b.md`, the second with `Depends on: P03-S01, P03-S99`): creating S01 returns `T-001` in `refine` with the heading as title; creating S02 returns `T-002` with `dependsOn: ["T-001"]` and one `DEPENDS_UNRESOLVED` warning for `P03-S99`; creating S02 again (new idempotency key) with `dependsOn: ["T-002"]` gives exactly `["T-002"]` (the parsed `T-001` is replaced), and with `noDeps: true` gives none (the warning is still shown). `dependsOn` with an unknown key → `TICKET_NOT_FOUND` and no ticket is created. Test: `tests/unit/test_p03_s02_commands.py` (drives `coordinator.process_pending` on a temp state DB with `inbox` rows, or the `HANDLERS` directly inside `store.transaction`).
- [x] Idempotency: the same idempotency key and payload return the same receipt and create one ticket; a different payload under the same key → `IDEMPOTENCY_CONFLICT`. Test: `tests/integration/test_p03_s02_ticket_commands.py` (through the CLI).
- [x] Errors: `move` to `merged` and `unblock` of a ticket that is not `blocked` → `TICKET_TRANSITION_INVALID`; `depend` closing a cycle → `TICKET_DEPENDENCY_CYCLE`; `show`, `move`, `block`, `unblock`, `cancel` and `depend` on `T-999` → `TICKET_NOT_FOUND`; `create` with `kind: "bug"`, or with both `dependsOn` and `noDeps` → `BAD_REQUEST`. Test: `tests/unit/test_p03_s02_commands.py`.
- [x] Cancel: a ticket whose `run_id` is a `queued` workflow run (fixture built with `tx.create` as in `tests/unit/test_p03_s01_transitions.py`) is `cancelled` and so is the run, in one command. Test: `tests/unit/test_p03_s02_commands.py`.
- [x] Show / list: `ticket.show` returns the row, `dependsOn`, `dependents` and at most 50 events (oldest first, after 55 writes); `ticket.list` filters by `status` and by `kind`. Test: `tests/unit/test_p03_s02_commands.py`.
- [x] The CLI and `serve` give byte-identical `data` JSON for `ticket.show` of the same ticket, with no write in between (one test drives both). Test: `tests/integration/test_p03_s02_ticket_commands.py`.
- [x] `python3 -m unittest discover -s tests -t .` stays green; `ticket.*` commands are in `dispatch.COMMANDS` and the mutating ones in `coordinator.HANDLERS`.

## Evidence

- Validation: `python3 -m unittest discover -s tests -t .` → `Ran 345 tests … OK (skipped=3)` (only pre-existing ResourceWarnings, in `tests/unit/test_s06_parts.py`).
- Implemented:
  - `protocol.py`: `STORY_PATH_INVALID`.
  - `dispatch.py`: `ticket.*` validators. The six mutating commands go through `_inbox`. `ticket.show` / `ticket.list` read the database directly through `_reader()`. Keys must match `^T-\d{3,}$`. `kind` other than `story` is refused, and so are `dependsOn` and `noDeps` together.
  - `tickets.py`: `check_workspace_path`, `parse_depends`, `resolve_depends`, `story_title`.
  - `coordinator.py`: `HANDLERS` for create, move, block, unblock, cancel and depend. `cancel` also cancels a `queued` / `running` / `paused` run in the same transaction.
  - `queries.py`: `ticket_detail` (deps, dependents, the last 50 events oldest first) and `ticket_list` (filters by status and kind; ordered by priority, created_at, key).
  - `cli.py`: the `ticket` subcommand and the usage text.
- Tests added:
  - `tests/unit/test_p03_s02_parse_depends.py`: path rule, parsing, resolve, title.
  - `tests/unit/test_p03_s02_commands.py`: create with deps / override / `[]` / noDeps and rollback on an unknown key; transition, cycle and not-found errors; validation `BAD_REQUEST`; `WORKSPACE_NOT_FOUND` at dispatch; cancel of a queued run; the 50-event limit and list filters.
  - `tests/integration/test_p03_s02_ticket_commands.py`: idempotent create and `IDEMPOTENCY_CONFLICT` through the CLI `request` command; byte-identical `ticket.show` `data` from the CLI and from `serve`.
- Also in this change: the phase README §I contract now covers read-only show/list, the path check and the create receipt. S08 and S10 point to `check_workspace_path` and note that S02 refuses `bug` / `feature` until they land.
