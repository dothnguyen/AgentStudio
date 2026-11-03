// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { RoutingScreen } from '../src/renderer/routing/RoutingScreen';
import { workspaceA } from './dashboardFixtures';
import { fakeManagement, routingSettingsFixture } from './teamsFixtures';

afterEach(cleanup);

const css = readFileSync(resolve(__dirname, '../src/renderer/styles.css'), 'utf8');
const flat = css.replace(/\s+/g, ' ');

function contrast(foreground: string, background: string): number {
  const luminance = (hex: string): number => {
    const channel = (offset: number): number => {
      const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  };
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function token(name: string): string {
  const match = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
  expect(match, `${name} is missing`).not.toBeNull();
  return match![1]!.toLocaleLowerCase();
}

async function renderRouting() {
  const fake = fakeManagement({ boardSettings: [{ ok: true, data: routingSettingsFixture() }] });
  const view = render(<RoutingScreen workspace={workspaceA} management={fake.api} onViewRole={vi.fn()} />);
  await act(async () => {});
  const panel = within(view.getByRole('region', { name: 'Workspace board routing' }));
  return { view, fake, panel };
}

it('routing_screen_has_one_h1_named_actions_a_focusable_table_and_textual_status', async () => {
  const { view, panel } = await renderRouting();
  expect(view.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  expect(view.getByRole('heading', { level: 1 }).textContent).toBe('Routing');
  expect(view.queryByRole('tablist')).toBeNull();
  expect(view.queryByRole('tab')).toBeNull();
  for (const card of ['Autonomous execution', 'Worktrees', 'Role coverage', 'Rules', 'Workflows']) {
    expect(panel.getByRole('region', { name: card })).toBeTruthy();
  }

  const scroll = panel.getByRole('region', { name: 'Routing transitions (scrollable)' });
  expect(scroll.tabIndex).toBe(0);
  scroll.focus();
  expect(document.activeElement).toBe(scroll);

  const rows = within(panel.getByRole('list', { name: 'Routing transitions' })).getAllByRole('listitem');
  expect(rows).toHaveLength(5);
  for (const [index, row] of rows.entries()) {
    expect(within(row).getByRole('button', { name: new RegExp(`^Edit rule ${index + 1}, `) })).toBeTruthy();
    expect(row.querySelector('.routing-status-name')?.textContent?.trim().length).toBeGreaterThan(0);
    for (const chip of Array.from(row.querySelectorAll('.routing-status-chip'))) {
      expect(chip.textContent?.trim().length).toBeGreaterThan(1);
    }
  }
  expect(panel.getByRole('button', { name: 'Add rule' })).toBeTruthy();
  expect(panel.getByRole('button', { name: 'Edit worktrees' })).toBeTruthy();
  for (const button of panel.getAllByRole('button')) {
    expect((button.getAttribute('aria-label') ?? button.textContent ?? '').trim().length).toBeGreaterThan(0);
  }
  for (const dot of Array.from(view.container.querySelectorAll('.routing-status-dot'))) {
    expect(dot.getAttribute('aria-hidden')).toBe('true');
  }
});

it('routing_rule_dialog_is_labelled_trapped_and_restores_focus', async () => {
  const user = userEvent.setup();
  const { panel } = await renderRouting();
  const opener = panel.getByRole('button', { name: 'Edit rule 1, backlog' });
  await user.click(opener);
  const dialog = screen.getByRole('dialog', { name: /^Edit rule 1/ });
  expect(dialog.getAttribute('style')).toContain('min(720px, 100%)');
  expect(dialog.contains(document.activeElement)).toBe(true);
  for (const label of ['Role', 'Workflow', 'Works in', 'If it passes', 'If it fails', 'If it is blocked']) {
    expect(within(dialog).getByLabelText(label)).toBeTruthy();
  }
  expect(within(dialog).getByRole('switch', { name: 'Sync the base branch first' })).toBeTruthy();
  expect(within(dialog).getByRole('button', { name: 'Remove rule' })).toBeTruthy();
  for (let index = 0; index < 14; index += 1) {
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
  }
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(opener);
});

it('routing_add_rule_dialog_has_a_named_choice_group_and_traps_focus', async () => {
  const user = userEvent.setup();
  const { panel } = await renderRouting();
  const opener = panel.getByRole('button', { name: 'Add rule' });
  await user.click(opener);
  const dialog = screen.getByRole('dialog', { name: 'Add rule' });
  expect(dialog.getAttribute('style')).toContain('min(720px, 100%)');
  expect(within(dialog).getByRole('radiogroup', { name: 'What happens' })).toBeTruthy();
  expect(within(dialog).getByRole('radio', { name: /An agent works it/ }).getAttribute('aria-checked')).toBe('true');
  expect(within(dialog).getByRole('radio', { name: /Built-in action: merge/ }).getAttribute('aria-checked')).toBe('false');
  expect(within(dialog).getByLabelText('Status')).toBeTruthy();
  for (let index = 0; index < 12; index += 1) {
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
  }
  await user.keyboard('{Escape}');
  expect(document.activeElement).toBe(opener);
});

it('routing_worktrees_and_remove_dialogs_are_bounded_labelled_and_restore_focus', async () => {
  const user = userEvent.setup();
  const { panel } = await renderRouting();

  const worktreesOpener = panel.getByRole('button', { name: 'Edit worktrees' });
  await user.click(worktreesOpener);
  const worktrees = screen.getByRole('dialog', { name: 'Edit worktrees' });
  expect(worktrees.getAttribute('style')).toContain('min(480px, 100%)');
  expect(within(worktrees).getByLabelText('Base branch')).toBeTruthy();
  expect(worktrees.contains(document.activeElement)).toBe(true);
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(worktreesOpener);

  const editOpener = panel.getByRole('button', { name: 'Edit rule 3, plan-merge-ready' });
  await user.click(editOpener);
  const edit = screen.getByRole('dialog', { name: /^Edit rule 3/ });
  await user.click(within(edit).getByRole('button', { name: 'Remove rule' }));
  const remove = screen.getByRole('alertdialog', { name: 'Remove the rule for plan-merge-ready?' });
  expect(remove.getAttribute('style')).toContain('min(480px, 100%)');
  expect(remove.getAttribute('aria-describedby')?.split(' ').map(id => document.getElementById(id)?.textContent ?? '').join(' '))
    .toContain('Tickets in this status will no longer be worked automatically.');
  expect(remove.contains(document.activeElement)).toBe(true);
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(document.activeElement).toBe(editOpener);
});

it('routing_saved_added_removed_and_error_messages_are_announced_once', async () => {
  const base = routingSettingsFixture();
  const refreshed = routingSettingsFixture({ worktree: { baseBranch: 'release-2', worktreeStatuses: [] } });
  const okUpdate = vi.fn(async () => ({ ok: true as const, data: {} }));

  const saved = fakeManagement({ boardSettings: [{ ok: true, data: base }, { ok: true, data: refreshed }], calls: { updateBoardSettings: okUpdate } });
  const savedView = render(<RoutingScreen workspace={workspaceA} management={saved.api} />);
  await act(async () => {});
  fireEvent.click(savedView.getByRole('button', { name: 'Edit worktrees' }));
  fireEvent.change(savedView.getByLabelText('Base branch'), { target: { value: 'release-2' } });
  await act(async () => { fireEvent.click(savedView.getByRole('button', { name: 'Save' })); });
  expect(savedView.getAllByRole('status').filter(status => status.textContent?.includes('Saved base branch.'))).toHaveLength(1);
  expect(savedView.queryAllByRole('alert')).toHaveLength(0);
  cleanup();

  const added = fakeManagement({ boardSettings: [{ ok: true, data: base }, { ok: true, data: base }], calls: { updateBoardSettings: okUpdate } });
  const addedView = render(<RoutingScreen workspace={workspaceA} management={added.api} />);
  await act(async () => {});
  fireEvent.click(addedView.getByRole('button', { name: 'Add rule' }));
  const addDialog = screen.getByRole('dialog', { name: 'Add rule' });
  await act(async () => { fireEvent.click(within(addDialog).getByRole('button', { name: 'Add rule' })); });
  expect(addedView.getAllByRole('status').filter(status => status.textContent?.includes('Added a rule for dev-ready.'))).toHaveLength(1);
  cleanup();

  const removed = fakeManagement({ boardSettings: [{ ok: true, data: base }, { ok: true, data: base }], calls: { updateBoardSettings: okUpdate } });
  const removedView = render(<RoutingScreen workspace={workspaceA} management={removed.api} />);
  await act(async () => {});
  fireEvent.click(removedView.getByRole('button', { name: 'Edit rule 3, plan-merge-ready' }));
  await act(async () => { fireEvent.click(removedView.getByRole('button', { name: 'Remove rule' })); });
  await act(async () => { fireEvent.click(removedView.getByRole('button', { name: 'Remove rule' })); });
  expect(removedView.getAllByRole('status').filter(status => status.textContent?.includes('Removed the rule for plan-merge-ready.'))).toHaveLength(1);
  cleanup();

  const conflict = fakeManagement({
    boardSettings: [{ ok: true, data: base }, { ok: true, data: base }],
    calls: { updateBoardSettings: vi.fn(async () => ({ ok: false as const, error: { code: 'CONFIG_CHANGED', message: 'configuration changed', retryable: false } })) },
  });
  const errorView = render(<RoutingScreen workspace={workspaceA} management={conflict.api} />);
  await act(async () => {});
  fireEvent.click(errorView.getByRole('button', { name: 'Edit worktrees' }));
  fireEvent.change(errorView.getByLabelText('Base branch'), { target: { value: 'release-2' } });
  await act(async () => { fireEvent.click(errorView.getByRole('button', { name: 'Save' })); });
  expect(errorView.getAllByRole('alert').filter(alert => alert.textContent?.includes('CONFIG_CHANGED: configuration changed'))).toHaveLength(1);
});

it('routing_secondary_text_on_cards_meets_4_5_to_1_contrast', () => {
  expect(token('--surface')).toBe('#16191d');
  expect(token('--text-muted')).toBe('#a3a9b2');
  expect(token('--text-label')).toBe('#8d949e');
  expect(flat).toContain('.section-card { min-width: 0; background: #16191d;');
  expect(flat).toContain('.routing-summary-note { margin: 0; color: #a3a9b2; font-size: 12px; }');
  for (const secondary of [token('--text-muted'), token('--text-label')]) {
    expect(contrast(secondary, token('--surface'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(secondary, '#14171a')).toBeGreaterThanOrEqual(4.5);
  }
});

it('routing_css_wraps_cards_scrolls_the_table_inside_its_card_and_bounds_dialogs', () => {
  expect(flat).toContain('.routing-summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 22px; align-items: stretch; min-width: 0; }');
  expect(flat).toContain('.routing-screen { display: flex; flex-direction: column; gap: 22px; max-width: 1240px; margin: 0 auto; min-width: 0; overflow-wrap: anywhere; }');
  expect(flat).toContain('.routing-table-wrap { overflow-x: auto; max-width: 100%; }');
  expect(flat).toContain('.routing-rules-inner { min-width: 1040px; }');
  expect(flat).toContain('.routing-rules-card > .section-card-body { padding: 0; }');
  expect(flat).toContain('.section-card { min-width: 0; background: #16191d; border: 1px solid #262a30; border-radius: 12px; overflow: hidden; }');
  expect(flat).toContain('.dialog-body { min-height: 0; padding: 20px; overflow-y: auto; }');
  expect(flat).toMatch(/@media \(max-width: 700px\) \{ \.dialog-backdrop \{ padding: 24px 12px; \} \.dialog-panel \{ max-height: calc\(100vh - 48px\); \}/);
  // Only the rules table scrolls horizontally inside the Routing screen.
  const scrollers = Array.from(css.matchAll(/([^{}]+)\{([^{}]*overflow-x: ?(?:auto|scroll)[^{}]*)\}/g))
    .map(match => match[1]!.trim())
    .filter(selector => /\.routing-/.test(selector));
  expect(scrollers.every(selector => selector === '.routing-table-wrap')).toBe(true);
});

it('routing_removes_the_old_form_disclosures_and_unused_panel_styles', () => {
  for (const removed of ['.routing-disclosure', '.routing-table {', '.routing-table :is', '.routing-rule-grid', '.routing-scope', '.routing-panel-header', '.routing-edit-form']) {
    expect(css, removed).not.toContain(removed);
  }
  expect(existsSync(resolve(__dirname, '../src/renderer/teams/RoutingEditForm.tsx'))).toBe(false);
  const source = [
    readFileSync(resolve(__dirname, '../src/renderer/teams/RoutingReadView.tsx'), 'utf8'),
    readFileSync(resolve(__dirname, '../src/renderer/teams/RoutingSettingsPanel.tsx'), 'utf8'),
  ].join('\n');
  expect(source).not.toContain('RoutingDisclosure');
  expect(source).not.toContain('RoutingEditForm');
  expect(source).not.toContain('routing-rule-grid');
  // The helpers only the removed read/edit views used are gone as well.
  const models = [
    readFileSync(resolve(__dirname, '../src/renderer/teams/routingSettingsModel.ts'), 'utf8'),
    readFileSync(resolve(__dirname, '../src/renderer/teams/routingViewModel.ts'), 'utf8'),
  ].join('\n');
  for (const removed of ['WorkspaceMode', 'failureLimitOf', 'escalationChains', 'memberForRole']) {
    expect(models, removed).not.toContain(removed);
  }
  expect(flat).toContain('.routing-read-view { display: flex;');
});

it('routing_docs_and_help_describe_the_standalone_screen_without_a_team_tab', () => {
  const appReadme = readFileSync(resolve(__dirname, '../README.md'), 'utf8');
  const designReadme = readFileSync(resolve(__dirname, '../../design/routing-v1/README.md'), 'utf8');
  const teamsScreen = readFileSync(resolve(__dirname, '../src/renderer/teams/TeamsScreen.tsx'), 'utf8');
  for (const [name, text] of [['app/README.md', appReadme], ['design/routing-v1/README.md', designReadme], ['TeamsScreen.tsx', teamsScreen]] as const) {
    expect(text, name).not.toMatch(/Routing tab/i);
    expect(text, name).not.toMatch(/\bthe routing tab\b/i);
  }
  expect(appReadme).toContain('The Routing screen (its own sidebar section after Skills)');
  expect(appReadme).toContain('the team page links to this screen instead of embedding a routing view');
  expect(designReadme).toContain('the team page links to this screen instead of embedding routing');
  expect(teamsScreen).toContain('Open Routing');
  expect(teamsScreen).toContain("Autonomous work follows the board&apos;s routing.");
});

it('routing_dialogs_label_every_select_and_trap_focus_in_both_directions', async () => {
  const user = userEvent.setup();
  const { panel } = await renderRouting();
  const focusable = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  async function trapsAndRestores(dialog: HTMLElement): Promise<void> {
    const items = Array.from(dialog.querySelectorAll<HTMLElement>(focusable));
    expect(items.length).toBeGreaterThan(1);
    items[0]!.focus();
    expect(document.activeElement).toBe(items[0]);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(items[items.length - 1]);
    await user.tab();
    expect(document.activeElement).toBe(items[0]);
  }

  function everySelectHasALabel(dialog: HTMLElement): void {
    const selects = within(dialog).getAllByRole('combobox');
    expect(selects.length).toBeGreaterThan(0);
    for (const select of selects) {
      const label = select.getAttribute('aria-label') ?? select.closest('label')?.textContent ?? (select as HTMLSelectElement).labels?.[0]?.textContent;
      expect(label?.trim().length, select.outerHTML).toBeGreaterThan(0);
    }
  }

  const editOpener = panel.getByRole('button', { name: 'Edit rule 1, backlog' });
  await user.click(editOpener);
  const edit = screen.getByRole('dialog', { name: /^Edit rule 1/ });
  everySelectHasALabel(edit);
  await trapsAndRestores(edit);
  await user.keyboard('{Escape}');
  expect(document.activeElement).toBe(editOpener);

  const actionOpener = panel.getByRole('button', { name: 'Edit rule 2, merge-ready' });
  await user.click(actionOpener);
  const action = screen.getByRole('dialog', { name: /^Edit rule 2/ });
  everySelectHasALabel(action);
  expect(within(action).queryByLabelText('Role')).toBeNull();
  await trapsAndRestores(action);
  await user.keyboard('{Escape}');
  expect(document.activeElement).toBe(actionOpener);

  const addOpener = panel.getByRole('button', { name: 'Add rule' });
  await user.click(addOpener);
  const add = screen.getByRole('dialog', { name: 'Add rule' });
  everySelectHasALabel(add);
  await trapsAndRestores(add);
  await user.keyboard('{Escape}');
  expect(document.activeElement).toBe(addOpener);

  const worktreesOpener = panel.getByRole('button', { name: 'Edit worktrees' });
  await user.click(worktreesOpener);
  const worktrees = screen.getByRole('dialog', { name: 'Edit worktrees' });
  expect(within(worktrees).getByLabelText('Base branch')).toBeTruthy();
  await trapsAndRestores(worktrees);
  await user.keyboard('{Escape}');
  expect(document.activeElement).toBe(worktreesOpener);

  const removeOpener = panel.getByRole('button', { name: 'Edit rule 3, plan-merge-ready' });
  await user.click(removeOpener);
  const editProtected = screen.getByRole('dialog', { name: /^Edit rule 3/ });
  await user.click(within(editProtected).getByRole('button', { name: 'Remove rule' }));
  const remove = screen.getByRole('alertdialog');
  await trapsAndRestores(remove);
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(document.activeElement).toBe(removeOpener);
});
