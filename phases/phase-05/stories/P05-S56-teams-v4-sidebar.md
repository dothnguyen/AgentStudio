# P05-S56 — Sidebar and team navigation identical to v4

Status: To Do
Depends on: P05-S55
Architecture: [Teams overview v4 fidelity](../README.md#teams-overview-v4-fidelity)

## Design reference (authoritative)
- `design/teams-overview-v4.png` — implement the left sidebar **as identical to the image as possible**.
- `design/teams-overview-v4.html` — exact sizes, colours and markup (the `<nav aria-label="Primary">` block).
- Team names and counts are sample data.

## Current vs design
| Element | Current | v4 |
|---|---|---|
| Brand | small mark + "Agent Studio" | 26×26 blue rounded tile (`#5b9cff`, radius 7) with terminal glyph, 14 px/600 "Agent Studio" |
| Workspace | "WORKSPACE" caption, name, path, down chevron | one card (bg `#14171b`, border `#23262c`, radius 8, padding 10): 28×28 initials avatar ("AS"), name 13/600, mono path 11 px muted with ellipsis, up/down chevron |
| Nav items | plain rows | 8×10 px padding, radius 6, 16 px stroke icons, `#b9bec6`; current item bg `#181b20`, text `#e7e9ec`, 500 |
| Teams | parent row, "New team" listed first, team row shows the word "Running" | Teams row with a chevron that shows it is expanded; nested list (left rule `#23262c`, indent 18 px): team rows with a status dot (green running, other states per runtime tone), name truncated with ellipsis, member count right-aligned (11 px muted); selected team bg `rgba(91,156,255,0.14)`; "+ New team" row **after** the teams |
| Footer | Switch workspace | same, with a top divider `#23262c` and 12 px padding |
| Width | ~240 | 240 px (min 220), sidebar bg `#0d0f12`, right border `#23262c` |

## Implement in this order
1. Update `app/src/renderer/shell/WorkspaceShell.tsx`, `ShellIcon.tsx` and `app/src/renderer/teams/WorkspaceTeamNavigation.tsx` markup to the v4 structure; keep every existing button, ref, `aria-current`, keyboard and focus behaviour, loading/error/notice states and the New team flow.
2. Replace the runtime word on team rows with a status dot plus visually hidden text (screen readers still hear the runtime state), and add the member count.
3. Move "New team" below the team list with a leading plus icon.
4. Style with the S55 tokens; match the reference sizes. Stopped/error/unknown teams use the matching tone dot; definition problems still show their warning text.
5. Update the sidebar/navigation tests for the new order and accessible names.

## Done when
- [ ] The sidebar matches `design/teams-overview-v4.png` in structure, sizes, colours, order and iconography. Test: `teamsScreen.test.tsx`/shell tests assert the order (teams before New team), the dot + hidden state text, the member count and the selected-row state.
- [ ] Keyboard, focus restoration, New team, workspace switching and refresh behaviour are unchanged. Test: existing navigation suites.
- [ ] `npm --prefix app test`, `npm --prefix app run typecheck`, `npm --prefix app run build` pass.

## Evidence
(filled in when the story is done)
