import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import type { BoardTicketList, ManagementApi, Workspace } from '../api';
import { BoardErrorCard, LoadingSkeleton } from './CurrentPhaseScreen';
import { BacklogToolbar } from './BacklogToolbar';
import { activeFilterCount, DEFAULT_BACKLOG_FILTERS, filterBacklogTickets, type BacklogFilters } from './backlogFilters';
import { BacklogGroupCard } from './BacklogGroupCard';
import { buildBacklogGroups } from './backlogModel';
import { useBacklogData } from './useBacklogData';

export function BacklogScreen({ workspace, management, refreshMs, onOpenTicket, onOpenPhases, filters: controlledFilters, onFiltersChange, onTicketCount }: { workspace: Workspace; management: ManagementApi; refreshMs?: number; onOpenTicket?: (key: string) => void; onOpenPhases?: () => void; filters?: BacklogFilters; onFiltersChange?: (filters: BacklogFilters) => void; onTicketCount?: (count: number) => void }): JSX.Element {
  const board = useBacklogData(management, workspace.id, refreshMs);
  const notifyChanged = useCallback(() => { window.dispatchEvent(new Event('board-changed')); }, []);
  const [localFilters, setLocalFilters] = useState(DEFAULT_BACKLOG_FILTERS);
  const filters = controlledFilters ?? localFilters;
  const setFilters = onFiltersChange ?? setLocalFilters;
  const [query, setQuery] = useState(filters.query);
  useEffect(() => { const timer = window.setTimeout(() => setQuery(filters.query), 150); return () => window.clearTimeout(timer); }, [filters.query]);
  const active = activeFilterCount(filters) > 0;
  const phaseFiltered = filters.phases.length > 0;
  useEffect(() => {
    if (board.data) for (const slug of filters.phases) {
      if (board.data.phases.phases.some(phase => phase.slug === slug)) void board.loadPhase(slug);
    }
  }, [board.data, board.loadPhase, filters.phases]);
  const data = board.data;
  const knownPhases = new Set(data?.phases.phases.map(phase => phase.slug) ?? []);
  const loaded = Object.entries(board.phaseData).flatMap(([slug, phase]) =>
    (phase.tickets?.tickets ?? []).filter(ticket => slug !== '' || ticket.phase == null || !knownPhases.has(ticket.phase)));
  const firstList = Object.values(board.phaseData).find(phase => phase.tickets)?.tickets;
  const tickets: BoardTicketList = firstList ? { ...firstList, tickets: loaded } : { workspace: workspace.id, statuses: data?.settings.statuses.map(status => status.id) ?? [], status: null, workflowStatus: null, phase: null, tickets: [] };
  const filtered = filterBacklogTickets(loaded, { ...filters, query: filters.query ? query : '' });
  const unassignedTotal = data?.phases.unassignedTicketCount ?? loaded.filter(ticket => ticket.phase == null || !knownPhases.has(ticket.phase)).length;
  const total = (data?.phases.phases.reduce((sum, phase) => sum + phase.ticketCount, 0) ?? 0) + unassignedTotal;
  useEffect(() => { if (board.data) onTicketCount?.(total); }, [board.data, onTicketCount, total]);
  const groups = data ? buildBacklogGroups(data.phases, { ...tickets, tickets: filtered }, filters.sort).map(group => {
    if (group.slug === null) return group;
    const phase = data.phases.phases.find(item => item.slug === group.slug)!;
    const matched = group.counts.total;
    return { ...group, counts: { ...group.counts, total: active && board.phaseData[phase.slug]?.state === 'ready' ? matched : phase.ticketCount, done: (phase.counts.done ?? 0) + (phase.counts.closed ?? 0), blocked: phase.counts.blocked ?? 0 } };
  }) : [];
  if (data && !groups.some(group => group.slug === null)) groups.push({
    slug: null, name: 'No phase', description: null, current: false, closed: false, tickets: [],
    counts: { total: 0, done: 0, working: 0, blocked: 0, waiting: 0, ready: 0 },
  });
  const visibleGroups = phaseFiltered ? groups.filter(group => group.slug !== null && filters.phases.includes(group.slug)) : groups;
  const noPhase = groups.find(group => group.slug === null);
  if (noPhase && !active) noPhase.counts.total = unassignedTotal;
  return (
    <div className="boards-current-screen" data-section="boards/backlog">
      <nav className="boards-breadcrumb" aria-label="Breadcrumb">
        <span>Boards</span><span aria-hidden="true">/</span><span aria-current="page">Backlog</span>
      </nav>
      {board.state === 'loading' ? <><h1 className="visually-hidden">Backlog</h1><LoadingSkeleton label="Loading the backlog…" /></> :
        board.state === 'error' ? <><h1 className="visually-hidden">Backlog</h1><BoardErrorCard title="Could not load the backlog" error={board.error} onRetry={() => { void board.reload(); }} /></> :
          <>
            <header className="boards-phase-header">
              <div className="boards-phase-summary">
                <div className="boards-phase-title"><h1>Backlog</h1></div>
                <p className="boards-phase-description">Every ticket on the board, grouped by phase.</p>
              </div>
              <span className="boards-backlog-count">{total} tickets</span>
            </header>
            {board.refreshError && <div className="boards-refresh-error" role="alert"><span>Could not refresh the backlog. The last loaded view is still shown. <code className="entity-id">{board.refreshError.code}</code>: {board.refreshError.message}</span><button type="button" onClick={() => { void board.reload(); }}>Retry</button></div>}
            {data && <BacklogToolbar filters={filters} onChange={setFilters} settings={data.settings} phases={data.phases} tickets={loaded} resultCount={filtered.length} />}
            {active && filtered.length === 0 && Object.values(board.phaseData).every(phase => phase.state !== 'loading') && (!phaseFiltered || visibleGroups.every(group => board.phaseData[group.slug!]?.state === 'ready')) && <div className="boards-no-match"><p>No tickets match these filters</p><button type="button" onClick={() => setFilters({ ...DEFAULT_BACKLOG_FILTERS, sort: filters.sort })}>Clear filters</button></div>}
            {!active && total === 0 && <section className="boards-state-card"><h2>No tickets yet</h2></section>}
            <div className="boards-backlog-groups" data-testid="backlog-body">{data && visibleGroups.map((group) => <BacklogGroupCard key={`${phaseFiltered ? 'filtered' : 'default'}-${group.slug ?? 'no-phase'}`} group={group} initiallyExpanded={phaseFiltered || group.current} total={active ? group.slug === null ? unassignedTotal : data.phases.phases.find(phase => phase.slug === group.slug)?.ticketCount : undefined} phaseState={board.phaseData[group.slug ?? '']?.state} loaded={board.phaseData[group.slug ?? '']?.tickets != null} error={board.phaseData[group.slug ?? '']?.error} onExpand={() => { void board.loadPhase(group.slug ?? ''); }} onRetry={() => { void board.loadPhase(group.slug ?? '', true); }} settings={data.settings} phases={data.phases.phases} management={management} workspaceId={workspace.id} onChanged={(ticket, changes) => { board.reconcile(ticket, changes); notifyChanged(); }} onOpenTicket={onOpenTicket} onOpenPhases={onOpenPhases} />)}</div>
          </>}
    </div>
  );
}
