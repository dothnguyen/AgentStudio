import type { BoardTicket, BoardTicketDetail, BoardTicketSummary } from '../api';
import {
  statusLabel,
  statusTone,
  type BoardStatusInfo,
  type BoardStatusTone,
} from './boardLanes';

export interface TicketStatusChip {
  /** The status shown on the page; a blocked ticket shows the status it returns to. */
  id: string;
  label: string;
  tone: BoardStatusTone;
}

function statusInfo(id: string, statuses: readonly BoardStatusInfo[]): BoardStatusInfo {
  return statuses.find((status) => status.id === id) ?? { id, name: null, kind: null };
}

/** The visible status of a ticket: blocked tickets show the column they return to. */
export function ticketStatusId(ticket: Pick<BoardTicket, 'status' | 'returnStatus'>): string {
  if (ticket.status !== 'blocked') return ticket.status;
  const returnStatus = ticket.returnStatus?.trim() ?? '';
  return returnStatus === '' ? ticket.status : returnStatus;
}

/** The page's status chip. Board display names are honoured when the settings read succeeded. */
export function ticketStatusChip(
  ticket: Pick<BoardTicket, 'status' | 'returnStatus'>,
  statuses: readonly BoardStatusInfo[] = [],
): TicketStatusChip {
  const id = ticketStatusId(ticket);
  const info = statusInfo(id, statuses);
  return { id, label: statusLabel(info), tone: statusTone(info) };
}

const FINISHED_STATUSES: readonly string[] = ['done', 'close'];

/** Open dependencies of a ticket detail, in the order the links read. */
export function openDependencyKeys(detail: BoardTicketDetail): string[] {
  return detail.links.dependsOn
    .filter((link) => link.status === null || !FINISHED_STATUSES.includes(link.status))
    .map((link) => link.key);
}

/**
 * The ticket page's ticket shape for the card activity mapping: the detail carries the dependency
 * links, while `ticket` itself only has the activity summary.
 */
export function ticketActivitySummary(detail: BoardTicketDetail): BoardTicketSummary {
  const { body: _body, ...ticket } = detail.ticket;
  return {
    ...ticket,
    dependsOn: detail.dependsOn,
    openDependsOn: openDependencyKeys(detail),
  };
}

/** The human name of the status a blocked ticket returns to, or null when it is unknown. */
export function blockedReturnLabel(
  ticket: Pick<BoardTicket, 'status' | 'returnStatus'>,
  statuses: readonly BoardStatusInfo[] = [],
): string | null {
  const returnStatus = ticket.returnStatus?.trim() ?? '';
  if (ticket.status !== 'blocked' || returnStatus === '') return null;
  return statusLabel(statusInfo(returnStatus, statuses));
}
