// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionStatus, DashboardActivity, DashboardApi, DashboardBoard, DashboardTeams, Result, Workspace } from '../src/renderer/api';
import { DashboardHome } from '../src/renderer/dashboard/DashboardHome';
import { WorkspaceShell } from '../src/renderer/shell/WorkspaceShell';
import { CONNECTED_TEXT, CONNECTING_TEXT, LOST_TITLE, StartupScreen } from '../src/renderer/StartupScreen';
import { activityFixture, boardFixture, readyApi, teamsFixture, workspaceA, workspaceB } from './dashboardFixtures';
import { fakeConnection } from './fakeConnection';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const workspace: Workspace = { id: 'workspace-7', name: 'Seventh workspace', path: '/full/path/seven', missing: false, exists: true };
const connected: ConnectionStatus = { state: 'connected', error: null, distro: 'Ubuntu', command: 'serve' };
const emptyTeams: DashboardTeams = { workspace: workspace.path, teams: [], truncated: false };
const emptyBoard: DashboardBoard = {
  workspace: workspace.path,
  currentPhase: { slug: 'default', name: 'Default', status: 'open' },
  columns: [],
  totals: { active: 0, blocked: 0, done: 0 },
  tickets: [],
};
const emptyActivity: DashboardActivity = { workspace: workspace.path, dbId: 'activity-db', head: 0, entries: [] };
const recentActivity: DashboardActivity = {
  ...emptyActivity,
  head: 1,
  entries: [{
    id: 'ticket-event:1', at: '2026-01-02T03:04:05.000Z', kind: 'ticket', name: 'ticket.moved',
    summary: 'Ticket T-001 moved from open to done', subject: { type: 'ticket', id: 'ticket-1', label: 'T-001' },
  }],
};

type Response<T> = Promise<Result<T>> | Result<T>;

function fakeDashboard(
  teamResponses: Array<Response<DashboardTeams>> = [{ ok: true, data: emptyTeams }],
  boardResponses: Array<Response<DashboardBoard>> = [{ ok: true, data: emptyBoard }],
) {
  let teamIndex = 0;
  let boardIndex = 0;
  const teams = vi.fn(() => Promise.resolve(teamResponses[Math.min(teamIndex++, teamResponses.length - 1)]));
  const board = vi.fn(() => Promise.resolve(boardResponses[Math.min(boardIndex++, boardResponses.length - 1)]));
  const activity = vi.fn(async () => ({ ok: true, data: emptyActivity } as Result<DashboardActivity>));
  return { api: { teams, board, activity } as DashboardApi, teams, board, activity };
}

