import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(resolve(__dirname, path), 'utf8');
const css = read('../src/renderer/styles.css');
const squash = (text: string): string => text.replace(/\s+/g, ' ');
const flat = squash(css);
const root = /:root \{[^}]*\}/.exec(flat)![0];

const tokens: Array<[string, string]> = [
  ['--bg', '#111316'],
  ['--sidebar-bg', '#0d0f12'],
  ['--surface', '#16191d'],
  ['--surface-raised', '#1b1f24'],
  ['--surface-hover', '#1b1f25'],
  ['--nav-hover', '#181b20'],
  ['--nav-active-bg', '#181b20'],
  ['--nav-team-active-bg', 'rgba(91, 156, 255, 0.14)'],
  ['--input-bg', '#121418'],
  ['--input-bg-alt', '#14171b'],
  ['--code-bg', '#1a1d22'],
  ['--chip-bg', '#1e2228'],
  ['--badge-bg', '#22262c'],
  ['--track-bg', '#23272d'],
  ['--avatar-bg', '#1f2630'],
  ['--avatar-text', '#9ec3ff'],
  ['--border', '#23262c'],
  ['--border-card', '#262a30'],
  ['--border-strong', '#2a2e35'],
  ['--border-row', '#1f2328'],
  ['--text', '#e7e9ec'],
  ['--text-bright', '#e7e9ec'],
  ['--text-secondary', '#c4cad2'],
  ['--text-nav', '#b9bec6'],
  ['--text-muted', '#a3a9b2'],
  ['--text-label', '#8d949e'],
  ['--accent', '#5b9cff'],
  ['--accent-hover', '#7fb2ff'],
  ['--accent-text', '#0b1220'],
  ['--link', '#7fb2ff'],
  ['--link-hover', '#a9cbff'],
  ['--focus', '#5b9cff'],
  ['--danger', '#f48771'],
  ['--danger-bg', 'rgba(244, 135, 113, 0.12)'],
  ['--warning', '#f0b453'],
  ['--warning-bg', 'rgba(240, 180, 83, 0.12)'],
  ['--success', '#4ac26b'],
  ['--success-text', '#6fd38b'],
  ['--success-bg', 'rgba(74, 194, 107, 0.12)'],
  ['--info', '#7fb2ff'],
  ['--info-bg', '#151a22'],
  ['--info-border', '#22304a'],
  ['--info-text', '#c4cdd9'],
  ['--radius-card', '10px'],
  ['--radius-banner', '8px'],
  ['--radius-control', '7px'],
  ['--radius-nav', '6px'],
  ['--radius-chip', '5px'],
  ['--radius-tag', '4px'],
  ['--radius-pill', '999px'],
  ['--control-height', '34px'],
  ['--control-height-sm', '32px'],
  ['--font-ui', '"Inter Variable", "Inter", "Segoe UI Variable", "Segoe UI", system-ui, sans-serif'],
  ['--font-mono', '"JetBrains Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace'],
];

const sharedRules: string[] = [
  '.ui-dot { display: inline-block; width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--text-label); }',
  '.ui-dot-lg { width: 8px; height: 8px; }',
  '.ui-dot-sm { width: 6px; height: 6px; }',
  '.ui-dot-success { background: var(--success); }',
  '.ui-dot-warning { background: var(--warning); }',
  '.ui-dot-danger { background: var(--danger); }',
  '.ui-dot-neutral { background: var(--text-label); }',
  '.ui-pill { display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px; border-radius: var(--radius-pill); background: var(--chip-bg); color: var(--text-secondary); font-size: 12px; font-weight: 500; }',
  '.ui-pill .ui-dot { width: 6px; height: 6px; }',
  '.ui-pill-success { background: var(--success-bg); color: var(--success-text); }',
  '.ui-pill-warning { background: var(--warning-bg); color: var(--warning); }',
  '.ui-pill-danger { background: var(--danger-bg); color: var(--danger); }',
  '.ui-tag { display: inline-block; padding: 1px 6px; border-radius: var(--radius-tag); font-size: 11px; }',
  '.ui-tag-warning { background: var(--warning-bg); color: var(--warning); }',
  '.ui-chip { display: inline-block; padding: 2px 8px; border: 1px solid var(--border-strong); border-radius: var(--radius-chip); background: var(--chip-bg); color: var(--text-secondary); font-size: 12px; }',
  '.ui-count { display: inline-block; padding: 1px 7px; border-radius: var(--radius-pill); background: var(--badge-bg); color: var(--text-secondary); font-size: 11px; }',
  '.ui-card { border: 1px solid var(--border-card); border-radius: var(--radius-card); background: var(--surface); }',
  '.ui-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: var(--control-height); min-height: var(--control-height); padding: 0 14px; border: 1px solid var(--border-strong); border-radius: var(--radius-control); color: var(--text); background: var(--surface); font-size: 13px; font-weight: 500; line-height: 1; }',
  '.ui-btn:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); background: var(--surface-raised); }',
  '.ui-btn-primary { border-color: var(--accent); color: var(--accent-text); background: var(--accent); font-weight: 600; }',
  '.ui-btn-primary:hover:not(:disabled) { border-color: var(--accent-hover); color: var(--accent-text); background: var(--accent-hover); }',
  '.ui-btn-sm { height: var(--control-height-sm); min-height: var(--control-height-sm); padding: 0 12px; font-size: 12.5px; }',
  '.ui-btn-xs { height: 28px; min-height: 28px; padding: 0 10px; border-radius: var(--radius-nav); background: var(--surface-raised); font-size: 12px; }',
  '.ui-icon-btn { width: var(--control-height); padding: 0; color: var(--text-nav); }',
  '.ui-banner { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border: 1px solid var(--info-border); border-radius: var(--radius-banner); color: var(--info-text); background: var(--info-bg); font-size: 12.5px; overflow-wrap: anywhere; }',
  '.ui-banner-icon { flex: none; color: var(--info); }',
  '.ui-col-head { color: var(--text-label); font-size: 11.5px; font-weight: 500; letter-spacing: 0.04em; text-transform: uppercase; }',
];

