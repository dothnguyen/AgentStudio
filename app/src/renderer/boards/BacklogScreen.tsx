import type { JSX } from 'react';
import type { ManagementApi, Workspace } from '../api';
import { BoardErrorCard, LoadingSkeleton } from './CurrentPhaseScreen';
import { useBacklogData } from './useBacklogData';

export function BacklogScreen({ workspace, management, refreshMs }: { workspace: Workspace; management: ManagementApi; refreshMs?: number }): JSX.Element {
  const board = useBacklogData(management, workspace.id, refreshMs);
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
            {board.data?.tickets.tickets.length === 0 && <section className="boards-state-card"><h2>No tickets yet</h2></section>}
            <div data-testid="backlog-body" />
          </>}
    </div>
  );
}
