import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../src/renderer/styles.css'), 'utf8');

function squash(text: string): string {
  return text.replace(/\s+/g, ' ');
}

function readToken(name: string): string {
  const match = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(css);
  if (match === null) throw new Error(`token ${name} not found`);
  return match[1];
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => {
    const value = parseInt(hex.slice(index, index + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

interface MediaBlock { width: number; body: string }

// Returns every @media (max-width: Npx) block with its body, brace-balanced so a
// nested rule cannot cut the block short the way a lazy regex would.
function readMaxWidthBlocks(text: string): MediaBlock[] {
  const blocks: MediaBlock[] = [];
  const opener = /@media \(max-width: (\d+)px\) \{/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(text)) !== null) {
    let depth = 1;
    let index = opener.lastIndex;
    while (index < text.length && depth > 0) {
      if (text[index] === '{') depth += 1;
      else if (text[index] === '}') depth -= 1;
      index += 1;
    }
    blocks.push({ width: Number(match[1]), body: text.slice(opener.lastIndex, index - 1) });
  }
  return blocks;
}

describe('dashboard styles', () => {
  it('member_roster_styles_have_focus_and_selection', () => {
    const flat = squash(css);
    // One focus ring only: the row ring (covering the whole row), not the button's.
    expect(flat).toContain('.teams-screen button.teams-member-open:focus-visible { outline-color: transparent; }');
    expect(flat).toContain('.teams-screen .teams-member-row:has(.teams-member-open:focus-visible) { outline: 2px solid var(--focus); outline-offset: -2px; }');
    expect(flat).toContain('.teams-screen .teams-member-row[data-current="true"] {');
    expect(flat).toContain('.teams-members-scroll { overflow-x: auto; max-width: 100%; }');
    expect(flat).toMatch(/\.teams-members-table \{[^}]*min-width: 820px;/);
    expect(flat).not.toMatch(/\.teams-member-list-head \{[^}]*display: none/);
  });
  it('members_card_uses_v4_values', () => {
    const flat = squash(css);
    expect(flat).toContain('.teams-roster { display: flex; flex-direction: column; min-width: 0; background: #16191d; border: 1px solid #262a30; border-radius: 10px; overflow: hidden; }');
    expect(flat).toContain('--teams-members-cols: minmax(0, 2fr) minmax(0, 1.2fr) minmax(0, 2.2fr) minmax(0, 1fr) minmax(0, 1.1fr) 28px 28px;');
    expect(flat).toContain('grid-template-columns: var(--teams-members-cols); gap: 16px;');
    expect(flat).toContain('text-transform: uppercase; letter-spacing: 0.04em;');
    expect(flat).toContain('background: #5b9cff; color: #0b1220;');
    expect(flat).toContain('color: #f0b453; background: rgba(240, 180, 83, 0.12);');
    expect(flat).toContain('background: #1f2630; color: #9ec3ff;');
    expect(flat).toContain('.teams-screen .teams-member-row:has(.teams-member-open):hover { background: #1b1f25;');
  });
  it('member_rows_fill_the_table_and_share_the_header_columns', () => {
    const flat = squash(css);
    const template = 'minmax(0, 2fr) minmax(0, 1.2fr) minmax(0, 2.2fr) minmax(0, 1fr) minmax(0, 1.1fr) 28px 28px';
    expect(flat.split(template)).toHaveLength(2);
    expect(template.match(/minmax\(0, [\d.]+fr\)|\d+px/g)).toEqual([
      'minmax(0, 2fr)', 'minmax(0, 1.2fr)', 'minmax(0, 2.2fr)', 'minmax(0, 1fr)', 'minmax(0, 1.1fr)', '28px', '28px',
    ]);
    const table = /\.teams-members-table \{([^}]*)\}/.exec(flat);
    expect(table).toBeTruthy();
    expect(table![1]).toContain(`--teams-members-cols: ${template};`);
    expect(table![1]).toContain('min-width: 820px;');
    const shared = /\.teams-member-list-head, \.teams-member-row \{([^}]*)\}/.exec(flat);
    expect(shared).toBeTruthy();
    expect(shared![1]).toContain('display: grid;');
    expect(shared![1]).toContain('grid-template-columns: var(--teams-members-cols);');
    expect(shared![1]).toContain('gap: 16px;');
    expect(flat.match(/\.teams-member-list-head, \.teams-member-row \{/g)).toHaveLength(1);
    expect(flat).toContain('.teams-member-list > li { display: block; min-width: 0; margin: 0; padding: 0; }');
    const row = /\.teams-screen \.teams-member-row \{([^}]*)\}/.exec(flat);
    expect(row).toBeTruthy();
    expect(row![1]).toContain('width: 100%;');
    expect(row![1]).toContain('box-sizing: border-box;');
    expect(row![1]).toContain('overflow-wrap: anywhere;');
    // header text and row cells share the same 16px left padding, so their columns line up
    expect(flat).toContain('.teams-member-list-head { padding: 10px 16px;');
    expect(row![1]).toContain('padding: 12px 16px;');
    expect(flat).toContain('.teams-members-scroll { overflow-x: auto; max-width: 100%; }');
    // T-095 (6747ad3) deliberately removed the old <=700px one-column member-row
    // override; P05-S59 step 6 replaced it with horizontal scrolling. Nothing below
    // 820px may collapse the shared template, so every row stays as wide as the
    // table (width: 100%) and scrolls with it inside .teams-members-scroll.
    // One narrow-width block holds both the routing table scroll and the row menu.
    expect(flat).toMatch(/@media \(max-width: 700px\) \{ [^@]*\.routing-table-wrap \{ overflow-x: auto; max-width: 100%; \} [^@]*\.teams-row-menu \{ position: absolute; top: 8px; right: 8px; \} [^@]*\.teams-member-chevron \{ visibility: hidden; \} \}/);
    expect(flat).not.toMatch(/@media \(max-width: 700px\) \{[^}]*\.teams-member-(row|list-head)/);
    const scroll = /\.teams-members-scroll \{([^}]*)\}/.exec(flat);
    expect(scroll).toBeTruthy();
    expect(scroll![1]).toContain('overflow-x: auto;');
    expect(scroll![1]).toContain('max-width: 100%;');
  });
  it('member_selection_and_hover_paint_the_full_row_without_changing_other_values', () => {
    const flat = squash(css);
    const selected = /\.teams-screen \.teams-member-row\[data-current="true"\] \{([^}]*)\}/.exec(flat);
    expect(selected).toBeTruthy();
    expect(selected![1]).toContain('background: #1b1f25;');
    expect(selected![1]).toContain('box-shadow: inset 2px 0 0 #5b9cff;');
    expect(selected![1]).not.toMatch(/(^| )(width|max-width|margin|padding):/);
    const hover = /\.teams-screen \.teams-member-row:has\(\.teams-member-open\):hover \{([^}]*)\}/.exec(flat);
    expect(hover).toBeTruthy();
    expect(hover![1]).toContain('background: #1b1f25;');
    expect(hover![1]).not.toMatch(/(^| )(width|max-width|margin|padding):/);
    // The row is clickable through the open button's positioned pseudo-element;
    // the menu trigger sits above it so a click on ⋯ does not open the detail.
    expect(flat).toContain('.teams-member-open::after { content: ""; position: absolute; inset: 0; }');
    expect(flat).toContain('.teams-row-menu { position: relative; z-index: 1;');
    // Raised specificity so the 28px trigger is not stretched by the shared
    // .teams-screen button min-height: 36px rule.
    const menuTrigger = /\.teams-screen \.teams-row-menu \.teams-member-menu-trigger \{([^}]*)\}/.exec(flat);
    expect(menuTrigger).toBeTruthy();
    expect(menuTrigger![1]).toContain('inline-size: 28px; block-size: 28px;');
    expect(menuTrigger![1]).toContain('min-height: 0;');
    expect(flat).toContain('.teams-row-menu { position: absolute; top: 8px; right: 8px; }');
    expect(flat).toContain('.teams-member-chevron { visibility: hidden; }');
    // long text wraps inside its own grid cell instead of pushing the next column across
    expect(flat).toContain('.teams-member-field { display: flex; flex-direction: column; gap: 2px; min-width: 0; }');
    expect(flat).toMatch(/\.teams-member-name \{[^}]*overflow-wrap: anywhere;/);
    expect(flat).toMatch(/\.teams-role-chip \{[^}]*overflow-wrap: anywhere;/);
    expect(flat).toMatch(/\.teams-member-agent-line \{[^}]*flex-wrap: wrap;/);
  });

  it('member_columns_are_never_restacked_below_the_scrolling_breakpoint', () => {
    // T-095 (6747ad3) removed the old <=700px one-column override; P05-S59 step 6
    // made the card scroll horizontally instead. No narrow-width media block may
    // reintroduce a per-breakpoint column definition or hide the header, otherwise
    // rows would stop matching the header the fix just aligned them with.
    const narrow = readMaxWidthBlocks(css).filter(block => block.width <= 820);
    expect(narrow.length).toBeGreaterThan(0);
    for (const block of narrow) {
      expect(block.body).not.toMatch(/[^{}]*\.teams-member-(row|list-head)[^{}]*\{[^}]*grid-template-columns/);
      expect(block.body).not.toMatch(/[^{}]*\.teams-member-list-head[^{}]*\{[^}]*display:\s*none/);
    }
    // The responsive contract is the scroll container plus the table's min-width.
    const flat = squash(css);
    expect(flat).toContain('.teams-members-scroll { overflow-x: auto; max-width: 100%; }');
    expect(flat).toMatch(/\.teams-members-table \{[^}]*min-width: 820px;/);
  });

  it('removes_the_in_content_team_chooser_styles', () => {
    const flat = squash(css);
    for (const selector of ['.teams-layout', '.teams-list-panel', '.teams-card-list', '.teams-card', '.teams-card-name', '.teams-card-facts']) {
      expect(flat).not.toContain(selector);
    }
  });

  it('sidebar_team_navigation_matches_v4', () => {
    const flat = squash(css);
    expect(flat).toMatch(/\.team-nav \{[^}]*margin: 2px 0 6px 18px;[^}]*padding-left: 10px;[^}]*border-left: 1px solid #23262c;/);
    expect(flat).toMatch(/\.team-nav-dot \{[^}]*width: 7px;[^}]*height: 7px;[^}]*border-radius: 50%;/);
    expect(flat).toContain('.team-nav-dot-ok { background: #4ac26b; }');
    expect(flat).toMatch(/\.team-nav-label \{[^}]*min-width: 0;[^}]*text-overflow: ellipsis;/);
    expect(flat).toMatch(/\.team-nav-count \{[^}]*color: #a3a9b2;[^}]*font-size: 11px;/);
    expect(flat).toMatch(/button\.team-nav-item-selected[^{]*\{[^}]*background: rgba\(91, 156, 255, 0\.14\);/);
    expect(flat).toMatch(/\.team-nav-warning \{[^}]*overflow-wrap: anywhere;/);
    expect(flat).toContain('.team-nav :is(button):focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }');
    expect(flat).toMatch(/\.visually-hidden \{[^}]*position: absolute;[^}]*clip-path: inset\(50%\);/);
  });

  it('sidebar_matches_v4_shell_values', () => {
    const flat = squash(css);
    expect(flat).toMatch(/\.workspace-sidebar \{[^}]*gap: 18px;[^}]*border-right: 1px solid #23262c;[^}]*background: #0d0f12;/);
    expect(flat).toMatch(/\.sidebar-brand-tile \{[^}]*width: 26px;[^}]*height: 26px;[^}]*border-radius: 7px;[^}]*background: #5b9cff;/);
    expect(flat).toMatch(/\.workspace-selector \{[^}]*padding: 10px;[^}]*border: 1px solid #23262c;[^}]*border-radius: 8px;[^}]*background: #14171b;/);
    expect(flat).toMatch(/\.workspace-avatar \{[^}]*width: 28px;[^}]*height: 28px;[^}]*background: #1f2630;/);
    expect(flat).toMatch(/\.workspace-sidebar nav button \{[^}]*padding: 8px 10px;[^}]*color: #b9bec6;[^}]*border-radius: 6px;/);
    expect(flat).toMatch(/\.sidebar-footer \{[^}]*margin-top: auto;[^}]*padding-top: 12px;[^}]*border-top: 1px solid #23262c;/);
    expect(flat).toMatch(/\.workspace-shell \{[^}]*grid-template-columns: 240px minmax\(0, 1fr\);/);
    expect(flat).toMatch(/@media \(max-width: 700px\) \{ \.workspace-shell \{ grid-template-columns: 220px minmax\(0, 1fr\); \} \}/);
  });

  it('home_grid_puts_wide_board_beside_team_and_stacks_at_1080px', () => {
    const flat = squash(css);
    expect(flat).toContain('.dashboard-grid { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: 16px; min-width: 0; }');
    expect(flat).toContain('.dashboard-panel { min-width: 0;');
    expect(flat).toContain('.dashboard-panel-activity { grid-column: 1 / -1; }');
    expect(flat).toMatch(/@media \(max-width: 1080px\) \{ \.dashboard-grid \{ grid-template-columns: minmax\(0, 1fr\); \} \.dashboard-panel-activity \{ grid-column: auto; \} \}/);
    expect(flat).toMatch(/\.dashboard-actions \{[^}]*flex-wrap: wrap/);
  });

  it('keeps dashboard controls visible and focused', () => {
    const flat = squash(css);
    expect(flat).toMatch(/\.dashboard-panel button:focus-visible[^{]*\{ outline: 2px solid var\(--focus\); outline-offset: 2px; \}/);
    expect(flat).toContain('overflow-wrap: anywhere');
    const dashboardRules = css.split('}').filter((rule) => /dashboard|panel-|team-|board-/.test(rule.split('{')[0]));
    expect(dashboardRules.length).toBeGreaterThan(0);
    for (const rule of dashboardRules) expect(rule).not.toMatch(/overflow-x:\s*hidden/);
  });

  it('keeps the compact shell and header reachable at narrow widths', () => {
    const flat = squash(css);
    expect(flat).toMatch(/\.workspace-sidebar \{[^}]*overflow-y: auto/);
    const sidebarRule = /\.workspace-sidebar \{[^}]*\}/.exec(flat)![0];
    expect(sidebarRule).not.toContain('overflow: hidden');
    expect(flat).toMatch(/\.sidebar-footer \{[^}]*margin-top: auto/);
    expect(flat).toMatch(/\.dashboard-header \{[^}]*flex-wrap: wrap/);
    expect(flat).toMatch(/\.breadcrumb ol \{[^}]*flex-wrap: wrap/);
    expect(flat).toMatch(/\.dashboard-workspace-name \{[^}]*overflow-wrap: anywhere/);
    expect(flat).toMatch(/\.workspace-name, \.workspace-path \{[^}]*text-overflow: ellipsis/);
    expect(flat).toMatch(/\.workspace-sidebar nav button\[aria-current="page"\] \{[^}]*background: #181b20;[^}]*font-weight: 500;/);
    expect(flat).toMatch(/button:focus-visible[^{]*\{ outline: 2px solid var\(--focus\)/);
  });

  it('disables motion when reduced motion is requested', () => {
    const flat = squash(css);
    const block = flat.slice(flat.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(block).toContain('animation-duration: 0.01ms !important');
    expect(block).toContain('transition-duration: 0.01ms !important');
    expect(block).toMatch(/\.spinner \{ animation: none;/);
  });

  it('keeps every dashboard text and badge token pair at WCAG AA contrast', () => {
    const pairs: Array<[string, string, string]> = [
      ['--text on --surface', readToken('--text'), readToken('--surface')],
      ['--text-bright on --surface', readToken('--text-bright'), readToken('--surface')],
      ['--text-muted on --surface', readToken('--text-muted'), readToken('--surface')],
      ['--text-label on --surface', readToken('--text-label'), readToken('--surface')],
      ['--accent-text on --accent', readToken('--accent-text'), readToken('--accent')],
      ['--danger on error surface', readToken('--danger'), '#241f1f'],
      ['warning text on warning surface', '#d7ba7d', '#29271d'],
      ['--text-muted on --surface-raised', readToken('--text-muted'), readToken('--surface-raised')],
      ['--text-muted on --bg', readToken('--text-muted'), readToken('--bg')],
      ['--success-text on --surface', readToken('--success-text'), readToken('--surface')],
      ['--link on --surface', readToken('--link'), readToken('--surface')],
      ['--info-text on --info-bg', readToken('--info-text'), readToken('--info-bg')],
      ['active nav text', '#e7e9ec', '#181b20'],
      ['sidebar nav text', '#b9bec6', '#0d0f12'],
      ['team count', '#a3a9b2', '#0d0f12'],
      ['workspace path', '#8d949e', '#14171b'],
      ['selected team text', '#e7e9ec', '#182333'],
    ];
    for (const [label, foreground, background] of pairs) {
      expect(contrastRatio(foreground, background), label).toBeGreaterThanOrEqual(4.5);
    }
    expect(css).toContain('#241f1f');
    expect(css).toContain('#29271d');
  });

  it('limits monospace styling to paths keys ids and code', () => {
    const mono = /font-family:[^;]*monospace/;
    const rules = css.split('}').map((rule) => rule.trim()).filter((rule) => mono.test(rule));
    const dashboardRule = rules.find((rule) => rule.includes('.ticket-key'));
    expect(dashboardRule).toBeDefined();
    const selectors = dashboardRule!.split('{')[0].split(',').map((item) => item.trim()).sort();
    expect(selectors).toEqual(['.dashboard-path', '.entity-id', '.ticket-key']);
    for (const rule of rules) {
      const names = rule.split('{')[0];
      expect(names).not.toMatch(/\.dashboard-panel|\bh[1-6]\b|button|\.status-badge/);
    }
  });

  it('reflows the board status grid without clipping', () => {
    const flat = squash(css);
    expect(flat).toContain('.dashboard-panel .board-status-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 120px), 1fr)); gap: 8px; margin: 0 0 14px; }');
    expect(flat).toMatch(/\.dashboard-panel \.board-status-cell \{[^}]*min-width: 0;/);
    expect(flat).toContain('.board-phase-name, .board-status-name, .board-ticket-title { min-width: 0; overflow-wrap: anywhere; }');
    const boardRules = css.split('}').filter((rule) => rule.split('{')[0].includes('board-'));
    for (const rule of boardRules) {
      expect(rule).not.toContain('nowrap');
      expect(rule).not.toContain('overflow-x: hidden');
    }
  });

  it('summary_cards_wrap_without_horizontal_scroll', () => {
    const flat = squash(css);
    expect(flat).toContain('.summary-cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr));');
    expect(flat).toMatch(/@media \(max-width: 900px\) \{ \.summary-cards \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \} \}/);
    expect(flat).toContain('.summary-card { min-width: 0;');
    expect(/\.summary-card \{[^}]*\}/.exec(flat)![0]).toContain('overflow-wrap: anywhere');
    const rules = css.split('}').filter((rule) => rule.split('{')[0].includes('summary-'));
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule).not.toMatch(/overflow-x:\s*hidden/);
      expect(rule.replace(/minmax\([^;]*\)/g, '')).not.toMatch(/(^|[\s;])(min-|max-)?width:\s*\d+px/);
    }
  });

  it('activity_table_fits_narrow_widths_without_clipping', () => {
    const flat = squash(css);
    expect(flat).toContain('.activity-table { width: 100%; table-layout: fixed; border-collapse: collapse; }');
    expect(flat).toMatch(/\.activity-table th, \.activity-table td \{[^}]*overflow-wrap: anywhere/);
    expect(flat).toContain('.activity-table .activity-col-type { width: 22%; }');
    expect(flat).toContain('.activity-table .activity-col-time { width: 30%; }');
    const rules = css.split('}').filter((rule) => rule.split('{')[0].includes('activity-'));
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule).not.toMatch(/overflow-x:\s*hidden/);
      expect(rule).not.toMatch(/text-overflow:\s*ellipsis/);
      expect(rule).not.toMatch(/white-space:\s*nowrap/);
      expect(rule).not.toMatch(/(^|[\s;])(min-|max-)?width:\s*\d+px/);
    }
  });

  it('wraps team cards and long names at narrow widths', () => {
    const flat = squash(css);
    expect(flat).toMatch(/\.team-heading \{[^}]*flex-wrap: wrap/);
    expect(flat).toMatch(/\.team-name \{[^}]*min-width: 0/);
    expect(flat).toMatch(/\.team-name \{[^}]*overflow-wrap: anywhere/);
    expect(flat).toMatch(/\.team-facts, \.team-presence \{[^}]*flex-wrap: wrap/);
    expect(flat).toMatch(/\.team-row \{[^}]*min-width: 0/);
    expect(flat).not.toContain('.team-metadata');
  });

  it('refresh_timestamp_and_note_wrap_at_narrow_widths', () => {
    const flat = squash(css);
    expect(flat).toMatch(/\.dashboard-actions time \{[^}]*overflow-wrap: anywhere/);
    expect(flat).toMatch(/\.dashboard-refresh-note \{[^}]*flex-basis: 100%[^}]*overflow-wrap: anywhere/);
    const narrow = flat.slice(flat.indexOf('@media (max-width: 560px)'));
    expect(narrow).toContain('.dashboard-refresh-note { text-align: left; }');
    expect(flat).toMatch(/\.refresh-button:focus-visible[^{]*\{ outline: 2px solid var\(--focus\)/);
  });

  it('narrow_window_reduces_content_padding', () => {
    expect(squash(css)).toMatch(/@media \(max-width: 700px\) \{ \.workspace-content \{ padding: 20px 16px; \} \}/);
  });

  it('long_header_text_and_timestamps_wrap', () => {
    const flat = squash(css);
    expect(flat).toMatch(/\.dashboard-actions time \{[^}]*overflow-wrap: anywhere/);
    expect(flat).toContain('.dashboard-panel th, .dashboard-panel td { min-width: 0; overflow-wrap: anywhere; }');
    expect(flat).toContain('.dashboard-panel table { width: 100%; table-layout: fixed; border-collapse: collapse; }');
    expect(flat).toMatch(/\.dashboard-workspace-name \{[^}]*overflow-wrap: anywhere/);
    expect(flat).toMatch(/\.dashboard-path \{[^}]*overflow-wrap: anywhere/);
  });

  it('dashboard_rules_have_no_wide_fixed_widths_or_nowrap', () => {
    const rules = css.split('}').map((rule) => {
      const parts = rule.split('{');
      return { selector: parts[parts.length - 2]?.trim() ?? '', body: parts[parts.length - 1] };
    }).filter((rule) => /dashboard|summary-|team-|board-|activity-/.test(rule.selector));
    expect(rules.length).toBeGreaterThan(10);
    for (const rule of rules) {
      const body = rule.body.replace(/(minmax|min)\([^;]*\)/g, '');
      for (const match of body.matchAll(/(?<![\w-])(?:min-)?width:\s*(\d+)px/g)) {
        expect(Number(match[1]), rule.selector).toBeLessThanOrEqual(360);
      }
      if (!rule.selector.includes('activity-') && !rule.selector.endsWith('.team-nav-label')) expect(rule.body, rule.selector).not.toMatch(/white-space:\s*nowrap/);
    }
  });

  it('focus_outline_is_never_removed', () => {
    const flat = squash(css);
    expect(css).not.toMatch(/outline:\s*(none|0)\s*;/);
    expect(flat).toContain('button:focus-visible');
    expect(flat).toMatch(/button:focus-visible[^{]*\{ outline: 2px solid var\(--focus\); outline-offset: 2px; \}/);
  });
});

