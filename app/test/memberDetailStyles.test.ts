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

function parts(selector: string, expected: string[]): void {
  const body = rule(selector);
  for (const part of expected) expect(body, `${selector} should contain ${part}`).toContain(part);
}

/** Returns the numeric px values of a padding/margin shorthand from a rule body. */
function pxValues(selector: string, property: 'padding' | 'margin'): number[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const bodies = Array.from(css.matchAll(new RegExp(`(?:^|[}\\s])${escaped}\\s*\\{([^}]*)\\}`, 'g')), (match) => match[1]!);
  for (const body of bodies) {
    const match = new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`).exec(body);
    if (match !== null) return match[1]!.trim().split(/\s+/).map((value) => Number.parseInt(value, 10));
  }
  throw new Error(`${property} not found on ${selector}`);
}

/** Expands the 1-4 value CSS shorthand into top, right, bottom, left. */
function edges(values: number[]): [number, number, number, number] {
  if (values.length === 1) return [values[0]!, values[0]!, values[0]!, values[0]!];
  if (values.length === 2) return [values[0]!, values[1]!, values[0]!, values[1]!];
  if (values.length === 3) return [values[0]!, values[1]!, values[2]!, values[1]!];
  return [values[0]!, values[1]!, values[2]!, values[3]!];
}

describe('member details v7 styles', () => {
  it('matches the page header and notice styles', () => {
    parts('.teams-member-hero-avatar', ['width: 48px', 'height: 48px', 'border-radius: 50%', '#1f2630', '#9ec3ff']);
    parts('.teams-role-chip', ['#1e2228', 'border: 1px solid #2a2e35', 'font-size: 12px']);
    parts('.teams-member-notice', ['background: #14171a', 'border: 1px solid #23262c', 'font-size: 12.5px']);
    parts('.teams-live-status-grid', ['repeat(auto-fit, minmax(130px, 1fr))']);
  });

  it('matches the member name, role chip and id subline', () => {
    parts('.teams-member-title-row h1', ['font-size: 22px', 'font-weight: 600', '#e7e9ec']);
    parts('.teams-member-subline', ['font-size: 12px', '#a3a9b2']);
    parts('.teams-member-subline code', ['color: #e7e9ec']);
  });

  it('matches the SectionCard and its action button', () => {
    parts('.section-card', ['background: #16191d', 'border: 1px solid #262a30', 'border-radius: 12px']);
    parts('.section-card-header', ['padding: 14px 18px', 'border-bottom: 1px solid #23262c']);
    parts('.section-card-heading h2', ['font-size: 14px', 'font-weight: 600']);
    parts('.section-card-heading p', ['font-size: 12px', '#8d949e']);
    parts('.teams-screen .section-card-action', ['height: 32px', 'padding: 0 12px', 'border: 1px solid #2f343c', 'border-radius: 7px', 'background: #1b1f24', 'font-size: 12.5px', 'font-weight: 500']);
    expect(rule('.teams-screen .section-card-action:hover:not(:disabled)')).toContain('#222831');
  });

  it('matches the Dialog backdrop, panel, header, footer and actions', () => {
    parts('.dialog-backdrop', ['padding: 96px 24px 24px', 'background: rgba(6, 7, 9, 0.68)']);
    parts('.dialog-panel', ['background: #16191d', 'border: 1px solid #2f343c', 'border-radius: 14px', 'box-shadow: 0 24px 64px rgba(0, 0, 0, 0.55)', 'max-height: calc(100vh - 120px)']);
    parts('.dialog-header', ['padding: 16px 20px', 'border-bottom: 1px solid #23262c']);
    parts('.dialog-header h2', ['font-size: 15px', 'font-weight: 600']);
    parts('.dialog-footer', ['border-top: 1px solid #23262c', 'background: #14171a']);
    parts('.dialog-footer-note', ['font-size: 12px', '#8d949e']);
    // The footer buttons get their own class so the legacy .dialog-actions
    // divider, margin and padding do not add a second line above them.
    const footerActions = rule('.dialog-footer-actions');
    for (const part of ['display: flex', 'gap: 8px', 'margin: 0 0 0 auto', 'padding: 0', 'border: 0']) expect(footerActions).toContain(part);
    expect(footerActions).not.toContain('border-top');
    expect(footerActions).not.toContain('margin-top');
    expect(footerActions).not.toContain('padding-top');
    parts('.dialog-action', ['height: 34px']);
    parts('.dialog-action-primary', ['background: #5b9cff', 'color: #0b1220', 'font-weight: 600']);
    parts('.dialog-action:disabled', ['opacity: 0.45']);
  });

  it('matches the Remove member card', () => {
    parts('.teams-member-remove', ['border: 1px solid #3a2626', 'border-radius: 12px']);
    parts('.teams-member-remove-actions button', ['border: 1px solid #4a2c2c', 'color: #b88a8a']);
  });

  it('composes the page padding to 28px 40px 56px from the shell wrappers', () => {
    const workspace = edges(pxValues('.workspace-content', 'padding'));
    const screenPad = edges(pxValues('.teams-screen.teams-screen-v4', 'padding'));
    const screenMargin = edges(pxValues('.teams-screen.teams-screen-v4', 'margin'));
    const detail = edges(pxValues('.teams-member-detail', 'padding'));
    // 32 (workspace) - 4 (screen top margin) = 28 top
    expect(workspace[0]!).toBe(32);
    expect(screenMargin[0]!).toBe(-4);
    expect(workspace[0]! + screenMargin[0]! + detail[0]!).toBe(28);
    // 32 (workspace) + 8 (screen side padding) = 40 sides
    expect(workspace[1]! + screenPad[1]! + detail[1]!).toBe(40);
    // 32 (workspace) + 16 (screen bottom) + 8 (detail bottom) = 56 bottom
    expect(workspace[2]!).toBe(32);
    expect(screenPad[2]!).toBe(16);
    expect(detail[2]!).toBe(8);
    expect(workspace[2]! + screenPad[2]! + detail[2]!).toBe(56);
  });

  it('matches the role instructions card and edit dialog tokens', () => {
    parts('.role-instructions-preview', ['border: 1px solid #23262c', 'border-radius: 8px', 'background: #121418', 'overflow: hidden']);
    parts('.role-instructions-preview pre', ['max-height: 168px', 'overflow: hidden', 'font-size: 12px', 'line-height: 1.6', 'color: #c4cad2']);
    parts('.role-instructions-fade', ['height: 56px', 'linear-gradient(to bottom, rgba(18, 20, 24, 0), #121418)']);
    parts('.role-instructions-field .role-instructions-prompt-input', ['min-height: 280px', 'resize: vertical', 'font-family: var(--font-mono)', 'font-size: 12.5px']);
    parts('.role-instructions-note', ['background: rgba(240, 180, 83, 0.07)', 'color: #f0b453', 'font-size: 12px']);
    parts('.dialog-subtitle', ['font-size: 12px', '#a3a9b2']);
  });

  it('does not let the new dialog title group inherit the legacy .dialog-heading layout', () => {
    // CreateWorkspaceDialog still uses the older flex heading.
    parts('.dialog-heading', ['display: flex', 'gap: 11px', 'margin-bottom: 20px']);
    const group = rule('.dialog-title-group');
    expect(group).toContain('min-width: 0');
    expect(group).not.toContain('display');
    expect(group).not.toContain('gap');
    expect(group).not.toContain('margin');
  });

  it('does not double the padding inside the legacy live-agent card', () => {
    expect(rule('.section-card .teams-live-actions')).toContain('padding: 0;');
  });

  it('styles the v7 Agents card rows and the Edit agent options dialog', () => {
    parts('.teams-agents-card .section-card-body', ['padding: 0']);
    parts('.teams-agent-row', ['display: flex', 'align-items: center', 'gap: 12px', 'padding: 13px 18px']);
    parts('.teams-agent-row.is-active', ['background: rgba(91, 156, 255, 0.06)']);
    parts('.teams-agent-mark', ['width: 34px', 'height: 34px', 'border-radius: 8px', '#1f2630', '#9ec3ff']);
    parts('.teams-agent-tag.is-default', ['color: #9ec3ff', 'background: rgba(91, 156, 255, 0.12)']);
    parts('.teams-agent-tag.is-live', ['color: #6fd38b', 'background: rgba(74, 194, 107, 0.12)']);
    parts('.teams-agents-diff', ['background: rgba(240, 180, 83, 0.07)', 'color: #f0b453', 'font-size: 12px']);
    parts('.member-agent-options-row', ['display: flex', 'align-items: center', 'gap: 10px', 'padding: 10px 12px', 'background: #121418']);
    parts('.member-agent-options-mark', ['width: 30px', 'height: 30px', 'border-radius: 7px']);
    parts('.member-agent-options-icon', ['width: 28px', 'height: 28px', 'border-radius: 6px']);
    parts('.member-agent-options-add', ['border: 1px dashed #343a43', 'border-radius: 8px']);
  });
});
