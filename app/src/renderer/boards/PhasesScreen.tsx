import type { JSX } from 'react';
import type { ManagementApi, Workspace } from '../api';
import { BoardErrorCard, LoadingSkeleton } from './CurrentPhaseScreen';
import { usePhasesData } from './usePhasesData';

export function PhasesScreen({ workspace, management, refreshMs }: { workspace: Workspace; management: ManagementApi; refreshMs?: number }): JSX.Element {
  const board = usePhasesData(management, workspace.id, refreshMs);
  return (
    <div className="boards-current-screen" data-section="boards/phases">
      <nav className="boards-breadcrumb" aria-label="Breadcrumb">
        <span>Boards</span><span aria-hidden="true">/</span><span aria-current="page">Phases</span>
      </nav>
      <header className="boards-phase-header">
        <div className="boards-phase-summary">
          <div className="boards-phase-title"><h1>Phases</h1></div>
          <p className="boards-phase-description">Progress of each phase, by ticket counts.</p>
        </div>
      </header>
      {board.state === 'loading' ? <LoadingSkeleton label="Loading phases…" /> :
        board.state === 'error' ? <BoardErrorCard title="Could not load phases" error={board.error} onRetry={() => { void board.reload(); }} /> :
          board.data?.phases.phases.length === 0 ? <section className="boards-state-card"><h2>No phases yet</h2></section> :
            <ul>{board.data?.phases.phases.map(phase => <li key={phase.slug}>{phase.name}</li>)}</ul>}
    </div>
  );
}
