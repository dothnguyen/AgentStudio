# P04-S05 — Cut-over: the new team replaces team.py

Status: To Do
Depends on: P04-S04 (ask and one-off workflows)
Architecture: [P04 design contract](../README.md#design-contract), constraints 1-2

## Goal
Every `team.py` command the operator uses exists as `agent-studio team ...` with the same behaviour and per-story state, then `team.py` and the `team.json` fallback are deleted. This is the cut-over: the operator verifies the new team on one real story before the next story starts.

## Implement in this order
1. Inventory `scripts/team/team.py` commands (`unpack`, `review`, `dev`, `fix`, `qa`, `final`, `commit`, `index`, `run`, `bug` if still used). For each, write down the behaviour to keep: saved per-story state, unit-tier `fix`/`qa`/`final`, integration gate at `commit`, the lead's commit message.
2. Implement `team unpack | review | dev | fix | qa | final | commit | index` on the new team, reading the same per-story state files so a story begun with `team.py` can continue.
3. Parity tests: run the same fixture story through both and compare state files and commands sent.
4. Operator step (not automatable): run one real story end to end with the new commands; record the commands and result in Evidence. Rollback is `git revert` of step 5.
5. Only after step 4: delete `scripts/team/team.py`, the `team.json` fallback, `import-legacy`'s fallback path (keep `import-legacy` only if `team.json` still exists), and update docs and role files that mention `team.py`.
6. Board-related `team.py` commands (`board`, `boards`, `ticket`, `bug`) are dropped with the software board in S06; until then they remain in git history only after step 5, so check nothing in docs tells the operator to use them.

## Done when
- [ ] Parity tests pass for every ported command. Test: integration with the fake provider.
- [ ] A real story is delivered with the new commands. Evidence: command log and story link.
- [ ] `team.py` and the `team.json` fallback are gone; the unit suite and `scripts/validate.py` pass. Test: full unit suite.
- [ ] A grep-style test shows no new command imports board code.

## Evidence
(filled in when the story is done)
