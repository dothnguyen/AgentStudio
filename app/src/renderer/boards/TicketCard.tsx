import { useState, type JSX } from 'react';
import type { BoardRuleView, BoardTicketSummary } from '../api';
import type { BoardStatusInfo } from './boardLaneModel';
import {
  ticketAttention, elapsedAttention,
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
  /** Opens the move dialog; omitted on read-only board copies. */
  onMove?(ticket: BoardTicketSummary): void;
  onApprove?(input: { workflowRunId: string; stage: string; approve: boolean; note?: string }): Promise<void>;
}

/** One kanban card: key, title, optional priority and blocked reason, activity and owner. */
export function TicketCard(props: TicketCardProps): JSX.Element {
  const { ticket, rules = [], onOpenTicket } = props;
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const attention = ticketAttention(ticket);
  const decide = async (approve: boolean): Promise<void> => {
    if (!ticket.waitingApproval || !props.onApprove || busy) return;
    setBusy(true); setError('');
    try {
      await props.onApprove({ workflowRunId: ticket.waitingApproval.workflowRunId, stage: ticket.waitingApproval.stage, approve, ...(!approve && note.trim() ? { note } : {}) });
      setRejecting(false);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not submit decision.'); }
    finally { setBusy(false); }
  };
  const chip = ticketActivityChip(ticket, rules);
  const tone = chip.tone;
  const workflow = workflowStatusChip(ticket.workflowStatus, props.workflowStatuses ?? [], rules);
  const agent = ticket.activity.agent?.trim() ?? '';
  const reason = tone === 'blocked' ? blockedReasonLine(ticket.blockedReason) : null;
  const open = (): void => { onOpenTicket?.(ticket.key); };
  const move = (): void => { props.onMove?.(ticket); };

  if (attention) return (
    <article className="boards-ticket-card boards-ticket-attention" data-attention={attention.kind}>
      <button type="button" className="boards-ticket-attention-open" onClick={open} aria-label={`Open ${ticket.key}: ${ticket.title}`}><span className="boards-ticket-key">{ticket.key}</span><span className="boards-ticket-title">{ticket.title}</span></button>
      <span><span className={`boards-attention-chip boards-attention-chip-${attention.kind}`}>{attention.label}</span> <span className="boards-attention-time">{elapsedAttention(attention.since)}</span></span>
      <span className="boards-ticket-attention-text">{attention.text}</span>
      {attention.kind === 'approval' && <span className="boards-ticket-actions"><button type="button" disabled={busy || !props.onApprove} onClick={() => { void decide(true); }}>Approve</button><button type="button" disabled={busy || !props.onApprove} onClick={() => setRejecting(true)}>Reject…</button></span>}
      {attention.kind === 'question' && <span><button type="button" onClick={open}>Answer…</button></span>}
      {rejecting && <div role="dialog" aria-label="Reject approval" className="boards-reject-dialog"><label>Note (optional)<textarea value={note} onChange={event => setNote(event.target.value)} /></label><button type="button" disabled={busy} onClick={() => setRejecting(false)}>Cancel</button><button type="button" disabled={busy} onClick={() => { void decide(false); }}>Reject</button></div>}
      {props.onMove !== undefined && <span><button type="button" className="boards-ticket-move" aria-label={`Move ${ticket.key}`} aria-haspopup="dialog" onClick={move}>Move</button></span>}
      {error && <span role="alert">{error}</span>}
    </article>
  );

  const card = (
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

  if (props.onMove === undefined) return card;
  return (
    <div className="boards-ticket-card-shell">
      {card}
      <button type="button" className="boards-ticket-move" aria-label={`Move ${ticket.key}`} aria-haspopup="dialog" onClick={move}>Move</button>
    </div>
  );
}
