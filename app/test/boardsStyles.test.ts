import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../src/renderer/styles.css'), 'utf8');
const flat = css.replace(/\s+/g, ' ');

describe('Current Phase header styles', () => {
  it('uses the design typography and spacing for the breadcrumb, heading and progress', () => {
    expect(flat).toContain('.boards-breadcrumb { display: flex; align-items: center; gap: 6px; margin-bottom: -6px; color: #8d949e; font-size: 12px; }');
    expect(flat).toContain('.boards-phase-title h1 { margin: 0; color: var(--text); font-size: 22px; font-weight: 600; letter-spacing: -0.01em;');
    expect(flat).toContain('.boards-phase-progress-track { display: block; height: 8px; border-radius: var(--radius-pill); background: var(--chip-bg); overflow: hidden; }');
    expect(flat).toContain('.boards-phase-progress-fill { display: block; height: 100%; border-radius: var(--radius-pill); background: var(--success); }');
  });

  it('uses the blue Current pill and the same notice row as the design', () => {
    expect(flat).toContain('.boards-phase-pill { display: inline-flex; align-items: center; flex: none; padding: 3px 9px; border-radius: var(--radius-pill); background: rgba(91, 156, 255, 0.14); color: #9ec3ff;');
    expect(flat).toContain('.boards-notice { display: flex; align-items: center; gap: 10px; padding: 9px 14px; border: 1px solid var(--border); border-radius: var(--radius-banner); background: #14171a;');
  });

  it('stacks the progress under the heading at narrow widths and stops the skeleton animation', () => {
    expect(flat).toContain('@media (max-width: 700px) { .boards-phase-progress { flex-basis: 100%; max-width: none; } }');
    expect(flat).toContain('@media (prefers-reduced-motion: reduce) { .boards-skeleton-line { animation: none; opacity: 0.8; } }');
  });
});
