# P04-S14 — Workspace shell, navigation and destination placeholders

Status: To Do
Depends on: none (parent feature: board ticket T-014; builds on the startup screen, T-009/T-013)
Architecture: [P04 design contract](../README.md#design-contract), §A (workspace registry), §C (team definitions), §D (board); renderer rules: ticket T-014 (allowlisted preload only, one `serve` process)

## Goal
Selecting or creating a workspace on the startup screen opens a full-window two-pane shell: a left `nav` (active workspace name, concise path, "Switch workspace" action, data-driven items Home, Teams, Boards, Configuration) and one stable right content region. Home is the default; its content is a labelled placeholder that S19 replaces with the dashboard. Teams, Boards and Configuration render deliberate empty screens that say what will appear there and offer no mutating controls. Section state is local component state; no router dependency.

## Implement in this order
1. Discovery (record in Evidence): today `WorkspacesScreen.tsx` shows `SelectedView` (name, path, Back) when a row is selected or a workspace is created; `main.tsx` renders `StartupScreen` with `connectedView={<WorkspacesScreen api=.../>}`; `useConnection` is only called inside `StartupScreen`. The active workspace is the `Workspace` object (`app/src/renderer/api.ts`: id, name, path, missing, exists) already held by `WorkspacesScreen`.
2. Add `app/src/renderer/shell/navModel.ts`: `NavItem { id: 'home'|'teams'|'boards'|'configuration'; label: string; disabled?: boolean }` and the exported `NAV_ITEMS` array; `DEFAULT_SECTION = 'home'`. Layout and selection code iterate this array only.
3. Add `WorkspaceShell.tsx` (props: `workspace: Workspace`, `onSwitchWorkspace(): void`, `renderSection?` override for later stories) holding `section` state (default Home, reset to Home when `workspace.id` changes). Left pane: `<nav aria-label="Workspace">`, name with `title`, path in monospace with `title`, truncation by CSS ellipsis; buttons with `aria-current="page"` on the selected item; text labels always visible. Right pane: one `<main>` region with an `<h1>` per section; after a menu selection focus stays on the activated nav button (no focus loss to body).
4. Add `sections/SectionPlaceholder.tsx` and the three destination texts (Teams: teams and their members; Boards: phases and tickets; Configuration: workspace settings), each stating "Not available yet" language without buttons implying mutation. Home renders a `HomePlaceholder` marked as replaced by S19.
5. Change `WorkspacesScreen` so selecting a row or finishing create renders `WorkspaceShell` instead of `SelectedView`; "Switch workspace" returns to the list (reloading the list as Back does today), never calling create/unregister. The missing-folder behaviour (no open) stays.
6. Styles in `styles.css` using the existing T-013 tokens only: selected / hover / pressed / disabled / `:focus-visible` states, compact width (nav ≤ 240px, shrinks at the minimum window size), `prefers-reduced-motion` respected.

## Done when
- [ ] Selecting an existing workspace, and creating one, shows the shell with the workspace name and path, nav items Home, Teams, Boards, Configuration, and Home selected. Test: `app/test/workspaceShell.test.tsx` and updated `workspacesScreen.test.tsx`.
- [ ] Selecting each item changes only the right pane heading/content, sets `aria-current` on exactly one item, keeps the workspace header, and makes no `list`/`create` call. Test: `workspaceShell.test.tsx` with spies on the workspaces API.
- [ ] "Switch workspace" returns to the picker list; the registry is unchanged (no `create` call). Test: `workspacesScreen.test.tsx`.
- [ ] Keyboard: Tab reaches every item, Enter/Space activates, focus stays on the activated button, `:focus-visible` rule exists. Test: `workspaceShell.test.tsx` (focus assertions) and a CSS string check as in existing style tests.
- [ ] Adding one entry to `NAV_ITEMS` in a test renders a working item without editing layout code. Test: `navModel` test.
- [ ] Long name and path render with `title` attributes and ellipsis class. Test: `workspaceShell.test.tsx`.
- [ ] Existing startup, create-workspace and connection tests stay green. Validation: npm --prefix app test; npm --prefix app run typecheck; npm --prefix app run build.

Out of scope: dashboard data, new IPC, collapsible nav, routing library, persisting the section or workspace across reloads (a window reload returns to the picker, as today).

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
