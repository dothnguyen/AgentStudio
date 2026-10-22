# P03-S02 — Ticket commands over the CLI and `serve`

Status: To Do
Depends on: P03-S01
Architecture: [P03 design contract](../README.md#design-contract), §B, §I (commands and errors), §J

## Goal

The operator can create and manage tickets without agents: `ticket.create / show / list / move / block / unblock / cancel / depend`. They go through the command inbox like every P00 command, with identical JSON on the CLI and `serve`. Story tickets get their dependencies from the story's `Depends on:` line unless `dependsOn` or `noDeps` overrides it, and the receipt shows what was parsed.

## Implement in this order

1. `protocol.py`: argument schemas for the §I `ticket.*` commands (without `approve`, `start` and `retry`, which belong to S05/S10/S12), with idempotency keys for the mutating ones.
2. Path rules on create:
   - `storyPath` / `briefPath` are relative to the workspace, exist, stay inside it (no `..`, no absolute path, no symlink escape) and are `.md` files (`STORY_PATH_INVALID` otherwise);
   - `outDir` stays inside `phases/`;
   - bug `text` is ≤ 32 KiB, `attachments` are paths inside the workspace (existence checked, contents never read).
3. `tickets.parse_depends(text)`: reads the `Depends on:` line, maps `PNN-Sxx` story IDs to existing story tickets with that file stem prefix, and returns `{resolved: [keys], unresolved: [ids]}`. Unresolved IDs are returned as warnings on the receipt, never errors. The title defaults to the story's `# ` heading.
4. Coordinator handlers calling the S01 functions. `ticket.show` returns the row, its deps, its dependents and the last 50 events. `ticket.list` filters by `status` / `kind`.
5. CLI: `agent-studio ticket create|show|list|move|block|unblock|cancel|depend …`, with the flags named like the args (`--story`, `--brief`, `--out`, `--text`, `--depends T-001`, `--no-deps`).

## Done when

- [ ] `ticket create --story phases/phase-03/stories/P03-S02-ticket-commands.md` in a fixture workspace returns `T-001` in `refine`, the title from the heading, and the parsed deps. The same idempotency key and payload return the same receipt; a different payload under the same key → `IDEMPOTENCY_CONFLICT`.
- [ ] `Depends on:` with one known and one unknown story ID → one dependency plus one warning. `--depends T-001` replaces the parsed set, and `--no-deps` gives none.
- [ ] `../x.md`, an absolute path, a symlink out of the workspace and a missing file each → `STORY_PATH_INVALID`.
- [ ] `move`, `block`, `unblock`, `cancel` and `depend` return the §I errors for invalid moves, cycles and unknown keys (`TICKET_NOT_FOUND`).
- [ ] The CLI and `serve` give byte-identical JSON for `ticket.show` (one test drives both).
- [ ] Tests: `tests/unit/test_p03_s02_parse_depends.py`, `tests/integration/test_p03_s02_ticket_commands.py`. All existing tests stay green.

## Evidence

(filled in when the story is done)
