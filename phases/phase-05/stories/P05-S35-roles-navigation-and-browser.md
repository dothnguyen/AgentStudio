# P05-S35 — Add Roles navigation and catalog browser

Status: To Do
Depends on: P05-S25, P05-S34
Architecture: [Roles catalog architecture](../README.md#verified-architecture-and-contract-gaps)

## Goal
Add a discoverable Roles destination beside Teams and Agents with real-data search, stable selection, role details, shared-instruction messaging, configured skills, assigned members, and independent partial/error states.

## Implement in this order
1. Add `roles` to `SectionId`, `NAV_ITEMS`, `IconName`, and `ShellIconName` in the shell/icon files; route a new `app/src/renderer/roles/RolesScreen.tsx` from `WorkspaceShell.tsx`. Reuse existing dark tokens and add scoped styles in `app/src/renderer/styles.css`.
2. Add pure `app/src/renderer/roles/rolesModel.ts` helpers for case-insensitive id/name/description search, stable file-order results, selected-id fallback, initials/labels, warning summaries, assigned-member labels, and usage partiality. Never derive permissions, agents, or live eligibility from a role.
3. Load `management.roles(workspace.id)` with `useDashboardSection`. Render one `h1`, a labelled search box/result count, keyboard-operable list selection, and a detail pane showing stable id, display name, description, read-only instruction content/state/path label, shared-by-all-members explanation, configured skill states, warnings, and saved/live assigned members.
4. Represent loading, missing/empty, no-match, invalid catalog, per-role partial instruction/skill, disconnected runtime, partial reference scan, and request error distinctly. Allow catalog inspection when runtime usage is unavailable; disable only unsafe mutations, not search/selection.
5. Remove the duplicate role-description editor/list from `app/src/renderer/teams/RoutingSettingsPanel.tsx` while retaining its routing role selector and validation. Add a link/button to Roles for routing-role context if useful, without coupling routing draft state.
6. Add `app/test/rolesModel.test.ts`, `app/test/rolesScreen.test.tsx`, and focused updates to `workspaceShell.test.tsx`, `icon.test.tsx`, and `routingSettingsPanel.test.tsx`. Parameterize loading, empty, no-match, invalid catalog, missing/truncated instructions, missing skills, partial usage, disconnected runtime, independent retry, and stale out-of-order workspace responses.
7. Add scoped wide/narrow layout rules: stack list/detail without page-level horizontal overflow, wrap long ids/paths/instructions/errors, preserve visible focus and target sizes, and use one main/h1, ordered headings, labelled controls, text with status color, restrained live regions, and native/listbox keyboard semantics.

## Done when
- [ ] Roles is enabled beside Teams/Agents, marks the current destination, resets to Home on workspace change, and renders one main/h1. Tests cover mouse and keyboard navigation plus shell icon semantics.
- [ ] Search uses returned id/name/description in stable order; selection persists while visible, falls back deterministically, and no-match/empty states are distinct.
- [ ] Details show actual instructions, configured/missing skills, warnings, assigned members and partial/disconnected state without claiming permissions or agents are inherited. Test fixtures include multiple teams, duplicate member labels, missing files, and runtime unavailable.
- [ ] Teams routing still validates and edits rules but no longer owns role-description editing. `npm --prefix app test -- roles workspaceShell routingSettingsPanel icon` passes.
- [ ] State-matrix and race tests reject stale workspace responses; automated wide/narrow assertions prove long content wraps, controls remain usable, and no page-level horizontal overflow appears.
- [ ] Keyboard-only search/selection/retry and semantic queries prove labelled controls, current navigation, visible focus, one main/h1, and restrained `status`/`alert` regions.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
