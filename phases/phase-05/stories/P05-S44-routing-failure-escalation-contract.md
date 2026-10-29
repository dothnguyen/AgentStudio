# P05-S44 — Expose routing failure escalation

Status: To Do
Depends on: P05-S11
Architecture: [Focused Teams views](../README.md#focused-teams-views-t-073)

## Goal
Expose the board's existing per-rule failure-limit policy through the typed management read model and routing draft helpers so the focused routing UI can show and edit escalation without losing hidden configuration. Do not change scheduler counting, routing, persistence, or validation semantics.

## Implement in this order
1. Inspect `backend/agent_studio/boardmodel.py` validation/application of `onFailureLimit`, the current `.agent-studio/board.json` QA/review escalation rules, `boardsettings.settings`, `app/src/shared/management.ts`, and `routingSettingsModel.ts`. Treat backend `boardmodel` validation as authoritative.
2. Add `onFailureLimit: null | { count: number; status: string }` to each agent `BoardRuleView` projection in `backend/agent_studio/boardsettings.py`; action rules return null. Copy validated values only and do not synthesize a default.
3. Mirror that exact shape in `app/src/shared/management.ts`, renderer API exports, and `app/test/teamsFixtures.ts`. Preserve backward-safe rendering of null and keep the raw `board.config.rules` draft as the source written by `board.settings.update`.
4. Extend `routingSettingsModel.ts` with explicit helpers to set, update, and remove `onFailureLimit`, preserving all unrelated/unknown rule fields. Validate enabled policies as a positive integer count and a returned board status; reject policies on action rules and include the escalation target in the reachability graph.
5. Add backend unit cases in `tests/unit/test_p05_s11_board_settings.py` proving projection of QA/review `{count: 3, status: "need-escalate"}`, null behavior, and no change to protected-route or update semantics. Add `app/test/routingSettingsModel.test.ts` cases for add/change/remove, invalid count/status, action-rule rejection, graph reachability, no-op detection, and preservation of `syncBase`, priorities, created-ticket policy, and unknown fields.
6. Run the focused Python and app model tests before the full app typecheck/build; no IPC channel or scheduler command is added.

## Done when
- [ ] `board.settings` projects validated `onFailureLimit` values exactly and null otherwise, with shared TypeScript types and fixtures matching the response. Test: `tests/unit/test_p05_s11_board_settings.py` and TypeScript typecheck.
- [ ] Routing draft helpers add, edit, or remove escalation without dropping unrelated raw rule fields and reject invalid counts, statuses, or action-rule policies. Test: `app/test/routingSettingsModel.test.ts`.
- [ ] QA and review escalation to the configured escalation status/`SeniorDeveloper` route is observable, while existing `boardmodel` failure counting and scheduler behavior are unchanged. Test: existing `test_p04_s09_rules_and_applier.py` plus projection tests.
- [ ] Focused Python tests, `npm --prefix app test`, `npm --prefix app run typecheck`, and `npm --prefix app run build` pass.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
