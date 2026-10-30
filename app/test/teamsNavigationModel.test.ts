import { describe, expect, it } from 'vitest';
import {
  compactTeamState,
  navigationItems,
  reconcileSelectedTeam,
  teamNavigationNotices,
} from '../src/renderer/teams/teamsNavigationModel';
import { overviewFixture, team } from './teamsFixtures';

const stopped = team({ id: 'stopped', name: 'Stopped', runtime: { state: 'stopped', teamId: 'old', status: 'stopped' } });
const runtimeOnly = team({
  id: null as unknown as string,
  name: 'Live only',
  definition: { state: 'missing', problems: [] },
  runtime: { state: 'running', teamId: 'live-1', status: 'running' },
});

describe('teams navigation model', () => {
  it('navigation_items_use_definition_and_runtime_keys_before_ordering', () => {
    const items = navigationItems(overviewFixture([stopped, runtimeOnly]));
    expect(items.map((item) => item.key)).toEqual(['runtime:live-1', 'stopped']);
    expect(navigationItems(null)).toEqual([]);
  });

  it('reconcile_selection_survives_reorder_and_falls_back_after_removal', () => {
    const before = navigationItems(overviewFixture([stopped, runtimeOnly]));
    const reordered = navigationItems(overviewFixture([runtimeOnly, stopped]));
    expect(reconcileSelectedTeam('stopped', before)).toBe('stopped');
    expect(reconcileSelectedTeam('stopped', reordered)).toBe('stopped');
    expect(reconcileSelectedTeam('stopped', navigationItems(overviewFixture([runtimeOnly])))).toBe('runtime:live-1');
    expect(reconcileSelectedTeam(null, before)).toBe('runtime:live-1');
    expect(reconcileSelectedTeam('stopped', [])).toBeNull();
  });

  it('compact_state_reports_runtime_and_definition_failures', () => {
    const broken = team({
      runtime: { state: 'unavailable', teamId: null, status: null },
      definition: { state: 'unreadable', problems: [] },
    });
    expect(compactTeamState(broken)).toEqual({ runtime: 'Runtime unavailable', definition: 'Definition unreadable' });
    expect(compactTeamState(stopped)).toEqual({ runtime: 'Stopped', definition: null });
  });

  it('navigation_notices_report_partial_and_truncated_results', () => {
    expect(teamNavigationNotices(overviewFixture([stopped]))).toEqual([]);
    expect(teamNavigationNotices(overviewFixture([stopped], { truncated: true })))
      .toEqual(['Showing the first 1 team. More teams exist in this workspace.']);
    expect(teamNavigationNotices(overviewFixture([stopped, runtimeOnly], { partial: true })))
      .toEqual(['Some team navigation data is unavailable.']);
    expect(teamNavigationNotices(overviewFixture([stopped, runtimeOnly], { partial: true, truncated: true })))
      .toEqual(['Showing the first 2 teams. More teams exist in this workspace.', 'Some team navigation data is unavailable.']);
  });
});
