# P04-S06 — Remove the software board

Status: To Do
Depends on: P04-S05 (cut-over done and verified)
Architecture: [P04 design contract](../README.md#design-contract), constraint 3

## Goal
The P03 software board is deleted completely so the generic board has a clean slate. The old code is tagged in git first.

## Implement in this order
1. Tag the current commit `software-board-p03` (the operator pushes it if wanted; no history rewrite).
2. Delete the board code: `board.py`, `board_config.py`, `board_defaults.json`, `board_scheduler.py`, `tickets.py`, `bugfile.py`, `manifest.py`, board-specific parts of `worktrees.py`/`gitws.py` only if unused by anything kept (keep what S10 will reuse), and their command registrations and `serve` handlers.
3. Delete the built-in `board-*` workflows, prompts and the ProductOwner board-unpack wiring that only the board used. Keep the ProductOwner role if `team unpack` uses it.
4. The next migration drops `tickets`, `ticket_deps`, `ticket_events` and `board_state`. Existing data is not migrated.
5. Delete the board tests and `scripts/live/board_drills.py`; keep the engine tests untouched. List removed test files in Evidence.
6. Update RECOVERY.md and READMEs; mark P03 as replaced by P04 in its README (status line only).

## Done when
- [ ] No module imports a removed board module; `rg` for the removed names finds nothing outside git history and P03 docs. Test: unit import check.
- [ ] The new migration applies on the previous-version database and on a fresh one. Test: unit (migration).
- [ ] The engine, team and workflow suites are unchanged and green. Test: full unit and integration suite.
- [ ] `team status` and the other team commands run without board tables. Test: integration.

## Evidence
(filled in when the story is done)
