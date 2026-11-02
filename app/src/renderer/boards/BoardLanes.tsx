import { useState, type JSX } from 'react';
import type { BoardRuleView, BoardTicketSummary } from '../api';
import {
  BOARD_CARD_LIMIT,
  buildBoardLanes,
  type BoardColumn,
  type BoardStatusInfo,
} from './boardLaneModel';
import { TicketCard } from './TicketCard';

export interface BoardLanesProps {
  statuses: readonly BoardStatusInfo[];
  workflowStatuses?: readonly BoardStatusInfo[];
  rules: readonly BoardRuleView[];
  tickets: readonly BoardTicketSummary[];
  /** Empty columns are hidden by default; the toolbar exposes this as a switch. */
  hideEmpty?: boolean;
  /** The toolbar filter predicate; non-matching tickets are left out of cards and counts. */
  matches?(ticket: BoardTicketSummary): boolean;
  /** Opens the ticket page; omitted until the ticket-page story wires it in. */
  onOpenTicket?(key: string): void;
}

function BoardColumnView(props: {
  column: BoardColumn;
  workflowStatuses?: readonly BoardStatusInfo[];
  rules: readonly BoardRuleView[];
  onOpenTicket?: (key: string) => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const { column } = props;
  const shown = expanded ? column.tickets : column.tickets.slice(0, BOARD_CARD_LIMIT);
  const remaining = column.tickets.length - shown.length;
  return (
    <section className="boards-column" aria-label={`${column.label} column`} data-status={column.id}>
      <div className="boards-column-header">
        <span className={`boards-status-dot boards-status-dot-${column.tone}`} aria-hidden="true" />
        <h2 className="boards-column-name" title={column.label}>{column.label}</h2>
        <span className="boards-column-count">{column.tickets.length}</span>
      </div>
      <ul className="boards-column-cards">
        {shown.map((ticket) => (
          <li key={ticket.id}>
            <TicketCard ticket={ticket} rules={props.rules} workflowStatuses={props.workflowStatuses} onOpenTicket={props.onOpenTicket} />
          </li>
        ))}
      </ul>
      {column.tickets.length > BOARD_CARD_LIMIT && (
        <button
          type="button"
          className="boards-column-more"
          aria-expanded={expanded}
          onClick={() => { setExpanded((value) => !value); }}
        >
          {expanded ? 'Show fewer' : `Show ${remaining} more`}
        </button>
      )}
      {column.tickets.length === 0 && <span className="boards-column-empty">No tickets</span>}
    </section>
  );
}

/** The Current Phase kanban: one row of columns and cards. */
export function BoardLanes(props: BoardLanesProps): JSX.Element {
  const columns = buildBoardLanes(props.tickets, {
    hideEmpty: props.hideEmpty,
    matches: props.matches,
  });
  return (
    <div className="boards-board" role="region" aria-label="Board columns (scrollable)" tabIndex={0}>
      <div className="boards-board-lanes">
        {columns.map((column) => (
          <BoardColumnView key={column.id} column={column} rules={props.rules} workflowStatuses={props.workflowStatuses} onOpenTicket={props.onOpenTicket} />
        ))}
      </div>
    </div>
  );
}
