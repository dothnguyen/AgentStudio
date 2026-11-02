import type { JSX } from 'react';
import type { BoardRuleView, BoardTicketSummary } from '../api';
import type { BoardStatusInfo } from './boardLaneModel';
import {
  workflowStatusChip,
  agentInitials,
  blockedReasonLine,
  TICKET_CHIP_TONE_CLASS,
  ticketActivityChip,
} from './ticketCardModel';

export interface TicketCardProps {
  ticket: BoardTicketSummary;
  /** Board rules supply the round limit for the "Working · round X/Y" chip. */
  rules?: readonly BoardRuleView[];
  workflowStatuses?: readonly BoardStatusInfo[];
  /** Opens the ticket page at boards/ticket/:key. */
  onOpenTicket?(key: string): void;
}

/** One kanban card: key, title, optional priority and blocked reason, activity and owner. */
export function TicketCard(props: TicketCardProps): JSX.Element {
  const { ticket, rules = [], onOpenTicket } = props;
  const chip = ticketActivityChip(ticket, rules);
  const tone = chip.tone;
  const workflow = workflowStatusChip(ticket.workflowStatus, props.workflowStatuses ?? [], rules);
  const agent = ticket.activity.agent?.trim() ?? '';
  const reason = tone === 'blocked' ? blockedReasonLine(ticket.blockedReason) : null;
  const open = (): void => { onOpenTicket?.(ticket.key); };

  return (
    <button
      type="button"
      className="boards-ticket-card"
      data-ticket-key={ticket.key}
      data-activity={tone}
      aria-label={`Open ${ticket.key}: ${ticket.title}`}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          open();
        }
      }}
    >
      <span className="boards-ticket-head">
        <span className="boards-ticket-key">{ticket.key}</span>
        {ticket.priority !== 100 && (
          <span className="boards-ticket-priority">Priority {ticket.priority}</span>
        )}
      </span>
      <span className="boards-ticket-title">{ticket.title}</span>
      {reason !== null && <span className="boards-ticket-reason">{reason}</span>}
      <span className="boards-ticket-footer">
        <span className={`boards-ticket-chip ${TICKET_CHIP_TONE_CLASS[chip.tone]}`} data-chip={chip.tone}>
          <span className="boards-ticket-chip-dot" aria-hidden="true" />
          {chip.label}
        </span>
        <span className={`boards-ticket-chip boards-workflow-chip-${workflow.tone}`} data-workflow-tone={workflow.tone} title={workflow.tooltip}>{workflow.label}</span>
        {agent !== '' && (
          <span className="boards-ticket-owner">
            <span className="boards-ticket-avatar" aria-hidden="true">{agentInitials(agent)}</span>
            <span className="boards-ticket-owner-name">{agent}</span>
          </span>
        )}
      </span>
    </button>
  );
}
