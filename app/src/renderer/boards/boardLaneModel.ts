import type { BoardRuleView, BoardTicketSummary } from '../api';

/** How many cards a column shows before its "Show N more" button. */
export const BOARD_CARD_LIMIT = 6;

/** The reserved workflow status for blocked tickets. */
export const BLOCKED_STATUS: string = 'blocked';

export type BoardStatusTone = 'neutral' | 'blue' | 'amber' | 'red' | 'green';

/** A board status as returned by board.settings, or a name-less status from ticket.list. */
export interface BoardStatusInfo {
  id: string;
  name?: string | null;
  kind?: string | null;
}

export interface BoardColumn {
  id: string;
  label: string;
  tone: BoardStatusTone;
  tickets: BoardTicketSummary[];
}

export interface BuildLanesOptions {
  /** Hide empty Backlog and Closed columns, based on unfiltered tickets. */
  hideEmpty?: boolean;
  matches?(ticket: BoardTicketSummary): boolean;
}

const STATUS_TONE: Record<string, BoardStatusTone> = {
  backlog: 'neutral',
  close: 'neutral',
  done: 'green',
  'need-escalate': 'amber',
  'merge-conflict': 'red',
  'plan-merge-conflict': 'red',
  [BLOCKED_STATUS]: 'red',
};

/** Words that need a specific case when a board status has no display name. */
const STATUS_ACRONYMS: Record<string, string> = { qa: 'QA' };
const STATUS_FIRST_WORDS: Record<string, string> = { need: 'Needs', close: 'Closed' };
const STATUS_LATER_WORDS: Record<string, string> = { escalate: 'escalation' };

/** "qa-ready" -> "QA ready", "need-escalate" -> "Needs escalation". */
export function humanizeStatusId(id: string): string {
  const words = id.split(/[-_]+/).filter(Boolean);
  if (words.length === 0) return id;
  return words
    .map((word, index) => {
      const lower = word.toLowerCase();
      const acronym = STATUS_ACRONYMS[lower];
      if (acronym !== undefined) return acronym;
      if (index > 0) return STATUS_LATER_WORDS[lower] ?? lower;
      const known = STATUS_FIRST_WORDS[lower];
      if (known !== undefined) return known;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

/** The board's display name when it has one, otherwise a readable id. */
export function statusLabel(status: BoardStatusInfo): string {
  const name = status.name?.trim() ?? '';
  if (name !== '' && name !== status.id) return name;
  return humanizeStatusId(status.id);
}

export function statusTone(status: BoardStatusInfo): BoardStatusTone {
  const known = STATUS_TONE[status.id];
  if (known !== undefined) return known;
  if (status.kind === 'done') return 'green';
  if (status.kind === 'initial' || status.kind === 'closed') return 'neutral';
  return 'blue';
}

/** The worker line comes from the first board rule that names the status. */
export function workerLineForStatus(status: string, rules: readonly BoardRuleView[]): string | null {
  const rule = rules.find((candidate) => candidate.status === status);
  if (rule === undefined) return null;
  if (rule.type === 'agent') {
    const role = rule.role?.trim() ?? '';
    return role === '' ? null : `${role} works this`;
  }
  const action = rule.action?.trim() ?? '';
  if (action === '') return null;
  const lower = action.toLowerCase();
  if (lower === 'merge') return 'Merges automatically';
  if (lower === 'close') return 'Closes automatically';
  return `${action.charAt(0).toUpperCase()}${action.slice(1)} runs automatically`;
}

/** Legacy workflow statuses can still arrive before the backend migrates a workspace. */
function ticketColumn(ticket: BoardTicketSummary): string {
  // Older workspaces may return statuses outside the current API union.
  const status: string = ticket.status;
  switch (status) {
    case 'backlog': case 'todo': case 'in-progress': case 'done': case 'closed':
      return status;
    case 'close':
      return 'closed';
    case 'blocked':
      return 'in-progress';
    default:
      return ticket.activity?.state === 'working' ? 'in-progress' : 'todo';
  }
}

/** Fixed Kanban columns use the ticket's board status, with a fallback for legacy statuses. */
export function buildBoardLanes(
  tickets: readonly BoardTicketSummary[],
  options: BuildLanesOptions = {},
): BoardColumn[] {
  const definitions: ReadonlyArray<{ id: string; label: string; tone: BoardStatusTone }> = [
    { id: 'backlog', label: 'Backlog', tone: 'neutral' },
    { id: 'todo', label: 'Todo', tone: 'blue' },
    { id: 'in-progress', label: 'In Progress', tone: 'blue' },
    { id: 'done', label: 'Done', tone: 'green' },
    { id: 'closed', label: 'Closed', tone: 'neutral' },
  ];
  return definitions.flatMap((definition) => {
    const rawTickets = tickets.filter((ticket) => ticketColumn(ticket) === definition.id);
    if ((options.hideEmpty ?? true) && rawTickets.length === 0 &&
        (definition.id === 'backlog' || definition.id === 'closed')) return [];
    return [{ ...definition, tickets: rawTickets.filter(options.matches ?? (() => true)) }];
  });
}
