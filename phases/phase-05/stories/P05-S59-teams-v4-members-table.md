# P05-S59 — Members table identical to v4

Status: Done (2026-11-01)
Depends on: P05-S58
Architecture: [Teams overview v4 fidelity](../README.md#teams-overview-v4-fidelity)

## Design reference (authoritative)
- `design/teams-overview-v4.png` — implement the Members section **as identical to the image as possible**.
- `design/teams-overview-v4.html` — exact markup and styles (the "Members" section and its rows).
- Member names, agents and the "Switched" example are sample data.

## Current vs design
| Element | Current | v4 |
|---|---|---|
| Container | bare section with "Members" heading | one card (bg `#16191d`, border `#262a30`, radius 10, overflow hidden) |
| Card header | "Add member" outlined button, then a wide search field and an Availability select | one row: "Members" (14/600) + count badge (11 px, bg `#22262c`, radius 999); right side: a 32 px filter input with search icon and placeholder "Filter members", and a primary "+ Add member" button (bg `#5b9cff`, text `#0b1220`, 600); bottom border `#23262c` |
| Column heads | Member · Role · Agent · Availability · Current work, sentence case | MEMBER · ROLE · LIVE AGENT · STATUS · CURRENT WORK — 11.5 px/500 uppercase, letter-spacing .04em, `#8d949e`; grid `2fr 1.2fr 2.2fr 1fr 1.1fr 28px`, gap 16, padding 10×16 |
| Rows | each row a bordered box | full-width rows, padding 12×16, 1 px divider `#1f2328`, hover bg `#1b1f25`, chevron-right icon in the last column |
| Member cell | name + id code | 30×30 initials avatar (bg `#1f2630`, text `#9ec3ff`, 11 px/600), name 13/500, id in JetBrains Mono 11 px `#8d949e` |
| Role cell | text + id | chip: bg `#1e2228`, border `#2a2e35`, radius 5, 12 px `#c4cad2` |
| Live agent | "Active: claude-sonnet-5-5-medium · claude · claude-sonnet-5-5" | catalog display name (13/500, e.g. "Claude Opus 5.5 medium"), with a "Switched" tag (11 px, `#f0b453` on `rgba(240,180,83,0.12)`, radius 4) when the live agent differs from the saved default; second line 11.5 px muted "provider · model · reasoning" |
| Status | pill with dot | dot (7 px) + text `#c4cad2`, no pill |
| Current work | "No current work" | "Idle" (muted) when there is none; otherwise the existing work summary (ticket, assignment, delegated-command waiting text) |

## Implement in this order
1. Restructure `MembersView.tsx` and `MemberList.tsx` to the card + grid markup. Keep rows as real buttons (or links) with the existing `data-member-row`, `aria-current`, row refs, open/back focus restoration and truncated/empty/no-match notes.
2. Filtering: the single filter field matches name, id, role, live agent name, status label and current work, so availability filtering stays possible by typing (e.g. "working"). Remove the separate Availability select; update `filterMembers` and its tests.
3. Live agent: use the catalog agent's display name for the runtime active agent (fall back to the saved default, then provider/model text, labelled as it is today when no live agent exists). "Switched" = runtime active agent differs from the member's saved default agent.
4. Initials: first letters of the name parts, or the first two characters, upper-cased; add a helper with tests.
5. Add member keeps the existing inline `MemberForm`, shown inside the card under the header.
6. At narrow widths the table scrolls horizontally inside the card (min-width 820 px), as in the reference.
7. Update `teamsScreen.test.tsx`, `teamsModel.test.ts`, `teamsA11y.test.tsx` and related suites.

## Done when
- [ ] The Members card matches `design/teams-overview-v4.png` (header row, column heads, row layout, avatar, role chip, live-agent name + Switched tag + meta line, dot status, "Idle", chevron). Test: row rendering assertions for a switched and a non-switched member, idle and working members.
- [ ] Opening a member, Back with focus restoration, Add member, truncation notes and filtering still work. Test: existing suites updated, plus filter-by-status text.
- [ ] `npm --prefix app test`, `npm --prefix app run typecheck`, `npm --prefix app run build` pass.

## Evidence
- Implementation: `app/src/renderer/teams/MembersView.tsx`, `app/src/renderer/teams/MemberList.tsx`, `app/src/renderer/teams/teamsModel.ts`, `app/src/renderer/icons/Icon.tsx`, `app/src/renderer/styles.css`.
- Tests: `app/test/teamsScreen.test.tsx` (`v4 members card`, updated "member roster" suites), `app/test/teamsModel.test.ts` (initials, live agent, row work, filters), `app/test/dashboardStyles.test.ts` (`members_card_uses_v4_values`), `app/test/teamsA11y.test.tsx`, `app/test/teamsLiveControls.test.tsx`, `app/test/teamEdit.test.tsx`.
- Local run: `npx vitest run` in `app/` — 59 files, 1405 tests passed.
- Delegated `test-ui` (`python3 scripts/validate.py --ui`): npm test, typecheck and build pass.
- Operator visual check at 1440×1000 against `design/teams-overview-v4.png` remains an operator check, not a condition for this story.
