// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ManagementResult, SkillCatalogList, SkillDetail } from '../src/renderer/api';
import { SkillsScreen } from '../src/renderer/skills/SkillsScreen';
import { fakeManagement } from './teamsFixtures';
import { SKILL_TEXT, skillCatalog, skillItem } from './skillFixtures';

afterEach(cleanup);
const workspace = { id: 'a', name: 'A', path: '/a', exists: true, missing: false };
const css = readFileSync(resolve(__dirname, '../src/renderer/styles.css'), 'utf8');
const flat = css.replace(/\s+/g, ' ');
const ok = (data: SkillCatalogList) => ({ ok: true as const, data });

type SkillLookup = (workspaceId: string, skillId: string) => Promise<ManagementResult<SkillDetail>>;

function defaultLookup(catalog: SkillCatalogList): SkillLookup {
  return async (_workspaceId, skillId) => {
    const skill = catalog.skills.find(entry => entry.id === skillId);
    if (skill === undefined) {
      return { ok: false, error: { code: 'SKILL_NOT_FOUND', message: `Skill '${skillId}' was not found.`, retryable: false } };
    }
    const text = skill.state === 'ok' || skill.state === 'truncated'
      ? SKILL_TEXT[skill.id] ?? `# ${skill.id}`
      : null;
    return { ok: true, data: { workspace: catalog.workspace, skill, text } };
  };
}

function setup(data: SkillCatalogList = skillCatalog()) {
  const skills = vi.fn(async () => ok(data));
  const skill = vi.fn(defaultLookup(data));
  const fake = fakeManagement({ calls: { skills, skill } });
  const view = render(<main><SkillsScreen workspace={workspace} management={fake.api} /></main>);
  return { view, skills, skill, fake };
}

const skillList = (view: ReturnType<typeof render>) => view.getByRole('list', { name: 'Saved skills' });
const rowById = (view: ReturnType<typeof render>, id: string) =>
  within(skillList(view)).getAllByRole('button').find(button => button.getAttribute('data-skill-id') === id)!;
const page = (view: ReturnType<typeof render>) => within(view.getByRole('region', { name: 'Skill details' }));
const backToSkills = (view: ReturnType<typeof render>) => fireEvent.click(view.getByRole('button', { name: 'Skills' }));

