# P04-S22 — Dashboard composition, responsive layout and accessibility

Status: To Do
Depends on: P04-S20, P04-S21
Architecture: [P04 design contract](../README.md#design-contract), §A (workspace registry), §C (team definitions), §D (board); renderer rules: ticket T-014 (allowlisted preload only, one `serve` process)

## Goal
Make the assembled dashboard consistent and accessible: panel grid that reflows at narrow widths, correct landmarks and focus behaviour, status never conveyed by colour alone, AA contrast and reduced motion, and cross-panel behaviour (Refresh, workspace switch, reconnect) proven together.

## Implement in this order
1. `styles.css`: dashboard grid (two columns above a width breakpoint, one below), no horizontal overflow hiding Refresh/View buttons at the minimum window size (`windowOptions.ts` minimum), monospace only for paths/keys/ids, flat T-013 tokens, `:focus-visible`, `@media (prefers-reduced-motion: reduce)` removes spinner/transition motion.
2. Semantics audit across `DashboardHome` and panels: one `h1`, panel `h2`s, `role="status"` for loading, `role="alert"` for errors, lists as lists; Refresh keeps focus on itself.
3. Composition tests: one Refresh issues one request per panel; a Refresh during a Refresh issues none; switching workspace (Switch workspace, then open another) discards in-flight responses of the first; connection `lost` replaced by the startup retry view and the shell is not left stale.
4. Contrast: tokens used for text/badges on dashboard surfaces are checked against 4.5:1 in a unit test over the token values in `styles.css`.

## Done when
- [ ] Each panel fails and retries independently with the other two unchanged. Test: `app/test/dashboardHome.test.tsx`.
- [ ] Refresh and workspace-switch behave as specified with no duplicate or stale updates. Test: same file.
- [ ] Status text exists for every status marker (not colour only); axe-style checks are limited to the assertions in the tests (no new dependency). Test: `dashboardA11y.test.tsx`.
- [ ] CSS contains the reduced-motion rule, focus-visible rules and the narrow breakpoint; contrast ratios ≥ 4.5:1. Test: `dashboardStyles.test.ts`.
- [ ] No dashboard code path calls a mutating API (all tests use the read-only fake). Test: existing tests plus `projectWiring.test.ts` extended if it checks the preload surface.
- [ ] Validation: npm --prefix app test; npm --prefix app run typecheck; npm --prefix app run build.

Out of scope: polling or auto-refresh, charts, customizable widgets, new dependencies.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
