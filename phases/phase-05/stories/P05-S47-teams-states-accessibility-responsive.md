# P05-S47 — Finish Teams states, accessibility, and responsive behavior

Status: To Do
Depends on: P05-S40, P05-S41, P05-S42, P05-S43, P05-S45, P05-S46
Architecture: [Focused Teams views](../README.md#focused-teams-views-t-073)

## Goal
Complete the focused Teams redesign with automated regression coverage for real loading/empty/disconnected/unavailable/partial/error states, keyboard and focus behavior, and narrow layouts. Prove that existing typed management operations and saved configuration behavior remain intact without adding a live or manual acceptance gate.

## Implement in this order
1. Audit the focused shell, Overview, Members, member detail, live-agent controls, and Routing against `design/teams-members-v2.png`, `teams-member-detail-v4.png`, and `teams-routing-v2.png` for hierarchy only. Consolidate dark-theme styles in `app/src/renderer/styles.css`; remove obsolete long-page selectors only after confirming no other screen uses them.
2. At desktop width, keep team context, tabs, status, actions, compact roster, two-column member detail, routing table, and disclosures readable. At narrow widths, stack panels, turn tables into labelled card/scroll presentations without clipping actions or hiding data, wrap long ids/errors/reset times, and keep dialogs within the viewport.
3. Verify one `h1`, logical headings/landmarks, labelled controls, native button/form semantics, status plus text (not color alone), `aria-live`/alert usage that does not double-announce, visible focus, minimum useful hit targets, reduced-motion compatibility, tab/disclosure/dialog keyboard behavior, and deterministic focus after navigation, cancel, save, delete/remove, refresh, and errors.
4. Add state matrices to `app/test/teamsScreen.test.tsx`, `teamsLiveControls.test.tsx`, `routingSettingsPanel.test.tsx`, and `workspaceShell.test.tsx` for initial loading, empty workspace/roster, connecting/lost/reconnected, coordinator/runtime unavailable, partial/truncated overview, catalog/role/board failure, stale retained data, mutation errors, polling timeout, invalid routing, and independent retries. Assert no illustrative design data appears.
5. Preserve and run regression suites for management IPC allowlisting and arguments, team create/rename/delete/member edits, role deep links, ordered saved options, board run/stop, live switch/resume/cancellation, routing SHA/protected routes/escalation, workspace switching, and Home/Agents/Roles navigation. Update test queries to the focused hierarchy instead of weakening assertions.
6. Run `npm --prefix app test`, `npm --prefix app run typecheck`, and `npm --prefix app run build`. Run focused Python board-settings/routing tests changed by S44; record commands and results in Evidence when implemented.

## Done when
- [ ] Every focused view has truthful loading, empty, disconnected, unavailable, partial, stale, and error handling with safe disabled actions and independent retry where applicable. Test: renderer state matrices.
- [ ] Team tabs, member rows, disclosures, forms, confirmations, and live-switch dialog are fully keyboard-operable with visible focus and deterministic restoration; status meaning is not color-only. Test: React keyboard/focus/accessibility assertions.
- [ ] Desktop and narrow layouts keep all returned content and actions reachable without overlap or page-level horizontal overflow. Test: responsive class/style assertions plus production build.
- [ ] Existing management IPC, team/member operations, role separation/deep links, board controls, switch/resume safety, routing persistence/protection/escalation, and workspace switching regressions pass with no new arbitrary renderer command.
- [ ] Focused Python tests, `npm --prefix app test`, `npm --prefix app run typecheck`, and `npm --prefix app run build` pass.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
