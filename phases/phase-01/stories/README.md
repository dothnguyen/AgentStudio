# Phase 01 — Configurable workflows

Read the [phase overview and design contract](../README.md), [PRD.md](../../../PRD.md) §6b, and the [P00 implementation contract](../../phase-00/architecture.md) before starting any story. P00's [rules for implementers](../../phase-00/stories/README.md#rules-for-implementers) apply unchanged.

| Story | Deliverable | Depends on | Status |
|---|---|---|---|
| [S01](./P01-S01-definition-model-and-json.md) | Definition model, JSON loader, static validation | — | Done (2026-10-22) |
| [S02](./P01-S02-yaml-subset-loader.md) | Strict YAML subset loader | S01 | Done |
| [S03](./P01-S03-prompt-templates.md) | Prompt templates and verdict footer | S01 | Done (2026-10-22) |
| [S04](./P01-S04-schema-binding-and-start.md) | Schema rebuild, role binding, frozen definition, first-stage dispatch | S01, S03 | To Do |
| [S05](./P01-S05-routing-and-bounds.md) | Agent-stage routing, bounds, diffs, `routed` events | S04 | Done |
| [S06](./P01-S06-validation-stages-and-builtin.md) | Validation stages, `passRequires`, built-in `developer-reviewer`, P00 compatibility | S05 | Done |
| [S07](./P01-S07-recovery-resolve-cancel.md) | Restart, resolve, cancel, deadlines for definition runs | S06 | Done |
| [S08](./P01-S08-workflow-commands.md) | `workflow list / validate / start --definition / show` over CLI and `serve` | S02, S06 | Done |
| [S09](./P01-S09-project-workflow-and-team-run.md) | `story-delivery.yaml` for this project and `team.py run` | S07, S08 | Done |
| [S10](./P01-S10-live-gate.md) | Real three-role definition run | S01–S09 | To Do |
| [S11](./P01-S11-adapter-session-contract.md) | Adapter session contract, fake resume, resume prompt and fallback, normalized usage | — | To Do |
| [S12](./P01-S12-session-store-and-decision.md) | `agent_sessions`, `task.direct` `sessionKey`, decision at assignment creation, pointer advance | S11 | To Do |
| [S13](./P01-S13-session-end-and-visibility.md) | `session.end` / `session.list`, `team.stop` ends sessions, snapshot / task show | S12 | To Do |
| [S14](./P01-S14-workflow-session-keys.md) | `workflow.start` `sessionKey`, run ID default, repair resumes | S12 | To Do |
| [S15](./P01-S15-claude-session-resume.md) | Claude Code resume, verified on the real CLI | S11 | To Do |
| [S16](./P01-S16-team-py-sessions-and-usage.md) | `team.py` story keys, `reset`, end on `commit`, `usage` | S13, S14 | To Do |
| [S17](./P01-S17-session-live-evidence.md) | Real story cycle with resumed sessions (E4 gate) | S15, S16 | To Do |
| [S18](./P01-S18-codex-session-resume.md) | Codex resume mapping (follow-up, outside the phase exit) | S11 | To Do |

S02 and S03 can proceed in parallel after S01, and S07 and S08 can proceed in parallel after S06. E4 (S11–S18) does not depend on S01–S10. S13, S14 and S15 can proceed in parallel after S12 (S15 needs only S11). See [§H of the design contract](../README.md#h-session-continuity-e4).

## Phase exit

P01 is Done only when S10 records a real run of a three-role definition in a disposable fixture, S17 records a real story cycle with resumed Claude sessions, and S01–S09 and S11–S16 are Done with evidence. Fake-adapter tests prove the routing loops, bounds and session rules; they never prove a real provider. S18 is not part of the exit.
