import { useId, useState } from 'react';
import type { JSX } from 'react';
import type { ApiError, BoardPhase, BoardSettings, BoardTicketSummary, ManagementApi } from '../api';
import type { BacklogGroup } from './backlogModel';
import { BoardErrorCard } from './CurrentPhaseScreen';
import { BacklogRow } from './BacklogRow';

export function BacklogGroupCard({ group, total, settings, onOpenTicket, onOpenPhases, onNewTicket, phaseState, error, loaded, onExpand, onRetry, initiallyExpanded, phases, management, workspaceId, onChanged }: { initiallyExpanded: boolean; phaseState?: 'loading' | 'ready' | 'error'; error?: ApiError | null; loaded?: boolean; onExpand(): void; onRetry(): void; group: BacklogGroup; total?: number; settings: BoardSettings; phases: BoardPhase[]; management: ManagementApi; workspaceId: string; onChanged(ticket: BoardTicketSummary, changes: Partial<BoardTicketSummary>): void; onOpenTicket?: (key: string) => void; onOpenPhases?: () => void; onNewTicket?: (phase: string) => void; onMoveToTodo?: (key: string) => void }): JSX.Element {
  const bodyId = useId();
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? group.tickets : group.tickets.slice(0, 50);
  const hasRows = loaded === true;
  return <section className="boards-backlog-group">
    <div className="boards-backlog-group-heading"><button type="button" className="boards-backlog-group-header" aria-expanded={expanded} aria-controls={bodyId} onClick={() => { if (!expanded) onExpand(); setExpanded(!expanded); }}>
      <span aria-hidden="true">{expanded ? '▾' : '▸'}</span><strong>{group.name}</strong>
      {group.current && <span className="boards-phase-pill">Current</span>}
      {group.closed && <span className="boards-phase-pill boards-backlog-closed">Closed</span>}
      <span className="boards-backlog-counts">{total !== undefined && total !== group.counts.total ? `${group.counts.total} of ${total}` : group.counts.total} tickets · {group.counts.done} done{group.counts.blocked > 0 && <span className="boards-backlog-blocked"> · {group.counts.blocked} blocked</span>}</span>
    </button>{group.slug !== null && onNewTicket && <button type="button" className="boards-new-ticket boards-backlog-new" aria-label={`New ticket in ${group.name}`} onClick={() => onNewTicket(group.slug!)}>New ticket</button>}{onOpenPhases && <button type="button" className="boards-backlog-progress-link" onClick={onOpenPhases}>Phase progress</button>}</div>
    <div id={bodyId} className="boards-backlog-group-body" hidden={!expanded}>
      {expanded && <>
      {!hasRows && (phaseState === 'loading' || !phaseState) ? <p role="status">Loading tickets…</p> : !hasRows && phaseState === 'error' ? <BoardErrorCard title="Could not load phase tickets" error={error ?? null} onRetry={onRetry} /> : <>
        {phaseState === 'error' && <div className="boards-refresh-error" role="alert"><span>Could not refresh these tickets. The last loaded tickets are still shown. {error && <><code className="entity-id">{error.code}</code>: {error.message}</>}</span><button type="button" onClick={onRetry}>Retry</button></div>}
        {visible.length === 0 ? <p className="boards-backlog-empty">No tickets in this phase.</p> : visible.map((ticket) => <BacklogRow key={ticket.key} ticket={ticket} status={settings.statuses.find((status) => status.id === ticket.status) ?? { id: ticket.status }} workflowStatus={settings.workflowStatuses.find((status) => status.id === ticket.workflowStatus) ?? { id: ticket.workflowStatus }} rules={settings.rules} onOpenTicket={onOpenTicket} phases={phases} settings={settings} management={management} workspaceId={workspaceId} onChanged={onChanged} />)}
        {!showAll && group.tickets.length > 50 && <button type="button" className="boards-backlog-more" onClick={() => setShowAll(true)}>Show {group.tickets.length - 50} more</button>}
      </>}
      </>}
    </div>
  </section>;
}
