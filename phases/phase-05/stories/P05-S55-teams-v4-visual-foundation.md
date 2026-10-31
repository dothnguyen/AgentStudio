# P05-S55 — Teams v4 visual foundation: colours, type, fonts, radii

Status: To Do
Depends on: none
Architecture: [Teams overview v4 fidelity](../README.md#teams-overview-v4-fidelity)

## Design reference (authoritative)
- `design/teams-overview-v4.png` (1440×1000) — the target. Implement the screen **as identical to this image as possible**.
- `design/teams-overview-v4.html` — the same design as static HTML with inline styles. Read exact colours, sizes, spacing, radii and font weights from it instead of estimating from the PNG.
- Names, members, agents and counts in both files are sample data. Show real data; everything else (layout, sizes, colours, type, iconography, copy style) must match.

## Goal
The app's current palette (VS Code greys, `--accent: #0e639c`, Segoe UI, 30 px controls) is the main reason the Teams screen looks unlike v4. Replace the shared design tokens with the v4 system so the shell and Teams screen can be built to match the image.

## Implement in this order
1. In `app/src/renderer/styles.css` set the `:root` tokens to the v4 values (taken from the reference HTML):
   - page `--bg: #111316`; sidebar `#0d0f12`; card/surface `#16191d`; raised/hover `#1b1f25`, `#181b20`; input bg `#121418`/`#14171b`.
   - borders `#23262c` (dividers, sidebar edge, tab rule), `#262a30` (cards), `#2a2e35` (buttons/inputs), row dividers `#1f2328`.
   - text `#e7e9ec` (primary), `#c4cad2`/`#b9bec6` (secondary), `#a3a9b2` (muted), `#8d949e` (labels, column heads).
   - accent `#5b9cff` (primary button bg, active tab underline, links `#7fb2ff`, hover `#a9cbff`), primary button text `#0b1220`.
   - success `#4ac26b` (dots, bars) with text `#6fd38b` and pill bg `rgba(74,194,107,0.12)`; warning `#f0b453` with bg `rgba(240,180,83,0.12)`; info banner bg `#151a22`, border `#22304a`, icon `#7fb2ff`.
   - radii: cards 10 px, buttons/inputs 7 px, chips 5 px, pills 999 px; control height 34 px (header buttons) / 32 px (card buttons).
   Keep the existing token names where they exist so other screens follow; add new tokens only where v4 needs a distinct value.
2. Typography: base 13 px / 1.45 line-height, UI font **Inter** (400/500/600/700) and mono **JetBrains Mono** (400/500) for ids. The renderer CSP is `font-src 'self'`, so bundle the fonts (for example `@fontsource-variable/inter` and `@fontsource/jetbrains-mono`, imported from `main.tsx`). Adding a dependency is a delegated command that needs human approval (`app-dev-dependency-add`); request it. If it is refused, fall back to `"Inter", "Segoe UI Variable", "Segoe UI", system-ui` and report it.
3. Define the shared visual pieces the next stories reuse, as CSS classes matching the reference: status dot (7–8 px circle), status pill, chip, count badge, card, primary button, secondary button, icon button (34×34), info banner, uppercase column header (11.5 px, 500, letter-spacing .04em).
4. Check that Home, Agents, Roles and Configuration still render legibly with the new tokens (no unreadable text, no missing borders). Do not redesign those screens.

## Done when
- [ ] `:root` tokens, fonts and shared classes match the values in `design/teams-overview-v4.html`; fonts are bundled and load under the existing CSP. Test: a `dashboardStyles.test.ts`-style assertion that `styles.css` defines the v4 token values, and that `main.tsx` imports the font packages.
- [ ] Existing screens remain readable; no test regressions. `npm --prefix app test`, `npm --prefix app run typecheck`, `npm --prefix app run build` pass.

## Evidence
(filled in when the story is done)
