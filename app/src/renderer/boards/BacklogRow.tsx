import { memo } from 'react';
import type { JSX } from 'react';
import type { BoardRuleView, BoardTicketSummary } from '../api';
import { statusLabel, statusTone, type BoardStatusInfo } from './boardLaneModel';
import { agentInitials, ticketActivityChip, TICKET_CHIP_TONE_CLASS } from './ticketCardModel';

interface Props {
  ticket: BoardTicketSummary;
  status: BoardStatusInfo;
  rules: readonly BoardRuleView[];
  onOpenTicket?: (key: string) => void;
}

function relativeTime(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '—';
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function Row({ ticket, status, rules, onOpenTicket }: Props): JSX.Element {
  const chip = ticketActivityChip(ticket, rules);
  const agent = ticket.activity.agent?.trim() ?? '';
  const date = new Date(ticket.updatedAt);
  const open = (): void => { onOpenTicket?.(ticket.key); };
  return <button type="button" className="boards-backlog-row" aria-label={`Open ${ticket.key}: ${ticket.title}`} onClick={open}>
    <span className="boards-ticket-key boards-backlog-key">{ticket.key}</span>
    <span className="boards-backlog-title" title={ticket.title}>{ticket.title}</span>
    <span className="boards-backlog-status"><span className={`boards-status-dot boards-status-dot-${statusTone(status)}`} aria-hidden="true" />{statusLabel(status)}</span>
    <span className={`boards-ticket-chip ${TICKET_CHIP_TONE_CLASS[chip.tone]}`}><span className="boards-ticket-chip-dot" aria-hidden="true" />{chip.label}</span>
    {ticket.priority !== 100 && <span className="boards-ticket-priority">Priority {ticket.priority}</span>}
    {agent && <span className="boards-ticket-owner"><span className="boards-ticket-avatar" aria-hidden="true">{agentInitials(agent)}</span><span className="boards-ticket-owner-name">{agent}</span></span>}
    <time className="boards-backlog-time" dateTime={ticket.updatedAt} title={Number.isNaN(date.getTime()) ? '' : date.toLocaleString()}>{relativeTime(ticket.updatedAt)}</time>
  </button>;
}

// Polling creates new objects; compare their contents so unchanged rows can be reused.
export const BacklogRow = memo(Row, (a, b) => a.onOpenTicket === b.onOpenTicket
  && a.ticket.key === b.ticket.key && a.ticket.updatedAt === b.ticket.updatedAt
  && JSON.stringify([a.ticket, a.status, a.rules]) === JSON.stringify([b.ticket, b.status, b.rules]));
