import type { Problem, RoleCatalogItem } from '../api';

export interface RoleCatalogRow { key: string; catalogIndex: number; role: RoleCatalogItem }
export interface RoleMemberLabel {
  key: string;
  team: string;
  teamId: string | null;
  member: string;
  memberId: string | null;
  states: Array<'Saved' | 'Live'>;
  runtime: string | null;
}
export type RoleRuntimeView = 'connected' | 'disconnected' | 'unavailable' | 'unknown';

// The backend payload is richer than the shared type (teamDefId, nested live/assignment,
// usage.problems, usage.liveRuntime); read the extra fields defensively and never infer facts.
type Loose = Record<string, unknown>;
const loose = (v: unknown): Loose | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Loose : null);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

export function roleRows(roles: readonly RoleCatalogItem[]): RoleCatalogRow[] {
  return roles.map((role, catalogIndex) => ({ key: `role:${role.id}`, catalogIndex, role }));
}
export function filterRoleRows(rows: readonly RoleCatalogRow[], query: string): RoleCatalogRow[] {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return [...rows];
  return rows.filter(({ role }) => [role.id, role.name, role.description].some(v => typeof v === 'string' && v.toLocaleLowerCase().includes(q)));
}
export function selectedRoleId(rows: readonly RoleCatalogRow[], currentId: string | null): string | null {
  return rows.some(row => row.role.id === currentId) ? currentId : rows[0]?.role.id ?? null;
}
export function roleDisplayLabel(role: RoleCatalogItem): string {
  return text(role.name)?.trim() ?? text(role.id)?.trim() ?? '';
}
export function roleInitials(role: RoleCatalogItem): string {
  const words = roleDisplayLabel(role).split(/\s+/).filter(Boolean).slice(0, 2);
  const initials = words.map(word => (Array.from(word)[0] ?? '').toLocaleUpperCase()).join('');
  return initials || '?';
}
export function roleUsageProblems(role: RoleCatalogItem): Problem[] {
  const usage = loose(role.usage);
  const list = usage?.sourceProblems ?? usage?.problems;
  return Array.isArray(list) ? list.filter(p => loose(p)).map(p => {
    const item = p as Loose;
    return { path: typeof item.path === 'string' ? item.path : '', message: typeof item.message === 'string' ? item.message : '' };
  }) : [];
}
export function roleRuntimeState(role: RoleCatalogItem): RoleRuntimeView {
  const usage = loose(role.usage);
  const direct = usage?.runtimeState ?? loose(usage?.liveRuntime)?.state;
  return direct === 'connected' || direct === 'disconnected' || direct === 'unavailable' ? direct : 'unknown';
}
export function roleIssueSummary(role: RoleCatalogItem): string {
  const n = (role.warnings?.length ?? 0) + (role.problems?.length ?? 0) + roleUsageProblems(role).length;
  return n === 0 ? 'No warnings' : n === 1 ? '1 warning' : `${n} warnings`;
}
export function assignedMemberLabels(role: RoleCatalogItem): RoleMemberLabel[] {
  const members = Array.isArray(role.usage?.members) ? role.usage.members : [];
  return members.map((raw, index) => {
    const m = raw as unknown as Loose;
    const teamId = text(m.teamDefId) ?? text(m.teamId);
    const memberId = text(m.memberId);
    const live = loose(m.live);
    const assignment = loose(m.assignment) ?? loose(live?.assignment);
    const availability = text(m.availability) ?? text(live?.availability);
    const status = text(assignment?.status) ?? text(m.assignmentStatus);
    const runtime = [availability, status ? `assignment ${status}` : null].filter(Boolean).join(', ') || null;
    const states: Array<'Saved' | 'Live'> = [];
    if (m.saved) states.push('Saved');
    if (m.live) states.push('Live');
    return {
      key: `${teamId ?? index}:${memberId ?? index}`,
      team: text(m.teamName) ?? teamId ?? 'Unknown team',
      teamId,
      member: text(m.memberName) ?? memberId ?? 'Unnamed member',
      memberId,
      states,
      runtime,
    };
  });
}
