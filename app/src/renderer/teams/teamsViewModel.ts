import type { OverviewTeam } from '../api';

export interface TeamsViewState {
  teamKey: string | null;
  memberId: string | null;
}

export const INITIAL_TEAMS_VIEW: TeamsViewState = { teamKey: null, memberId: null };

export interface TeamViewItem {
  key: string;
  team: OverviewTeam;
}

export function resolveTeamsView(state: TeamsViewState, teams: readonly TeamViewItem[] | null): TeamsViewState {
  if (teams === null) return state;
  const first = teams[0];
  if (first === undefined) return INITIAL_TEAMS_VIEW;
  const match = teams.find((item) => item.key === state.teamKey);
  if (match === undefined) return { teamKey: first.key, memberId: null };
  if (state.memberId !== null && !match.team.members.some((m) => m.memberId === state.memberId)) {
    return { ...state, memberId: null };
  }
  return state;
}

export function selectTeamView(state: TeamsViewState, teamKey: string | null): TeamsViewState {
  if (teamKey === state.teamKey) return state;
  return { teamKey, memberId: null };
}
