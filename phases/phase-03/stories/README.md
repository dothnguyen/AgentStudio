# Phase 03 — Asynchronous ticket board

Before starting any story, read the [phase overview and design contract](../README.md), the [P01 design contract](../../phase-01/README.md#design-contract) and the [P00 implementation contract](../../phase-00/architecture.md). P00's [rules for implementers](../../phase-00/stories/README.md#rules-for-implementers) apply unchanged. All git work in tests uses throwaway repositories under a temp directory, never this checkout.

| Story | Deliverable | Depends on | Status |
|---|---|---|---|
| [S01](./P03-S01-ticket-store-and-states.md) | Schema v7, ticket statuses, transition table | — | To Do |
| [S02](./P03-S02-ticket-commands.md) | `ticket.*` commands, `Depends on:` parsing, CLI + `serve` | S01 | To Do |
| [S03](./P03-S03-worktree-service.md) | Worktree service, commit-on-branch, planning commits | — | To Do |
| [S04](./P03-S04-per-run-workspace.md) | Per-run workspace for `workflow.start` / `task.direct` | S01, S03 | To Do |
| [S05](./P03-S05-board-config-and-columns.md) | `board.json`, column definitions, run seeds, `ticket.start` | S02, S04 | To Do |
| [S06](./P03-S06-outcome-applier.md) | Outcome applier, findings, round limits, develop and refine commits | S05 | To Do |
| [S07](./P03-S07-merge-step.md) | Squash merge, main-checkout lock, conflicts, dependents | S06 | To Do |
| [S08](./P03-S08-bug-tickets-and-triage.md) | Bug tickets and the triage column | S06 | To Do |
| [S09](./P03-S09-product-owner-and-manifest.md) | ProductOwner role, unpack definition, manifest validator | S05 | To Do |
| [S10](./P03-S10-unpack-outcome-and-children.md) | Unpack outcome and child tickets | S06, S09 | To Do |
| [S11](./P03-S11-usage-limits.md) | Usage limits, `limit_reached`, `board.resume` | S06 | To Do |
| [S12](./P03-S12-leases-and-recovery.md) | Leases, release, restart recovery, `ticket.retry` | S06 | To Do |
| [S13](./P03-S13-scheduler-picker.md) | Scheduler tick, priorities, `board.run/pause` | S07, S08, S10, S11, S12 | To Do |
| [S14](./P03-S14-multi-agent-rosters.md) | Several agents per role | S13 | To Do |
| [S15](./P03-S15-board-show-and-team-py.md) | `board.show`, `team.py board` / `ticket` | S11, S12 | To Do |
| [S16](./P03-S16-recovery-doc-and-drills.md) | Recovery doc and failure drills | S13, S14, S15 | To Do |
| [S17](./P03-S17-live-gate.md) | Live gate with real providers | S01–S16 | To Do |

S03 can run in parallel with S01–S02. S07, S08 and S09 can run in parallel after S06 (S09 needs only S05). S11 and S12 can run in parallel. S15 can start once S11 and S12 are done.

## Phase exit

P03 is Done only when S17 records a real board run with real providers (three tickets, one dependency, one forced QA fail, all `merged`) and S01–S16 are Done with evidence. Fake-provider tests never prove a real provider.
