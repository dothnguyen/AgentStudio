// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionStatus, DashboardApi, Result } from '../src/renderer/api';
import { WorkspaceShell } from '../src/renderer/shell/WorkspaceShell';
import { activityFixture, boardFixture, deferred, readyApi, teamsFixture, workspaceA } from './dashboardFixtures';
import { fakeManagement } from './teamsFixtures';

afterEach(cleanup);

const connected: ConnectionStatus = { state: 'connected', error: null, distro: 'Ubuntu', command: 'serve' };

function shell(api: DashboardApi) {
  return render(
    <WorkspaceShell management={fakeManagement().api} workspace={workspaceA} dashboard={api} connection={connected} onSwitchWorkspace={vi.fn()} />,
  );
}

describe('dashboard accessibility', () => {
  it('renders one h1, three labelled h2 panel regions, one main and named navigation landmarks', async () => {
    const result = shell(readyApi().api);
    await act(async () => {});

    expect(result.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(result.getByRole('heading', { level: 1 }).textContent).toBe('Workspace overview');
    expect(result.getByRole('navigation', { name: 'Breadcrumb' })).toBeTruthy();
    const h2 = result.getAllByRole('heading', { level: 2 }).map((node) => node.textContent);
    expect(h2).toEqual(['Board status', 'Team status', 'Recent activity']);
    for (const name of ['Board status', 'Team status', 'Recent activity']) {
      expect(result.getByRole('region', { name })).toBeTruthy();
    }
    expect(result.getAllByRole('main')).toHaveLength(1);
    expect(result.getByRole('navigation', { name: 'Workspace' })).toBeTruthy();
    expect(result.getByRole('complementary', { name: 'Workspace sidebar' })).toBeTruthy();
  });

  it('uses status for loading and alert for each retryable error', async () => {
    const never = () => new Promise<Result<never>>(() => {});
    const loading = shell({ teams: never, board: never, activity: never } as unknown as DashboardApi);
    const statuses = loading.getAllByRole('status').map((node) => node.textContent);
    expect(statuses).toHaveLength(4);
    expect(statuses).toContain('Loading teams…');
    expect(statuses.join(' ')).toMatch(/team/i);
    expect(statuses.join(' ')).toMatch(/board/i);
    expect(statuses.join(' ')).toMatch(/activity/i);
    loading.unmount();

    const failure = (message: string) => async () => ({
      ok: false as const,
      error: { code: 'BROKEN', message, retryable: true },
    });
    const failed = shell({
      teams: failure('teams broke'),
      board: failure('board broke'),
      activity: failure('activity broke'),
    } as unknown as DashboardApi);
    await act(async () => {});
    const alerts = failed.getAllByRole('alert').map((node) => node.textContent ?? '');
    expect(alerts).toHaveLength(3);
    for (const message of ['teams broke', 'board broke', 'activity broke']) {
      expect(alerts.some((text) => text.includes(message))).toBe(true);
    }
    expect(failed.getAllByRole('button', { name: 'Retry' })).toHaveLength(3);
  });

  it('gives every visual status marker visible text', async () => {
    const result = shell(readyApi('x').api);
    await act(async () => {});

    const badges = Array.from(result.container.querySelectorAll('.status-badge'));
    expect(badges.length).toBeGreaterThan(0);
    for (const badge of badges) expect((badge.textContent ?? '').trim()).not.toBe('');
    const texts = badges.map((badge) => badge.textContent!.trim());
    for (const expected of ['Connected', 'running', 'no runtime', 'busy', 'open', 'in-review', 'blocked', 'ticket']) {
      expect(texts.some((text) => text.toLowerCase().includes(expected.toLowerCase()))).toBe(true);
    }
    for (const icon of Array.from(result.container.querySelectorAll('.status-dot, .status-icon, .spinner'))) {
      expect(icon.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('renders dashboard collections with list and table semantics and machine-readable time', async () => {
    const result = shell(readyApi('x').api);
    await act(async () => {});

    const teams = within(result.getByRole('region', { name: 'Team status' }));
    expect(teams.getAllByRole('list')).toHaveLength(1);
    expect(teams.getAllByRole('listitem').length).toBeGreaterThanOrEqual(2);
    const board = within(result.getByRole('region', { name: 'Board status' }));
    expect(board.getAllByRole('list').length).toBeGreaterThanOrEqual(2);
    const activityRegion = result.getByRole('region', { name: 'Recent activity' });
    expect(within(activityRegion).getByRole('table', { name: 'Recent activity' })).toBeTruthy();
    expect(within(activityRegion).getAllByRole('columnheader').map((node) => node.textContent)).toEqual(['Event', 'Type', 'Time']);
    expect(within(activityRegion).getAllByRole('row')).toHaveLength(5);
    const times = Array.from(activityRegion.querySelectorAll('time[datetime]'));
    expect(times.map((node) => node.getAttribute('datetime'))).toEqual([
      '2026-01-01T01:02:03.000Z', '2026-01-02T01:02:03.000Z', '2026-01-03T01:02:03.000Z', '2026-01-04T01:02:03.000Z',
    ]);
    expect(result.container.textContent).not.toMatch(/[{}]|"workspace"/);
  });

  it('names the board heading and progress bar', async () => {
    const result = shell(readyApi('x').api);
    await act(async () => {});

    const board = within(result.getByRole('region', { name: 'Board status' }));
    expect(board.getByRole('heading', { level: 2, name: 'Board status' })).toBeTruthy();
    expect(board.getByRole('progressbar', { name: '0 of 2 completed (0%)' })).toBeTruthy();
    expect(board.getByRole('button', { name: 'View board' })).toBeTruthy();
  });

  it('summary_cards_are_static_and_labelled', async () => {
    const result = shell(readyApi('x').api);
    await act(async () => {});
    const region = result.getByRole('region', { name: 'Workspace summary' });
    expect(within(region).getAllByRole('group').map((g) => g.querySelector('.summary-label')!.textContent))
      .toEqual(['Running teams', 'Active assignments', 'Open tickets', 'Completed tickets']);
    expect(result.getAllByRole('heading', { level: 2 }).map((node) => node.textContent))
      .toEqual(['Board status', 'Team status', 'Recent activity']);
    expect(region.querySelector('button, a, input, [tabindex]')).toBeNull();
  });

  it('refresh_is_a_native_busy_button_that_keeps_focus', async () => {
    const fake = readyApi('x');
    const result = shell(fake.api);
    await act(async () => {});
    const refresh = result.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement;
    expect(refresh.tagName).toBe('BUTTON');
    expect(refresh.getAttribute('type')).toBe('button');
    expect(refresh.disabled).toBe(false);
    const pending = deferred<Result<never>>();
    fake.board.mockImplementationOnce(() => pending.promise as never);
    refresh.focus();
    fireEvent.click(refresh);
    expect(refresh.getAttribute('aria-busy')).toBe('true');
    expect(document.activeElement).toBe(refresh);
    expect(within(result.getByRole('region', { name: 'Board status' })).getByRole('status')).toBeTruthy();
    await act(async () => pending.resolve({ ok: true, data: boardFixture('x') } as never));
    expect(refresh.getAttribute('aria-busy')).toBe('false');
    expect(document.activeElement).toBe(refresh);
  });

  it('retry_is_native_and_failures_are_announced_once_per_section', async () => {
    const fake = readyApi('x');
    fake.activity.mockImplementationOnce(async () => ({
      ok: false, error: { code: 'BROKEN', message: 'activity broke', retryable: true },
    }));
    const result = shell(fake.api);
    await act(async () => {});
    const alerts = result.getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].textContent).toContain('activity broke');
    const note = result.container.querySelector('.dashboard-refresh-note')!;
    expect(note.textContent).toBe('Not updated: Recent activity');
    expect(note.getAttribute('role')).toBeNull();
    const retry = within(result.getByRole('region', { name: 'Recent activity' })).getByRole('button', { name: 'Retry' });
    expect(retry.tagName).toBe('BUTTON');
    expect(retry.getAttribute('type')).toBe('button');
    retry.focus();
    expect(document.activeElement).toBe(retry);
    fireEvent.click(retry);
    await act(async () => {});
    expect(result.queryAllByRole('alert')).toHaveLength(0);
    expect(result.container.querySelector('.dashboard-refresh-note')).toBeNull();
  });

  it('panels_follow_visual_order_board_team_activity', async () => {
    const result = shell(readyApi('x').api);
    await act(async () => {});
    const grid = result.container.querySelector('.dashboard-grid')!;
    const kids = Array.from(grid.children);
    expect(kids[0].className).toContain('dashboard-panel-board');
    expect(kids[1].className).toContain('dashboard-panel-teams');
    expect(kids[2].className).toContain('dashboard-panel-activity');
    const region = result.getByRole('region', { name: 'Workspace summary' });
    expect(region.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keyboard_order_matches_visual_order', async () => {
    const result = shell(readyApi('x').api);
    await act(async () => {});
    const board = within(result.getByRole('region', { name: 'Board status' }));
    const team = within(result.getByRole('region', { name: 'Team status' }));
    const ordered = [
      result.getByRole('button', { name: /^Current workspace: / }),
      result.getByRole('button', { name: 'Home' }),
      result.getByRole('button', { name: 'Teams' }),
      result.getByRole('button', { name: 'Boards' }),
      result.getByRole('button', { name: 'Configuration' }),
      result.getByRole('button', { name: 'Switch workspace' }),
      result.getByRole('button', { name: 'Refresh' }),
      board.getByRole('button', { name: 'View board' }),
      team.getByRole('button', { name: 'View teams' }),
    ];
    for (let index = 0; index < ordered.length - 1; index += 1) {
      expect(ordered[index].compareDocumentPosition(ordered[index + 1]) & Node.DOCUMENT_POSITION_FOLLOWING, String(index)).toBeTruthy();
    }
    for (const button of Array.from(result.container.querySelectorAll('button'))) {
      expect(button).toBeInstanceOf(HTMLButtonElement);
      expect(button.getAttribute('type')).toBe('button');
    }
    expect(Array.from(result.container.querySelectorAll('[tabindex]')).every((n) => Number(n.getAttribute('tabindex')) <= 0)).toBe(true);
  });

  it('retry_buttons_follow_panel_order_and_take_focus', async () => {
    const failure = (message: string) => async () => ({
      ok: false as const,
      error: { code: 'BROKEN', message, retryable: true },
    });
    const result = shell({ teams: failure('a'), board: failure('b'), activity: failure('c') } as unknown as DashboardApi);
    await act(async () => {});
    const retries = result.getAllByRole('button', { name: 'Retry' });
    expect(retries).toHaveLength(3);
    expect(retries.map((r) => r.closest('section')!.querySelector('h2')!.textContent))
      .toEqual(['Board status', 'Team status', 'Recent activity']);
    for (const retry of retries) {
      retry.focus();
      expect(document.activeElement).toBe(retry);
    }
  });

  it('every_state_keeps_one_h1_and_three_panel_h2s', async () => {
    const ok = <T,>(data: T) => vi.fn(async () => ({ ok: true as const, data }));
    const fail = (code: string, retryable: boolean) => vi.fn(async () => ({
      ok: false as const,
      error: { code, message: 'broke', retryable },
    }));
    const states: Record<string, unknown> = {
      loading: { teams: () => new Promise(() => {}), board: () => new Promise(() => {}), activity: () => new Promise(() => {}) },
      error: { teams: fail('BROKEN', true), board: fail('BROKEN', true), activity: fail('BROKEN', true) },
      empty: {
        teams: ok({ ...teamsFixture('e'), teams: [] }),
        board: ok({ ...boardFixture('e'), columns: [], tickets: [], totals: { active: 0, blocked: 0, done: 0 } }),
        activity: ok({ ...activityFixture('e'), entries: [], head: 0 }),
      },
      unavailable: {
        teams: ok(teamsFixture('u')),
        board: fail('BOARD_CONFIG_INVALID', false),
        activity: ok(activityFixture('u')),
      },
    };
    for (const [name, api] of Object.entries(states)) {
      const result = shell(api as DashboardApi);
      await act(async () => {});
      expect(result.getAllByRole('heading', { level: 1 }).map((n) => n.textContent), name).toEqual(['Workspace overview']);
      expect(result.getAllByRole('heading', { level: 2 }).map((n) => n.textContent), name)
        .toEqual(['Board status', 'Team status', 'Recent activity']);
      expect(result.getAllByRole('main'), name).toHaveLength(1);
      expect(result.getByRole('button', { name: 'Refresh' })).toBeTruthy();
      if (name === 'unavailable') {
        const board = within(result.getByRole('region', { name: 'Board status' }));
        expect(board.getByText('No board configured for this workspace')).toBeTruthy();
        expect(board.queryByRole('button', { name: 'Retry' })).toBeNull();
      }
      if (name === 'empty') expect(result.queryAllByRole('alert')).toHaveLength(0);
      result.unmount();
    }
  });

  it('long_strings_stay_whole_and_accessible', async () => {
    const workspace = { ...workspaceA, name: 'W'.repeat(180), path: '/mnt/c/' + 'very-long-segment/'.repeat(12) };
    const phase = 'Phase-' + 'x'.repeat(150);
    const ticket = 'z'.repeat(200);
    const teamName = 'Team-' + 'y'.repeat(150);
    const summary = 'Event ' + 'e'.repeat(200);
    const board = boardFixture('l');
    board.currentPhase = { ...board.currentPhase!, name: phase };
    board.tickets[0] = { ...board.tickets[0], title: ticket };
    const teams = teamsFixture('l');
    teams.teams[0] = { ...teams.teams[0], name: teamName };
    const activity = activityFixture('l');
    activity.entries[0] = { ...activity.entries[0], summary };
    const api = {
      teams: vi.fn(async () => ({ ok: true, data: teams })),
      board: vi.fn(async () => ({ ok: true, data: board })),
      activity: vi.fn(async () => ({ ok: true, data: activity })),
    } as unknown as DashboardApi;
    const result = render(
      <WorkspaceShell management={fakeManagement().api} workspace={workspace} dashboard={api} connection={connected} onSwitchWorkspace={vi.fn()} />,
    );
    await act(async () => {});
    const c = result.container;
    expect(result.getByRole('heading', { level: 1 }).textContent).toBe('Workspace overview');
    const name = c.querySelector('.dashboard-workspace-name')!;
    expect(name.textContent).toBe(workspace.name);
    expect(name.getAttribute('title')).toBe(workspace.name);
    expect(c.querySelector('.dashboard-path')!.textContent).toBe(workspace.path);
    expect(c.querySelector('.workspace-name')!.getAttribute('title')).toBe(workspace.name);
    expect(c.querySelector('.workspace-path')!.getAttribute('title')).toBe(workspace.path);
    const boardText = result.getByRole('region', { name: 'Board status' }).textContent!;
    expect(boardText).toContain(phase);
    expect(boardText).toContain(ticket);
    expect(result.getByRole('region', { name: 'Team status' }).textContent).toContain(teamName);
    const act2 = result.getByRole('region', { name: 'Recent activity' });
    expect(act2.textContent!.includes(summary) || act2.querySelector(`[title="${summary}"]`) !== null).toBe(true);
  });
});

describe('dashboard icon accessibility', () => {
  it('icons_add_no_roles_names_or_tab_stops', async () => {
    const result = shell(readyApi('x').api);
    await act(async () => {});
    const svgs = Array.from(result.container.querySelectorAll('svg[data-icon]'));
    expect(svgs.length).toBeGreaterThan(0);
    for (const svg of svgs) {
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      expect(svg.getAttribute('focusable')).toBe('false');
      expect(svg.hasAttribute('role')).toBe(false);
      expect(svg.hasAttribute('tabindex')).toBe(false);
      expect(svg.querySelector('title')).toBeNull();
    }
    for (const name of ['Refresh', 'View board', 'View teams']) expect(result.getByRole('button', { name })).toBeTruthy();
  });
});
