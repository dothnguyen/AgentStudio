import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../src/renderer/styles.css'), 'utf8').replace(/\s+/g, ' ');

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|[}\\s])${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (match === null) throw new Error(`rule ${selector} not found`);
  return match[1];
}

describe('teams v4 summary card styles', () => {
  it('teams_v4_summary_card_styles_match_reference', () => {
    expect(css).toContain('repeat(auto-fit, minmax(220px, 1fr))');
    for (const part of ['#16191d', '#262a30', 'border-radius: 10px', 'padding: 16px']) expect(css).toContain(part);
    for (const selector of ['.teams-summary-card', '.teams-overview-summaries .teams-board']) {
      for (const part of ['#16191d', '#262a30', 'border-radius: 10px', 'padding: 16px']) expect(rule(selector)).toContain(part);
    }
    const label = rule('.teams-summary-label');
    for (const part of ['font-size: 12px', 'font-weight: 500', '#8d949e']) expect(label).toContain(part);
    const value = rule('.teams-summary-value');
    for (const part of ['font-size: 18px', 'font-weight: 600', 'gap: 8px', '#e7e9ec']) expect(value).toContain(part);
    const total = rule('.teams-availability-total');
    for (const part of ['font-size: 14px', 'font-weight: 500', '#8d949e']) expect(total).toContain(part);
    const bar = rule('.teams-availability-bar');
    for (const part of ['height: 6px', 'border-radius: 3px', '#23272d']) expect(bar).toContain(part);
    expect(rule('.teams-availability-fill')).toContain('#4ac26b');
    expect(rule('.teams-availability-fill')).toContain('height: 100%');
    expect(rule('.teams-summary-link')).toContain('#7fb2ff');
    expect(rule('.teams-board-button')).toContain('height: 28px');
    expect(rule('.teams-board-button')).toContain('font-size: 12px');
    const banner = rule('.teams-info-banner');
    for (const part of ['#151a22', '#22304a', '12.5px', 'padding: 10px 14px', 'border-radius: 8px', 'gap: 10px']) expect(banner).toContain(part);
  });

  it('teams_v4_summary_styles_drop_the_old_board_actions_rule', () => {
    expect(css).not.toContain('.teams-board-actions');
  });
});
