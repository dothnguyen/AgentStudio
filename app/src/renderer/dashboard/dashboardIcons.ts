import type { DashboardActivity, DashboardAgentAvailability, DashboardBoard } from '../api';
import type { IconSpec } from '../icons/Icon';

export const AVAILABLE_ICON: IconSpec = { name: 'teams', tone: 'success' };

export function boardStatusIcon(column: Pick<DashboardBoard['columns'][number], 'status' | 'kind'>): IconSpec {
  if (column.kind === 'initial') return { name: 'document', tone: null };
  if (column.kind === 'done') return { name: 'check-circle', tone: 'success' };
  if (column.kind === 'closed') return { name: 'lock', tone: null };
  const s = column.status.toLowerCase();
  if (s.includes('unpack')) return { name: 'box', tone: null };
  if (s.includes('refine') || s.includes('merge')) return { name: 'git-branch', tone: null };
  if (s.includes('dev')) return { name: 'code', tone: null };
  if (s.includes('qa')) return { name: 'search', tone: null };
  if (s.includes('review')) return { name: 'teams', tone: null };
  return { name: 'item', tone: null };
}

export function activityIcon(entry: Pick<DashboardActivity['entries'][number], 'name' | 'kind'>): IconSpec {
  const n = entry.name.toLowerCase();
  if (n.includes('merged')) return { name: 'git-branch', tone: null };
  if (n.includes('moved') || n.includes('transition')) return { name: 'arrow-right', tone: null };
  if (n.includes('finished') || n.includes('completed')) return { name: 'check-circle', tone: 'success' };
  switch (entry.kind) {
    case 'workflow': return { name: 'gear', tone: null };
    case 'assignment': return { name: 'check', tone: null };
    case 'team': return { name: 'teams', tone: null };
    case 'ticket': return { name: 'ticket', tone: null };
    default: return { name: 'item', tone: null };
  }
}

export function availabilityIcon(state: DashboardAgentAvailability): IconSpec | null {
  if (state === 'busy') return { name: 'clock', tone: 'warning' };
  if (state === 'error' || state === 'limit_reached') return { name: 'warning', tone: 'danger' };
  return null;
}
