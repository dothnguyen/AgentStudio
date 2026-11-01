import type { BoardRuleView, BoardTicketSummary } from '../api';

/** How many cards a column shows before its "Show N more" button. */
export const BOARD_CARD_LIMIT = 6;

/** The reserved status for blocked tickets; they normally sit in their return status' column. */
export const BLOCKED_STATUS = 'blocked';
export const BLOCKED_COLUMN_LABEL = 'Blocked';

export type BoardStatusTone = 'neutral' | 'blue' | 'amber' | 'red' | 'green';

export interface LaneDefinition {
  id: string;
  name: string;
  statuses: readonly string[];
}

/** Lane order and membership from design/boards-v1. A status that is not in this table lands in Other. */
export const BOARD_LANES: readonly LaneDefinition[] = [
  { id: 'intake', name: 'Intake', statuses: ['backlog', 'unpack-ready', 'refine-ready'] },
  { id: 'build', name: 'Build', statuses: ['dev-ready', 'qa-ready', 'need-escalate'] },
  {
    id: 'review',
    name: 'Review and merge',
    statuses: ['review-ready', 'plan-merge-ready', 'plan-merge-conflict', 'merge-ready', 'merge-conflict'],
  },
  { id: 'finished', name: 'Finished', statuses: ['done', 'close'] },
];

export const OTHER_LANE: LaneDefinition = { id: 'other', name: 'Other', statuses: [] };

/** A board status as returned by board.settings, or a name-less status from ticket.list. */
export interface BoardStatusInfo {
  id: string;
  name?: string | null;
  kind?: string | null;
}

export interface BoardColumn {
  /** The column key: a board status id, or the reserved Blocked fallback. */
  id: string;
  /** The ticket status this column shows. */
  status: string;
  label: string;
  tone: BoardStatusTone;
  /** "Developer works this" or "Merges automatically"; null when no board rule applies. */
  worker: string | null;
  /** True for the extra Blocked column at the end of Build. */
  fallback: boolean;
  tickets: BoardTicketSummary[];
}

export interface BoardLane {
  id: string;
  name: string;
  /** Every ticket in the lane, including tickets in hidden columns. */
  total: number;
  columns: BoardColumn[];
  /** Columns hidden because they hold no tickets (only with hideEmpty). */
  hiddenColumns: BoardColumn[];
}

export interface BuildLanesOptions {
  /** Hide columns without tickets; defaults to true. */
  hideEmpty?: boolean;
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

function statusMap(statuses: readonly BoardStatusInfo[], tickets: readonly BoardTicketSummary[]): Map<string, BoardStatusInfo> {
  const entries = new Map<string, BoardStatusInfo>();
  for (const status of statuses) {
    if (!entries.has(status.id)) entries.set(status.id, status);
  }
  // ticket.list also carries the configured statuses. Use them when board.settings is unavailable,
  // and keep a ticket visible even if the board config changed underneath it.
  for (const ticket of tickets) {
    if (ticket.status === BLOCKED_STATUS || entries.has(ticket.status)) continue;
    entries.set(ticket.status, { id: ticket.status, name: null, kind: null });
  }
  return entries;
}

function laneForStatus(status: string): LaneDefinition | null {
  return BOARD_LANES.find((lane) => lane.statuses.includes(status)) ?? null;
}

function blockedTarget(ticket: BoardTicketSummary, known: Map<string, BoardStatusInfo>): string {
  const returnStatus = ticket.returnStatus?.trim() ?? '';
  return returnStatus !== '' && known.has(returnStatus) ? returnStatus : BLOCKED_STATUS;
}

function groupTickets(tickets: readonly BoardTicketSummary[], known: Map<string, BoardStatusInfo>): Map<string, BoardTicketSummary[]> {
  const byColumn = new Map<string, BoardTicketSummary[]>();
  for (const ticket of tickets) {
    const target = ticket.status === BLOCKED_STATUS ? blockedTarget(ticket, known) : ticket.status;
    const bucket = byColumn.get(target);
    if (bucket === undefined) byColumn.set(target, [ticket]);
    else bucket.push(ticket);
  }
  return byColumn;
}

function columnFor(
  status: BoardStatusInfo,
  tickets: BoardTicketSummary[],
  rules: readonly BoardRuleView[],
): BoardColumn {
  return {
    id: status.id,
    status: status.id,
    label: statusLabel(status),
    tone: statusTone(status),
    worker: workerLineForStatus(status.id, rules),
    fallback: false,
    tickets,
  };
}

/**
 * Groups the phase's tickets into the four design lanes, honouring the board's status list.
 * Blocked tickets move to their return status' column; unknown return statuses get one Blocked
 * column at the end of Build.
 */
export function buildBoardLanes(
  statuses: readonly BoardStatusInfo[],
  rules: readonly BoardRuleView[],
  tickets: readonly BoardTicketSummary[],
  options: BuildLanesOptions = {},
): BoardLane[] {
  const hideEmpty = options.hideEmpty ?? true;
  const known = statusMap(statuses, tickets);
  const byColumn = groupTickets(tickets, known);
  const needsBlockedColumn = (byColumn.get(BLOCKED_STATUS)?.length ?? 0) > 0;

  const lanes: BoardLane[] = BOARD_LANES.map((lane) => {
    const laneStatuses = lane.statuses
      .filter((status) => known.has(status))
      .map((status) => known.get(status)!);
    const columns = laneStatuses.map((status) => columnFor(status, byColumn.get(status.id) ?? [], rules));
    if (lane.id === 'build' && needsBlockedColumn) {
      columns.push({
        id: BLOCKED_STATUS,
        status: BLOCKED_STATUS,
        label: BLOCKED_COLUMN_LABEL,
        tone: 'amber',
        worker: workerLineForStatus(BLOCKED_STATUS, rules),
        fallback: true,
        tickets: byColumn.get(BLOCKED_STATUS) ?? [],
      });
    }
    return finishLane(lane, columns, hideEmpty);
  });

  const otherStatuses = Array.from(known.values()).filter((status) => laneForStatus(status.id) === null);
  if (otherStatuses.length > 0) {
    const columns = otherStatuses.map((status) => columnFor(status, byColumn.get(status.id) ?? [], rules));
    lanes.push(finishLane(OTHER_LANE, columns, hideEmpty));
  }

  return lanes;
}

function finishLane(lane: LaneDefinition, columns: BoardColumn[], hideEmpty: boolean): BoardLane {
  const total = columns.reduce((count, column) => count + column.tickets.length, 0);
  if (!hideEmpty) return { id: lane.id, name: lane.name, total, columns, hiddenColumns: [] };
  return {
    id: lane.id,
    name: lane.name,
    total,
    columns: columns.filter((column) => column.tickets.length > 0),
    hiddenColumns: columns.filter((column) => column.tickets.length === 0),
  };
}

/** "1 ticket" / "3 tickets" for a lane header. */
export function laneCountLabel(total: number): string {
  return `${total} ${total === 1 ? 'ticket' : 'tickets'}`;
}

/** "1 empty hidden: Unpack ready" for the dashed placeholder at the end of a lane. */
export function hiddenColumnsLabel(columns: readonly BoardColumn[]): string | null {
  if (columns.length === 0) return null;
  return `${columns.length} empty hidden: ${columns.map((column) => column.label).join(', ')}`;
}
