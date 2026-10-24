# P04-S06 — Remove the software board

Status: To Do
Depends on: P04-S05 (cut-over done and verified)
Architecture: [P04 design contract](../README.md#design-contract), constraint 3

## Goal
The P03 software board is deleted completely so the generic board has a clean slate. The old code is tagged in git first. This story is the first one delivered end to end with the new `agent-studio team` story commands (S05), and that delivery is the operator's verification of the cut-over (constraint 2); its last step deletes `team.py` (whose `bug`, `board`, `boards` and `ticket` commands call the software board) and the CLI-side `team.json` fallback.

## Implement in this order
0. Operator: deliver this story with `agent-studio team review / run-workflow --story (or dev) / qa / final / commit`, never `team.py`; the command log goes into Evidence.
1. Tag the current commit `software-board-p03` (the operator pushes it if wanted; no history rewrite).
2. Delete the board code: `board.py`, `board_config.py`, `board_defaults.json`, `board_scheduler.py`, `tickets.py`, `bugfile.py`, `manifest.py`, board-specific parts of `worktrees.py`/`gitws.py` only if unused by anything kept (keep what S10 will reuse), and their command registrations and `serve` handlers.
3. Delete the built-in `board-*` workflows, prompts and the ProductOwner board-unpack wiring that only the board used. Keep the ProductOwner role if `team unpack` uses it.
4. The next migration drops `tickets`, `ticket_deps`, `ticket_events` and `board_state`. Existing data is not migrated.
5. Delete the board tests and `scripts/live/board_drills.py`; keep the engine tests untouched. List removed test files in Evidence.
6. Update RECOVERY.md and READMEs; mark P03 as replaced by P04 in its README (status line only).
7. **Delete `team.py` (moved here from S05).** Delete `scripts/team/team.py` and the tests that load it: `tests/unit/test_p01_s09_team_run.py`, `test_p03_s08_team_bug.py`, `test_p03_s09_team_unpack.py`, `test_p03_s15_team_py_board.py`, `test_p03_s15_team_py_ticket.py`, `test_p04_s05_parity.py`, the `team.py` part of `test_validate_script.py` (its `scripts/validate.py` tests stay), and the `team.py` parts of `tests/integration/test_p01_s09_story_delivery.py` and `test_p03_s11_usage_limit.py` (the rest of each stays). Delete the CLI-side `team.json` fallback: `teamdefs`' `default` legacy team (`_select`, `list_teams`) and `team start`'s roster-less start when `teams/` is empty (it becomes `TEAM_NOT_FOUND` with remediation `run agent-studio team import-legacy`). `team import-legacy` stays (it converts a `team.json` when one exists). The coordinator's `team.start` without `roster` (reads `team.json`, used by `serve` and machine callers) is engine and stays (constraint 5). Update PRD, ROADMAP (current-usage lines only), RECOVERY.md, `backend/README.md`, `.agent-studio/roles/*` and `.agent-studio/README.md` so no doc tells the operator to run `team.py`. Rollback is `git revert` of this step.

## Done when
- [ ] No module imports a removed board module; `rg` for the removed names finds nothing outside git history and P03 docs. Test: unit import check.
- [ ] The new migration applies on the previous-version database and on a fresh one. Test: unit (migration).
- [ ] The engine, team and workflow suites are unchanged and green. Test: full unit and integration suite.
- [ ] `team status` and the other team commands run without board tables. Test: integration.
- [ ] This story was delivered with the new team commands only. Evidence: command log.
- [ ] `scripts/team/team.py` is gone, no test loads it, and `rg "team\.py"` finds it only in git history, `phases/` history docs and briefs; `agent-studio team start` in a workspace with only `team.json` is `TEAM_NOT_FOUND` naming `team import-legacy`, and `team import-legacy` still converts it. Test: full unit suite; unit (start without `teams/`).

## Evidence
(filled in when the story is done)
