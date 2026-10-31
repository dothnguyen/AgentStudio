import type { OverviewTeam, TeamOverview } from '../api';
import { RUNTIME_LABELS, definitionBadge, orderTeams, plural, teamKey } from './teamsModel';

export interface TeamNavigationItem {
  key: string;
  team: OverviewTeam;
}

export function navigationItems(data: TeamOverview | null): TeamNavigationItem[] {
  if (data === null) return [];
  return orderTeams(data.teams.map((team, index) => ({ key: teamKey(team, index), team })));
}

export function reconcileSelectedTeam(selectedKey: string | null, items: readonly TeamNavigationItem[]): string | null {
  if (selectedKey !== null && items.some((item) => item.key === selectedKey)) return selectedKey;
  return items[0]?.key ?? null;
}

export function compactTeamState(team: OverviewTeam): { runtime: string; definition: string | null } {
  return { runtime: RUNTIME_LABELS[team.runtime.state], definition: definitionBadge(team) };
}

export function teamNavigationNotices(data: TeamOverview): string[] {
  const notices: string[] = [];
  if (data.truncated) notices.push(`Showing the first ${plural(data.teams.length, 'team', 'teams')}. More teams exist in this workspace.`);
  if (data.partial) notices.push('Some team navigation data is unavailable.');
  return notices;
}

/** Visible count text and its accessible label for a team row. */
export function teamMemberCount(team: OverviewTeam): { text: string; label: string } {
  const n = team.members.length;
  if (team.membersTruncated === true) return { text: `${n}+`, label: `${n}+ members` };
  return { text: String(n), label: plural(n, 'member', 'members') };
}
