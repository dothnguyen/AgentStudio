import { useState, type JSX } from 'react';
import type { BoardRuleView, BoardTicketSummary } from '../api';
import {
  BOARD_CARD_LIMIT,
  buildBoardLanes,
  hiddenColumnsLabel,
  laneCountLabel,
  type BoardColumn,
  type BoardLane,
  type BoardStatusInfo,
} from './boardLaneModel';
import { TicketCard } from './TicketCard';

export interface BoardLanesProps {
  statuses: readonly BoardStatusInfo[];
  rules: readonly BoardRuleView[];
  tickets: readonly BoardTicketSummary[];
  /** Empty columns are hidden by default; the toolbar exposes this as a switch. */
  hideEmpty?: boolean;
  /** The toolbar filter predicate; non-matching tickets are left out of cards and counts. */
  matches?(ticket: BoardTicketSummary): boolean;
  /** Opens the ticket page; omitted until the ticket-page story wires it in. */
  onOpenTicket?(key: string): void;
}

function Chevron({ up }: { up: boolean }): JSX.Element {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={up ? 'M9 6l6 6-6 6' : 'M6 9l6 6 6-6'} />
    </svg>
  );
}

function WorkerIcon(): JSX.Element {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <rect x="5" y="8" width="14" height="11" rx="3" />
      <path d="M12 4v4M9 13h.01M15 13h.01" />
    </svg>
  );
}

function BoardColumnView(props: {
  column: BoardColumn;
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
        <h3 className="boards-column-name" title={column.label}>{column.label}</h3>
        <span className="boards-column-count">{column.tickets.length}</span>
      </div>
      {column.worker !== null && (
        <span className="boards-column-worker">
          <WorkerIcon />
          {column.worker}
        </span>
      )}
      <ul className="boards-column-cards">
        {shown.map((ticket) => (
          <li key={ticket.id}>
            <TicketCard ticket={ticket} rules={props.rules} onOpenTicket={props.onOpenTicket} />
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

function BoardLaneView(props: {
  lane: BoardLane;
  rules: readonly BoardRuleView[];
  onOpenTicket?: (key: string) => void;
}): JSX.Element {
  const { lane } = props;
  const [collapsed, setCollapsed] = useState(lane.id === 'finished');
  const hiddenText = hiddenColumnsLabel(lane.hiddenColumns);
  return (
    <section className="boards-lane" aria-label={`${lane.name} lane`}>
      <div className="boards-lane-header">
        <h2 className="boards-lane-name">
          {lane.name}
          <span className="boards-lane-count">{laneCountLabel(lane.total)}</span>
        </h2>
        <button
          type="button"
          className="boards-lane-toggle"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${lane.name} lane`}
          onClick={() => { setCollapsed((value) => !value); }}
        >
          <Chevron up={collapsed} />
        </button>
      </div>
      {!collapsed && (
        <div className="boards-lane-columns">
          {lane.columns.map((column) => (
            <BoardColumnView key={column.id} column={column} rules={props.rules} onOpenTicket={props.onOpenTicket} />
          ))}
          {hiddenText !== null && <span className="boards-lane-hidden">{hiddenText}</span>}
        </div>
      )}
    </section>
  );
}

/** The Current Phase kanban: lanes, columns and cards. */
export function BoardLanes(props: BoardLanesProps): JSX.Element {
  const lanes = buildBoardLanes(props.statuses, props.rules, props.tickets, {
    hideEmpty: props.hideEmpty,
    matches: props.matches,
  });
  return (
    <div className="boards-board" role="region" aria-label="Board columns (scrollable)" tabIndex={0}>
      <div className="boards-board-lanes">
        {lanes.map((lane) => (
          <BoardLaneView key={lane.id} lane={lane} rules={props.rules} onOpenTicket={props.onOpenTicket} />
        ))}
      </div>
    </div>
  );
}
