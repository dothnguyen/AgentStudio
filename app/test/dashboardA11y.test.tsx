// @vitest-environment jsdom
import { act, cleanup, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionStatus, DashboardApi, Result } from '../src/renderer/api';
import { WorkspaceShell } from '../src/renderer/shell/WorkspaceShell';
import { readyApi, workspaceA } from './dashboardFixtures';

afterEach(cleanup);

const connected: ConnectionStatus = { state: 'connected', error: null, distro: 'Ubuntu', command: 'serve' };

function shell(api: DashboardApi) {
  return render(
    <WorkspaceShell workspace={workspaceA} dashboard={api} connection={connected} onSwitchWorkspace={vi.fn()} />,
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
    expect(h2).toEqual(['Team status', 'Board status', 'Recent activity']);
    for (const name of ['Team status', 'Board status', 'Recent activity']) {
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
    expect(statuses).toHaveLength(3);
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
    for (const expected of ['Connected', 'running', 'stopped', 'busy', 'open', 'in-review', 'blocked', 'team', 'assignment', 'workflow', 'ticket']) {
      expect(texts.some((text) => text.toLowerCase().includes(expected.toLowerCase()))).toBe(true);
    }
    for (const icon of Array.from(result.container.querySelectorAll('.status-dot, .status-icon, .spinner'))) {
      expect(icon.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('renders dashboard collections with list semantics and machine-readable time', async () => {
    const result = shell(readyApi('x').api);
    await act(async () => {});

    const teams = within(result.getByRole('region', { name: 'Team status' }));
    expect(teams.getAllByRole('list')).toHaveLength(1);
    expect(teams.getAllByRole('listitem').length).toBeGreaterThanOrEqual(2);
    const board = within(result.getByRole('region', { name: 'Board status' }));
    expect(board.getAllByRole('list').length).toBeGreaterThanOrEqual(2);
    const activityRegion = result.getByRole('region', { name: 'Recent activity' });
    const ordered = activityRegion.querySelector('ol');
    expect(ordered).toBeTruthy();
    expect(within(activityRegion).getAllByRole('listitem')).toHaveLength(4);
    const times = Array.from(activityRegion.querySelectorAll('time[datetime]'));
    expect(times.map((node) => node.getAttribute('datetime'))).toEqual([
      '2026-01-01T01:02:03.000Z', '2026-01-02T01:02:03.000Z', '2026-01-03T01:02:03.000Z', '2026-01-04T01:02:03.000Z',
    ]);
    expect(result.container.textContent).not.toMatch(/[{}]|"workspace"/);
  });
});

