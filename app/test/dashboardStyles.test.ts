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
  it('uses a two-column minmax grid and one column at 900px', () => {
    const flat = squash(css);
    expect(flat).toContain('.dashboard-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; min-width: 0; }');
    expect(flat).toContain('.dashboard-panel { min-width: 0;');
    expect(flat).toContain('.dashboard-panel-activity { grid-column: 1 / -1; }');
    expect(flat).toMatch(/@media \(max-width: 900px\) \{ \.dashboard-grid \{ grid-template-columns: minmax\(0, 1fr\); \} \.dashboard-panel-activity \{ grid-column: auto; \} \}/);
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
});
