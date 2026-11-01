// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../src/renderer/api';
import { RolesScreen } from '../src/renderer/roles/RolesScreen';
import type { RoleCatalogList } from '../src/shared/management';
import { fakeManagement } from './teamsFixtures';
import { roleItem, rolesFixture } from './rolesFixtures';

afterEach(cleanup);
const workspace: Workspace = { id: 'a', name: 'A', path: '/a', exists: true, missing: false };
const ok = (data: RoleCatalogList) => ({ ok: true as const, data });
const css = readFileSync(resolve(__dirname, '../src/renderer/styles.css'), 'utf8');
const flat = css.replace(/\s+/g, ' ');

function setup(data: RoleCatalogList = rolesFixture()) {
  const roles = vi.fn(async (_id: string) => ok(data));
  const fake = fakeManagement({ calls: { roles } });
  const view = render(<main><RolesScreen workspace={workspace} management={fake.api} /></main>);
  return { view, roles, fake };
}

const row = (view: ReturnType<typeof render>, id: string) =>
  within(view.getByRole('list', { name: 'Saved roles' })).getAllByRole('button').find(b => b.getAttribute('data-role-id') === id)!;

async function openRole(view: ReturnType<typeof render>, id = 'Developer') {
  await view.findByRole('list', { name: 'Saved roles' });
  fireEvent.click(row(view, id));
  return view.getByRole('region', { name: 'Role details' });
}

