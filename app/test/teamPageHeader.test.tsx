// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeamsHarness } from './teamsHarness';
import { workspaceA } from './dashboardFixtures';
import { chooseDeleteTeam, fakeManagement, overviewFixture, team } from './teamsFixtures';

afterEach(cleanup);

const flush = () => act(async () => {});
const ok = <T,>(data: T) => ({ ok: true as const, data });
const RUNTIME_ID = 'b4597175-1111-2222-3333-4444f9548168';
const running = () => team({ id: 'dev-team', name: 'Dev Team', runtime: { state: 'running', teamId: RUNTIME_ID, status: 'running' } });

async function renderTeam(opts: Parameters<typeof fakeManagement>[0] = {}) {
  const fake = fakeManagement(opts);
  const view = render(<TeamsHarness workspace={workspaceA} management={fake.api} />);
  await flush();
  return { fake, view };
}
const withTeam = (t: ReturnType<typeof team>) => ({ overview: [ok(overviewFixture([t]))] });
const btn = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

describe('team page header', () => {
  it('header_shows_breadcrumb_title_pill_and_meta_row_from_returned_data', async () => {
    const { view } = await renderTeam(withTeam(running()));
    const crumbs = within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getAllByRole('listitem');
    expect(crumbs.map((li) => li.textContent)).toEqual(['Workspace', 'Teams', 'Dev Team']);
    expect(crumbs[2]!.getAttribute('aria-current')).toBe('page');
    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]!.textContent).toBe('Dev Team');
    expect(h1s[0]!.id).toBe('teams-detail-title');
    const pill = view.container.querySelector('.teams-page-pill.teams-page-pill-ok')!;
    expect(pill.textContent).toBe('Running');
    expect(pill.querySelector('.status-dot')!.getAttribute('aria-hidden')).toBe('true');
    const meta = view.container.querySelector('.teams-page-meta')!.textContent ?? '';
    for (const t of ['Team id', 'dev-team', 'Runtime', 'b4597175…f9548168', 'Definition valid']) expect(meta).toContain(t);
    expect(view.container.querySelector(`code[title="${RUNTIME_ID}"]`)).not.toBeNull();
    expect(screen.queryByText('Manage team membership, routing, and live operation in this workspace.')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Team actions' })).toBeNull();
    expect(screen.queryByRole('heading', { level: 1, name: 'Teams' })).toBeNull();
  });

  it('header_omits_missing_ids_and_shows_definition_problems', async () => {
    const first = await renderTeam(withTeam(team({
      runtime: { state: 'not_started', teamId: null, status: null },
      definition: { state: 'problems', problems: [{ path: 'a', message: 'x' }, { path: 'b', message: 'y' }] },
    })));
    const meta = first.view.container.querySelector('.teams-page-meta')!.textContent ?? '';
    expect(meta).not.toContain('Runtime');
    expect(screen.queryByRole('button', { name: 'Copy runtime id' })).toBeNull();
    expect(meta).toContain('Definition has 2 problems');
    const pill = first.view.container.querySelector('.teams-page-pill-muted')!;
    expect(pill.textContent).toBe('Not started');
    cleanup();
    const second = await renderTeam(withTeam(team({ id: null, name: null, definition: { state: 'missing', problems: [] }, runtime: { state: 'running', teamId: 'rt-9', status: 'running' } })));
    const text = second.view.container.querySelector('.teams-page-meta')!.textContent ?? '';
    expect(text).not.toContain('Team id');
    expect(text).toContain('rt-9');
    expect(text).toContain('No definition (runtime only)');
  });

  it('header_actions_are_icon_refresh_rename_and_more_menu', async () => {
    await renderTeam(withTeam(running()));
    const refresh = btn('Refresh');
    expect(refresh.classList.contains('teams-page-icon-button')).toBe(true);
    expect((refresh.textContent ?? '').trim()).toBe('');
    const rename = btn('Rename team');
    expect(rename.textContent).toBe('Rename');
    const more = btn('More team actions');
    expect(more.getAttribute('aria-haspopup')).toBe('menu');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    const order = [refresh, rename, more];
    order.slice(1).forEach((el, i) => expect(order[i]!.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy());
  });

  it('more_menu_keyboard_opens_moves_and_escape_returns_focus', async () => {
    await renderTeam(withTeam(running()));
    const more = btn('More team actions');
    fireEvent.keyDown(more, { key: 'ArrowDown' });
    await flush();
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('menu')).toBeTruthy();
    const item = screen.getByRole('menuitem', { name: 'Delete team' });
    expect(document.activeElement).toBe(item);
    fireEvent.keyDown(item, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(more);
    fireEvent.click(more);
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('delete_from_menu_confirms_exact_team_and_cancel_restores_focus_to_menu_button', async () => {
    const deleteTeam = vi.fn(async () => ok({ deleted: 'dev-team' }));
    await renderTeam({ ...withTeam(running()), calls: { deleteTeam } });
    chooseDeleteTeam(); await flush();
    expect(screen.getByText('Delete team "Dev Team"? Its definition file is removed.')).toBeTruthy();
    fireEvent.click(btn('Cancel'));
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    expect(document.activeElement).toBe(btn('More team actions'));
    chooseDeleteTeam(); await flush();
    fireEvent.click(btn('Confirm delete')); await flush();
    expect(deleteTeam).toHaveBeenCalledWith('ws-a', 'dev-team');
  });

  it('uneditable_team_menu_item_is_disabled_with_reason', async () => {
    const deleteTeam = vi.fn();
    await renderTeam({ ...withTeam(team({ definition: { state: 'unreadable', problems: [] } })), calls: { deleteTeam } });
    expect(screen.queryByRole('button', { name: 'Rename team' })).toBeNull();
    fireEvent.click(btn('More team actions'));
    const item = screen.getByRole('menuitem', { name: 'Delete team' });
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(document.getElementById(item.getAttribute('aria-describedby')!)!.textContent).toMatch(/could not be read; fix the file/);
    fireEvent.click(item); await flush();
    expect(deleteTeam).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Confirm delete' })).toBeNull();
    expect(screen.getByRole('menu')).toBeTruthy();
  });

  describe('copy runtime id', () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    afterEach(() => {
      if (original) Object.defineProperty(navigator, 'clipboard', original);
      else delete (navigator as unknown as { clipboard?: unknown }).clipboard;
    });

    it('copy_runtime_id_writes_full_id_and_announces', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
      await renderTeam(withTeam(running()));
      fireEvent.click(btn('Copy runtime id')); await flush();
      expect(writeText).toHaveBeenCalledWith(RUNTIME_ID);
      expect(screen.getByRole('status').textContent).toBe('Runtime id copied');
      cleanup();
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
      await renderTeam(withTeam(running()));
      fireEvent.click(btn('Copy runtime id')); await flush();
      expect(screen.getByRole('status').textContent).toBe('Runtime id could not be copied.');
    });
  });

  it('menu_button_disabled_while_stale', async () => {
    await renderTeam({ overview: [ok(overviewFixture([team()])), { ok: false, error: { code: 'INTERNAL', message: 'down', retryable: true } }] });
    fireEvent.click(btn('Refresh')); await flush();
    expect(btn('Rename team').disabled).toBe(true);
    expect(btn('More team actions').disabled).toBe(true);
  });

  it('no_team_selected_shows_teams_h1_and_refresh_only', async () => {
    const { view } = await renderTeam({ overview: [ok(overviewFixture([]))] });
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.textContent).toBe('Teams');
    expect(h1.id).toBe('');
    expect(Array.from(view.container.querySelectorAll('.teams-page-breadcrumb li')).map((li) => li.textContent)).toEqual(['Workspace', 'Teams']);
    expect(btn('Refresh')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Rename team' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'More team actions' })).toBeNull();
  });

  it('underline_tabs_keep_aria_and_rename_heading_is_h2', async () => {
    await renderTeam(withTeam(running()));
    const overview = screen.getByRole('tab', { name: 'Overview' });
    expect(overview.getAttribute('aria-selected')).toBe('true');
    expect(overview.classList.contains('teams-view-tab')).toBe(true);
    fireEvent.keyDown(overview, { key: 'ArrowRight' }); await flush();
    expect(screen.getByRole('tab', { name: 'Routing' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: 'Overview' })); await flush();
    fireEvent.click(btn('Rename team')); await flush();
    const form = screen.getByRole('form', { name: 'Rename team' });
    expect(within(form).getByRole('heading', { level: 2, name: 'Rename team' })).toBeTruthy();
    const levels = screen.getAllByRole('heading').map((h) => Number(h.tagName[1]));
    expect(levels[0]).toBe(1);
    levels.forEach((level, i) => { if (i > 0) expect(level).toBeLessThanOrEqual(levels[i - 1]! + 1); });
  });
});
