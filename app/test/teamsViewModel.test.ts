import { describe, expect, it } from 'vitest';
import {
  INITIAL_TEAMS_VIEW,
  resolveTeamsView,
  selectTeamView,
  type TeamsViewState,
  type TeamViewItem,
} from '../src/renderer/teams/teamsViewModel';
import { member, team } from './teamsFixtures';

const items: TeamViewItem[] = [
  { key: 'a', team: team({ id: 'a', members: [member({ memberId: 'm1' })] }) },
  { key: 'b', team: team({ id: 'b' }) },
];
const state = (over: Partial<TeamsViewState> = {}): TeamsViewState => ({ teamKey: 'a', memberId: null, ...over });

describe('teamsViewModel', () => {
  it('resolve_keeps_state_without_data', () => {
    const s = state();
    expect(resolveTeamsView(s, null)).toBe(s);
  });

  it('resolve_empty_teams_clears_selection', () => {
    expect(resolveTeamsView(state(), [])).toBe(INITIAL_TEAMS_VIEW);
  });

  it('resolve_missing_or_null_key_falls_back_to_first_team', () => {
    const expected = { teamKey: 'a', memberId: null };
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

  it('select_team_resets_member_unless_same', () => {
    const s = state({ memberId: 'm1' });
    expect(selectTeamView(s, 'a')).toBe(s);
    expect(selectTeamView(s, 'b')).toEqual({ teamKey: 'b', memberId: null });
    expect(selectTeamView(s, null)).toEqual({ teamKey: null, memberId: null });
  });

  it('view_state_has_no_child_view_and_initial_state_is_empty', () => {
    expect(INITIAL_TEAMS_VIEW).toEqual({ teamKey: null, memberId: null });
    expect('view' in INITIAL_TEAMS_VIEW).toBe(false);
  });
});