function fakeDashboardWithActivity(
  activityResponses: Array<Promise<Result<DashboardActivity>> | Result<DashboardActivity>>,
  ...teamResponses: Array<Promise<Result<DashboardTeams>> | Result<DashboardTeams>>
) {
  const fake = fakeDashboard(teamResponses);
  let index = 0;
  const activity = vi.fn(() => Promise.resolve(activityResponses[index++] ?? activityResponses.at(-1)!));
  return { ...fake, api: { ...fake.api, activity }, activity };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('DashboardHome', () => {
  it('renders breadcrumb and overview heading', async () => {
    const fake = fakeDashboard();
    const result = render(<DashboardHome workspace={workspace} dashboard={fake.api} connection={connected} onNavigate={vi.fn()} />);
    await act(async () => {});
    const nav = result.getByRole('navigation', { name: 'Breadcrumb' });
    expect(nav.textContent).toBe('WorkspaceHome');
    expect(nav.querySelector('li[aria-current="page"]')?.textContent).toBe('Home');
    const h1 = result.getAllByRole('heading', { level: 1 });
    expect(h1).toHaveLength(1);
    expect(h1[0].textContent).toBe('Workspace overview');
  });

  it('connection badge keeps exact wording with an aria-hidden dot', async () => {
    const fake = fakeDashboard();
    const states: Array<[ConnectionStatus['state'], string]> = [
      ['connecting', CONNECTING_TEXT], ['connected', CONNECTED_TEXT], ['lost', LOST_TITLE],
    ];
    const result = render(<DashboardHome workspace={workspace} dashboard={fake.api} connection={connected} onNavigate={vi.fn()} />);
    await act(async () => {});
    for (const [state, text] of states) {
      result.rerender(
        <DashboardHome workspace={workspace} dashboard={fake.api} connection={{ ...connected, state }} onNavigate={vi.fn()} />,
      );
      const badge = result.container.querySelector('.connection-badge')!;
      expect(badge.classList.contains(`connection-${state}`)).toBe(true);
      expect(badge.textContent).toBe(text);
      expect(badge.querySelector('.status-dot')?.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('refresh button keeps its accessible name with an icon', async () => {
    const fake = fakeDashboard();
    const result = render(<DashboardHome workspace={workspace} dashboard={fake.api} connection={connected} onNavigate={vi.fn()} />);
    await act(async () => {});
    const button = result.getByRole('button', { name: 'Refresh' });
    expect(button.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
    await act(async () => { fireEvent.click(button); });
    expect(fake.teams).toHaveBeenCalledTimes(2);
    expect(fake.board).toHaveBeenCalledTimes(2);
    expect(fake.activity).toHaveBeenCalledTimes(2);
  });

  it('long and markup-like workspace identity stays literal with full text', async () => {
    const fake = fakeDashboard();
    const odd = { ...workspace, name: '<b>x</b>'.repeat(20), path: '/very/long/'.repeat(30) };
    const result = render(<DashboardHome workspace={odd} dashboard={fake.api} connection={connected} onNavigate={vi.fn()} />);
    await act(async () => {});
    const name = result.container.querySelector('.dashboard-workspace-name')!;
    expect(name.textContent).toBe(odd.name);
    expect(name.getAttribute('title')).toBe(odd.name);
    const path = result.container.querySelector('code.dashboard-path')!;
    expect(path.textContent).toBe(odd.path);
    expect(path.getAttribute('title')).toBe(odd.path);
    expect(result.container.querySelector('b')).toBeNull();
  });

  it('header stays visible while every section is loading', () => {
    const pending = vi.fn(() => new Promise<never>(() => {}));
    const api = { teams: pending, board: pending, activity: pending } as unknown as DashboardApi;
    const result = render(<DashboardHome workspace={workspace} dashboard={api} connection={connected} onNavigate={vi.fn()} />);
    expect(result.getByRole('heading', { level: 1, name: 'Workspace overview' })).toBeTruthy();
    expect(result.getByRole('navigation', { name: 'Breadcrumb' })).toBeTruthy();
    expect(result.getByText(CONNECTED_TEXT)).toBeTruthy();
    expect(result.getByRole('button', { name: 'Refresh' })).toBeTruthy();
    expect(result.getAllByRole('status')).toHaveLength(3);
    expect(result.container.textContent).not.toContain('Last updated');
  });

  it('header stays visible when every section fails', async () => {
    const failed = vi.fn(async () => ({ ok: false, error: { code: 'BROKEN', message: 'x failed', retryable: true } }));
    const api = { teams: failed, board: failed, activity: failed } as unknown as DashboardApi;
    const result = render(<DashboardHome workspace={workspace} dashboard={api} connection={connected} onNavigate={vi.fn()} />);
    await act(async () => {});
    expect(result.getByRole('heading', { level: 1, name: 'Workspace overview' })).toBeTruthy();
    expect(result.getByRole('button', { name: 'Refresh' })).toBeTruthy();
    expect(result.getByText(CONNECTED_TEXT)).toBeTruthy();
    expect(result.getAllByRole('alert')).toHaveLength(3);
    expect(result.getAllByRole('button', { name: 'Retry' })).toHaveLength(3);
  });

  it('opens_home_with_one_teams_request', async () => {
    const fake = fakeDashboard();
    const result = render(<WorkspaceShell workspace={workspace} dashboard={fake.api} connection={connected} onSwitchWorkspace={vi.fn()} />);
    await act(async () => {});

    const heading = result.getByRole('heading', { level: 1, name: 'Workspace overview' });
    expect(heading).toBeTruthy();
    const name = result.container.querySelector('.dashboard-workspace-name');
    expect(name?.textContent).toBe(workspace.name);
    expect(name?.getAttribute('title')).toBe(workspace.name);
    const path = result.getAllByText(workspace.path).find((node) => node.tagName === 'CODE');
    expect(path?.getAttribute('title')).toBe(workspace.path);
    expect(result.getByText(CONNECTED_TEXT)).toBeTruthy();
    expect(result.getByRole('region', { name: 'Team status' })).toBeTruthy();
    expect(result.getByRole('region', { name: 'Board status' })).toBeTruthy();
    expect(result.getByRole('region', { name: 'Recent activity' }).textContent).toContain('No recent activity');
    expect(fake.teams).toHaveBeenCalledTimes(1);
    expect(fake.teams).toHaveBeenCalledWith(workspace.id);
    expect(fake.board).toHaveBeenCalledTimes(1);
    expect(fake.activity).toHaveBeenCalledTimes(1);
  });

  it('loads_board_once_when_dashboard_opens', async () => {
    const fake = fakeDashboard();
    render(<DashboardHome workspace={workspace} dashboard={fake.api} connection={connected} onNavigate={vi.fn()} />);
    await act(async () => {});

    expect(fake.board).toHaveBeenCalledTimes(1);
    expect(fake.board).toHaveBeenCalledWith(workspace.id);
  });

  it('refreshes_teams_once_and_updates_last_updated_on_success', async () => {
    const first = deferred<Result<DashboardTeams>>();
    const second = deferred<Result<DashboardTeams>>();
    const fake = fakeDashboard([first.promise, second.promise]);
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const result = render(<DashboardHome workspace={workspace} dashboard={fake.api} connection={connected} onNavigate={vi.fn()} />);
    expect(result.queryByText(/Last updated/)).toBeNull();
    const refresh = result.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement;
    expect(refresh.disabled).toBe(false);
    expect(refresh.getAttribute('aria-busy')).toBe('true');

    await act(async () => first.resolve({ ok: true, data: emptyTeams }));
    expect(result.getByText(`Last updated ${new Date(1_000).toLocaleTimeString()}`).getAttribute('datetime')).toBe(new Date(1_000).toISOString());
    fireEvent.click(refresh);
    expect(fake.teams).toHaveBeenCalledTimes(2);
    expect(refresh.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(refresh);
    expect(fake.teams).toHaveBeenCalledTimes(2);
    dateNow.mockReturnValue(2_000);
    await act(async () => second.resolve({ ok: true, data: emptyTeams }));
    expect(result.getByText(`Last updated ${new Date(2_000).toLocaleTimeString()}`)).toBeTruthy();
  });

  it('team_error_does_not_hide_the_dashboard_frame_and_retry_calls_only_teams', async () => {
    const first: Result<DashboardTeams> = { ok: false, error: { code: 'TEAMS', message: 'failed', retryable: true } };
    const fake = fakeDashboard([first, { ok: true, data: emptyTeams }]);
    const result = render(<DashboardHome workspace={workspace} dashboard={fake.api} connection={connected} onNavigate={vi.fn()} />);
    await act(async () => {});

    expect(result.getByRole('heading', { level: 1, name: 'Workspace overview' })).toBeTruthy();
    expect(result.getByRole('region', { name: 'Board status' })).toBeTruthy();
    expect(result.getByRole('region', { name: 'Recent activity' })).toBeTruthy();
    fireEvent.click(within(result.getByRole('region', { name: 'Team status' })).getByRole('button', { name: 'Retry' }));
    expect(fake.teams).toHaveBeenCalledTimes(2);
    expect(fake.board).toHaveBeenCalledTimes(1);
    expect(fake.activity).toHaveBeenCalledTimes(1);
  });

  it('view_teams_selects_the_existing_shell_section', async () => {
    const fake = fakeDashboard();
    const result = render(<WorkspaceShell workspace={workspace} dashboard={fake.api} connection={connected} onSwitchWorkspace={vi.fn()} />);
    await act(async () => {});
    fireEvent.click(result.getByRole('button', { name: 'View teams' }));

    expect(result.getByRole('heading', { level: 1, name: 'Teams' })).toBeTruthy();
    const nav = result.getByRole('navigation', { name: 'Workspace' });
    expect(within(nav).getByRole('button', { name: 'Teams' }).getAttribute('aria-current')).toBe('page');
    expect(within(nav).getByRole('button', { name: 'Home' }).getAttribute('aria-current')).toBeNull();
  });

  it('loads recent activity once for the selected workspace', async () => {
    const selected = { ...workspace, id: 'workspace-a' };
    const fake = fakeDashboardWithActivity(
      [{ ok: true, data: recentActivity }],
      { ok: true, data: emptyTeams },
    );
    const result = render(<DashboardHome workspace={selected} dashboard={fake.api} connection={connected} onNavigate={vi.fn()} />);
    await act(async () => {});

    expect(fake.activity).toHaveBeenCalledTimes(1);
    expect(fake.activity).toHaveBeenCalledWith('workspace-a');
    expect(result.getByText('Ticket T-001 moved from open to done')).toBeTruthy();
  });

  it('activity failure leaves Teams and Board visible and its retry is isolated', async () => {
    const activityError: Result<DashboardActivity> = {
      ok: false,
      error: { code: 'UNAVAILABLE', message: 'Activity could not be loaded.', retryable: true },
    };
    const fake = fakeDashboardWithActivity(
      [activityError, { ok: true, data: recentActivity }],
      { ok: true, data: emptyTeams },
    );
    const result = render(<DashboardHome workspace={workspace} dashboard={fake.api} connection={connected} onNavigate={vi.fn()} />);
    await act(async () => {});

    expect(result.getByRole('region', { name: 'Team status' })).toBeTruthy();
    expect(result.getByRole('region', { name: 'Board status' })).toBeTruthy();
    const activityRegion = result.getByRole('region', { name: 'Recent activity' });
    expect(within(activityRegion).getByRole('alert').textContent).toContain('UNAVAILABLE: Activity could not be loaded.');
    fireEvent.click(within(activityRegion).getByRole('button', { name: 'Retry' }));

    expect(fake.activity).toHaveBeenCalledTimes(2);
    expect(fake.teams).toHaveBeenCalledTimes(1);
    expect(fake.board).toHaveBeenCalledTimes(1);
  });

  it('top-level Refresh includes activity', async () => {
    const fake = fakeDashboardWithActivity(
      [{ ok: true, data: emptyActivity }, { ok: true, data: recentActivity }],
      { ok: true, data: emptyTeams },
      { ok: true, data: emptyTeams },
    );
    const result = render(<DashboardHome workspace={workspace} dashboard={fake.api} connection={connected} onNavigate={vi.fn()} />);
    await act(async () => {});
    fireEvent.click(result.getByRole('button', { name: 'Refresh' }));
    await act(async () => {});

    expect(fake.teams).toHaveBeenCalledTimes(2);
    expect(fake.activity).toHaveBeenCalledTimes(2);
    expect(fake.board).toHaveBeenCalledTimes(2);
  });

  it('uses_exact_startup_connection_wording', () => {
    const never = new Promise<Result<DashboardTeams>>(() => {});
    const fake = fakeDashboard([never]);
    const result = render(<DashboardHome workspace={workspace} dashboard={fake.api} connection={{ ...connected, state: 'connecting' }} onNavigate={vi.fn()} />);
    expect(result.getByText(CONNECTING_TEXT)).toBeTruthy();
    result.rerender(<DashboardHome workspace={workspace} dashboard={fake.api} connection={connected} onNavigate={vi.fn()} />);
    expect(result.getByText(CONNECTED_TEXT)).toBeTruthy();
    result.rerender(<DashboardHome workspace={workspace} dashboard={fake.api} connection={{ ...connected, state: 'lost' }} onNavigate={vi.fn()} />);
    expect(result.getByText(LOST_TITLE)).toBeTruthy();
  });

  it('dashboard_fake_has_read_methods_only', async () => {
    const fake = fakeDashboard();
    render(<DashboardHome workspace={workspace} dashboard={fake.api} connection={connected} onNavigate={vi.fn()} />);
    await act(async () => {});
    expect(Object.keys(fake.api).sort()).toEqual(['activity', 'board', 'teams']);
    expect(fake.teams).toHaveBeenCalledTimes(1);
    expect(fake.board).toHaveBeenCalledTimes(1);
    expect(fake.activity).toHaveBeenCalledTimes(1);
  });

  it('board_failure_leaves_ready_teams_visible', async () => {
    const teamData: DashboardTeams = {
      workspace: workspace.path,
      teams: [{ id: 'builders', name: 'Build team', members: 0, runtime: null }],
      truncated: false,
    };
    const fake = fakeDashboard(
      [{ ok: true, data: teamData }],
      [{ ok: false, error: { code: 'BOARD_FAILED', message: 'Board unavailable', retryable: true } }],
    );
    const result = render(<DashboardHome workspace={workspace} dashboard={fake.api} connection={connected} onNavigate={vi.fn()} />);
    await act(async () => {});

    expect(within(result.getByRole('region', { name: 'Team status' })).getByText('Build team')).toBeTruthy();
    const board = result.getByRole('region', { name: 'Board status' });
    expect(within(board).getByRole('alert').textContent).toBe('Board unavailable');
    expect(within(result.getByRole('region', { name: 'Team status' })).queryByRole('alert')).toBeNull();
  });

  it('board_loading_keeps_ready_teams_visible', async () => {
    const pendingBoard = deferred<Result<DashboardBoard>>();
    const teamData: DashboardTeams = {
      workspace: workspace.path,
      teams: [{ id: 'builders', name: 'Build team', members: 1, runtime: null }],
      truncated: false,
    };
    const fake = fakeDashboard([{ ok: true, data: teamData }], [pendingBoard.promise]);
    const result = render(<DashboardHome workspace={workspace} dashboard={fake.api} connection={connected} onNavigate={vi.fn()} />);
    await act(async () => {});

    expect(within(result.getByRole('region', { name: 'Team status' })).getByText('Build team')).toBeTruthy();
    expect(within(result.getByRole('region', { name: 'Board status' })).getByRole('status').textContent).toBe('Loading board…');
    expect((result.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).getAttribute('aria-busy')).toBe('true');
  });

  it('refresh_while_board_is_loading_reloads_settled_teams_only', async () => {
    const pendingBoard = deferred<Result<DashboardBoard>>();
    const teamRefresh = deferred<Result<DashboardTeams>>();
    const fake = fakeDashboard(
      [{ ok: true, data: emptyTeams }, teamRefresh.promise],
      [pendingBoard.promise],
    );
    const result = render(<DashboardHome workspace={workspace} dashboard={fake.api} connection={connected} onNavigate={vi.fn()} />);
    await act(async () => {});

    fireEvent.click(result.getByRole('button', { name: 'Refresh' }));
    expect(fake.teams).toHaveBeenCalledTimes(2);
    expect(fake.board).toHaveBeenCalledTimes(1);
  });

  it('refresh_while_teams_is_loading_reloads_settled_board_only', async () => {
    const pendingTeams = deferred<Result<DashboardTeams>>();
    const boardRefresh = deferred<Result<DashboardBoard>>();
    const fake = fakeDashboard(
      [pendingTeams.promise],
      [{ ok: true, data: emptyBoard }, boardRefresh.promise],
    );
    const result = render(<DashboardHome workspace={workspace} dashboard={fake.api} connection={connected} onNavigate={vi.fn()} />);
    await act(async () => {});

    fireEvent.click(result.getByRole('button', { name: 'Refresh' }));
    expect(fake.teams).toHaveBeenCalledTimes(1);
    expect(fake.board).toHaveBeenCalledTimes(2);
    expect(within(result.getByRole('region', { name: 'Team status' })).getByRole('status').textContent).toBe('Loading team status…');
  });

  it('board_retry_does_not_reload_teams', async () => {
    const fake = fakeDashboard(
      [{ ok: true, data: emptyTeams }],
      [
        { ok: false, error: { code: 'BOARD_FAILED', message: 'Board unavailable', retryable: false } },
        { ok: true, data: emptyBoard },
      ],
    );
    const result = render(<DashboardHome workspace={workspace} dashboard={fake.api} connection={connected} onNavigate={vi.fn()} />);
    await act(async () => {});

    fireEvent.click(within(result.getByRole('region', { name: 'Board status' })).getByRole('button', { name: 'Retry' }));
    await act(async () => {});
    expect(fake.board).toHaveBeenCalledTimes(2);
    expect(fake.teams).toHaveBeenCalledTimes(1);
  });

  it('header_refresh_reloads_each_settled_section_once', async () => {
    const fake = fakeDashboard();
    const result = render(<DashboardHome workspace={workspace} dashboard={fake.api} connection={connected} onNavigate={vi.fn()} />);
    await act(async () => {});

    fireEvent.click(result.getByRole('button', { name: 'Refresh' }));
    expect(fake.teams).toHaveBeenCalledTimes(2);
    expect(fake.board).toHaveBeenCalledTimes(2);
  });

  it('view_board_selects_boards_in_the_workspace_shell', async () => {
    const fake = fakeDashboard();
    const onSwitchWorkspace = vi.fn();
    const result = render(<WorkspaceShell workspace={workspace} dashboard={fake.api} connection={connected} onSwitchWorkspace={onSwitchWorkspace} />);
    await act(async () => {});
    fireEvent.click(result.getByRole('button', { name: 'View board' }));

    expect(result.getByRole('heading', { level: 1, name: 'Boards' })).toBeTruthy();
    const nav = result.getByRole('navigation', { name: 'Workspace' });
    expect(within(nav).getByRole('button', { name: 'Boards' }).getAttribute('aria-current')).toBe('page');
    expect(within(nav).getByRole('button', { name: 'Home' }).getAttribute('aria-current')).toBeNull();
    expect(onSwitchWorkspace).not.toHaveBeenCalled();
  });
});

describe('DashboardHome composition', () => {
  const messages = { teams: 'Alpha running team', board: 'Alpha phase', activity: 'Alpha ticket T-1 moved' };

  it.each(['teams', 'board', 'activity'] as const)(
    'keeps sibling panels ready and retries only a failed %s panel',
    async (failing) => {
      const fake = readyApi('Alpha');
      const failure = { ok: false as const, error: { code: 'BROKEN', message: 'panel failed', retryable: true } };
      const method = fake[failing] as ReturnType<typeof vi.fn>;
      method.mockImplementationOnce(async () => failure);
      const result = render(<DashboardHome workspace={workspaceA} dashboard={fake.api} connection={connected} onNavigate={vi.fn()} />);
      await act(async () => {});

      for (const [name, text] of Object.entries(messages)) {
        if (name !== failing) expect(result.getAllByText(new RegExp(text)).length).toBeGreaterThan(0);
      }
      expect(result.getByRole('alert').textContent).toContain('panel failed');
      const counts = { teams: fake.teams.mock.calls.length, board: fake.board.mock.calls.length, activity: fake.activity.mock.calls.length };
      fireEvent.click(result.getByRole('button', { name: 'Retry' }));
      await act(async () => {});

      for (const name of ['teams', 'board', 'activity'] as const) {
        expect(fake[name].mock.calls.length).toBe(counts[name] + (name === failing ? 1 : 0));
      }
      expect(result.queryByRole('alert')).toBeNull();
      for (const text of Object.values(messages)) expect(result.getAllByText(new RegExp(text)).length).toBeGreaterThan(0);
    },
  );

  it('refreshes all panels once and ignores refresh while the batch is pending', async () => {
    const fake = readyApi('Alpha');
    const result = render(<DashboardHome workspace={workspaceA} dashboard={fake.api} connection={connected} onNavigate={vi.fn()} />);
    await act(async () => {});

    const pendingBoard = deferred<Result<DashboardBoard>>();
    fake.board.mockImplementationOnce(() => pendingBoard.promise);
    const refresh = result.getByRole('button', { name: 'Refresh' });
    refresh.focus();
    fireEvent.click(refresh);
    expect([fake.teams.mock.calls.length, fake.board.mock.calls.length, fake.activity.mock.calls.length]).toEqual([2, 2, 2]);
    await act(async () => {});
    fireEvent.click(refresh);
    expect([fake.teams.mock.calls.length, fake.board.mock.calls.length, fake.activity.mock.calls.length]).toEqual([2, 2, 2]);
    expect(refresh.getAttribute('aria-busy')).toBe('true');

    await act(async () => pendingBoard.resolve({ ok: true, data: boardFixture('Alpha') }));
    expect(refresh.getAttribute('aria-busy')).toBe('false');
    expect(document.activeElement).toBe(refresh);
    expect(result.getByRole('button', { name: 'Refresh' })).toBe(refresh);
  });

  it('drops responses from the workspace switched away from', async () => {
    const a = { teams: deferred<Result<DashboardTeams>>(), board: deferred<Result<DashboardBoard>>(), activity: deferred<Result<DashboardActivity>>() };
    const b = { teams: deferred<Result<DashboardTeams>>(), board: deferred<Result<DashboardBoard>>(), activity: deferred<Result<DashboardActivity>>() };
    const pick = <T,>(id: string, x: Deferred<Result<T>>, y: Deferred<Result<T>>) => (id === workspaceA.id ? x : y).promise;
    const teams = vi.fn((id: string) => pick(id, a.teams, b.teams));
    const board = vi.fn((id: string) => pick(id, a.board, b.board));
    const activity = vi.fn((id: string) => pick(id, a.activity, b.activity));
    const api = { teams, board, activity } as DashboardApi;

    function Harness() {
      const [current, setCurrent] = useState<Workspace | null>(workspaceA);
      return current === null ? (
        <button type="button" onClick={() => setCurrent(workspaceB)}>Open B</button>
      ) : (
        <WorkspaceShell workspace={current} dashboard={api} connection={connected} onSwitchWorkspace={() => setCurrent(null)} />
      );
    }
    const result = render(<Harness />);
    await act(async () => {});
    fireEvent.click(result.getByRole('button', { name: 'Switch workspace' }));
    fireEvent.click(result.getByRole('button', { name: 'Open B' }));
    await act(async () => {});

    for (const method of [teams, board, activity]) {
      expect(method.mock.calls.filter(([id]) => id === workspaceB.id)).toHaveLength(1);
    }
    await act(async () => {
      b.teams.resolve({ ok: true, data: teamsFixture('Beta') });
      b.board.resolve({ ok: true, data: boardFixture('Beta') });
      b.activity.resolve({ ok: true, data: activityFixture('Beta') });
    });
    await act(async () => {
      a.teams.resolve({ ok: true, data: teamsFixture('Alpha') });
      a.board.resolve({ ok: true, data: boardFixture('Alpha') });
      a.activity.resolve({ ok: true, data: activityFixture('Alpha') });
    });
    expect(result.getAllByText(/Beta/).length).toBeGreaterThan(0);
    expect(result.container.textContent).toContain('Beta running team');
    expect(result.container.textContent).not.toContain('Alpha running team');
    expect(result.container.textContent).not.toContain('Alpha phase');
    expect(result.container.textContent).not.toContain('Alpha ticket T-1 moved');
  });

  it('replaces a connected dashboard with the startup retry view on connection loss', async () => {
    const fake = readyApi('Alpha');
    const conn = fakeConnection();
    const onRetry = vi.fn();
    const result = render(
      <StartupScreen
        connection={conn.api}
        onRetry={onRetry}
        connectedView={(status) => (
          <WorkspaceShell workspace={workspaceA} dashboard={fake.api} connection={status} onSwitchWorkspace={vi.fn()} />
        )}
      />,
    );
    await act(async () => conn.emit(connected));
    await act(async () => {});
    expect(result.getByRole('heading', { level: 1, name: 'Workspace overview' })).toBeTruthy();

    await act(async () => conn.emit({ state: 'lost', error: 'serve exited', distro: 'Ubuntu', command: 'serve' }));
    expect(result.getByRole('heading', { level: 1 }).textContent).toBe(LOST_TITLE);
    expect(result.queryByText('Alpha running team')).toBeNull();
    expect(result.queryByRole('heading', { name: 'Team status' })).toBeNull();
    expect(result.container.querySelectorAll('[data-role="app-shell"]')).toHaveLength(1);
    expect(document.activeElement).toBe(result.getByRole('button', { name: 'Retry' }));
  });
});

describe('DashboardHome summary metrics', () => {
  function renderHome(api: DashboardApi) {
    return render(<DashboardHome workspace={workspaceA} dashboard={api} connection={connected} onNavigate={vi.fn()} />);
  }

  it('summary_uses_existing_section_results_without_extra_requests', async () => {
    const fake = readyApi('Alpha');
    const result = renderHome(fake.api);
    await act(async () => {});
    expect(within(result.getByRole('group', { name: 'Running teams' })).getByText('1')).toBeTruthy();
    expect(within(result.getByRole('group', { name: 'Open tickets' })).getByText('2')).toBeTruthy();
    expect(within(result.getByRole('group', { name: 'Completed tickets' })).getByText('0')).toBeTruthy();
    for (const fn of [fake.teams, fake.board, fake.activity]) {
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith(workspaceA.id);
    }
    expect(Object.keys(fake.api).sort()).toEqual(['activity', 'board', 'teams']);
  });

  it('summary_partial_error_keeps_successful_cards', async () => {
    const fake = readyApi('Alpha');
    fake.board.mockImplementationOnce(async () => ({ ok: false, error: { code: 'BROKEN', message: 'panel failed', retryable: true } }));
    const result = renderHome(fake.api);
    await act(async () => {});
    expect(within(result.getByRole('group', { name: 'Open tickets' })).getByText('Unavailable: board could not be loaded')).toBeTruthy();
    expect(within(result.getByRole('group', { name: 'Running teams' })).getByText('1')).toBeTruthy();
    fireEvent.click(within(result.getByRole('region', { name: 'Board status' })).getByRole('button', { name: 'Retry' }));
    await act(async () => {});
    expect(within(result.getByRole('group', { name: 'Open tickets' })).getByText('2')).toBeTruthy();
    expect(fake.teams).toHaveBeenCalledTimes(1);
    expect(fake.board).toHaveBeenCalledTimes(2);
  });

  it('summary_shows_loading_until_sections_resolve', async () => {
    const t = deferred<Result<DashboardTeams>>();
    const b = deferred<Result<DashboardBoard>>();
    const fake = readyApi('Alpha');
    fake.teams.mockImplementation(() => t.promise);
    fake.board.mockImplementation(() => b.promise);
    const result = renderHome(fake.api);
    await act(async () => {});
    const names = ['Running teams', 'Active assignments', 'Open tickets', 'Completed tickets'];
    for (const name of names) expect(result.getByRole('group', { name }).textContent).toContain('Loading…');
    await act(async () => t.resolve({ ok: true, data: teamsFixture('Alpha') }));
    expect(within(result.getByRole('group', { name: 'Running teams' })).getByText('1')).toBeTruthy();
    expect(result.getByRole('group', { name: 'Open tickets' }).textContent).toContain('Loading…');
  });

  it('summary_marks_truncated_teams', async () => {
    const fake = readyApi('Alpha');
    fake.teams.mockImplementation(async () => ({ ok: true, data: { ...teamsFixture('Alpha'), truncated: true } }));
    const result = renderHome(fake.api);
    await act(async () => {});
    const running = result.getByRole('group', { name: 'Running teams' });
    expect(within(running).getByText('1+')).toBeTruthy();
    expect(running.textContent).toContain('Partial');
  });

  it('summary_refresh_reloads_each_section_once', async () => {
    const fake = readyApi('Alpha');
    const result = renderHome(fake.api);
    await act(async () => {});
    fireEvent.click(result.getByRole('button', { name: /Refresh/ }));
    await act(async () => {});
    for (const fn of [fake.teams, fake.board, fake.activity]) expect(fn).toHaveBeenCalledTimes(2);
    expect(within(result.getByRole('group', { name: 'Running teams' })).getByText('1')).toBeTruthy();
    expect(within(result.getByRole('group', { name: 'Open tickets' })).getByText('2')).toBeTruthy();
  });
});

describe('DashboardHome refresh coordination', () => {
  type Api = ReturnType<typeof readyApi>;
  const fail = (message = 'failed') => async () => ({ ok: false, error: { code: 'BROKEN', message, retryable: true } }) as never;

  function mountHome(fake: Api, ws: Workspace = workspaceA) {
    return render(<DashboardHome workspace={ws} dashboard={fake.api} connection={connected} onNavigate={vi.fn()} />);
  }
  const timeEl = (r: ReturnType<typeof render>) => r.container.querySelector('.dashboard-actions time');
  const noteEl = (r: ReturnType<typeof render>) => r.container.querySelector('.dashboard-refresh-note');
  const stamp = (n: number) => `Last updated ${new Date(n).toLocaleTimeString()}`;
  const refreshButton = (r: ReturnType<typeof render>) => r.getByRole('button', { name: 'Refresh' });

  function holdAll(fake: Api) {
    const t = deferred<Result<DashboardTeams>>();
    const b = deferred<Result<DashboardBoard>>();
    const a = deferred<Result<DashboardActivity>>();
    fake.teams.mockImplementationOnce(() => t.promise);
    fake.board.mockImplementationOnce(() => b.promise);
    fake.activity.mockImplementationOnce(() => a.promise);
    return { t, b, a };
  }

  it('refresh_calls_each_section_once_and_ignores_duplicate_clicks', async () => {
    const fake = readyApi('Alpha');
    const result = mountHome(fake);
    await act(async () => {});
    const d = holdAll(fake);
    const refresh = refreshButton(result);
    fireEvent.click(refresh);
    fireEvent.click(refresh);
    fireEvent.click(refresh);
    for (const fn of [fake.teams, fake.board, fake.activity]) expect(fn).toHaveBeenCalledTimes(2);
    expect(refresh.getAttribute('aria-busy')).toBe('true');
    await act(async () => {
      d.t.resolve({ ok: true, data: teamsFixture('Alpha') });
      d.b.resolve({ ok: true, data: boardFixture('Alpha') });
      d.a.resolve({ ok: true, data: activityFixture('Alpha') });
    });
    expect(refresh.getAttribute('aria-busy')).toBe('false');
    fireEvent.click(refresh);
    await act(async () => {});
    for (const fn of [fake.teams, fake.board, fake.activity]) expect(fn).toHaveBeenCalledTimes(3);
  });

  it('last_updated_waits_for_all_three_sections', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const fake = readyApi('Alpha');
    const result = mountHome(fake);
    await act(async () => {});
    expect(timeEl(result)!.textContent).toBe(stamp(1000));
    now.mockReturnValue(2000);
    const d = holdAll(fake);
    fireEvent.click(refreshButton(result));
    await act(async () => d.t.resolve({ ok: true, data: teamsFixture('Alpha') }));
    expect(timeEl(result)!.textContent).toBe(stamp(1000));
    await act(async () => d.a.resolve({ ok: true, data: activityFixture('Alpha') }));
    expect(timeEl(result)!.textContent).toBe(stamp(1000));
    await act(async () => d.b.resolve({ ok: true, data: boardFixture('Alpha') }));
    expect(timeEl(result)!.textContent).toBe(stamp(2000));
    expect(timeEl(result)!.getAttribute('datetime')).toBe(new Date(2000).toISOString());
  });

  async function partialFailure() {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const fake = readyApi('Alpha');
    const result = mountHome(fake);
    await act(async () => {});
    now.mockReturnValue(2000);
    fake.board.mockImplementationOnce(fail('panel failed'));
    fireEvent.click(refreshButton(result));
    await act(async () => {});
    return { now, fake, result };
  }

  it('partial_failure_keeps_prior_time_and_names_unavailable_section', async () => {
    const { result } = await partialFailure();
    expect(timeEl(result)!.textContent).toBe(stamp(1000));
    const note = noteEl(result)!;
    expect(note.textContent).toBe('Not updated: Board status');
    expect(note.getAttribute('role')).toBeNull();
    expect(within(result.getByRole('group', { name: 'Open tickets' })).getByText('Unavailable: board could not be loaded')).toBeTruthy();
    expect(result.getByText('Alpha running team')).toBeTruthy();
  });

  it('retry_completing_a_partial_refresh_shows_oldest_data_time', async () => {
    const { now, fake, result } = await partialFailure();
    now.mockReturnValue(3000);
    fireEvent.click(within(result.getByRole('region', { name: 'Board status' })).getByRole('button', { name: 'Retry' }));
    await act(async () => {});
    expect(timeEl(result)!.textContent).toBe(stamp(2000));
    expect(noteEl(result)).toBeNull();
    expect(fake.teams).toHaveBeenCalledTimes(2);
    expect(fake.activity).toHaveBeenCalledTimes(2);
    expect(fake.board).toHaveBeenCalledTimes(3);
  });

  it('initial_partial_failure_shows_no_last_updated', async () => {
    const fake = readyApi('Alpha');
    fake.board.mockImplementationOnce(fail());
    const result = mountHome(fake);
    await act(async () => {});
    expect(timeEl(result)).toBeNull();
    expect(noteEl(result)!.textContent).toBe('Not updated: Board status');
  });

  it('all_failures_name_every_section_without_extra_alerts', async () => {
    const fake = readyApi('Alpha');
    fake.teams.mockImplementation(fail('teams failed'));
    fake.board.mockImplementation(fail('board failed'));
    fake.activity.mockImplementation(fail('activity failed'));
    const result = mountHome(fake);
    await act(async () => {});
    expect(noteEl(result)!.textContent).toBe('Not updated: Team status, Board status, Recent activity');
    expect(result.getAllByRole('alert')).toHaveLength(3);
    expect(timeEl(result)).toBeNull();
  });

  it('board_not_configured_counts_as_complete', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const fake = readyApi('Alpha');
    fake.board.mockImplementation(async () => ({ ok: false, error: { code: 'BOARD_CONFIG_INVALID', message: 'no board', retryable: false } }));
    const result = mountHome(fake);
    await act(async () => {});
    expect(timeEl(result)!.textContent).toBe(stamp(1000));
    expect(noteEl(result)).toBeNull();
  });

  it('workspace_switch_drops_old_responses_and_resets_last_updated', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const aT = deferred<Result<DashboardTeams>>();
    const aB = deferred<Result<DashboardBoard>>();
    const aA = deferred<Result<DashboardActivity>>();
    const bT = deferred<Result<DashboardTeams>>();
    const bB = deferred<Result<DashboardBoard>>();
    const bA = deferred<Result<DashboardActivity>>();
    let bReady = false;
    const aCalls = { teams: 0, board: 0, activity: 0 };
    const teams = vi.fn((id: string) => {
      if (id === workspaceA.id) return ++aCalls.teams === 1 ? Promise.resolve({ ok: true, data: teamsFixture('Alpha') } as Result<DashboardTeams>) : aT.promise;
      return bReady ? Promise.resolve({ ok: true, data: teamsFixture('Beta') } as Result<DashboardTeams>) : bT.promise;
    });
    const board = vi.fn((id: string) => {
      if (id === workspaceA.id) return ++aCalls.board === 1 ? Promise.resolve({ ok: true, data: boardFixture('Alpha') } as Result<DashboardBoard>) : aB.promise;
      return bReady ? Promise.resolve({ ok: true, data: boardFixture('Beta') } as Result<DashboardBoard>) : bB.promise;
    });
    const activity = vi.fn((id: string) => {
      if (id === workspaceA.id) return ++aCalls.activity === 1 ? Promise.resolve({ ok: true, data: activityFixture('Alpha') } as Result<DashboardActivity>) : aA.promise;
      return bReady ? Promise.resolve({ ok: true, data: activityFixture('Beta') } as Result<DashboardActivity>) : bA.promise;
    });
    const api = { teams, board, activity } as DashboardApi;
    const ui = (ws: Workspace) => <DashboardHome workspace={ws} dashboard={api} connection={connected} onNavigate={vi.fn()} />;
    const result = render(ui(workspaceA));
    await act(async () => {});
    expect(timeEl(result)!.textContent).toBe(stamp(1000));
    fireEvent.click(refreshButton(result));
    result.rerender(ui(workspaceB));
    expect(timeEl(result)).toBeNull();
    for (const fn of [teams, board, activity]) {
      expect(fn.mock.calls.filter(([id]) => id === workspaceB.id)).toHaveLength(1);
    }
    now.mockReturnValue(5000);
    await act(async () => {
      aT.resolve({ ok: true, data: teamsFixture('Alpha') });
      aB.resolve({ ok: true, data: boardFixture('Alpha') });
      aA.resolve({ ok: true, data: activityFixture('Alpha') });
    });
    expect(timeEl(result)).toBeNull();
    for (const text of ['Alpha running team', 'Alpha phase', 'Alpha ticket T-1 moved']) {
      expect(result.container.textContent).not.toContain(text);
    }
    now.mockReturnValue(6000);
    await act(async () => {
      bT.resolve({ ok: true, data: teamsFixture('Beta') });
      bB.resolve({ ok: true, data: boardFixture('Beta') });
      bA.resolve({ ok: true, data: activityFixture('Beta') });
    });
    expect(timeEl(result)!.textContent).toBe(stamp(6000));
    expect(result.getByText('Beta running team')).toBeTruthy();
    bReady = true;
    fireEvent.click(refreshButton(result));
    await act(async () => {});
    for (const fn of [teams, board, activity]) {
      expect(fn.mock.calls.filter(([id]) => id === workspaceB.id)).toHaveLength(2);
    }
  });

  it('unmount_during_refresh_logs_nothing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fake = readyApi('Alpha');
    const result = mountHome(fake);
    await act(async () => {});
    const d = holdAll(fake);
    fireEvent.click(refreshButton(result));
    result.unmount();
    await act(async () => {
      d.t.resolve({ ok: true, data: teamsFixture('Alpha') });
      d.b.resolve({ ok: true, data: boardFixture('Alpha') });
      d.a.resolve({ ok: true, data: activityFixture('Alpha') });
    });
    expect(errors).not.toHaveBeenCalled();
  });
});
