import { useState } from 'react';
import type { JSX } from 'react';
import type { BoardSettings } from '../api';
import type { BacklogGroup } from './backlogModel';
import { BacklogRow } from './BacklogRow';

export function BacklogGroupCard({ group, total, settings, onOpenTicket }: { group: BacklogGroup; total?: number; settings: BoardSettings; onOpenTicket?: (key: string) => void }): JSX.Element {
  const [expanded, setExpanded] = useState(group.current || !group.closed);
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? group.tickets : group.tickets.slice(0, 50);
  return <section className="boards-backlog-group">
    <button type="button" className="boards-backlog-group-header" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
      <span aria-hidden="true">{expanded ? '▾' : '▸'}</span><strong>{group.name}</strong>
      {group.current && <span className="boards-phase-pill">Current</span>}
      {group.closed && <span className="boards-phase-pill boards-backlog-closed">Closed</span>}
      <span className="boards-backlog-counts">{total !== undefined && total !== group.counts.total ? `${group.counts.total} of ${total}` : group.counts.total} tickets · {group.counts.done} done{group.counts.blocked > 0 && <span className="boards-backlog-blocked"> · {group.counts.blocked} blocked</span>}</span>
    </button>
    {expanded && <div className="boards-backlog-group-body">
      {visible.length === 0 ? <p className="boards-backlog-empty">No tickets in this phase.</p> : visible.map((ticket) => <BacklogRow key={ticket.key} ticket={ticket} status={settings.statuses.find((status) => status.id === ticket.status) ?? { id: ticket.status }} rules={settings.rules} onOpenTicket={onOpenTicket} />)}
      {!showAll && group.tickets.length > 50 && <button type="button" className="boards-backlog-more" onClick={() => setShowAll(true)}>Show {group.tickets.length - 50} more</button>}
    </div>}
  </section>;
}
