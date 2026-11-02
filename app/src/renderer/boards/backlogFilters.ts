import type { BoardTicketSummary } from '../api';
import type { BacklogSort } from './backlogModel';

export interface BacklogFilters {
  query: string;
  statuses: string[];
  phases: string[];
  activity: Array<'working' | 'blocked' | 'waiting' | 'ready' | 'finished'>;
  owner: string | null;
  priority: 'any' | 'urgent' | 'normal' | 'low';
  hasOpenDeps: 'any' | 'yes' | 'no';
  sort: BacklogSort;
}

export const DEFAULT_BACKLOG_FILTERS: BacklogFilters = {
  query: '', statuses: [], phases: [], activity: [], owner: null,
  priority: 'any', hasOpenDeps: 'any', sort: 'priority',
};

export function matchesBacklogFilters(ticket: BoardTicketSummary, filters: BacklogFilters): boolean {
  const query = filters.query.trim().toLowerCase();
  if (query && !ticket.key.toLowerCase().includes(query) && !ticket.title.toLowerCase().includes(query)) return false;
  if (filters.statuses.length && !filters.statuses.includes(ticket.status)) return false;
  if (filters.phases.length && (ticket.phase === null || !filters.phases.includes(ticket.phase))) return false;
  const activity = ticket.activity.state === 'not started'
    ? (ticket.activity.waitingFor ? 'waiting' : 'ready') : ticket.activity.state;
  if (filters.activity.length && !filters.activity.includes(activity)) return false;
  if (filters.owner !== null && ticket.activity.agent !== filters.owner) return false;
  if (filters.priority === 'urgent' && !(ticket.priority < 100)) return false;
  if (filters.priority === 'normal' && ticket.priority !== 100) return false;
  if (filters.priority === 'low' && !(ticket.priority > 100)) return false;
  if (filters.hasOpenDeps === 'yes' && ticket.openDependsOn.length === 0) return false;
  if (filters.hasOpenDeps === 'no' && ticket.openDependsOn.length > 0) return false;
  return true;
}

export function filterBacklogTickets(tickets: readonly BoardTicketSummary[], filters: BacklogFilters): BoardTicketSummary[] {
  return tickets.filter(ticket => matchesBacklogFilters(ticket, filters));
}

export function activeFilterCount(filters: BacklogFilters): number {
  return Number(filters.query !== '') + Number(filters.statuses.length > 0) + Number(filters.phases.length > 0)
    + Number(filters.activity.length > 0) + Number(filters.owner !== null) + Number(filters.priority !== 'any')
    + Number(filters.hasOpenDeps !== 'any');
}

export function ownersOf(tickets: readonly BoardTicketSummary[]): string[] {
  return [...new Set(tickets.map(ticket => ticket.activity.agent).filter((agent): agent is string => Boolean(agent)))].sort();
}

export function isDefaultFilters(filters: BacklogFilters): boolean {
  return activeFilterCount(filters) === 0 && filters.sort === DEFAULT_BACKLOG_FILTERS.sort;
}
