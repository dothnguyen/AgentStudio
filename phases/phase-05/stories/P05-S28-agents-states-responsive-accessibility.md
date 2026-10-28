# P05-S28 — Complete Agents states, responsive layout, and accessibility

Status: To Do
Depends on: P05-S26, P05-S27
Architecture: [Standalone Agents catalog management](../README.md#standalone-agents-catalog-management--t-056)

## Goal
Finish the standalone Agents screen with independently truthful data states, keyboard and focus behavior, and a usable narrow layout, proven by automated component and accessibility checks rather than a live acceptance gate.

## Implement in this order
1. Add Agents-specific rules to `app/src/renderer/styles.css` using existing color, spacing, border, focus, and reduced-motion tokens. Match the mockup’s catalog-plus-details hierarchy at wide widths; below the existing supported breakpoint stack controls, catalog, and details without horizontal page overflow or clipped actions.
2. Complete independent catalog and usage loading/error/retry behavior in `AgentsScreen.tsx`: catalog failure owns its retry and blocks mutations, while overview failure leaves catalog browsing/editing available with usage explicitly unavailable. Preserve last successful data only if the existing section controller marks it as such; never fabricate stale references.
3. Add explicit initial loading, empty catalog, filtered empty, malformed catalog problems, disconnected/connecting, thrown request, pending write, and retry-success presentations. A disconnected screen may inspect loaded saved configuration but disables writes and says why; reconnect triggers the established scoped refresh behavior without duplicate calls.
4. Audit native labels, one `main`/`h1`, heading order, list/table and selected-item semantics, status/alert announcements, dialog name/description, focus return, visible `:focus-visible`, keyboard access to rows and menus, long strings, 4000-character descriptions, and reduced motion. Color is never the only provider/reasoning/error cue.
5. Add `app/test/agentsA11y.test.tsx` and focused state/layout assertions in `app/test/agentsScreen.test.tsx` and `app/test/workspaceShell.test.tsx`. Follow the existing jsdom/style assertion pattern; do not add screenshots, a manual E2E requirement, or a live Windows/WSL gate.

## Done when
- [ ] Catalog and usage loading, empty, partial, disconnected, error, retry, and reconnect states are independently labelled and never replace real values with mockup data. Test: `app/test/agentsScreen.test.tsx`.
- [ ] Search, filters, selection, create/edit/duplicate, confirmation, cancel, retry, and navigation are fully keyboard operable with deterministic focus placement/return and announced results. Test: `app/test/agentsA11y.test.tsx`.
- [ ] Automated wide and supported-narrow layout assertions prove stacked controls/details, wrapped long content, visible actions, and no fixed-width overflow; reduced-motion and visible-focus rules are present. Test: `app/test/agentsA11y.test.tsx` plus stylesheet assertions.
- [ ] Teams accessibility/runtime regressions remain covered after catalog removal. Test: `app/test/teamsScreen.test.tsx`, `app/test/teamEdit.test.tsx`, and `app/test/teamsLiveControls.test.tsx`.
- [ ] `npm --prefix app test`, `npm --prefix app run typecheck`, and `npm --prefix app run build` pass.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
