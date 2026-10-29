import type { ManagementError, Problem, RoleCatalogItem } from '../api';

export type RoleUsageView = RoleCatalogItem['usage'];
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

// ---- Role deletion ----
export type RoleDeleteDisposition = 'deleted' | 'preserved' | 'missing' | 'none';
export interface RoleBlockerGroup { key: string; title: string; items: string[] }
const MAX_LABEL = 200;
const bound = (value: string): string => (value.length > MAX_LABEL ? `${value.slice(0, MAX_LABEL)}…` : value);

export const ROLE_DATA_CHANGED_REASON = 'Role data changed. Close and reopen Delete to confirm the latest version.';

export function conventionalInstructionPath(roleId: string): string {
  return `.agent-studio/roles/${roleId}.md`;
}
export function isInstructionFileShared(role: Pick<RoleCatalogItem, 'id' | 'instructions'>, all: readonly Pick<RoleCatalogItem, 'id' | 'instructions'>[]): boolean {
  const path = role.instructions.path;
  return !!path && all.some(other => other.id !== role.id && other.instructions.path === path);
}
// `shared` must come from the catalog (another role names the same file); a path alone never proves ownership.
export function instructionDeleteDescription(role: Pick<RoleCatalogItem, 'id' | 'instructions'>, shared = false): string {
  const { state, path } = role.instructions;
  if (state === 'none' || (!path && state !== 'ok')) return 'No instruction file is configured for this role, so no file will be changed.';
  if (state === 'missing' && path === conventionalInstructionPath(role.id) && !shared) return `The instruction file ${path} is already missing, so no file cleanup is needed.`;
  if (path && path === conventionalInstructionPath(role.id) && !shared && state !== 'missing') return `The role entry and its instruction file ${path} will be removed.`;
  if (state === 'missing') return `The configured instruction file ${path ?? ''} is already missing and no file will be changed.`.replace('  ', ' ');
  return `The role entry will be removed. The instruction file ${path ?? ''} is ${shared ? 'shared with another role' : 'a custom file'} and will be preserved.`.replace('  ', ' ');
}
export function roleDeleteDisabledReason(args: {
  role: RoleCatalogItem;
  catalogSha256: string | null;
  disconnected: boolean;
  mutationPending: boolean;
  refreshRequired: boolean;
}): string | null {
  const { role } = args;
  if (args.refreshRequired) return 'A role was deleted but Roles has not been refreshed. Retry Roles before making another change.';
  if (args.mutationPending) return 'Another role change is in progress.';
  if (args.disconnected) return 'Delete is unavailable while the backend connection is not ready.';
  if (role.usage.blocking) return 'This role is still referenced. Remove its references before deleting it.';
  if (role.usage.partial) return 'Role usage could not be checked completely, so deletion is unavailable. Retry loading roles.';
  if (!args.catalogSha256) return 'The roles catalog has no version token, so deletion is unavailable. Reload Roles.';
  const { state, sha256 } = role.instructions;
  if (state === 'invalid' || state === 'truncated') return 'The instruction file is invalid or truncated, so deletion is unavailable until it is fixed.';
  if (state === 'ok' && !sha256) return 'The instruction file has no version token, so deletion is unavailable. Reload Roles.';
  return null;
}
export function selectionAfterRoleDeletion(beforeVisibleIds: readonly string[], afterVisibleIds: readonly string[], deletedId: string): string | null {
  const remaining = new Set(afterVisibleIds.filter(id => id !== deletedId));
  const at = beforeVisibleIds.indexOf(deletedId);
  if (at >= 0) {
    const next = beforeVisibleIds.slice(at + 1).find(id => remaining.has(id));
    if (next !== undefined) return next;
    for (let i = at - 1; i >= 0; i--) if (remaining.has(beforeVisibleIds[i]!)) return beforeVisibleIds[i]!;
  }
  return afterVisibleIds.find(id => id !== deletedId) ?? null;
}

