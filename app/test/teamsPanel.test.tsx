// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { within } from '@testing-library/react';
import type { DashboardTeamRuntime, DashboardTeams } from '../src/renderer/api';
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

  it('renders_running_team_counts_from_team_list', () => {
    const data = ready([{ id: 'build', name: 'Build team', members: 3, runtime: runtime('running', 3, { idle: 1, busy: 1, waiting_input: 1 }, 1) }]);
    const result = show(data);
    for (const text of ['running', '3 members', '1 active assignment', '1 of 3 available', 'busy: 1', 'idle: 1', 'waiting_input: 1']) {
      expect(result.getByText(text)).toBeTruthy();
    }
    expect(result.queryByText('starting: 0')).toBeNull();
    expect(result.queryByText('offline: 0')).toBeNull();
    expect(result.queryByText('Definition has problems')).toBeNull();
    const badges = Array.from(result.container.querySelectorAll('.team-availability')).map((n) => n.textContent);
    expect(badges).toEqual(['busy: 1', 'idle: 1', 'waiting_input: 1']);
  });

  it('orders_running_teams_first_and_keeps_every_team', () => {
    const data = ready([
      { id: 'a', name: 'a', members: 1, runtime: runtime('stopped', 1, {}, 0) },
      { id: 'b', name: 'b', members: 1, runtime: null },
      { id: 'c', name: null, members: 1, runtime: runtime('running', 1, { idle: 1 }, 0) },
      { id: 'd', name: 'd', members: 1, runtime: runtime('error', 1, { error: 1 }, 0) },
      { id: 'e', name: 'e', members: 1, runtime: runtime('running', 1, { busy: 1 }, 0) },
    ]);
    const result = show(data);
    expect(Array.from(result.container.querySelectorAll('h3')).map((n) => n.textContent)).toEqual(['c', 'e', 'a', 'b', 'd']);
    expect(result.getAllByRole('listitem')).toHaveLength(5);
    expect(result.getByText('5 teams · 2 running')).toBeTruthy();
  });

  it('labels_every_runtime_state', () => {
    const mk = (id: string, status: DashboardTeamRuntime['status']) =>
      ({ id, name: id, members: 2, runtime: runtime(status, 2, { idle: 1, error: 1 }, 0) });
    const data = ready([mk('t1', 'starting'), mk('t2', 'stopping'), mk('t3', 'error'), mk('t4', 'stopped'),
      { id: 't5', name: 't5', members: 2, runtime: null }]);
    const rows = show(data).getAllByRole('listitem').map((r) => within(r));
    ['starting', 'stopping', 'error', 'stopped', 'no runtime'].forEach((label, i) => {
      expect(rows[i].getByText(label, { selector: '.team-status' })).toBeTruthy();
    });
    for (const i of [0, 1, 2]) expect(rows[i].getByText('1 of 2 available')).toBeTruthy();
  });

  it('stopped_and_no_runtime_teams_are_not_reported_available', () => {
    const data = ready([
      { id: 's', name: 's', members: 2, runtime: runtime('stopped', 2, { idle: 2 }, 0) },
      { id: 'n', name: 'n', members: 4, runtime: null },
    ]);
    const result = show(data);
    const [stopped, none] = result.getAllByRole('listitem').map((r) => within(r));
    expect(stopped.getByText('Not available — team stopped')).toBeTruthy();
    expect(result.container.querySelectorAll('.team-availability')).toHaveLength(0);
    expect(result.queryByText('2 of 2 available')).toBeNull();
    expect(stopped.getByText('0 active assignments')).toBeTruthy();
    expect(none.getByText('Availability unknown — no runtime')).toBeTruthy();
    expect(none.getByText('4 members')).toBeTruthy();
    expect(none.queryByText(/active assignment/)).toBeNull();
  });

  it('running_team_with_no_agents_says_so', () => {
    const result = show(ready([{ id: 'r', name: 'r', members: 1, runtime: runtime('running', 0, {}, 0) }]));
    expect(result.getByText('No agents in runtime')).toBeTruthy();
    expect(result.queryByText('0 of 0 available')).toBeNull();
  });

  it('treats_missing_availability_keys_as_zero', () => {
    const rt = { ...runtime('running', 2, {}, 0), availability: { busy: 1 } as unknown as DashboardTeamRuntime['availability'] };
    const result = show(ready([{ id: 'm', name: 'm', members: 2, runtime: rt }]));
    expect(result.getByText('0 of 2 available')).toBeTruthy();
    expect(Array.from(result.container.querySelectorAll('.team-availability')).map((n) => n.textContent)).toEqual(['busy: 1']);
  });

  it('labels_definition_problems_without_leaking_details', () => {
    const result = show(ready([{ id: 'broken-team', name: null, members: 0, runtime: null, problems: [{ path: '/secret', message: 'bad' }] }]));
    expect(result.getByText('broken-team')).toBeTruthy();
    expect(result.getByText('Definition has problems')).toBeTruthy();
    expect(result.getByText('no runtime')).toBeTruthy();
    expect(result.container.textContent).not.toContain('/secret');
    expect(result.container.textContent).not.toContain('bad');
  });

  it('labels_truncated_list', () => {
    const two = ready([
      { id: 'a', name: 'a', members: 1, runtime: runtime('running', 1, { idle: 1 }, 0) },
      { id: 'b', name: 'b', members: 1, runtime: null },
    ], true);
    const first = show(two);
    expect(first.getByText('2 teams shown · 1 running')).toBeTruthy();
    expect(first.getByText('Showing the first 2 teams. More teams are defined in this workspace.')).toBeTruthy();
    cleanup();
    const second = show(ready([{ id: 'a', name: 'a', members: 1, runtime: null }]));
    expect(second.getByText('1 team · 0 running')).toBeTruthy();
    expect(second.queryByText(/Showing the first/)).toBeNull();
  });

  it('long_team_names_render_whole', () => {
    const name = `${'A'.repeat(120)} team`;
    const result = show(ready([{ id: 'l', name, members: 1, runtime: null }]));
    const heading = result.getByRole('heading', { level: 3 });
    expect(heading.textContent).toBe(name);
    expect(heading.className).toContain('team-name');
  });

  it('team_cards_use_headings_one_list_and_text_badges', () => {
    const result = show(ready([
      { id: 'a', name: 'a', members: 1, runtime: runtime('running', 1, { idle: 1 }, 0) },
      { id: 'b', name: 'b', members: 1, runtime: null },
      { id: 'c', name: 'c', members: 1, runtime: runtime('stopped', 1, {}, 0), problems: [{ path: 'p', message: 'm' }] },
    ]));
    expect(result.getAllByRole('heading', { level: 3 })).toHaveLength(3);
    expect(result.getAllByRole('list')).toHaveLength(1);
    for (const badge of Array.from(result.container.querySelectorAll('.status-badge'))) {
      expect((badge.textContent ?? '').trim()).not.toBe('');
    }
  });

  it('keyboard_reaches_only_native_controls', () => {
    const onNavigate = vi.fn();
    const result = render(<TeamsPanel section={section({ state: 'ready', data: ready([
      { id: 'a', name: 'a', members: 1, runtime: null },
      { id: 'b', name: 'b', members: 1, runtime: runtime('running', 1, { idle: 1 }, 0) },
    ]) })} onNavigate={onNavigate} />);
    const found = result.container.querySelectorAll('button, [tabindex], a[href], input');
    expect(found).toHaveLength(1);
    const button = result.getByRole('button', { name: 'View teams' });
    expect(found[0]).toBe(button);
    expect(button.getAttribute('type')).toBe('button');
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith('teams');
    cleanup();

    const reload = vi.fn();
    const errored = render(<TeamsPanel section={section({
      state: 'error', error: { code: 'E', message: 'm', retryable: true }, reload,
    })} onNavigate={vi.fn()} />);
    const focusable = errored.container.querySelectorAll('button, [tabindex], a[href], input');
    expect(focusable).toHaveLength(1);
    const retry = errored.getByRole('button', { name: 'Retry' });
    retry.focus();
    expect(document.activeElement).toBe(retry);
    fireEvent.click(retry);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

function runtime(status: DashboardTeamRuntime['status'], memberCount: number,
  availability: Partial<DashboardTeamRuntime['availability']>, activeAssignments: number): DashboardTeamRuntime {
  return {
    teamId: `rt-${status}`, status, memberCount, activeAssignments,
    availability: {
      starting: 0, idle: 0, busy: 0, waiting_input: 0, limit_reached: 0, offline: 0, error: 0, ...availability,
    },
  };
}

function ready(teams: DashboardTeams['teams'], truncated = false): DashboardTeams {
  return { workspace: '/a', truncated, teams };
}

function show(data: DashboardTeams) {
  return render(<TeamsPanel section={section({ state: 'ready', data })} onNavigate={vi.fn()} />);
}