async function open(view: ReturnType<typeof render>, id = 'code-search') {
  await view.findByRole('list', { name: 'Saved skills' });
  fireEvent.click(rowById(view, id));
  return view.findByRole('region', { name: 'Skill details' });
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

function expectNamedControls(root: HTMLElement): void {
  for (const control of within(root).getAllByRole('button')) {
    expect((control.getAttribute('aria-label') ?? control.textContent ?? '').trim().length).toBeGreaterThan(0);
  }
}

describe('Skills accessibility', () => {
  it('list_has_one_h1_logical_headings_named_native_controls_and_no_spurious_live_messages', async () => {
    const { view } = setup();
    await view.findByRole('list', { name: 'Saved skills' });
    expect(view.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(view.getByRole('heading', { level: 1 }).textContent).toBe('Skills');
    const levels = view.getAllByRole('heading').map(heading => Number(heading.tagName[1]));
    levels.forEach((level, index) => { if (index > 0) expect(level).toBeLessThanOrEqual(levels[index - 1]! + 1); });
    expectNamedControls(view.container);
    const rows = within(skillList(view)).getAllByRole('button');
    expect(rows).toHaveLength(5);
    expect(rows.every(button => button.tagName === 'BUTTON' && !button.hasAttribute('tabindex'))).toBe(true);
    expect(view.queryAllByRole('alert')).toHaveLength(0);
    expect(view.queryAllByRole('status')).toHaveLength(0);
    // The amber missing state always carries text, never colour alone.
    const missing = rowById(view, 'legacy-notes');
    expect(within(missing).getByText('No SKILL.md found. Roles still list it.')).toBeTruthy();
    expect(within(missing).getByText('Missing')).toBeTruthy();
    expect(within(missing).getByText('File not found')).toBeTruthy();
  });

  it('over_limit_size_and_context_states_are_spelled_out_not_just_coloured', async () => {
    const overLimit = skillItem({
      id: 'huge-skill',
      state: 'truncated',
      title: 'Huge skill',
      bytes: 40960,
      sha256: 'b'.repeat(64),
      roles: [{ id: 'Developer', name: 'Developer', contextBytes: 120000 }],
    });
    const { view } = setup(skillCatalog({ skills: [overLimit], problems: [] }));
    const list = await view.findByRole('list', { name: 'Saved skills' });
    const row = within(list).getByRole('button', { name: 'Open skill huge-skill' });
    // The over-limit state carries text, so the amber styling is never the only signal.
    expect(within(row).getByText('40.0 KB').classList.contains('is-warning')).toBe(true);
    expect(within(row).getByText('Over the 32 KiB limit').classList.contains('is-warning')).toBe(true);
    expectNamedControls(view.container);
  });

  it('reaches_the_search_and_rows_in_order_and_returns_focus_after_back', async () => {
    const { view } = setup();
    await view.findByRole('list', { name: 'Saved skills' });
    const user = userEvent.setup();
    view.getByRole('button', { name: 'New skill' }).focus();
    await user.tab();
    expect(document.activeElement).toBe(view.getByLabelText('Search skills'));
    await user.tab();
    expect(document.activeElement).toBe(rowById(view, 'code-search'));
    await user.tab();
    expect(document.activeElement).toBe(rowById(view, 'legacy-notes'));

    rowById(view, 'python-testing').focus();
    await user.keyboard('{Enter}');
    await view.findByRole('region', { name: 'Skill details' });
    await waitFor(() => expect(document.activeElement).toBe(page(view).getByRole('heading', { level: 1, name: 'python-testing' })));
    await user.tab();
    expect(document.activeElement).toBe(page(view).getByRole('button', { name: 'Edit skill content' }));
    await user.tab();
    expect(document.activeElement).toBe(page(view).getByRole('button', { name: 'Edit roles that use this skill' }));

    const back = page(view).getByRole('button', { name: 'Skills' });
    back.focus();
    await user.keyboard('{Enter}');
    await view.findByRole('list', { name: 'Saved skills' });
    await waitFor(() => expect(document.activeElement).toBe(rowById(view, 'python-testing')));
  });

  it('the_skill_page_has_one_h1_named_edit_buttons_and_a_keyboard_breadcrumb', async () => {
    const { view } = setup();
    await open(view);
    const region = view.getByRole('region', { name: 'Skill details' });
    expect(within(region).getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(within(region).getByRole('navigation', { name: 'Breadcrumb' })).toBeTruthy();
    expectNamedControls(region);
    expect(within(region).getByRole('button', { name: 'Edit skill content' })).toBeTruthy();
    expect(within(region).getByRole('button', { name: 'Edit roles that use this skill' })).toBeTruthy();
    const controls = [...region.querySelectorAll<HTMLButtonElement>('button')];
    expect(controls.every(control => control.tagName === 'BUTTON' && !control.hasAttribute('tabindex'))).toBe(true);
  });

  it('the_missing_page_explains_the_state_in_text_and_offers_both_fixes', async () => {
    const { view } = setup();
    await open(view, 'legacy-notes');
    const region = view.getByRole('region', { name: 'Skill details' });
    expect(within(region).getByRole('heading', { level: 1, name: 'legacy-notes' })).toBeTruthy();
    expect(within(region).getByText('Missing')).toBeTruthy();
    expect(within(region).getByText(/does not exist, so it is skipped when assignments start/)).toBeTruthy();
    expect(within(region).getByText('No SKILL.md yet')).toBeTruthy();
    const createButtons = within(region).getAllByRole('button', { name: 'Create this skill' });
    expect(createButtons).toHaveLength(2);
    expect(createButtons.every(button => button.tagName === 'BUTTON')).toBe(true);
    expect(within(region).getByRole('button', { name: 'Edit roles' }).tagName).toBe('BUTTON');
    expectNamedControls(region);
  });

  it.each([
    { name: 'content', openPage: 'code-search', opener: 'Edit skill content', dialog: 'Edit code-search', width: 780 },
    { name: 'roles', openPage: 'code-search', opener: 'Edit roles that use this skill', dialog: 'Roles that use code-search', width: 560 },
    { name: 'new', openPage: null, opener: 'New skill', dialog: 'New skill', width: 680 },
    { name: 'delete', openPage: 'ts-testing', opener: 'Delete skill', dialog: 'Delete ts-testing?', width: 480 },
  ])('$name dialog is modal, keyboard trapped, correctly sized and returns focus', async (item) => {
    const { view } = setup();
    if (item.openPage !== null) await open(view, item.openPage);
    else await view.findByRole('list', { name: 'Saved skills' });
    const user = userEvent.setup();
    const opener = view.getByRole('button', { name: item.opener });
    opener.focus();
    await user.keyboard('{Enter}');
    const role = item.name === 'delete' ? 'alertdialog' : 'dialog';
    const dialog = view.getByRole(role, { name: item.dialog });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('style')).toContain(`width: min(${item.width}px, 100%)`);
    expectNamedControls(dialog);
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    for (let i = 0; i < 8; i++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await user.keyboard('{Escape}');
    expect(view.queryByRole(role)).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('delete_dialog_starts_on_cancel_and_tabs_to_the_destructive_action', async () => {
    const { view } = setup();
    await open(view, 'ts-testing');
    const user = userEvent.setup();
    const opener = view.getByRole('button', { name: 'Delete skill' });
    opener.focus();
    await user.keyboard('{Enter}');
    const dialog = view.getByRole('alertdialog', { name: 'Delete ts-testing?' });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    await user.tab();
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Delete skill' }));
    await user.tab();
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(opener);
  });

  it('announces_a_saved_skill_once', async () => {
    const catalog = skillCatalog();
    const saved: SkillDetail = {
      workspace: catalog.workspace,
      skill: { ...catalog.skills.find(skill => skill.id === 'code-search')!, sha256: 'f'.repeat(64) },
      text: `${SKILL_TEXT['code-search']}\n\nA new line.`,
    };
    const skills = vi.fn(async () => ok(skillCatalog()));
    const skill = vi.fn(defaultLookup(catalog));
    const updateSkill = vi.fn(async () => ({ ok: true as const, data: saved }));
    const fake = fakeManagement({ calls: { skills, skill, updateSkill } });
    const view = render(<main><SkillsScreen workspace={workspace} management={fake.api} /></main>);
    await open(view);
    const user = userEvent.setup();
    await user.click(page(view).getByRole('button', { name: 'Edit skill content' }));
    const dialog = view.getByRole('dialog', { name: 'Edit code-search' });
    fireEvent.change(within(dialog).getByLabelText('Content (markdown)'), { target: { value: `${SKILL_TEXT['code-search']}\n\nA new line.` } });
    await user.click(within(dialog).getByRole('button', { name: 'Save to file' }));
    await waitFor(() => expect(view.queryByRole('dialog')).toBeNull());
    const announcements = view.getAllByRole('status').filter(node => node.textContent?.includes('Saved skills/code-search/SKILL.md.'));
    expect(announcements).toHaveLength(1);
    expect(view.getAllByText(/Saved skills\/code-search\/SKILL\.md\./)).toHaveLength(1);
  });

  it('announces_a_created_skill_once_and_opens_its_page', async () => {
    const fake = fakeManagement();
    const view = render(<main><SkillsScreen workspace={workspace} management={fake.api} /></main>);
    await view.findByRole('list', { name: 'Saved skills' });
    const user = userEvent.setup();
    await user.click(view.getByRole('button', { name: 'New skill' }));
    const dialog = view.getByRole('dialog', { name: 'New skill' });
    await user.type(within(dialog).getByLabelText('Skill id'), 'harness-skill');
    await user.click(within(dialog).getByRole('button', { name: 'Create skill' }));
    await waitFor(() => expect(view.queryByRole('dialog')).toBeNull());
    const announcements = view.getAllByRole('status').filter(node => node.textContent?.includes('Created skill harness-skill.'));
    expect(announcements).toHaveLength(1);
    await waitFor(() => expect(page(view).getByRole('heading', { level: 1, name: 'harness-skill' })).toBeTruthy());
  });

  it('announces_a_deleted_skill_once_from_the_keyboard', async () => {
    const fake = fakeManagement();
    const view = render(<main><SkillsScreen workspace={workspace} management={fake.api} /></main>);
    await open(view, 'ts-testing');
    const user = userEvent.setup();
    const opener = page(view).getByRole('button', { name: 'Delete skill' });
    opener.focus();
    await user.keyboard('{Enter}');
    const dialog = view.getByRole('alertdialog', { name: 'Delete ts-testing?' });
    await user.tab();
    await user.keyboard('{Enter}');
    await view.findByRole('list', { name: 'Saved skills' });
    const announcements = view.getAllByRole('status').filter(node => node.textContent?.includes('Deleted skill ts-testing.'));
    expect(announcements).toHaveLength(1);
    expect(view.getAllByText(/Deleted skill ts-testing\./)).toHaveLength(1);
  });

  it('announces_a_save_error_once_inside_the_dialog_and_keeps_it_open', async () => {
    const catalog = skillCatalog();
    const updateSkill = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'BAD_REQUEST', message: 'The skill cannot be saved.', retryable: false },
    }));
    const fake = fakeManagement({ calls: { skills: vi.fn(async () => ok(catalog)), skill: vi.fn(defaultLookup(catalog)), updateSkill } });
    const view = render(<main><SkillsScreen workspace={workspace} management={fake.api} /></main>);
    await open(view);
    const user = userEvent.setup();
    await user.click(page(view).getByRole('button', { name: 'Edit skill content' }));
    const dialog = view.getByRole('dialog', { name: 'Edit code-search' });
    fireEvent.change(within(dialog).getByLabelText('Content (markdown)'), { target: { value: '# Changed\n' } });
    await user.click(within(dialog).getByRole('button', { name: 'Save to file' }));
    await waitFor(() => expect(within(dialog).getByRole('alert')).toBeTruthy());
    const alerts = view.getAllByRole('alert').filter(node => node.textContent?.includes('The skill cannot be saved.'));
    expect(alerts).toHaveLength(1);
    expect(dialog.contains(alerts[0]!)).toBe(true);
    expect(view.queryAllByRole('status').filter(node => node.textContent?.includes('The skill cannot be saved.'))).toHaveLength(0);
    expect(view.getByRole('dialog', { name: 'Edit code-search' })).toBe(dialog);
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
    // The Skills page uses fixed secondary colours on its cards and preview.
    for (const foreground of ['#a3a9b2', '#8d949e']) {
      for (const background of ['#16191d', '#1b1f24', '#121418']) {
        expect(contrast(foreground, background), `${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(flat).toMatch(/\.skills-usedby-context \{ color: #8d949e;/);
    expect(flat).toMatch(/\.skills-subtitle \{ margin: 0; color: var\(--text-muted\);/);
  });

  it('scrolls_the_table_inside_its_card_and_reflows_the_page_and_dialogs', () => {
    expect(flat).toMatch(/\.skills-screen \{[^}]*max-width: 1180px;[^}]*min-width: 0;/);
    expect(flat).toMatch(/\.skills-table-card \{[^}]*overflow: hidden;/);
    expect(flat).toMatch(/\.skills-table-scroll \{ overflow-x: auto; max-width: 100%; \}/);
    expect(flat).toMatch(/\.skills-table \{[^}]*min-width: 820px;/);
    expect(flat).toMatch(/@media \(max-width: 900px\) \{ \.skills-page-layout \{ flex-direction: column; \} \.skills-page-main, \.skills-page-aside \{ width: 100%; flex: 1 1 auto; max-width: none; \} \}/);
    expect(flat).toMatch(/@media \(max-width: 700px\) \{ \.dialog-backdrop \{ padding: 24px 12px; \} \.dialog-panel \{ max-height: calc\(100vh - 48px\); \}/);
    expect(flat).toMatch(/\.dialog-body \{[^}]*overflow-y: auto;/);
    expect(flat).toMatch(/\.dialog-panel \{[^}]*max-width: 100%;/);
    expect(flat).toMatch(/\.dialog-action \{ display: inline-flex;[^}]*height: 34px; min-height: 34px;/);
    // The table scroller is the only horizontal scroller in the Skills styles.
    const scrollers = Array.from(css.matchAll(/([^{}]+)\{([^{}]*overflow-x: ?(?:auto|scroll)[^{}]*)\}/g))
      .map(match => match[1]!.trim())
      .filter(selector => /\.skills-/.test(selector));
    expect(scrollers).toEqual(['.skills-table-scroll']);
  });
});