function contrast(foreground: string, background: string): number {
  const luminance = (hex: string): number => {
    const value = hex.replace('#', '');
    const channels = [0, 2, 4].map(index => parseInt(value.slice(index, index + 2), 16) / 255)
      .map(channel => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
  };
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

describe('Roles accessibility', () => {
  it('has_one_h1_logical_headings_named_controls_and_native_rows_on_both_views', async () => {
    const { view } = setup();
    const list = await view.findByRole('list', { name: 'Saved roles' });
    expect(view.getByRole('main')).toBeTruthy();
    expect(view.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(view.getByRole('heading', { level: 1 }).textContent).toBe('Roles');
    const levels = view.getAllByRole('heading').map(heading => Number(heading.tagName[1]));
    levels.forEach((level, index) => { if (index > 0) expect(level).toBeLessThanOrEqual(levels[index - 1]! + 1); });
    for (const control of view.getAllByRole('button')) {
      expect((control.getAttribute('aria-label') ?? control.textContent ?? '').trim().length).toBeGreaterThan(0);
    }
    const rows = within(list).getAllByRole('button');
    expect(rows).toHaveLength(5);
    expect(rows.every(button => button.tagName === 'BUTTON' && !button.hasAttribute('tabindex'))).toBe(true);
    expect(view.queryAllByRole('alert')).toHaveLength(0);
    expect(view.queryAllByRole('status')).toHaveLength(0);

    const region = await openRole(view);
    expect(within(region).getByRole('navigation', { name: 'Breadcrumb' })).toBeTruthy();
    expect(within(region).getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const pageLevels = within(region).getAllByRole('heading').map(heading => Number(heading.tagName[1]));
    pageLevels.forEach((level, index) => { if (index > 0) expect(level).toBeLessThanOrEqual(pageLevels[index - 1]! + 1); });
    for (const control of within(region).getAllByRole('button')) {
      expect((control.getAttribute('aria-label') ?? control.textContent ?? '').trim().length).toBeGreaterThan(0);
    }
    expect(within(region).getByRole('button', { name: 'Edit overview' }).tagName).toBe('BUTTON');
    expect(within(region).getByRole('button', { name: 'Edit shared instructions' }).tagName).toBe('BUTTON');
    expect(within(region).getByRole('button', { name: 'Edit skills' }).tagName).toBe('BUTTON');
  });

  it('reaches_rows_and_the_breadcrumb_in_a_sensible_keyboard_order', async () => {
    const { view } = setup();
    await view.findByRole('list', { name: 'Saved roles' });
    const user = userEvent.setup();
    const newRole = view.getByRole('button', { name: 'New role' });
    newRole.focus();
    await user.tab();
    expect(document.activeElement).toBe(view.getByLabelText('Search roles'));
    await user.tab();
    expect(document.activeElement).toBe(row(view, 'Developer'));
    // The table rows are plain buttons in reading order, so Tab reaches the next role.
    await user.tab();
    expect(document.activeElement).toBe(row(view, 'Reviewer'));

    row(view, 'Reviewer').focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(document.activeElement).toBe(view.getByRole('heading', { level: 1, name: 'Code Reviewer' })));
    const back = view.getByRole('button', { name: 'Roles' });
    back.focus();
    await user.keyboard('{Enter}');
    await view.findByRole('list', { name: 'Saved roles' });
    await waitFor(() => expect(document.activeElement).toBe(row(view, 'Reviewer')));
  });

  it('opens_each_edit_dialog_from_the_keyboard_traps_focus_and_restores_it', async () => {
    const { view } = setup();
    const region = await openRole(view);
    const user = userEvent.setup();
    const cases = [
      { opener: 'Edit overview', dialog: 'Edit overview', first: 'Name', width: '560' },
      { opener: 'Edit shared instructions', dialog: 'Edit Developer instructions', first: 'Instructions', width: '780' },
      { opener: 'Edit skills', dialog: 'Edit skills', first: 'python-testing', width: '560' },
    ];
    for (const item of cases) {
      const opener = within(region).getByRole('button', { name: item.opener });
      opener.focus();
      await user.keyboard('{Enter}');
      const dialog = view.getByRole('dialog', { name: item.dialog });
      expect(dialog.getAttribute('aria-modal')).toBe('true');
      expect(dialog.getAttribute('style')).toContain(`width: min(${item.width}px, 100%)`);
      if (item.dialog === 'Edit skills') expect(within(dialog).getByRole('checkbox', { name: new RegExp(item.first) })).toBeTruthy();
      else expect(within(dialog).getByLabelText(item.first)).toBeTruthy();
      await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
      // Tab stays inside the modal and wraps through the footer, close button included.
      for (let i = 0; i < 8; i++) { await user.tab(); expect(dialog.contains(document.activeElement)).toBe(true); }
      await user.keyboard('{Escape}');
      expect(view.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(opener);
    }
  });

  it('skills_checkboxes_toggle_with_the_keyboard_and_escape_discards_the_draft', async () => {
    const { view } = setup(rolesFixture({ availableSkills: ['python-testing', 'extra-skill'] }));
    const region = await openRole(view);
    const opener = within(region).getByRole('button', { name: 'Edit skills' });
    opener.focus();
    const user = userEvent.setup();
    await user.keyboard('{Enter}');
    const dialog = view.getByRole('dialog', { name: 'Edit skills' });
    const extra = within(dialog).getByRole('checkbox', { name: 'extra-skill' });
    extra.focus();
    await user.keyboard(' ');
    expect(extra.getAttribute('aria-checked')).toBe('true');
    await user.keyboard('{Escape}');
    expect(view.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
    // Cancelling discarded the change.
    expect(within(region).queryByText('extra-skill')).toBeNull();
  });

  it('new_role_dialog_keeps_the_keyboard_inside_and_returns_focus_to_its_trigger', async () => {
    const { view } = setup();
    await view.findByRole('list', { name: 'Saved roles' });
    const opener = view.getByRole('button', { name: 'New role' });
    const user = userEvent.setup();
    opener.focus();
    await user.keyboard('{Enter}');
    const dialog = view.getByRole('dialog', { name: 'New role' });
    expect(within(dialog).getByLabelText('Name')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByLabelText('Name')));
    for (let i = 0; i < 8; i++) { await user.tab(); expect(dialog.contains(document.activeElement)).toBe(true); }
    await user.keyboard('{Escape}');
    expect(view.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('delete_is_a_keyboard_alertdialog_that_returns_focus_on_cancel', async () => {
    const data = rolesFixture({ items: [roleItem('free', { name: 'Free role' })] });
    const { view } = setup(data);
    const region = await openRole(view, 'free');
    const deleteButton = within(region).getByRole('button', { name: 'Delete role' });
    deleteButton.focus();
    const user = userEvent.setup();
    await user.keyboard('{Enter}');
    const dialog = view.getByRole('alertdialog', { name: 'Delete Free role?' });
    expect(dialog.getAttribute('style')).toContain('width: min(480px, 100%)');
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    await user.tab();
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Delete role' }));
    await user.tab();
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    await user.keyboard('{Escape}');
    expect(view.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(deleteButton);
  });

  it('announces_a_saved_role_once', async () => {
    const before = rolesFixture();
    const renamed = roleItem('Developer', { ...before.items[0], description: 'Changed' });
    const after = rolesFixture({ items: [renamed, ...before.items.slice(1)], sha256: '8'.repeat(64) });
    const roles = vi.fn().mockResolvedValueOnce(ok(before)).mockResolvedValue(ok(after));
    const updateRole = vi.fn(async () => ({ ok: true as const, data: { workspace: '/w', sha256: '8'.repeat(64), role: renamed, warnings: [], appliesToNewAssignments: true as const } }));
    const fake = fakeManagement({ calls: { roles, updateRole } });
    const view = render(<main><RolesScreen workspace={workspace} management={fake.api} /></main>);
    const region = await openRole(view);
    const user = userEvent.setup();
    await user.click(within(region).getByRole('button', { name: 'Edit overview' }));
    const dialog = view.getByRole('dialog', { name: 'Edit overview' });
    await user.clear(within(dialog).getByLabelText('Description'));
    await user.type(within(dialog).getByLabelText('Description'), 'Changed');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(view.queryByRole('dialog')).toBeNull());
    const announcements = view.getAllByRole('status').filter(node => node.textContent?.includes('Saved role Developer.'));
    expect(announcements).toHaveLength(1);
    expect(announcements[0]!.textContent).toBe('Saved role Developer. Saved changes apply to new assignments; current assignments are unchanged.');
    expect(view.getAllByText(/Saved role Developer\./)).toHaveLength(1);
  });

  it('announces_a_save_error_once_and_keeps_it_inside_the_dialog', async () => {
    const data = rolesFixture();
    const roles = vi.fn(async () => ok(data));
    const updateRole = vi.fn(async () => ({ ok: false as const, error: { code: 'BAD_REQUEST', message: 'Role update is invalid', retryable: false } }));
    const fake = fakeManagement({ calls: { roles, updateRole } });
    const view = render(<main><RolesScreen workspace={workspace} management={fake.api} /></main>);
    const region = await openRole(view, 'Developer');
    const user = userEvent.setup();
    await user.click(within(region).getByRole('button', { name: 'Edit overview' }));
    const dialog = view.getByRole('dialog', { name: 'Edit overview' });
    await user.clear(within(dialog).getByLabelText('Name'));
    await user.type(within(dialog).getByLabelText('Name'), 'Renamed');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(dialog).getByRole('alert')).toBeTruthy());
    const alerts = view.getAllByRole('alert').filter(node => node.textContent?.includes('BAD_REQUEST: Role update is invalid'));
    expect(alerts).toHaveLength(1);
    expect(dialog.contains(alerts[0]!)).toBe(true);
    expect(view.queryAllByRole('status').filter(node => node.textContent?.includes('Role update is invalid'))).toHaveLength(0);
    expect(view.getByRole('dialog', { name: 'Edit overview' })).toBeTruthy();
  });

  it('announces_a_created_role_once_and_opens_its_page', async () => {
    const before = rolesFixture();
    const created = roleItem('qa-lead', { name: 'QA Lead', description: null });
    const after = rolesFixture({ items: [...before.items, created], sha256: '9'.repeat(64) });
    const roles = vi.fn().mockResolvedValueOnce(ok(before)).mockResolvedValue(ok(after));
    const createRole = vi.fn(async () => ({ ok: true as const, data: { workspace: '/w', sha256: '9'.repeat(64), role: created, warnings: [], appliesToNewAssignments: true as const } }));
    const fake = fakeManagement({ calls: { roles, createRole } });
    const view = render(<main><RolesScreen workspace={workspace} management={fake.api} /></main>);
    await view.findByRole('list', { name: 'Saved roles' });
    const user = userEvent.setup();
    await user.click(view.getByRole('button', { name: 'New role' }));
    const dialog = view.getByRole('dialog', { name: 'New role' });
    await user.type(within(dialog).getByLabelText('Name'), 'QA Lead');
    await user.click(within(dialog).getByRole('button', { name: 'Create role' }));
    await waitFor(() => expect(view.queryByRole('dialog')).toBeNull());
    const announcements = view.getAllByRole('status').filter(node => node.textContent?.includes('Created role QA Lead.'));
    expect(announcements).toHaveLength(1);
    expect(announcements[0]!.textContent).toBe('Created role QA Lead.');
    expect(view.getAllByText(/Created role QA Lead\./)).toHaveLength(1);
    expect(within(await view.findByRole('region', { name: 'Role details' })).getByRole('heading', { level: 1, name: 'QA Lead' })).toBeTruthy();
  });

  it('confirms_and_announces_a_deleted_role_once_from_the_keyboard', async () => {
    const data = rolesFixture({ items: [roleItem('free', { name: 'Free role' }), roleItem('used', { name: 'Used role' })] });
    const after = rolesFixture({ items: [roleItem('used', { name: 'Used role' })] });
    const roles = vi.fn().mockResolvedValueOnce(ok(data)).mockResolvedValue(ok(after));
    const deleteRole = vi.fn(async () => ({ ok: true as const, data: { workspace: '/w', sha256: data.sha256, deleted: { id: 'free', instructions: 'none' } } }));
    const fake = fakeManagement({ calls: { roles, deleteRole } });
    const view = render(<main><RolesScreen workspace={workspace} management={fake.api} /></main>);
    const region = await openRole(view, 'free');
    const user = userEvent.setup();
    const deleteButton = within(region).getByRole('button', { name: 'Delete role' });
    deleteButton.focus();
    await user.keyboard('{Enter}');
    const dialog = view.getByRole('alertdialog', { name: 'Delete Free role?' });
    await user.tab();
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Delete role' }));
    await user.keyboard('{Enter}');
    await view.findByRole('list', { name: 'Saved roles' });
    expect(deleteRole).toHaveBeenCalledTimes(1);
    const announcements = view.getAllByRole('status').filter(node => node.textContent?.includes('Role Free role was deleted.'));
    expect(announcements).toHaveLength(1);
    expect(announcements[0]!.textContent).toBe('Role Free role was deleted. No instruction file was configured.');
    expect(view.getAllByText(/Role Free role was deleted\./)).toHaveLength(1);
  });

  it('keeps_secondary_text_at_or_above_4_5_contrast_on_card_backgrounds', () => {
    const tokens = {
      card: /--surface: (#[0-9a-f]{6});/.exec(css)?.[1] ?? '',
      raised: /--surface-raised: (#[0-9a-f]{6});/.exec(css)?.[1] ?? '',
      input: /--input-bg: (#[0-9a-f]{6});/.exec(css)?.[1] ?? '',
      muted: /--text-muted: (#[0-9a-f]{6});/.exec(css)?.[1] ?? '',
      label: /--text-label: (#[0-9a-f]{6});/.exec(css)?.[1] ?? '',
    };
    expect(Object.values(tokens).every(value => value.startsWith('#'))).toBe(true);
    for (const foreground of [tokens.muted, tokens.label]) {
      for (const background of [tokens.card, tokens.raised, tokens.input]) {
        expect(contrast(foreground, background), `${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    // The role page uses fixed secondary colours rather than only tokens; they
    // must still clear 4.5:1 on every card surface it renders on.
    for (const foreground of ['#a3a9b2', '#8d949e']) {
      for (const background of ['#16191d', '#1b1f25', '#121418']) {
        expect(contrast(foreground, background), `${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    // The role page deliberately uses the same muted token on its cards.
    expect(flat).toMatch(/\.roles-role-running \{ color: #a3a9b2;/);
    expect(flat).toMatch(/\.roles-role-reason\.is-muted \{ color: #a3a9b2; \}/);
    expect(flat).toMatch(/\.roles-usedby-meta \{ color: #8d949e;/);
  });

  it('scrolls_the_table_inside_its_card_and_reflows_the_page_and_dialogs', () => {
    expect(flat).toMatch(/\.roles-screen \{ display: flex; flex-direction: column; gap: 22px; max-width: 1180px; margin: 0 auto; min-width: 0;/);
    expect(flat).toMatch(/\.roles-table-card \{[^}]*overflow: hidden;/);
    expect(flat).toMatch(/\.roles-table-scroll \{ overflow-x: auto; max-width: 100%; \}/);
    expect(flat).toMatch(/\.roles-table \{[^}]*min-width: 820px;/);
    // Stack before flex wrapping leaves the aside alone in a 400px row; the
    // 1240px rule also covers the required one column at 900px and below.
    expect(flat).toMatch(/@media \(max-width: 1240px\) \{ \.roles-role-layout \{ flex-direction: column; \} \.roles-role-main, \.roles-role-aside \{ width: 100%; flex: 1 1 auto; max-width: none; \} \}/);
    expect(flat).toMatch(/@media \(max-width: 700px\) \{ \.dialog-backdrop \{ padding: 24px 12px; \} \.dialog-panel \{ max-height: calc\(100vh - 48px\); \}/);
    expect(flat).toMatch(/\.dialog-body \{[^}]*overflow-y: auto;/);
    expect(flat).toMatch(/\.dialog-panel \{[^}]*display: flex;[^}]*flex-direction: column;/);
    // The backdrop leaves 12px on each side at 700px, and every dialog is
    // capped at the panel width, so it fills the viewport minus 24px.
    expect(flat).toMatch(/\.dialog-panel \{[^}]*max-width: 100%;/);
    expect(flat).toMatch(/\.roles-instructions-preview pre \{[^}]*max-height: 300px/);
  });

  it('uses_the_tighter_instructions_gap_only_for_the_roles_dialog', () => {
    // The Roles design uses 14px between fields, but the shared member details
    // dialog must keep the 16px gap from its own design.
    expect(flat).toMatch(/\.role-instructions-dialog \.dialog-body \{ display: flex; flex-direction: column; gap: 16px; padding: 18px 20px; \}/);
    expect(flat).toMatch(/\.roles-instructions-dialog \.dialog-body \{ gap: 14px; \}/);
  });

  it('only_scrolls_the_role_table_sideways_inside_its_card', () => {
    // "Never makes the page scroll sideways": the table scroller is the only
    // horizontal scroller in the whole Roles stylesheet, and it sits inside a
    // card that clips its overflow.
    const scrollers = Array.from(css.matchAll(/([^{}]+)\{([^{}]*overflow-x: ?(?:auto|scroll)[^{}]*)\}/g))
      .map(match => match[1]!.trim())
      .filter(selector => /\.roles-/.test(selector));
    expect(scrollers).toEqual(['.roles-table-scroll']);
    expect(flat).toMatch(/\.roles-table-card \{[^}]*overflow: hidden;/);
    expect(flat).toMatch(/\.roles-table-scroll \{ overflow-x: auto; max-width: 100%; \}/);
    expect(flat).toMatch(/\.roles-screen \{[^}]*max-width: 1180px;[^}]*min-width: 0;/);
  });
});
