import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../src/renderer/styles.css'), 'utf8').replace(/\s+/g, ' ');

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|[}\\s])${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (match === null) throw new Error(`rule ${selector} not found`);
  return match[1]!;
}

describe('action menu v4 styles', () => {
  it('matches the design tokens for the fixed popover and its items', () => {
    const menu = rule('.ui-menu');
    for (const part of [
      'position: fixed',
      'background: #16191d',
      'border: 1px solid #262a30',
      'border-radius: 8px',
      'box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4)',
      'padding: 4px',
      'min-width: 200px',
      'max-width: 320px',
      'max-height: calc(100vh - 16px)',
      'overflow-y: auto',
    ]) expect(menu).toContain(part);

    const item = rule('.ui-menu-item');
    for (const part of ['min-height: 32px', 'font-size: 13px', 'overflow-wrap: anywhere']) expect(item).toContain(part);

    expect(rule('.ui-menu-separator')).toContain('background: #23262c');
    expect(rule('.ui-menu-reason')).toContain('font-size: 11.5px');
    expect(rule('.ui-menu-reason')).toContain('color: #8d949e');
    expect(rule('.ui-menu-check')).toContain('width: 14px');
  });

  it('has hover, focus, danger and disabled states and honours reduced motion', () => {
    expect(css).toContain(
      '.ui-menu-item:hover:not([aria-disabled="true"]), .ui-menu-item:focus-visible { background: #1b1f25;',
    );
    expect(css).toContain('outline: 2px solid var(--focus)');
    expect(css).toContain('.ui-menu-item-danger, .ui-menu-item-danger:hover:not([aria-disabled="true"]), .ui-menu-item-danger:focus-visible { color: #f48771; }');
    expect(css).toContain('.ui-menu-item[aria-disabled="true"] { color: #8d949e;');
    expect(css).toContain('@media (prefers-reduced-motion: reduce) { .ui-menu, .ui-confirm { transition: none; animation: none; } }');
  });

  it('drops the old absolute-positioned header popover', () => {
    expect(css).not.toContain('.teams-page-menu-popover');
    expect(css).not.toContain('.teams-page-menu { position: relative; }');
  });
});
