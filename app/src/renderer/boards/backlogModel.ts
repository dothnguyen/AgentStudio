import type { BoardPhases, BoardTicketList, BoardTicketSummary } from '../api';

export type BacklogSort = 'priority' | 'key' | 'updated' | 'status';
export interface BacklogGroup {
  slug: string | null;
  name: string;
  description: string | null;
  current: boolean;
  closed: boolean;
  tickets: BoardTicketSummary[];
  counts: { total: number; done: number; working: number; blocked: number; waiting: number; ready: number };
}

function keyNumber(key: string | undefined): number {
  const match = /^T-(\d+)$/.exec(key ?? '');
  return match ? Number(match[1]) : -1;
}

function priority(ticket: BoardTicketSummary): number {
  return typeof ticket.priority === 'number' && Number.isFinite(ticket.priority) ? ticket.priority : Infinity;
}

function comparePriority(a: BoardTicketSummary, b: BoardTicketSummary): number {
  return (priority(a) - priority(b)) || (keyNumber(a.key) - keyNumber(b.key));
}

function updated(ticket: BoardTicketSummary): number {
  const value = Date.parse(ticket.updatedAt ?? '');
  return Number.isNaN(value) ? -Infinity : value;
}

/** Build independent phase groups from phase.list and ticket.list summaries. */
export function buildBacklogGroups(phases: BoardPhases, tickets: BoardTicketList, sort: BacklogSort = 'priority'): BacklogGroup[] {
  const statuses = new Map((tickets?.statuses ?? []).map((status, index) => [status, index]));
  const compare = (a: BoardTicketSummary, b: BoardTicketSummary): number => {
    if (sort === 'key') return (keyNumber(b.key) - keyNumber(a.key)) || comparePriority(a, b);
    if (sort === 'updated') return (updated(b) - updated(a)) || comparePriority(a, b);
    if (sort === 'status') return ((statuses.get(a.status) ?? Infinity) - (statuses.get(b.status) ?? Infinity)) || comparePriority(a, b);
    return comparePriority(a, b);
  };
  const groups: BacklogGroup[] = (phases?.phases ?? []).map((phase) => ({
    slug: phase.slug, name: phase.name, description: phase.description ?? null,
    current: phase.current === true, closed: phase.status === 'closed', tickets: [],
    counts: { total: 0, done: 0, working: 0, blocked: 0, waiting: 0, ready: 0 },
  }));
  const positions = new Map((phases?.phases ?? []).map((phase) => [phase.slug, phase.position]));
  groups.sort((a, b) => Number(b.current) - Number(a.current) || Number(a.closed) - Number(b.closed)
    || ((positions.get(a.slug ?? '') ?? Infinity) - (positions.get(b.slug ?? '') ?? Infinity)));
  const bySlug = new Map(groups.map((group) => [group.slug, group]));
  let noPhase: BacklogGroup | undefined;
  for (const ticket of tickets?.tickets ?? []) {
    const group = (ticket.phase != null ? bySlug.get(ticket.phase) : undefined) ?? (noPhase ??= {
      slug: null, name: 'No phase', description: null, current: false, closed: false, tickets: [],
      counts: { total: 0, done: 0, working: 0, blocked: 0, waiting: 0, ready: 0 },
    });
    group.tickets.push(ticket);
    group.counts.total++;
    if (ticket.status === 'done' || (ticket.status as string) === 'close') group.counts.done++;
    else if (ticket.activity?.state === 'working') group.counts.working++;
    else if (ticket.activity?.state === 'blocked') group.counts.blocked++;
    else if (ticket.activity?.state === 'not started' && ticket.activity.waitingFor) group.counts.waiting++;
    else group.counts.ready++;
  }
  if (noPhase) groups.push(noPhase);
  for (const group of groups) group.tickets.sort(compare);
  return groups;
}
