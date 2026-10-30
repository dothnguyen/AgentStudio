import type { OverviewTeam } from '../api';

export type TeamsChildView = 'overview' | 'routing';

export const TEAMS_CHILD_VIEWS: readonly { id: TeamsChildView; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'routing', label: 'Routing' },
];

export interface TeamsViewState {
  teamKey: string | null;
  view: TeamsChildView;
  memberId: string | null;
}

export const INITIAL_TEAMS_VIEW: TeamsViewState = { teamKey: null, view: 'overview', memberId: null };

export interface TeamViewItem {
  key: string;
  team: OverviewTeam;
}

export function teamsTabId(view: TeamsChildView): string {
  return `teams-tab-${view}`;
}

export function teamsPanelId(view: TeamsChildView): string {
  return `teams-panel-${view}`;
}

export function resolveTeamsView(state: TeamsViewState, teams: readonly TeamViewItem[] | null): TeamsViewState {
  if (teams === null) return state;
  const first = teams[0];
  if (first === undefined) return INITIAL_TEAMS_VIEW;
  const match = teams.find((item) => item.key === state.teamKey);
  if (match === undefined) return { teamKey: first.key, view: 'overview', memberId: null };
  if (state.memberId !== null && !match.team.members.some((m) => m.memberId === state.memberId)) {
    return { ...state, memberId: null };
  }
  return state;
}

export function selectTeamView(state: TeamsViewState, teamKey: string | null): TeamsViewState {
  if (teamKey === state.teamKey) return state;
  return { teamKey, view: 'overview', memberId: null };
}

export function selectChildView(state: TeamsViewState, view: TeamsChildView): TeamsViewState {
  if (view === state.view) return state;
  return { ...state, view };
}

export function rovingIndex(key: string, index: number, count: number, orientation: 'horizontal' | 'vertical'): number | null {
  if (count <= 0) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  const next = orientation === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
  const prev = orientation === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
  if (key === next) return (index + 1) % count;
  if (key === prev) return (index - 1 + count) % count;
  return null;
}
