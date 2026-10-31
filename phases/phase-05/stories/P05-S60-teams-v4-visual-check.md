# P05-S60 — Teams overview screenshot check against v4

Status: To Do
Depends on: P05-S56, P05-S57, P05-S58, P05-S59
Architecture: [Teams overview v4 fidelity](../README.md#teams-overview-v4-fidelity)

## Design reference (authoritative)
- `design/teams-overview-v4.png` and `design/teams-overview-v4.html`. The finished screen should be as identical to the PNG as possible.

## Goal
Give the operator a one-command way to see how close the built Teams overview is to v4: render the real screen with a fixture equal to the mockup's sample data at 1440×1000, save a screenshot, and produce a side-by-side and a difference image.

## Implement in this order
1. Add a renderer fixture (test-only module) whose team, members, agents, board and availability equal the sample data in `design/teams-overview-v4.html` (Agent Studio Dev Team, `dev-team`, runtime `b4597175…f9548168`, six members lead/dev-1/dev-2/dev-3/reviewer/qa, lead switched to Codex 5.6 Sol medium, board running, 6/6 available).
2. Add an operator script (`npm --prefix app run capture:teams`, Windows/Electron, no new dependencies) that opens the renderer with that fixture in a 1440×1000 window, captures `test-results/teams-overview-v4-actual.png`, and writes `test-results/teams-overview-v4-compare.png` (design | actual | difference). Keep it out of the normal test run.
3. Unit-test the fixture wiring (the fixture renders through the real `TeamsScreen` and `WorkspaceShell`) under jsdom.
4. Document the command in `app/README.md`.
5. If any visible difference remains that the previous stories could not remove without breaking behaviour or accessibility, list it in Evidence with the reason.

## Done when
- [ ] The fixture renders the real Teams overview with the v4 sample data. Test: a jsdom test asserting the six rows, the "Switched" tag, the cards and the header from the fixture.
- [ ] `capture:teams` and its compare output are documented; running it is an operator check, not a condition for this story.
- [ ] `npm --prefix app test`, `npm --prefix app run typecheck`, `npm --prefix app run build` pass.

## Evidence
(filled in when the story is done)
