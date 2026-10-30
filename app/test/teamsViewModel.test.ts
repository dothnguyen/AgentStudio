import { describe, expect, it } from 'vitest';
import {
  INITIAL_TEAMS_VIEW,
  resolveTeamsView,
  rovingIndex,
  selectChildView,
  selectTeamView,
  teamsPanelId,
  teamsTabId,
  type TeamsViewState,
  type TeamViewItem,
} from '../src/renderer/teams/teamsViewModel';
import { member, team } from './teamsFixtures';

const items: TeamViewItem[] = [
  { key: 'a', team: team({ id: 'a', members: [member({ memberId: 'm1' })] }) },
  { key: 'b', team: team({ id: 'b' }) },
];
const state = (over: Partial<TeamsViewState> = {}): TeamsViewState => ({ teamKey: 'a', view: 'overview', memberId: null, ...over });

describe('teamsViewModel', () => {
  it('resolve_keeps_state_without_data', () => {
    const s = state();
    expect(resolveTeamsView(s, null)).toBe(s);
  });

  it('resolve_empty_teams_clears_selection', () => {
    expect(resolveTeamsView(state(), [])).toBe(INITIAL_TEAMS_VIEW);
  });

  it('resolve_missing_or_null_key_falls_back_to_first_overview', () => {
    const expected = { teamKey: 'a', view: 'overview', memberId: null };
    expect(resolveTeamsView(state({ teamKey: 'gone', memberId: 'x' }), items)).toEqual(expected);
    expect(resolveTeamsView(state({ teamKey: null }), items)).toEqual(expected);
  });

  it('resolve_keeps_valid_selection_identity', () => {
    const s = state({ memberId: 'm1' });
    expect(resolveTeamsView(s, items)).toBe(s);
  });

  it('resolve_clears_missing_member_only', () => {
    const s = state({ memberId: 'nope' });
    expect(resolveTeamsView(s, items)).toEqual({ ...s, memberId: null });
  });

  it('select_team_resets_view_and_member_unless_same', () => {
    const s = state({ memberId: 'm1' });
    expect(selectTeamView(s, 'a')).toBe(s);
    expect(selectTeamView(s, 'b')).toEqual({ teamKey: 'b', view: 'overview', memberId: null });
    expect(selectTeamView(s, null)).toEqual({ teamKey: null, view: 'overview', memberId: null });
  });

  it('select_child_view_keeps_team_and_member', () => {
    const s = state({ memberId: 'm1' });
    expect(selectChildView(s, 'overview')).toBe(s);
    expect(selectChildView(s, 'routing')).toEqual({ teamKey: 'a', view: 'routing', memberId: 'm1' });
  });

  it('roving_index_matrix', () => {
    expect(rovingIndex('ArrowRight', 0, 3, 'horizontal')).toBe(1);
    expect(rovingIndex('ArrowRight', 2, 3, 'horizontal')).toBe(0);
    expect(rovingIndex('ArrowLeft', 0, 3, 'horizontal')).toBe(2);
    expect(rovingIndex('Home', 1, 3, 'horizontal')).toBe(0);
    expect(rovingIndex('End', 0, 3, 'horizontal')).toBe(2);
    expect(rovingIndex('ArrowDown', 0, 3, 'horizontal')).toBeNull();
    expect(rovingIndex('ArrowDown', 1, 2, 'vertical')).toBe(0);
    expect(rovingIndex('ArrowUp', 0, 2, 'vertical')).toBe(1);
    expect(rovingIndex('ArrowRight', 0, 2, 'vertical')).toBeNull();
    expect(rovingIndex('Home', 0, 0, 'vertical')).toBeNull();
    expect(rovingIndex('a', 0, 3, 'horizontal')).toBeNull();
  });

  it('ids_are_stable', () => {
    expect(teamsTabId('overview')).toBe('teams-tab-overview');
    expect(teamsPanelId('routing')).toBe('teams-panel-routing');
  });
});
