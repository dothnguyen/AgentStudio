// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionStatus, DashboardActivity, DashboardApi, DashboardBoard, DashboardTeams, Result, Workspace } from '../src/renderer/api';
import { DashboardHome } from '../src/renderer/dashboard/DashboardHome';
import { WorkspaceShell } from '../src/renderer/shell/WorkspaceShell';
import { CONNECTED_TEXT, CONNECTING_TEXT, LOST_TITLE } from '../src/renderer/StartupScreen';

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
    id: 'event:1', at: '2026-01-02T03:04:05.000Z', kind: 'team', name: 'created',
    summary: 'Build team was created', subject: { type: 'team', id: 'build', label: 'Build team' },
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
  it('opens_home_with_one_teams_request', async () => {
    const fake = fakeDashboard();
    const result = render(<WorkspaceShell workspace={workspace} dashboard={fake.api} connection={connected} onSwitchWorkspace={vi.fn()} />);
    await act(async () => {});

    const heading = result.getByRole('heading', { level: 1, name: workspace.name });
    expect(heading).toBeTruthy();
    const path = result.getAllByText(workspace.path).find((node) => node.tagName === 'CODE');
    expect(path?.getAttribute('title')).toBe(workspace.path);
    expect(result.getByText(CONNECTED_TEXT)).toBeTruthy();
    expect(result.getByRole('region', { name: 'Team status' })).toBeTruthy();
    expect(result.getByRole('region', { name: 'Board' })).toBeTruthy();
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

    expect(result.getByRole('heading', { level: 1, name: workspace.name })).toBeTruthy();
    expect(result.getByRole('region', { name: 'Board' })).toBeTruthy();
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
    expect(result.getByText('Build team was created')).toBeTruthy();
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
    expect(result.getByRole('region', { name: 'Board' })).toBeTruthy();
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
    const board = result.getByRole('region', { name: 'Board' });
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
    expect(within(result.getByRole('region', { name: 'Board' })).getByRole('status').textContent).toBe('Loading board…');
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

    fireEvent.click(within(result.getByRole('region', { name: 'Board' })).getByRole('button', { name: 'Retry' }));
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
