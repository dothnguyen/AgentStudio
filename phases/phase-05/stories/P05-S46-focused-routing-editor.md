# P05-S46 — Refactor the focused routing editor

Status: To Do
Depends on: P05-S45
Architecture: [Focused Teams views](../README.md#focused-teams-views-t-073)

## Goal
Provide a focused, safe routing editor for existing status transitions, worktree behavior, failure escalation, and protected routes. Preserve raw configuration fields, optimistic concurrency, backend graph validation, and conflict protections while making when changes apply clear.

## Implement in this order
1. Reuse `createRoutingDraft`, `boardSettingsChanges`, `validateRoutingDraft`, and the raw `board.config.rules`; split the editor UI into compact sections that correspond to the S45 read view. Continue to submit only `board.settings.update(workspaceId, changes, expectedSha256)`.
2. Keep base branch, source status, role, workflow, workspace, pass, fail, blocked, and existing read/write fields editable exactly where supported. Add an optional Failure escalation control for agent rules with positive integer count and target status, backed by S44 helpers; disabling it removes only `onFailureLimit`.
3. Preserve every unedited raw rule property, including `syncBase`, `maxRounds`, `priority`, `onFailPriority`, `onPassCreatedTickets`, and future unknown keys. No-op submit performs no write, Cancel discards the draft, and changing one field cannot rewrite a role, workflow, status list, or other rule.
4. Keep protected conflict validation for `merge-conflict` and `plan-merge-conflict` → `TeamLead`, duplicate-source and done-reachability checks, dynamic role/workflow/status options, unavailable-workflow disabling, and backend `BOARD_CONFIG_INVALID` problems beside the exact field.
5. Explain that a successful save changes the workspace board routing used for future claims/transitions; it does not change member roles, edit shared role instructions, cancel current assignments, or claim that in-flight work was rerouted.
6. Preserve disconnected/invalid/missing inspect-only behavior, single-submit locking, `CONFIG_CHANGED` draft retention, explicit Reload latest settings, failed reload feedback, post-save fresh reload, and truthful saved confirmation only after refresh.
7. Expand `app/test/routingSettingsModel.test.ts` and `routingSettingsPanel.test.tsx` for failure-policy editing, QA/review escalation retention, protected-route rejection, unknown-field preservation, dynamic options, no-op/cancel, double submit, configuration conflict/reload, backend validation, disconnect, and post-save copy.

## Done when
- [ ] The editor can change existing routing/worktree fields and add/edit/remove agent-rule failure escalation while preserving every unrelated raw field. Test: `routingSettingsModel.test.ts` and submitted-payload assertions in `routingSettingsPanel.test.tsx`.
- [ ] Invalid graphs, thresholds, targets, workflows, roles, duplicate sources, unreachable completion, and protected conflict routes cannot be presented as saved; backend problems map to exact fields. Test: routing model/panel invalid-case matrix.
- [ ] Disconnect, invalid/missing config, concurrent SHA change, failed reload, rapid submit, cancel, and no-op behavior remain safe and truthful. Test: `routingSettingsPanel.test.tsx`.
- [ ] UI copy states workspace-wide timing and does not mutate roles, members, or current assignments. Test: component assertions and API call assertions.
- [ ] `npm --prefix app test`, `npm --prefix app run typecheck`, and `npm --prefix app run build` pass.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
