# P05-S58 — Overview summary cards and running notice identical to v4

Status: To Do
Depends on: P05-S57
Architecture: [Teams overview v4 fidelity](../README.md#teams-overview-v4-fidelity)

## Design reference (authoritative)
- `design/teams-overview-v4.png` — implement the three summary cards and the info banner **as identical to the image as possible**.
- `design/teams-overview-v4.html` — exact markup and styles (the "Status cards" and "Running notice" blocks).
- Counts and states in the image are sample data.

## Current vs design
| Element | Current | v4 |
|---|---|---|
| Cards | "Team status" (name, pill, Definition/Coordinator/Live state list), "Board" (full-width pill, Run board + Stop board), "Member availability" (count text + chips) | three equal cards in a grid (`repeat(auto-fit, minmax(220px, 1fr))`, gap 12, bg `#16191d`, border `#262a30`, radius 10, padding 16, gap 10) in the order **Runtime, Availability, Board** |
| Runtime card | — | label "Runtime" (12 px/500 `#8d949e`); value "● Running" (18 px/600, 8 px dot in tone colour); detail "Coordinator running · live state available" (12 px `#a3a9b2`), built from the returned coordinator and live-state text |
| Availability card | chips per presence | label "Availability"; value "**6** / 6 available" (number 18/600, rest 14/500 muted); 6 px progress bar (track `#23272d`, fill `#4ac26b`, radius 3) with width = available ÷ members; other presences (working, offline …) as one muted line under the bar, e.g. "1 working" |
| Board card | two buttons always shown | label "Board" with an "Open board" link right-aligned; value "● Running"/"● Stopped"/…; detail "With this team" (or the existing conflict/unbound text); **one** small contextual button bottom-right: "■ Stop board" when running, "▶ Run board" when stopped (28 px high, 12 px/500) |
| Notice | note text inside "Team actions" | full-width info banner under the cards: bg `#151a22`, border `#22304a`, radius 8, padding 10×14, 15 px info icon `#7fb2ff`, text 12.5 px `#c4cad2`: "The team is running. Member edits apply on next start; stop the team to remove members or delete it." Shown only when the team is running; other existing notes (uneditable, problems) use the same banner style |

## Implement in this order
1. Rewrite `TeamStatusSummary`, `MemberAvailabilitySummary` and the `BoardControl` view in `TeamOverviewPanel.tsx` to the card markup. Keep the derived helpers in `teamsModel.ts` and `boardControlModel.ts`; add small helpers for the "6 / 6 available" text, bar ratio and "other presences" line, with unit tests.
2. The board button shows the action that applies (`view.canStop` → Stop board, `view.canRun` → Run board); when neither applies, show no button but keep the reason text. Pending, error and announcement behaviour stay as today.
3. "Open board" navigates to the Boards section (use the existing shell navigation; if Boards is not available, hide the link).
4. Stale, partial, truncated, stopped, unavailable and another-team states keep their current text, shown inside the matching card in the v4 style.
5. Update `teamsScreen.test.tsx`, `teamsLiveControls.test.tsx` and `boardControlModel.test.ts`.

## Done when
- [ ] The three cards and the banner match `design/teams-overview-v4.png` in order, sizes, colours and copy pattern. Test: fixture-matrix assertions for running/stopped/unavailable/another-team boards, full/partial availability (bar ratio) and the banner only for running teams.
- [ ] Board run/stop keeps locks, conflict handling and result feedback. Test: existing board-control suites.
- [ ] `npm --prefix app test`, `npm --prefix app run typecheck`, `npm --prefix app run build` pass.

## Evidence
(filled in when the story is done)
