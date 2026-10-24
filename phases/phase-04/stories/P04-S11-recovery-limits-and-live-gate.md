# P04-S11 — Recovery, limits and live gate

Status: To Do
Depends on: P04-S10 (scheduler and run-board)
Architecture: [P04 design contract](../README.md#design-contract), §E

## Goal
The generic board survives crashes and provider usage limits, the recovery is documented and drilled, and a real run on a real project closes the phase.

## Implement in this order
1. Lease expiry and crash recovery: a coordinator or runner death releases the claim and the ticket returns to its rule's status exactly once; orphan worktrees are reconciled; `ticket retry` clears a stuck claim.
2. Usage limits: a `USAGE_LIMIT` result releases the ticket without counting a round and marks the member `limit_reached`; `board resume --member M` makes it eligible again.
3. RECOVERY.md section for the new board (`You see | Meaning | Command`) covering each code and a danger-zones subsection, with a doc test that every code is documented.
4. Drill script on the fake provider (coordinator killed, runner killed, merge conflict, round limit, usage limit, stuck claim), run in isolated state dirs, writing evidence.
5. Live gate: with real providers on a throwaway repo, three tickets, one dependency, one forced QA fail, all `done`; also confirm the other team stays free for `ask`. Record the run folder. Update ROADMAP/PRD only if the operator asks.

## Done when
- [ ] Each drill follows its expected path on the fake provider. Test: integration, one method per drill.
- [ ] The recovery doc names every operator-visible code. Test: unit doc check.
- [ ] The live gate passes with real providers. Evidence: run folder, not a fake-provider run.

## Evidence
(filled in when the story is done)
