import type { BoardStatuses } from '../api';

export type Status = BoardStatuses['statuses'][number];
export const statusPresentation: Record<Status['type'], { label: string; column: string; tone: string }> = {
  start: { label: 'Start', column: 'Backlog', tone: 'neutral' },
  startsWorkflow: { label: 'Starts a workflow', column: 'Todo or In Progress', tone: 'blue' },
  whileRunning: { label: 'While running', column: 'In Progress', tone: 'amber' },
  done: { label: 'Done', column: 'Done', tone: 'green' },
  closed: { label: 'Closed', column: 'Closed', tone: 'neutral' },
  unused: { label: 'Not used', column: 'Set by hand', tone: 'muted' },
};

export function statusCounts(statuses: readonly Status[]) {
  return {
    starts: statuses.filter(s => s.type === 'startsWorkflow').length,
    running: statuses.filter(s => s.type === 'whileRunning').length,
    protected: statuses.filter(s => s.type === 'start' || s.type === 'done' || s.type === 'closed').length,
    unused: statuses.filter(s => s.usedBy.length === 0 && s.kind === null).length,
  };
}

export function filterStatuses(statuses: readonly Status[], query: string, unusedOnly: boolean): Status[] {
  const needle = query.trim().toLocaleLowerCase();
  return statuses.filter(s => (!unusedOnly || (s.usedBy.length === 0 && s.kind === null)) &&
    (s.name.toLocaleLowerCase().includes(needle) || s.id.toLocaleLowerCase().includes(needle)));
}

export function statusIdFromName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-');
}

export function validStatusId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id) && id !== 'blocked';
}

export function statusErrorMessage(error: { code: string; message: string; data?: unknown }): string {
  if (error.code === 'CONFIG_CHANGED') return 'Statuses changed elsewhere - reload';
  if (error.code === 'STATUS_IN_USE' && error.data && typeof error.data === 'object') {
    const data = error.data as { usedBy?: Array<{ title?: string; workflow?: string }>; ticketCount?: number };
    const users = Array.isArray(data.usedBy) ? data.usedBy.map(use => use.title || use.workflow).filter(Boolean) : [];
    return `Status is in use${users.length ? ` by ${users.join(', ')}` : ''}${data.ticketCount ? `; ${data.ticketCount} ticket(s)` : ''}.`;
  }
  return error.message;
}
