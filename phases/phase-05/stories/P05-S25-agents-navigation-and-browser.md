# P05-S25 — Add Agents navigation and standalone catalog browser

Status: To Do
Depends on: P05-S13 (T-043), P05-S19 (T-051), P05-S24
Architecture: [Standalone Agents catalog management](../README.md#standalone-agents-catalog-management--t-056)

## Goal
Open a dedicated Agents screen from workspace navigation and move the visible catalog out of Teams, with searchable/filterable saved definitions, selection details, and truthful team-member references.

## Implement in this order
1. Add `agents` to `SectionId` and `NAV_ITEMS` in `app/src/renderer/shell/navModel.ts`; add a repository-native Agents icon through `app/src/renderer/icons/Icon.tsx` and `app/src/renderer/shell/ShellIcon.tsx`; route the section to a new `app/src/renderer/agents/AgentsScreen.tsx` from `WorkspaceShell.tsx`.
2. Add pure functions in `app/src/renderer/agents/agentsModel.ts` for case-insensitive name/id/description search, exact provider and reasoning filters, stable catalog-order results, selection fallback, and saved usage references. Usage must inspect every member `agentOptions` id, de-duplicate a member, include available team/member labels, and return unavailable or “at least” metadata when `team.overview` is unavailable/truncated.
3. In `AgentsScreen.tsx`, load `management.agents(workspace.id)` and `management.overview(workspace.id)` independently with `useDashboardSection`. Render the Agents breadcrumb/title, result count, labelled search/provider/reasoning controls, a keyboard-operable selectable list/table showing name, provider, model, reasoning, and usage, plus a details pane showing id and description.
4. Derive filter values only from returned catalog entries; do not hard-code mockup providers, models, counts, or agents. Keep a selected agent selected while visible; if search/filter removes it select the first visible result, and show a no-match state without changing catalog data.
5. Remove `AgentCatalogPanel` and its catalog problem presentation from `app/src/renderer/teams/TeamsScreen.tsx`, but retain the existing catalog request and data passed to `TeamDetailPanel`/`MemberForm`. Update the Teams subtitle so it describes team membership and live operation rather than hosting catalog management.
6. Add `app/test/agentsModel.test.ts`, `app/test/agentsScreen.test.tsx`, and focused updates to `workspaceShell.test.tsx`, `teamsScreen.test.tsx`, `dashboardHome.test.tsx`, `workspacesScreen.test.tsx`, and fixtures.

## Done when
- [ ] Workspace navigation contains one enabled Agents item, marks it current when selected, resets to Home after a workspace switch, and renders exactly one main `h1`. Test: `app/test/workspaceShell.test.tsx` and `app/test/agentsScreen.test.tsx`.
- [ ] Search and combined provider/reasoning filters operate on real response values in stable order; clearing filters restores the catalog and a no-match query has an explicit empty result. Test: `app/test/agentsModel.test.ts` and `app/test/agentsScreen.test.tsx`.
- [ ] Details and “Used by” include all ordered saved options, distinguish zero/unavailable/truncated usage, and never use runtime `activeAgent` as a saved reference. Test fixtures include a non-default option, duplicate references, missing labels, truncated teams/members, and a differing live agent.
- [ ] Teams no longer renders an Agent catalog region, but member add/edit still receives catalog options and existing Teams live controls remain unchanged. Test: `app/test/teamsScreen.test.tsx`, `app/test/teamEdit.test.tsx`, and `app/test/teamsLiveControls.test.tsx`.
- [ ] App tests, `npm --prefix app run typecheck`, and `npm --prefix app run build` pass.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