describe('icon tones', () => {
  it('icon_tones_use_existing_palette_tokens', () => {
    const flat = squash(css);
    for (const tone of ['success', 'info', 'warning', 'danger']) {
      expect(flat).toContain(`.icon-${tone} { color: var(--${tone}); }`);
    }
    expect(readToken('--success')).toBe('#4ac26b');
    expect(readToken('--info')).toBe('#7fb2ff');
    for (const token of ['--success', '--info', '--warning', '--danger']) {
      expect(contrastRatio(readToken(token), readToken('--surface'))).toBeGreaterThanOrEqual(3);
    }
    const rule = /\.icon \{[^}]*\}/.exec(flat)![0];
    expect(rule).toContain('stroke: currentColor');
    expect(rule).not.toMatch(/(^|[\s{;])(width|height):/);
  });
});

describe('routing screen', () => {
  it('routing_header_and_notice_keep_the_existing_panel_focus_styles', () => {
    const flat = squash(css);
    expect(flat).toContain('.routing-screen { display: flex; flex-direction: column; gap: 22px; max-width: 1240px; margin: 0 auto;');
    expect(flat).toContain('.routing-heading { display: flex; flex-direction: column; gap: 4px; min-width: 0; max-width: 760px; }');
    expect(flat).toContain('.routing-notice { display: flex; align-items: center; gap: 10px;');
    expect(flat).toContain('.routing-notice svg { flex: none; color: #9ec3ff; }');
    expect(flat).toContain('.routing-screen .routing-refresh { display: inline-flex;');
    expect(flat).toContain('.teams-routing-link { margin: 4px 0 0; color: var(--text-muted); font-size: 12.5px; }');
    expect(flat).toContain('.routing-settings :is(input, textarea, select, button):focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }');
    expect(flat).toContain('.teams-view-panel:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }');
  });
});

describe('teams overview', () => {
  it('teams_overview_styles_use_tokens', () => {
    const flat = squash(css);
    expect(flat).toContain('.teams-overview-summaries { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));');
    expect(flat).toContain('.teams-summary-card { display: flex;');
    expect(flat).toMatch(/@media \(max-width: 560px\) \{[^@]*\.teams-overview-summaries \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  });
});
