// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionStatus, DashboardApi, DashboardTeams, Result, Workspace } from '../src/renderer/api';
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

function fakeDashboard(...responses: Array<Promise<Result<DashboardTeams>> | Result<DashboardTeams>>) {
  let index = 0;
  const teams = vi.fn(() => Promise.resolve(responses[index++]));
  const board = vi.fn();
  const activity = vi.fn();
  return { api: { teams, board, activity } as DashboardApi, teams, board, activity };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('DashboardHome', () => {
  it('opens_home_with_one_teams_request', async () => {
    const fake = fakeDashboard({ ok: true, data: emptyTeams });
    const result = render(<WorkspaceShell workspace={workspace} dashboard={fake.api} connection={connected} onSwitchWorkspace={vi.fn()} />);
    await act(async () => {});

    const heading = result.getByRole('heading', { level: 1, name: workspace.name });
    expect(heading).toBeTruthy();
    const path = result.getAllByText(workspace.path).find((node) => node.tagName === 'CODE');
    expect(path?.getAttribute('title')).toBe(workspace.path);
    expect(result.getByText(CONNECTED_TEXT)).toBeTruthy();
    expect(result.getByRole('region', { name: 'Team status' })).toBeTruthy();
    expect(result.getByRole('region', { name: 'Board status' }).textContent).toContain('Not available yet.');
    expect(result.getByRole('region', { name: 'Recent activity' }).textContent).toContain('Not available yet.');
    expect(fake.teams).toHaveBeenCalledTimes(1);
    expect(fake.teams).toHaveBeenCalledWith(workspace.id);
    expect(fake.board).not.toHaveBeenCalled();
    expect(fake.activity).not.toHaveBeenCalled();
  });

  it('refreshes_teams_once_and_updates_last_updated_on_success', async () => {
    const first = deferred<Result<DashboardTeams>>();
    const second = deferred<Result<DashboardTeams>>();
    const fake = fakeDashboard(first.promise, second.promise);
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const result = render(<DashboardHome workspace={workspace} dashboard={fake.api} connection={connected} onNavigate={vi.fn()} />);
    expect(result.queryByText(/Last updated/)).toBeNull();
    const refresh = result.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement;
    expect(refresh.disabled).toBe(true);

    await act(async () => first.resolve({ ok: true, data: emptyTeams }));
    expect(result.getByText(`Last updated ${new Date(1_000).toLocaleTimeString()}`).getAttribute('datetime')).toBe(new Date(1_000).toISOString());
    fireEvent.click(refresh);
    expect(fake.teams).toHaveBeenCalledTimes(2);
    expect(refresh.disabled).toBe(true);
    expect(refresh.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(refresh);
    expect(fake.teams).toHaveBeenCalledTimes(2);
    dateNow.mockReturnValue(2_000);
    await act(async () => second.resolve({ ok: true, data: emptyTeams }));
    expect(result.getByText(`Last updated ${new Date(2_000).toLocaleTimeString()}`)).toBeTruthy();
  });

  it('team_error_does_not_hide_the_dashboard_frame_and_retry_calls_only_teams', async () => {
    const first: Result<DashboardTeams> = { ok: false, error: { code: 'TEAMS', message: 'failed', retryable: true } };
    const fake = fakeDashboard(first, { ok: true, data: emptyTeams });
    const result = render(<DashboardHome workspace={workspace} dashboard={fake.api} connection={connected} onNavigate={vi.fn()} />);
    await act(async () => {});

    expect(result.getByRole('heading', { level: 1, name: workspace.name })).toBeTruthy();
    expect(result.getByRole('region', { name: 'Board status' })).toBeTruthy();
    expect(result.getByRole('region', { name: 'Recent activity' })).toBeTruthy();
    fireEvent.click(result.getByRole('button', { name: 'Retry' }));
    expect(fake.teams).toHaveBeenCalledTimes(2);
    expect(fake.board).not.toHaveBeenCalled();
    expect(fake.activity).not.toHaveBeenCalled();
  });

  it('view_teams_selects_the_existing_shell_section', async () => {
    const fake = fakeDashboard({ ok: true, data: emptyTeams });
    const result = render(<WorkspaceShell workspace={workspace} dashboard={fake.api} connection={connected} onSwitchWorkspace={vi.fn()} />);
    await act(async () => {});
    fireEvent.click(result.getByRole('button', { name: 'View teams' }));

    expect(result.getByRole('heading', { level: 1, name: 'Teams' })).toBeTruthy();
    const nav = result.getByRole('navigation', { name: 'Workspace' });
    expect(within(nav).getByRole('button', { name: 'Teams' }).getAttribute('aria-current')).toBe('page');
    expect(within(nav).getByRole('button', { name: 'Home' }).getAttribute('aria-current')).toBeNull();
  });

  it('uses_exact_startup_connection_wording', () => {
    const never = new Promise<Result<DashboardTeams>>(() => {});
    const fake = fakeDashboard(never);
    const result = render(<DashboardHome workspace={workspace} dashboard={fake.api} connection={{ ...connected, state: 'connecting' }} onNavigate={vi.fn()} />);
    expect(result.getByText(CONNECTING_TEXT)).toBeTruthy();
    result.rerender(<DashboardHome workspace={workspace} dashboard={fake.api} connection={connected} onNavigate={vi.fn()} />);
    expect(result.getByText(CONNECTED_TEXT)).toBeTruthy();
    result.rerender(<DashboardHome workspace={workspace} dashboard={fake.api} connection={{ ...connected, state: 'lost' }} onNavigate={vi.fn()} />);
    expect(result.getByText(LOST_TITLE)).toBeTruthy();
  });

  it('dashboard_fake_has_read_methods_only', async () => {
    const fake: DashboardApi = {
      teams: vi.fn(async () => ({ ok: true, data: emptyTeams })),
      board: vi.fn(),
      activity: vi.fn(),
    };
    render(<DashboardHome workspace={workspace} dashboard={fake} connection={connected} onNavigate={vi.fn()} />);
    await act(async () => {});
    expect(Object.keys(fake).sort()).toEqual(['activity', 'board', 'teams']);
    expect(fake.teams).toHaveBeenCalledTimes(1);
    expect(fake.board).not.toHaveBeenCalled();
    expect(fake.activity).not.toHaveBeenCalled();
  });
});
