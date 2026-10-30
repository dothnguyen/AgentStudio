import type { RoleCatalogItem, ResolvedAgentOption, MemberWork, OverviewMember, OverviewRuntimeState, OverviewTeam, TeamOverview } from '../api';


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

export function savedAgentOptionText(option: ResolvedAgentOption, index: number): string {
  return `${index === 0 ? 'Default — ' : ''}${option.name ?? option.id} · ${providerModelText(option.provider, option.model)}${option.reasoning ? ` · Reasoning: ${option.reasoning}` : ''}${option.state === 'missing' ? ' · Missing from catalog' : ''}`;
}
export function liveAgentText(member: OverviewMember): string {
  const runtime = member.runtime;
  if (runtime === null) return 'Not running';
  if (!runtime.activeAgent) return 'No live agent';
  return `${runtime.activeAgent} · ${providerModelText(runtime.provider, runtime.model)}${runtime.reasoning ? ` · Reasoning: ${runtime.reasoning}` : ''}`;
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

export function definitionStateText(team: OverviewTeam): string {
  switch (team.definition.state) {
    case 'valid': return 'Valid';
    case 'problems': return `Has ${plural(team.definition.problems.length, 'problem', 'problems')}`;
    case 'unreadable': return 'Unreadable';
    default: return 'No definition (runtime only)';
  }
}

export interface AvailabilityCount { presence: string; label: string; tone: Tone; count: number }

export function availabilityCounts(members: readonly OverviewMember[]): AvailabilityCount[] {
  const counts = new Map<string, number>();
  for (const member of members) counts.set(member.presence, (counts.get(member.presence) ?? 0) + 1);
  const known = Object.keys(PRESENCE_LABELS).filter((p) => counts.has(p));
  const unknown = [...counts.keys()].filter((p) => !Object.prototype.hasOwnProperty.call(PRESENCE_LABELS, p));
  return [...known, ...unknown].map((presence) => ({
    presence,
    label: presenceLabel(presence),
    tone: presenceTone(presence),
    count: counts.get(presence)!,
  }));
}

export function coordinatorText(o: TeamOverview): { text: string; tone: Tone } {
  return o.coordinator.running === true ? { text: 'Running', tone: 'ok' } : { text: 'Not running', tone: 'danger' };
}

export function liveStateText(o: TeamOverview): { text: string; tone: Tone } {
  if (o.runtimeState.available) return { text: 'Available', tone: 'ok' };
  return { text: `Unavailable — ${o.runtimeState.error?.message ?? 'runtime not reachable'}`, tone: 'danger' };
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

export interface MemberListFilters { query: string; availability: string | null }

/** Filters only the returned members, by the text the roster actually displays; keeps backend order. */
export function filterMembers(members: readonly OverviewMember[], roles: readonly RoleCatalogItem[] | null, filters: MemberListFilters): OverviewMember[] {
  const query = filters.query.trim().toLowerCase();
  return members.filter((m) => {
    if (filters.availability !== null && m.presence !== filters.availability) return false;
    if (query === '') return true;
    const identity = memberIdentity(m), role = memberRoleSummary(m, roles), agent = memberAgentSummary(m);
    return [identity.name, identity.id, m.role, role.label, role.roleId, agent.text, agent.note, workSummary(m.work)]
      .some((v) => v !== null && v.toLowerCase().includes(query));
  });
}

export interface MemberSelection { teamKey: string; memberId: string }

export type MemberSelectionResult =
  | { state: 'none' }
  | { state: 'other-team' }
  | { state: 'missing'; memberId: string }
  | { state: 'selected'; member: OverviewMember };

export function resolveMemberSelection(team: OverviewTeam, key: string, selection: MemberSelection | null): MemberSelectionResult {
  if (selection === null) return { state: 'none' };
  if (selection.teamKey !== key) return { state: 'other-team' };
  const member = team.members.find((m) => m.memberId === selection.memberId);
  return member === undefined ? { state: 'missing', memberId: selection.memberId } : { state: 'selected', member };
}

export function missingMemberNotice(memberId: string, truncated: boolean): string {
  return truncated
    ? `Member "${memberId}" is not among the returned members (the member list is truncated). Showing the returned members.`
    : `Member "${memberId}" is no longer in this team. Showing all members.`;
}

export function memberIdentity(m: OverviewMember): { name: string; id: string | null; note: string | null } {
  const name = memberName(m);
  return {
    name,
    id: m.memberId !== null && m.memberId !== name ? m.memberId : null,
    note: m.memberId === null ? 'No member id returned'
      : m.source === 'runtime' ? 'Runtime only — not in the saved team definition'
      : null,
  };
}

export function memberRoleSummary(m: OverviewMember, roles: readonly RoleCatalogItem[] | null): { label: string; roleId: string | null; note: string | null } {
  const u = m.roleState === 'unavailable' ? 'Role descriptions unavailable' : null;
  if (m.role === null) return { label: 'No role', roleId: null, note: u };
  if (m.roleState === 'undefined') return { label: m.role, roleId: null, note: 'Role not defined in roles.json' };
  const item = roles?.find((r) => r.id === m.role) ?? null;
  if (item !== null) return { label: item.name, roleId: item.id !== item.name ? item.id : null, note: u };
  if (roles !== null) return { label: m.role, roleId: null, note: u ?? 'Not found in the role catalog' };
  return { label: m.role, roleId: null, note: u };
}

export function memberAgentSummary(m: OverviewMember): { text: string; kind: 'active' | 'stale' | 'none' | 'saved'; note: string | null } {
  const r = m.runtime;
  const active = r ? text(r.activeAgent) : null;
  const first = m.agentOptions[0];
  let result: { text: string; kind: 'active' | 'stale' | 'none' | 'saved' };
  if (r && active && !r.stale) result = { text: `Active: ${active} · ${providerModelText(r.provider, r.model)}`, kind: 'active' };
  else if (r && active) result = { text: `Last live agent: ${active} (team not running)`, kind: 'stale' };
  else if (r) result = { text: 'No live agent reported', kind: 'none' };
  else if (m.source === 'runtime') result = { text: 'No live or saved agent', kind: 'none' };
  else if (m.agentMode === 'inline') {
    result = m.provider === null
      ? { text: 'No live or saved agent', kind: 'none' }
      : { text: `Not running · saved inline: ${providerModelText(m.provider, m.model)}`, kind: 'saved' };
  } else {
    result = first === undefined
      ? { text: 'No live or saved agent', kind: 'none' }
      : { text: `Not running · saved default: ${first.name ?? first.id}`, kind: 'saved' };
  }
  const note = r && text(r.pendingAgent) ? `Switch to ${r.pendingAgent} pending`
    : result.kind === 'saved' && m.agentMode !== 'inline' && first?.state === 'missing' ? 'Saved default is missing from the catalog'
    : null;
  return { ...result, note };
}

export const WORK_UNAVAILABLE_REASONS: Record<string, string> = {
  not_in_runtime: 'member is not in the running team',
  not_started: 'team not started',
  stopped: 'team stopped',
  error: 'team runtime error',
  disconnected: 'team disconnected',
  unavailable: 'live state unavailable',
};

export function workSummary(work: MemberWork): string {
  if (work.state === 'none') return 'No current work';
  if (work.state === 'unavailable') {
    const reason = text(work.reason);
    if (reason === null) return 'Not available';
    const label = Object.prototype.hasOwnProperty.call(WORK_UNAVAILABLE_REASONS, reason) ? WORK_UNAVAILABLE_REASONS[reason]! : reason;
    return `Not available — ${label}`;
  }
  if (work.ticket !== null) return work.ticket.title === '' ? work.ticket.key : `${work.ticket.key} ${work.ticket.title}`;
  if (work.assignment !== null) return work.assignment.goal !== '' ? work.assignment.goal : `Assignment ${work.assignment.id}`;
  return 'Working (no details returned)';
}
