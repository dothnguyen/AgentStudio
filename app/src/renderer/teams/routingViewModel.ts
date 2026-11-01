import type { BoardSettings, OverviewMember, OverviewTeam, RoleCatalogItem, TeamOverview } from '../../shared/management';

export type RoleRef = { kind: 'catalog'; id: string; label: string } | { kind: 'missing'; id: string } | { kind: 'catalog-unavailable'; id: string } | { kind: 'none' };
export function statusLabel(statuses: BoardSettings['statuses'], id: string): string {
  const s = statuses.find(s => s.id === id);
  return !s ? `${id} (unknown status)` : s.name?.trim() && s.name !== id ? `${s.name} (${id})` : id;
}
/** The status name on its own, as the rules table shows it; unknown ids keep a diagnostic. */
export function statusName(statuses: BoardSettings['statuses'], id: string): string {
  const s = statuses.find(s => s.id === id);
  if (!s) return `${id} (unknown status)`;
  return s.name?.trim() ? s.name : id;
}
export type StatusTone = 'grey' | 'blue' | 'amber' | 'red' | 'green' | 'neutral';
/** The design's id colours first, then the status kind, with a neutral default for custom statuses. */
export function statusTone(statuses: BoardSettings['statuses'], id: string): StatusTone {
  const status = statuses.find(s => s.id === id);
  if (status?.kind === 'closed') return 'grey';
  const key = id.toLocaleLowerCase();
  if (key === 'backlog' || key === 'closed') return 'grey';
  if (key === 'done') return 'green';
  if (key.includes('conflict')) return 'red';
  if (key.includes('escalat')) return 'amber';
  if (key.includes('ready')) return 'blue';
  if (status?.kind === 'initial') return 'grey';
  if (status?.kind === 'done') return 'green';
  return 'neutral';
}
export function roleRef(roleId: string | null, roleItems: RoleCatalogItem[] | null): RoleRef {
  if (!roleId) return { kind: 'none' };
  if (roleItems === null) return { kind: 'catalog-unavailable', id: roleId };
  const item = roleItems.find(r => r.id === roleId);
  return item ? { kind: 'catalog', id: roleId, label: item.name?.trim() ? item.name : item.id } : { kind: 'missing', id: roleId };
}
export function workflowLabel(workflows: BoardSettings['workflows'], name: string | null): string {
  if (name === null) return '—';
  const workflow = workflows.find(w => w.name === name);
  return !workflow ? `${name} — not found` : workflow.errors.length ? `${name} — unavailable` : name;
}
export function workspaceLabel(mode: string | null): string {
  if (!mode) return 'Not set';
  switch (mode) {
    case 'main': return 'Main workspace';
    case 'worktree': return 'Isolated worktree';
    case 'none': return 'No workspace';
    default: return mode;
  }
}
export function protectedState(settings: Pick<BoardSettings, 'protectedRoutes'>, status: string): 'protected' | 'needs-repair' | null {
  const route = settings.protectedRoutes.find(r => r.status === status);
  return route ? route.satisfied ? 'protected' : 'needs-repair' : null;
}
export function workflowErrorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return JSON.stringify(error);
}

/** Teams that are running for this workspace, in backend order. */
export function runningTeams(overview: TeamOverview | null): OverviewTeam[] {
  if (overview === null || !overview.runtimeState.available) return [];
  return overview.teams.filter(team => team.runtime.state === 'running');
}
export interface RoleMember {
  member: OverviewMember | null;
  /** False when the returned member lists cannot prove that a role is unfilled. */
  known: boolean;
}
/**
 * The first member of a running team that fills the role.
 * A truncated member list leaves an unfilled role unknown instead of absent.
 */
export function roleMember(overview: TeamOverview | null, roleId: string | null): RoleMember {
  if (roleId === null) return { member: null, known: true };
  if (overview === null || !overview.runtimeState.available) return { member: null, known: false };
  const teams = runningTeams(overview);
  for (const team of teams) {
    const member = team.members.find(candidate => candidate.role === roleId);
    if (member) return { member, known: true };
  }
  if (teams.length === 0) return { member: null, known: true };
  return { member: null, known: !teams.some(team => team.membersTruncated) };
}
/** Distinct role ids used by agent rules, in rule order. */
export function rolesUsedByRules(settings: Pick<BoardSettings, 'rules'>): string[] {
  const seen = new Set<string>();
  for (const rule of settings.rules) {
    if (rule.type === 'agent' && rule.role !== null) seen.add(rule.role);
  }
  return [...seen];
}
export interface RoleCoverageGap { role: string; label: string; statuses: string[] }
export interface RoleCoverage {
  total: number;
  filled: number;
  gaps: RoleCoverageGap[];
  /** True when at least one team is running. */
  running: boolean;
  /** False while the teams overview is unavailable, so no gap is claimed from unknown data. */
  known: boolean;
  /** True when a running team returned only part of its members, so an unfilled role may still have one. */
  truncated: boolean;
}
export function roleCoverage(
  settings: Pick<BoardSettings, 'rules' | 'statuses'>,
  overview: TeamOverview | null,
  roleItems: RoleCatalogItem[] | null,
): RoleCoverage {
  const roles = rolesUsedByRules(settings);
  if (overview === null || !overview.runtimeState.available) {
    return { total: roles.length, filled: 0, gaps: [], running: false, known: false, truncated: false };
  }
  const teams = runningTeams(overview);
  const members = teams.flatMap(team => team.members);
  const filled = roles.filter(role => members.some(member => member.role === role));
  if (teams.length === 0) return { total: roles.length, filled: filled.length, gaps: [], running: false, known: true, truncated: false };
  const truncated = teams.some(team => team.membersTruncated);
  const gaps = truncated ? [] : roles
    .filter(role => !members.some(member => member.role === role))
    .map(role => {
      const ref = roleRef(role, roleItems);
      const statuses = [...new Set(settings.rules.filter(rule => rule.type === 'agent' && rule.role === role).map(rule => statusName(settings.statuses, rule.status)))];
      return { role, label: ref.kind === 'catalog' ? ref.label : role, statuses };
    });
  return { total: roles.length, filled: filled.length, gaps, running: true, known: true, truncated };
}
