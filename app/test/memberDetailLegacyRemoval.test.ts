import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const appDir = resolve(__dirname, '..');
const read = (relativePath: string): string => readFileSync(resolve(appDir, relativePath), 'utf8');
const css = read('src/renderer/styles.css');

/** Every renderer source file, so a deleted component cannot linger in an import. */
function rendererSources(): string[] {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolute = resolve(dir, entry.name);
    if (entry.isDirectory()) return walk(absolute);
    return /\.(ts|tsx)$/.test(entry.name) ? [absolute] : [];
  });
  return walk(resolve(appDir, 'src/renderer'));
}

/**
 * T-111 removes the two temporary cards that came before the v7 sections.
 * These assertions read the production files because the removal itself is
 * the behaviour under test: a deleted card cannot be exercised through the UI.
 */
describe('member details v7 legacy editor removal', () => {
  it('removes the temporary configuration and live agent cards from the member panel', () => {
    const panel = read('src/renderer/teams/MemberDetailPanel.tsx');
    for (const legacy of [
      'Saved configuration (temporary)',
      'Live agent (temporary)',
      '// LEGACY',
      'liveActions',
      'MemberLiveAgentActions',
      'MemberForm',
      'memberFormInitial',
      'ticketPermissionText',
      'SAVED_OPTIONS_NOTE',
      'ROLE_SHARING_NOTE',
      'LIVE_STATE_NOTE',
    ]) {
      expect(panel, `MemberDetailPanel must not contain ${legacy}`).not.toContain(legacy);
    }
    expect(existsSync(resolve(appDir, 'src/renderer/teams/MemberLiveAgentActions.tsx'))).toBe(false);
    expect(read('src/renderer/teams/MembersView.tsx')).not.toMatch(/liveActions|MemberLiveAgentActions/);
  });

  it('keeps the add-member form and the shared live-agent row model', () => {
    // The Add member flow still renders MemberForm; only the duplicate edit-mode
    // editor was removed, so the component and its helpers stay.
    const forms = read('src/renderer/teams/TeamEditForms.tsx');
    expect(forms).toContain('export function MemberForm');
    expect(forms).toContain('export function TeamNameForm');
    expect(read('src/renderer/teams/MembersView.tsx')).toContain('<MemberForm');
    // The page and the Agents card both project the same row model.
    expect(read('src/renderer/teams/AgentsSection.tsx')).toContain('memberAgentActions');
    expect(read('src/renderer/teams/MemberDetailPanel.tsx')).toContain('memberAgentActions');
  });

  it('removes the styles that only the legacy cards used', () => {
    for (const selector of [
      '.teams-saved-configuration',
      '.teams-saved-options',
      '.teams-saved-option-detail',
      '.teams-live-actions',
      '.teams-live-summary',
      '.teams-live-options',
      '.teams-live-option-label',
      '.teams-live-option-actions',
      '.teams-live-reason',
    ]) {
      expect(css, `${selector} must be removed`).not.toContain(selector);
    }
    // Match the old class itself, not the new .teams-member-settings-card/grid.
    expect(css).not.toMatch(/\.teams-member-settings(?![-a-z])/);
    expect(css).not.toMatch(/\.teams-member-actions(?![-a-z])/);
  });

  it('still routes both row-menu intents to the v7 dialogs', () => {
    const panel = read('src/renderer/teams/MemberDetailPanel.tsx');
    expect(panel).toMatch(/props\.intent === 'edit'[\s\S]*setSettingsOpen\(true\)/);
    expect(panel).toMatch(/else setConfirmingRemove\(true\)/);
    expect(panel).toContain('<MemberSettingsDialog');
    expect(panel).toContain('role="alertdialog"');
  });

  it('leaves no import or render of the deleted live-actions component behind', () => {
    for (const file of rendererSources()) {
      const source = readFileSync(file, 'utf8');
      expect(source, `${file} still mentions the removed live-actions component`).not.toContain('MemberLiveAgentActions');
      expect(source, `${file} still passes the removed liveActions prop`).not.toContain('liveActions');
    }
  });

  it('drops the model helpers and constants that only the old editor used', () => {
    const model = read('src/renderer/teams/teamEditModel.ts');
    for (const name of [
      'ticketPermissionText',
      'memberFormInitial',
      'ROLE_SHARING_NOTE',
      'SAVED_OPTIONS_NOTE',
      'LIVE_STATE_NOTE',
    ]) {
      expect(model, `${name} must be removed from teamEditModel`).not.toMatch(new RegExp(`\\b${name}\\b`));
    }
    // The v7 card and dialog still need their own values.
    expect(model).toContain('ticketPermissionValue');
    expect(model).toContain('memberSettingsInitial');
  });

  it('drops the edit-mode branch from the shared member form', () => {
    const forms = read('src/renderer/teams/TeamEditForms.tsx');
    expect(forms).toContain("validateMemberForm(values, 'add', missing)");
    expect(forms).not.toContain('showMemberSettings');
    expect(forms).not.toContain('memberChanges');
    expect(forms).not.toMatch(/mode\s*:\s*'add'\s*\|\s*'edit'/);
  });
});
