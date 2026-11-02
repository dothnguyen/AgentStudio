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

describe('Current Phase lane styles', () => {
  it('lets the board scroll horizontally while the page itself does not', () => {
    expect(flat).toContain('.boards-current-screen { display: flex; flex-direction: column; gap: 20px; max-width: 1240px; margin: 0 auto; min-width: 0; overflow-x: clip;');
    expect(flat).toContain('.boards-board { max-width: 100%; min-width: 0; overflow-x: auto; padding-bottom: 12px; margin: 0 -4px; padding-left: 4px; }');
  });

  it('uses the design lane header and 276px column card', () => {
    expect(flat).toContain('.boards-lane-name { display: inline-flex; align-items: center; gap: 8px; color: #a3a9b2; font-size: 12px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }');
    expect(flat).toContain('.boards-lane-count { color: #8d949e; font-weight: 500; letter-spacing: 0; text-transform: none; }');
    expect(flat).toContain('.boards-column { display: flex; flex-direction: column; gap: 10px; flex: none; width: 276px; padding: 10px; border: 1px solid #23262c; border-radius: 12px; background: #14171a; }');
  });

  it('uses dashed empty and show-more placeholders and a three-line card title', () => {
    expect(flat).toContain('.boards-column-empty { padding: 14px 8px; border: 1px dashed #262a30;');
    expect(flat).toContain('.boards-lane-hidden { align-self: flex-start; max-width: 150px; padding: 8px 12px; border: 1px dashed #2f343c;');
    expect(flat).toContain('.boards-column-more { width: 100%; min-height: 0; padding: 7px 10px; border: 1px dashed #343a43;');
    expect(flat).toContain('.boards-ticket-title { display: -webkit-box; overflow: hidden; font-weight: 500; -webkit-box-orient: vertical; -webkit-line-clamp: 3; }');
  });
});

describe('Needs attention card styles', () => {
  it('uses the amber card from the design with a warning header and compact rows', () => {
    expect(flat).toContain('.boards-attention { background: #16191d; border: 1px solid #4a3d1e; border-radius: 12px; overflow: hidden; }');
    expect(flat).toContain('.boards-attention-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 18px; border-bottom: 1px solid #2a2417; background: rgba(240, 180, 83, 0.05); }');
    expect(flat).toContain('.boards-attention-title { display: inline-flex; align-items: center; gap: 8px; margin: 0; color: #f0b453; font-size: 14px; font-weight: 600; }');
    expect(flat).toContain('.boards-attention-row { display: flex; align-items: center; gap: 12px; padding: 11px 18px; }');
    expect(flat).toContain('.boards-attention-open { flex: none; box-sizing: border-box; height: 28px; padding: 0 12px; border: 1px solid #2f343c; border-radius: 7px; background: #1b1f24;');
  });
});

describe('Board toolbar styles', () => {
  it('uses the design search field, 32px chips and right-aligned count', () => {
    expect(flat).toContain('.boards-search { display: flex; align-items: center; gap: 8px; width: min(300px, 100%); height: 36px;');
    expect(flat).toContain('.boards-filter-chip { display: inline-flex; align-items: center; gap: 7px; box-sizing: border-box; height: 32px; padding: 0 12px; border: 1px solid #2f343c; border-radius: var(--radius-pill); background: #1b1f24;');
    expect(flat).toContain('.boards-filter-chip[aria-pressed="true"] { border-color: #3d6bb3; background: rgba(91, 156, 255, 0.12); color: #9ec3ff; }');
    expect(flat).toContain('.boards-toolbar-count { flex: none; color: #8d949e; font-size: 12px;');
  });
});

describe('Ticket card styles', () => {
  it('colours the working and blocked left edges and shows a focus ring', () => {
    expect(flat).toContain('.boards-ticket-card[data-activity="working"] { border-left-color: #4ac26b; }');
    expect(flat).toContain('.boards-ticket-card[data-activity="blocked"] { border-left-color: #f0b453; }');
    expect(flat).toContain('button.boards-ticket-card:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }');
  });

  it('uses the design priority tag, two-line blocked reason and activity chips', () => {
    expect(flat).toContain('.boards-ticket-priority { flex: none; padding: 1px 7px; border-radius: 4px; background: rgba(91, 156, 255, 0.12); color: #9ec3ff; font-size: 11px; }');
    expect(flat).toContain('.boards-ticket-reason { display: -webkit-box; overflow: hidden; color: #f0b453; font-size: 12px; overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }');
    expect(flat).toContain('.boards-ticket-chip-working { color: #6fd38b; background: rgba(74, 194, 107, 0.12); }');
    expect(flat).toContain('.boards-ticket-chip-blocked { color: #f0b453; background: rgba(240, 180, 83, 0.12); }');
    expect(flat).toContain('.boards-ticket-chip-queued { color: #9ec3ff; background: rgba(91, 156, 255, 0.12); }');
  });
});
