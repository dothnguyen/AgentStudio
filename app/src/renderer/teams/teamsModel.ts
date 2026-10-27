import type { MemberWork, OverviewMember, OverviewRuntimeState, OverviewTeam, TeamOverview } from '../api';

export const MAX_CATALOG_PROBLEMS = 5;

export function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function teamKey(team: OverviewTeam, index: number): string {
  return team.id ?? (team.runtime.teamId !== null ? `runtime:${team.runtime.teamId}` : `index:${index}`);
}

export function teamLabel(team: OverviewTeam): string {
  return text(team.name) ?? team.id ?? team.runtime.teamId ?? 'Unnamed team';
}

export function orderTeams<T extends { team: OverviewTeam }>(items: T[]): T[] {
  const live = (item: T) => item.team.runtime.state === 'running' || item.team.runtime.state === 'starting';
  return [...items.filter(live), ...items.filter((item) => !live(item))];
}

export const RUNTIME_LABELS: Record<OverviewRuntimeState, string> = {
  not_started: 'Not started',
  starting: 'Starting',
  running: 'Running',
  stopped: 'Stopped',
  error: 'Error',
  disconnected: 'Disconnected',
  unavailable: 'Runtime unavailable',
};

export const PRESENCE_LABELS: Record<string, string> = {
  idle: 'Available',
  busy: 'Working',
  waiting_input: 'Waiting for input',
  starting: 'Starting',
  limit_reached: 'Limit reached',
  offline: 'Offline',
  error: 'Error',
  not_in_runtime: 'Not in runtime',
  not_started: 'Not started',
  stopped: 'Stopped',
  disconnected: 'Disconnected',
  unavailable: 'Unavailable',
};

export function presenceLabel(presence: string): string {
  return Object.prototype.hasOwnProperty.call(PRESENCE_LABELS, presence) ? PRESENCE_LABELS[presence]! : presence;
}

export function providerModelText(provider: string | null, model: string | null): string {
  if (provider === null) return 'Not available';
  if (model === null) return `${provider} · model not set`;
  return `${provider} · ${model}`;
}

export function memberProviderModel(m: OverviewMember): string {
  if (m.provider !== null) return providerModelText(m.provider, m.model);
  if (m.runtime !== null) return providerModelText(m.runtime.provider, m.runtime.model);
  return 'Not available';
}

export function memberName(m: OverviewMember): string {
  return text(m.name) ?? m.memberId ?? 'Unnamed member';
}

export function memberSourceNote(m: OverviewMember): string | null {
  if (m.source === 'inline') return 'Inline member';
  if (m.source === 'runtime') return 'Runtime only';
  if (m.agentDefState === 'missing') return `Agent definition ${m.agentDefId} is missing`;
  if (m.agentDefState === 'unavailable') return 'Agent catalog unavailable';
  return `Agent: ${m.agentDefId}`;
}

export function roleText(m: OverviewMember): string {
  return m.role ?? 'No role';
}

export function roleNote(m: OverviewMember): string | null {
  if (m.roleState === 'defined') return m.roleDescription ?? 'No description';
  if (m.roleState === 'undefined') return 'Role not defined in roles.json';
  if (m.roleState === 'unavailable') return 'Role descriptions unavailable';
  return null;
}

export function workText(work: MemberWork): string {
  if (work.state === 'none') return 'No current work';
  if (work.state === 'unavailable') return 'Not available';
  if (work.ticket !== null) return `${work.ticket.key} ${work.ticket.title}`;
  if (work.assignment !== null && work.assignment.goal !== '') return work.assignment.goal;
  return 'Working';
}

export function memberCountText(team: OverviewTeam): string {
  return team.membersTruncated
    ? `${team.members.length}+ members`
    : plural(team.members.length, 'member', 'members');
}

export function definitionBadge(team: OverviewTeam): string | null {
  switch (team.definition.state) {
    case 'problems': return 'Definition has problems';
    case 'unreadable': return 'Definition unreadable';
    case 'missing': return 'No definition (runtime only)';
    default: return null;
  }
}

export function overviewNotices(o: TeamOverview): string[] {
  const notices: string[] = [];
  if (!o.runtimeState.available) {
    notices.push(`Live team state unavailable — ${o.runtimeState.error?.message ?? 'runtime not reachable'}`);
  }
  if (o.roles.state !== 'ok') notices.push(`Role descriptions unavailable — ${o.roles.message ?? o.roles.state}`);
  if (o.catalog.state !== 'ok') notices.push(`Agent catalog could not be read — ${o.catalog.message ?? o.catalog.state}`);
  if (o.teams.some((t) => t.definition.state === 'unreadable')) notices.push('Some team definitions could not be read.');
  if (o.truncated) {
    notices.push(`Showing the first ${plural(o.teams.length, 'team', 'teams')}. More teams exist in this workspace.`);
  }
  if (o.partial && notices.length === 0) notices.push('Some team details could not be read.');
  return notices;
}

export function agentUsage(o: TeamOverview | null, agentId: string | null): string {
  if (o === null || agentId === null) return 'Usage unavailable';
  let members = 0;
  let teams = 0;
  for (const team of o.teams) {
    const n = team.members.filter((m) => m.source === 'catalog' && m.agentDefId === agentId).length;
    members += n;
    if (n > 0) teams += 1;
  }
  if (members === 0) return 'Not used by any team';
  const atLeast = o.truncated || o.teams.some((t) => t.membersTruncated) ? 'at least ' : '';
  return `Used by ${atLeast}${plural(members, 'member', 'members')} in ${plural(teams, 'team', 'teams')}`;
}

export type Tone = 'ok' | 'busy' | 'warning' | 'danger' | 'muted';

export function presenceTone(presence: string): Tone {
  switch (presence) {
    case 'idle': return 'ok';
    case 'busy': return 'busy';
    case 'starting':
    case 'waiting_input':
    case 'limit_reached': return 'warning';
    case 'offline':
    case 'error':
    case 'disconnected': return 'danger';
    default: return 'muted';
  }
}

export function runtimeTone(state: string): Tone {
  switch (state) {
    case 'running': return 'ok';
    case 'starting': return 'warning';
    case 'error':
    case 'disconnected': return 'danger';
    default: return 'muted';
  }
}