const MONO = 'font-family: "JetBrains Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace;';

describe('v4 visual foundation', () => {
  it('v4_root_tokens_match_reference', () => {
    for (const [name, value] of tokens) expect(root).toContain(`${name}: ${value};`);
    expect(root.indexOf('--bg:')).toBeLessThan(root.indexOf('--sidebar-bg:'));
  });

  it('v4_root_sets_ui_font_and_base_type', () => {
    expect(root).toContain('font-family: var(--font-ui);');
    const body = /(^|\} )body \{[^}]*\}/.exec(flat)![0];
    expect(body).toContain('font-size: 13px;');
    expect(body).toContain('line-height: 1.45;');
    expect(flat).toContain('button, input, select, textarea { font: inherit; }');
  });

  it('v4_fonts_are_bundled_and_imported', () => {
    const pkg = JSON.parse(read('../package.json'));
    expect(Object.keys(pkg.devDependencies)).toEqual(
      expect.arrayContaining(['@fontsource-variable/inter', '@fontsource/jetbrains-mono']),
    );
    expect(pkg.dependencies ?? {}).toEqual({});
    const main = read('../src/renderer/main.tsx');
    const stylesImport = main.indexOf("import './styles.css';");
    expect(stylesImport).toBeGreaterThan(-1);
    for (const line of [
      "import '@fontsource-variable/inter';",
      "import '@fontsource/jetbrains-mono/400.css';",
      "import '@fontsource/jetbrains-mono/500.css';",
    ]) {
      expect(main).toContain(line);
      expect(main.indexOf(line)).toBeLessThan(stylesImport);
    }
    expect(read('../vite.config.ts')).toContain('assetsInlineLimit: 0');
    const html = read('../src/renderer/index.html');
    expect(html).toContain("font-src 'self'");
    expect(html).not.toContain('fonts.googleapis');
    expect(html).not.toContain('fonts.gstatic');
  });

  it('v4_shared_classes_match_reference', () => {
    expect(sharedRules.length).toBeGreaterThanOrEqual(26);
    for (const rule of sharedRules) expect(flat).toContain(rule);
  });

  it('v4_base_controls_use_tokens', () => {
    expect(flat).toMatch(/button \{[^}]*border-radius: var\(--radius-control\);[^}]*background: var\(--surface\);/);
    expect(/button\.primary \{[^}]*\}/.exec(flat)![0]).toContain('color: var(--accent-text);');
    expect(flat).toMatch(
      /\.workspace-sidebar nav button\[aria-current="page"\] \{[^}]*background: var\(--nav-active-bg\);[^}]*box-shadow: inset 3px 0 var\(--accent\);/,
    );
    for (const value of ['#0e639c', '#1177bb', '#007fd4', '#4daafc', '#89d185', '#04395e', '#095a8d', '#2584c6', '#181818', '#1f1f1f']) {
      expect(css).not.toContain(value);
    }
  });

  it('v4_mono_font_stack_used_for_ids', () => {
    expect(/\.ticket-key, \.entity-id, \.dashboard-path \{[^}]*\}/.exec(flat)![0]).toContain(MONO);
    expect(/code, \.ws-path \{[^}]*\}/.exec(flat)![0]).toContain(MONO);
  });
});
