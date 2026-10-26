// @vitest-environment jsdom
import { cleanup, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiError, DashboardBoard, DashboardTeams } from '../src/renderer/api';
import { SummaryMetrics, boardMetrics, teamMetrics } from '../src/renderer/dashboard/SummaryMetrics';
import type { DashboardSectionController } from '../src/renderer/dashboard/useDashboardSection';
import { boardFixture, teamsFixture } from './dashboardFixtures';

afterEach(cleanup);

function section<T>(state: 'loading' | 'ready' | 'error', data: T | null, error: ApiError | null = null): DashboardSectionController<T> {
  return { state, data, error, loading: state === 'loading', lastUpdatedAt: null, reload: vi.fn(async () => {}) };
}

function runtime(status: 'starting' | 'running' | 'stopping' | 'stopped' | 'error', activeAssignments: number, id: string) {
  return {
    id, name: id, members: 1,
    runtime: { teamId: id, status, memberCount: 1, availability: {} as never, activeAssignments },
  };
}

function teams(list: DashboardTeams['teams'], truncated = false): DashboardTeams {
  return { workspace: 'x', teams: list, truncated };
}

function board(columns: DashboardBoard['columns'], extra: Partial<DashboardBoard> = {}): DashboardBoard {
  return { ...boardFixture('x'), columns, ...extra };
}

function renderCards(t: DashboardSectionController<DashboardTeams>, b: DashboardSectionController<DashboardBoard>) {
  const result = render(<SummaryMetrics teams={t} board={b} />);
  const group = (name: string) => result.getByRole('group', { name });
  return { result, group };
}

const apiError = (code: string): ApiError => ({ code, message: 'failed', retryable: true });

describe('SummaryMetrics', () => {
  it('derives_running_teams_and_assignments_from_runtimes', () => {
    const data = teams([
      runtime('running', 2, 'a'), runtime('stopped', 1, 'b'),
      { id: 'c', name: 'c', members: 1, runtime: null }, runtime('starting', 0, 'd'),
    ]);
    expect(teamMetrics(data)).toEqual({ runningTeams: 1, activeAssignments: 3 });
    const { group } = renderCards(section('ready', data), section('ready', boardFixture('x')));
    const running = group('Running teams');
    for (const text of ['1', 'All teams', 'Loaded']) expect(within(running).getByText(text)).toBeTruthy();
    expect(within(group('Active assignments')).getByText('3')).toBeTruthy();
  });

  it('derives_open_and_completed_from_all_current_phase_columns', () => {
    const data = board([
      { status: 'todo', kind: 'initial', title: 'Todo', count: 2 },
      { status: 'qa', kind: null, title: 'QA', count: 3 },
      { status: 'blocked', kind: null, title: 'Blocked', count: 1 },
      { status: 'done', kind: 'done', title: 'Done', count: 4 },
      { status: 'closed', kind: 'closed', title: 'Closed', count: 5 },
    ], { tickets: [], totals: { active: 99, blocked: 99, done: 99 }, currentPhase: { slug: 'b', name: 'Build phase', status: 'open' } });
    expect(boardMetrics(data)).toEqual({ open: 6, completed: 9 });
    const { group } = renderCards(section('ready', teamsFixture('x')), section('ready', data));
    expect(within(group('Open tickets')).getByText('6')).toBeTruthy();
    expect(within(group('Open tickets')).getByText('Current phase: Build phase')).toBeTruthy();
    expect(within(group('Completed tickets')).getByText('9')).toBeTruthy();
  });

  it('shows_loading_without_numbers', () => {
    const { group } = renderCards(section<DashboardTeams>('loading', null), section<DashboardBoard>('loading', null));
    for (const name of ['Running teams', 'Active assignments', 'Open tickets', 'Completed tickets']) {
      const g = group(name);
      expect(g.textContent).toContain('Loading…');
      const value = g.querySelector('.summary-value')!;
      expect(value.textContent).toBe('—');
      expect(value.getAttribute('aria-hidden')).toBe('true');
      expect(g.textContent).not.toMatch(/\d/);
    }
  });

  it('shows_real_zero_states', () => {
    const zero = board([{ status: 'todo', kind: 'initial', title: 'Todo', count: 0 }]);
    const { group } = renderCards(section('ready', teams([])), section('ready', zero));
    expect(group('Running teams').textContent).toContain('0');
    expect(group('Running teams').textContent).toContain('No teams defined');
    expect(group('Open tickets').textContent).toContain('0');
    expect(group('Open tickets').textContent).toContain('No tickets in the current phase');
  });

  it('team_error_marks_team_cards_unavailable_and_keeps_board_cards', () => {
    const { group } = renderCards(section<DashboardTeams>('error', null, apiError('TEAMS')), section('ready', boardFixture('x')));
    for (const name of ['Running teams', 'Active assignments']) {
      expect(group(name).textContent).toContain('Unavailable: team status could not be loaded');
      expect(group(name).textContent).not.toMatch(/\d/);
    }
    expect(group('Open tickets').textContent).toContain('2');
    expect(group('Open tickets').textContent).toContain('Loaded');
  });

  it('board_error_marks_board_cards_unavailable_and_keeps_team_cards', () => {
    const t = section('ready', teamsFixture('x'));
    const { result, group } = renderCards(t, section<DashboardBoard>('error', null, apiError('BOARD_FAILED')));
    expect(group('Open tickets').textContent).toContain('Unavailable: board could not be loaded');
    expect(group('Completed tickets').textContent).not.toMatch(/\d/);
    result.rerender(<SummaryMetrics teams={t} board={section<DashboardBoard>('error', null, apiError('BOARD_CONFIG_INVALID'))} />);
    expect(group('Open tickets').textContent).toContain('Unavailable: no board configured');
    expect(within(group('Running teams')).getByText('1')).toBeTruthy();
  });

  it('marks_truncated_team_totals_as_partial', () => {
    const data = teams([runtime('running', 1, 'a'), runtime('running', 1, 'b')], true);
    const { group } = renderCards(section('ready', data), section('ready', boardFixture('x')));
    const running = group('Running teams');
    for (const text of ['2+', 'First 50 teams', 'Partial: more than 50 teams; showing a lower bound']) {
      expect(within(running).getByText(text)).toBeTruthy();
    }
    expect(running.closest('li')!.className).toContain('summary-card-partial');
    expect(within(group('Active assignments')).getByText('2+')).toBeTruthy();
  });

  it('refreshing_with_retained_data_keeps_values', () => {
    const { group } = renderCards(section('loading', teamsFixture('x')), section('ready', boardFixture('x')));
    expect(within(group('Running teams')).getByText('1')).toBeTruthy();
    expect(within(group('Running teams')).getByText('Refreshing…')).toBeTruthy();
  });

  it('cards_have_labels_and_no_tab_stops_or_live_regions', () => {
    const { result } = renderCards(section('ready', teamsFixture('x')), section('ready', boardFixture('x')));
    expect(result.getAllByRole('group').map((g) => g.getAttribute('aria-labelledby') && g.querySelector('.summary-label')!.textContent))
      .toEqual(['Running teams', 'Active assignments', 'Open tickets', 'Completed tickets']);
    const region = result.getByRole('region', { name: 'Workspace summary' });
    expect(region.querySelector('button, a, input, select, textarea, [tabindex], [role="status"], [role="alert"], [aria-live], h1, h2, h3, h4, h5, h6')).toBeNull();
  });
});
