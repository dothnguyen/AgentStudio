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

describe('dashboard styles', () => {
  it('member_roster_styles_have_focus_and_selection', () => {
    const flat = squash(css);
    expect(flat).toContain('.teams-member-row:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }');
    expect(flat).toContain('.teams-member-row[aria-current="true"] {');
    expect(flat).toMatch(/@media \(max-width: 760px\) \{\s*\.teams-member-list-head \{ display: none; \}/);
  });
  it('keeps team list item spacing separate from card layout', () => {
    const flat = squash(css);
    expect(flat).toContain('.dashboard-panel .teams-card-list li { display: block; padding: 4px 0; }');
    expect(flat).toMatch(/\.teams-card \{ display: flex; flex-direction: column;/);
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
    expect(flat).toMatch(/\.switch-workspace \{[^}]*margin-top: auto/);
    expect(flat).toMatch(/\.dashboard-header \{[^}]*flex-wrap: wrap/);
    expect(flat).toMatch(/\.breadcrumb ol \{[^}]*flex-wrap: wrap/);
    expect(flat).toMatch(/\.dashboard-workspace-name \{[^}]*overflow-wrap: anywhere/);
    expect(flat).toMatch(/\.workspace-name, \.workspace-path \{[^}]*text-overflow: ellipsis/);
    expect(flat).toMatch(/\.workspace-sidebar nav button\[aria-current="page"\] \{[^}]*box-shadow: inset 3px 0/);
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
      ['white on --accent', '#ffffff', readToken('--accent')],
      ['--danger on error surface', readToken('--danger'), '#241f1f'],
      ['warning text on warning surface', '#d7ba7d', '#29271d'],
      ['--text-muted on --surface-raised', readToken('--text-muted'), readToken('--surface-raised')],
      ['--text-muted on --bg', readToken('--text-muted'), readToken('--bg')],
      ['breadcrumb current on --bg', '#4daafc', readToken('--bg')],
      ['active nav text', readToken('--text-bright'), '#04395e'],
    ];
    for (const [label, foreground, background] of pairs) {
      expect(contrastRatio(foreground, background), label).toBeGreaterThanOrEqual(4.5);
    }
    expect(css).toContain('#241f1f');
    expect(css).toContain('#29271d');
    expect(css).toContain('#04395e');
    expect(css).toContain('#4daafc');
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
      if (!rule.selector.includes('activity-')) expect(rule.body, rule.selector).not.toMatch(/white-space:\s*nowrap/);
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
    expect(readToken('--success')).toBe('#89d185');
    expect(readToken('--info')).toBe('#4daafc');
    for (const value of ['#89d185', '#4daafc']) expect(css.split(value).length).toBeGreaterThan(2);
    for (const token of ['--success', '--info', '--warning', '--danger']) {
      expect(contrastRatio(readToken(token), readToken('--surface'))).toBeGreaterThanOrEqual(3);
    }
    const rule = /\.icon \{[^}]*\}/.exec(flat)![0];
    expect(rule).toContain('stroke: currentColor');
    expect(rule).not.toMatch(/(^|[\s{;])(width|height):/);
  });
});

describe('teams navigation', () => {
  it('teams_tabs_have_selected_state_and_visible_focus', () => {
    const flat = squash(css);
    expect(flat).toContain('.teams-view-tab[aria-selected="true"] { border-bottom-color: var(--focus);');
    expect(flat).toContain('.teams-view-tab:focus-visible, .teams-card:focus-visible, .teams-view-panel:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }');
    expect(/\.teams-view-tabs \{[^}]*flex-wrap: wrap/.test(flat)).toBe(true);
  });
});

describe('teams overview', () => {
  it('teams_overview_styles_use_tokens', () => {
    const flat = squash(css);
    expect(flat).toContain('.teams-overview-facts { display: grid;');
    expect(flat).toContain('.teams-overview-facts dt { color: var(--text-muted);');
    expect(flat).toMatch(/@media \(max-width: 560px\) \{[^@]*\.teams-overview-facts \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  });
});
