# P05-S45 — Build the focused routing view

Status: To Do
Depends on: P05-S39, P05-S44, P05-S38
Architecture: [Focused Teams views](../README.md#focused-teams-views-t-073)

## Goal
Turn the workspace board settings into a readable Routing view with a scan-friendly workflow table and focused expandable summaries for worktrees, escalation, and protected conflict routes. Make workspace-wide effect and unavailable configuration explicit.

## Implement in this order
1. Refactor `RoutingSettingsPanel.tsx` into read and edit compositions under `app/src/renderer/teams/`, mounted only in the S39 Routing child panel. Pass the existing board section controller and `onViewRole` callback; do not load a second board or role source.
2. Label the view “Workspace board routing” and explain that changes affect every team using this workspace board, not only the selected team. Show board missing/invalid, roles missing/invalid, disconnected, stale retained data, loading, reload error, and backend problem states without sample routes.
3. Render returned rules in configured order with source status, type, assigned role/action, workflow, workspace mode, pass, fail, blocked, maximum rounds, priority, and failure-limit escalation. Resolve display labels from returned statuses/role catalog only while retaining stable ids; unavailable workflows and missing roles remain explicit.
4. Make role cells/actions deep-link to the stable role in the separate Roles catalog through `onViewRole`; never render role description/instruction editing in Teams. If role catalog data is unavailable or the id is undefined, show the stable id/diagnostic without a broken link.
5. Add keyboard-operable native expandable sections for merge/worktree settings, failure escalation, protected conflict routing, action rules, and workflow availability. The escalation summary must make the configured QA/review threshold → escalation status → `SeniorDeveloper` workflow chain understandable from returned data, without hard-coding those names.
6. Keep protected `merge-conflict` and `plan-merge-conflict` routes visibly distinguished by returned `protectedRoutes`, including Needs repair. Keep on-pass-created-ticket/action details sourced from `actionRules`.
7. Update `app/test/routingSettingsPanel.test.tsx`, `teamsScreen.test.tsx`, and fixtures for dynamic labels, reordered/custom statuses, agent/action rules, failure escalation, role deep links, missing roles/workflows, invalid/missing config, protected repair, disclosure keyboard behavior, and workspace-wide copy.

## Done when
- [ ] Routing shows every returned transition and policy in configured order, including pass/fail/blocked, workspace, action, max rounds, priority, and failure escalation, with no hard-coded workflow/status names. Test: `routingSettingsPanel.test.tsx`.
- [ ] Workspace-wide scope is explicit; role links use stable ids and role instructions/descriptions cannot be edited from Routing. Test: `routingSettingsPanel.test.tsx` and `teamsScreen.test.tsx`.
- [ ] Worktree, escalation, action, workflow, and protected-route summaries are keyboard-operable, and missing/invalid/unavailable/repair states remain understandable. Test: component keyboard/state matrix.
- [ ] `npm --prefix app test`, `npm --prefix app run typecheck`, and `npm --prefix app run build` pass.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
