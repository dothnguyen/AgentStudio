// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DashboardTeams } from '../src/renderer/api';
import { TeamsPanel } from '../src/renderer/dashboard/TeamsPanel';
import type { DashboardSection } from '../src/renderer/dashboard/useDashboardSection';

afterEach(cleanup);

function section(overrides: Partial<DashboardSection<DashboardTeams>>): DashboardSection<DashboardTeams> {
  const merged = {
    state: 'loading' as const, data: null, error: null, lastUpdatedAt: null,
    reload: vi.fn(() => Promise.resolve()), ...overrides,
  };
  return { loading: merged.state === 'loading', ...merged };
}

describe('TeamsPanel', () => {
  it('renders_loading_state', () => {
    const result = render(<TeamsPanel section={section({})} onNavigate={vi.fn()} />);
    expect(result.getByRole('status').textContent).toBe('Loading team status…');
    expect(result.queryByRole('button')).toBeNull();
  });

  it('renders_empty_state_and_view_teams', () => {
    const onNavigate = vi.fn();
    const data = { workspace: '/a', teams: [], truncated: false };
    const result = render(<TeamsPanel section={section({ state: 'ready', data })} onNavigate={onNavigate} />);
    expect(result.getByText('No teams defined')).toBeTruthy();
    fireEvent.click(result.getByRole('button', { name: 'View teams' }));
    expect(onNavigate).toHaveBeenCalledWith('teams');
  });

  it('renders_error_remediation_and_retries_only_this_section', () => {
    const reload = vi.fn();
    const result = render(<TeamsPanel section={section({
      state: 'error',
      error: { code: 'TEAM_LIST', message: 'Could not list teams', retryable: true, remediation: 'Check the workspace.' },
      reload,
    })} onNavigate={vi.fn()} />);
    const alert = result.getByRole('alert');
    expect(alert.textContent).toContain('TEAM_LIST: Could not list teams');
    expect(alert.textContent).toContain('Check the workspace.');
    fireEvent.click(result.getByRole('button', { name: 'Retry' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('renders_ready_team_counts_and_exact_backend_labels', () => {
    const data: DashboardTeams = {
      workspace: '/a',
      truncated: false,
      teams: [{
        id: 'build', name: 'Build team', members: 3, runtime: {
          teamId: 'build', status: 'running', memberCount: 3, activeAssignments: 1,
          availability: { starting: 0, idle: 1, busy: 1, waiting_input: 1, limit_reached: 0, offline: 0, error: 0 },
        },
      }],
    };
    const result = render(<TeamsPanel section={section({ state: 'ready', data })} onNavigate={vi.fn()} />);
    expect(result.getByText('running')).toBeTruthy();
    expect(result.getByText('3 members')).toBeTruthy();
    expect(result.getByText('starting: 0')).toBeTruthy();
    expect(result.getByText('idle: 1')).toBeTruthy();
    expect(result.getByText('busy: 1')).toBeTruthy();
    expect(result.getByText('waiting_input: 1')).toBeTruthy();
    expect(result.getByText('limit_reached: 0')).toBeTruthy();
    expect(result.getByText('offline: 0')).toBeTruthy();
    expect(result.getByText('error: 0')).toBeTruthy();
    expect(result.getByText('1 active assignment')).toBeTruthy();
    expect(result.queryByText('Definition has problems')).toBeNull();
  });

  it('renders_stopped_fallback_malformed_definition_and_truncation', () => {
    const data: DashboardTeams = {
      workspace: '/a', truncated: true,
      teams: [{ id: 'broken-team', name: null, members: 1, runtime: null, problems: [{ path: '/secret', message: 'bad' }] }],
    };
    const result = render(<TeamsPanel section={section({ state: 'ready', data })} onNavigate={vi.fn()} />);
    expect(result.getByText('broken-team')).toBeTruthy();
    expect(result.getByText('stopped')).toBeTruthy();
    expect(result.getByText('1 member')).toBeTruthy();
    expect(result.getByText('0 active assignments')).toBeTruthy();
    expect(result.getByText('Definition has problems')).toBeTruthy();
    expect(result.getByText('Showing the first 50 teams.')).toBeTruthy();
    expect(result.container.textContent).not.toContain('/secret');
    expect(result.container.textContent).not.toContain('bad');
  });
});
