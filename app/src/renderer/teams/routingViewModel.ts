import type { BoardRuleView, BoardSettings, RoleCatalogItem } from '../../shared/management';

export type RoleRef = { kind: 'catalog'; id: string; label: string } | { kind: 'missing'; id: string } | { kind: 'catalog-unavailable'; id: string } | { kind: 'none' };
export function statusLabel(statuses: BoardSettings['statuses'], id: string): string {
  const s = statuses.find(s => s.id === id);
  return !s ? `${id} (unknown status)` : s.name?.trim() && s.name !== id ? `${s.name} (${id})` : id;
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
export interface EscalationHandler { ruleIndex: number; type: 'agent' | 'action'; role: string | null; workflow: string | null; action: string | null }
export interface EscalationChain { ruleIndex: number; source: string; role: string | null; count: number; target: string; handlers: EscalationHandler[] }
export function escalationChains(settings: Pick<BoardSettings, 'rules'>): EscalationChain[] {
  return settings.rules.flatMap((rule: BoardRuleView) => rule.onFailureLimit ? [{ ruleIndex: rule.index, source: rule.status, role: rule.role, count: rule.onFailureLimit.count, target: rule.onFailureLimit.status, handlers: settings.rules.filter(r => r.status === rule.onFailureLimit!.status).map(r => ({ ruleIndex: r.index, type: r.type, role: r.role, workflow: r.workflow, action: r.action })) }] : []);
}
export function workflowErrorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return JSON.stringify(error);
}