const array = (v: unknown): Loose[] => (Array.isArray(v) ? v.map(loose).filter((x): x is Loose => x !== null) : []);
export function roleUsageFromDeleteError(error: ManagementError): RoleUsageView | null {
  if (error.code !== 'ROLE_IN_USE') return null;
  const usage = loose(loose(error.data)?.usage);
  if (!usage) return null;
  const out = {
    members: array(usage.members), boardRules: array(usage.boardRules), workflows: array(usage.workflows),
    legacyRoster: array(usage.legacyRoster), liveRuntime: array(usage.liveRuntime),
    count: typeof usage.count === 'number' ? usage.count : 0, blocking: true, partial: usage.partial === true,
  };
  const total = out.members.length + out.boardRules.length + out.workflows.length + out.legacyRoster.length + out.liveRuntime.length;
  return total === 0 ? null : out as unknown as RoleUsageView;
}
export function roleUsageProblemsFromDeleteError(error: ManagementError): Array<{ source: string; message: string }> {
  if (error.code !== 'ROLE_USAGE_UNAVAILABLE') return [];
  const data = loose(error.data);
  const list = array(data?.problems ?? loose(data?.usage)?.problems);
  return list.filter(p => text(p.message)).map(p => ({ source: text(p.source) ?? text(p.path) ?? 'unknown', message: bound(text(p.message)!) }));
}
export function roleBlockerGroups(usage: RoleUsageView): RoleBlockerGroup[] {
  const u = usage as unknown as Record<string, unknown>;
  const named = (name: string | null, id: string | null, fallback: string): string => (name && id && name !== id ? `${name} (${id})` : name ?? id ?? fallback);
  const groups: RoleBlockerGroup[] = [
    { key: 'members', title: 'Team members', items: array(u.members).map(m => {
      const live = loose(m.live);
      const extra = [m.saved ? 'saved' : null, live ? 'live' : null, text(live?.availability) ?? text(m.availability)].filter(Boolean).join(', ');
      return `${named(text(m.teamName), text(m.teamDefId) ?? text(m.teamId), 'Unknown team')} — ${named(text(m.memberName), text(m.memberId), 'Unnamed member')}${extra ? ` · ${extra}` : ''}`;
    }) },
    { key: 'boardRules', title: 'Board rules', items: array(u.boardRules).map((r, i) => {
      const index = typeof r.index === 'number' ? r.index + 1 : i + 1;
      return `Rule ${index}${text(r.status) ? ` (status ${text(r.status)})` : ''}${text(r.label) ? ` — ${text(r.label)}` : ''}`;
    }) },
    { key: 'workflows', title: 'Workflow stages', items: array(u.workflows).map(w => `${text(w.name) ?? text(w.definition) ?? text(w.sourceId) ?? 'Workflow'} — stage ${text(w.stageId) ?? 'unknown'}${text(w.label) ? ` · ${text(w.label)}` : ''}`) },
    { key: 'legacyRoster', title: 'Legacy roster', items: array(u.legacyRoster).map((l, i) => {
      const index = typeof l.memberIndex === 'number' ? l.memberIndex + 1 : i + 1;
      return `${named(text(l.memberName), text(l.memberId), `Member ${index}`)}${text(l.label) ? ` · ${text(l.label)}` : ''}`;
    }) },
    { key: 'liveRuntime', title: 'Live runtime', items: array(u.liveRuntime).map(r => `${named(text(r.teamName), text(r.teamId), 'Unknown team')} — ${named(text(r.memberName), text(r.memberId), 'Unnamed member')}${[text(r.availability), text(r.assignmentId) ? `assignment ${text(r.assignmentId)}` : null].filter(Boolean).map(x => ` · ${x}`).join('')}`) },
  ];
  return groups.filter(g => g.items.length > 0).map(g => ({ ...g, items: g.items.map(bound) }));
}
// The shared type and the backend payload name the disposition differently; read both.
export function roleDeleteDisposition(data: unknown): RoleDeleteDisposition {
  const d = loose(data);
  const raw = loose(d?.deleted)?.instructions ?? loose(d?.instructions)?.action;
  return raw === 'deleted' || raw === 'preserved' || raw === 'missing' || raw === 'none' ? raw : 'none';
}
export function roleDeleteAnnouncement(role: string, disposition: RoleDeleteDisposition): string {
  const tail = disposition === 'deleted' ? 'Its instruction file was deleted.'
    : disposition === 'preserved' ? 'Its custom or shared instruction file was preserved.'
    : disposition === 'missing' ? 'Its instruction file was already missing.'
    : 'No instruction file was configured.';
  return `Role ${role} was deleted. ${tail}`;
}
