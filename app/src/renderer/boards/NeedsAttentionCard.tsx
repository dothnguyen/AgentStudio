import { useState, type JSX } from 'react';
import { ATTENTION_ROW_LIMIT, type AttentionRow } from './attentionModel';

export interface NeedsAttentionCardProps {
  rows: readonly AttentionRow[];
  counts?: { approval: number; question: number; blocked: number; paused: number };
  /** Opens the ticket page at boards/ticket/:key. */
  onOpenTicket?(key: string): void;
}

function WarningIcon(): JSX.Element {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M12 9v4M12 17h.01" />
      <path d="M10.3 3.9L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    </svg>
  );
}

/** The amber card above the toolbar: blocked tickets, command approvals and paused runs. */
export function NeedsAttentionCard(props: NeedsAttentionCardProps): JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  const { rows } = props;
  if (rows.length === 0 && (!props.counts || !Object.values(props.counts).some(Boolean))) return null;

  const shown = expanded ? rows : rows.slice(0, ATTENTION_ROW_LIMIT);
  const remaining = rows.length - shown.length;

  return (
    <section className="boards-attention" aria-labelledby="boards-attention-title">
      <div className="boards-attention-header">
        <h2 id="boards-attention-title" className="boards-attention-title">
          <WarningIcon />
          Needs attention · {rows.length}
        </h2>
      </div>
      {props.counts && <div className="boards-attention-counts"><span>{props.counts.approval} waiting for approval</span><span>{props.counts.question} needs an answer</span><span>{props.counts.blocked} blocked</span><span className="boards-attention-time">{props.counts.paused} paused, will be picked up again</span></div>}
      <ul className="boards-attention-list">
        {shown.map((row) => (
          <li className="boards-attention-row" key={row.id} data-source={row.source}>
            <span className="boards-attention-key">{row.key}</span>
            <span className="boards-attention-text">
              <span className="boards-attention-row-title">{row.title}</span>
              <span className="boards-attention-reason">{row.reason}</span>
            </span>
            <button
              type="button"
              className="boards-attention-open"
              aria-label={`Open ${row.key}`}
              disabled={row.ticketKey === null}
              onClick={() => {
                if (row.ticketKey !== null) props.onOpenTicket?.(row.ticketKey);
              }}
            >
              Open
            </button>
          </li>
        ))}
      </ul>
      {rows.length > ATTENTION_ROW_LIMIT && (
        <div className="boards-attention-footer">
          <button
            type="button"
            className="boards-attention-more"
            aria-expanded={expanded}
            onClick={() => { setExpanded((value) => !value); }}
          >
            {expanded ? 'Show fewer' : `Show ${remaining} more`}
          </button>
        </div>
      )}
    </section>
  );
}
