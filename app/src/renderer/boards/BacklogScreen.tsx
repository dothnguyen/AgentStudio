import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import type { ManagementApi, Workspace } from '../api';
import { BoardErrorCard, LoadingSkeleton } from './CurrentPhaseScreen';
import { BacklogToolbar } from './BacklogToolbar';
import { activeFilterCount, DEFAULT_BACKLOG_FILTERS, filterBacklogTickets } from './backlogFilters';
import { BacklogGroupCard } from './BacklogGroupCard';
import { buildBacklogGroups } from './backlogModel';
import { useBacklogData } from './useBacklogData';

export function BacklogScreen({ workspace, management, refreshMs, onOpenTicket }: { workspace: Workspace; management: ManagementApi; refreshMs?: number; onOpenTicket?: (key: string) => void }): JSX.Element {
  const board = useBacklogData(management, workspace.id, refreshMs);
  const [filters, setFilters] = useState(DEFAULT_BACKLOG_FILTERS);
  const [query, setQuery] = useState('');
  useEffect(() => { const timer = window.setTimeout(() => setQuery(filters.query), 150); return () => window.clearTimeout(timer); }, [filters.query]);
  const active = activeFilterCount(filters) > 0;
  const data = board.data;
  const filtered = data ? filterBacklogTickets(data.tickets.tickets, { ...filters, query: filters.query ? query : '' }) : [];
  const totals = data ? new Map(buildBacklogGroups(data.phases, data.tickets).map(group => [group.slug, group.counts.total])) : new Map();
  const groups = data ? buildBacklogGroups(data.phases, { ...data.tickets, tickets: filtered }, filters.sort).filter(group => !active || group.counts.total > 0) : [];
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
              <span className="boards-backlog-count">{board.data?.tickets.tickets.length ?? 0} tickets</span>
            </header>
            {data && <BacklogToolbar filters={filters} onChange={setFilters} settings={data.settings} phases={data.phases} tickets={data.tickets.tickets} resultCount={filtered.length} />}
            {active && filtered.length === 0 && <div className="boards-no-match"><p>No tickets match these filters</p><button type="button" onClick={() => setFilters({ ...DEFAULT_BACKLOG_FILTERS, sort: filters.sort })}>Clear filters</button></div>}
            {!active && board.data?.tickets.tickets.length === 0 && <section className="boards-state-card"><h2>No tickets yet</h2></section>}
            <div className="boards-backlog-groups" data-testid="backlog-body">{data && groups.map((group) => <BacklogGroupCard key={group.slug ?? "no-phase"} group={group} total={active ? totals.get(group.slug) : undefined} settings={data.settings} onOpenTicket={onOpenTicket} />)}</div>
          </>}
    </div>
  );
}
