import type { JSX } from 'react';
import type { ManagementApi, Workspace } from '../api';
import { BoardErrorCard, LoadingSkeleton } from './CurrentPhaseScreen';
import { usePhasesData } from './usePhasesData';
import { PhaseCard } from './PhaseCard';

export function PhasesScreen({ workspace, management, refreshMs, onViewTickets = () => {}, onOpenBoard = () => {} }: { workspace: Workspace; management: ManagementApi; refreshMs?: number; onViewTickets?: (slug: string) => void; onOpenBoard?: () => void }): JSX.Element {
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
            <div className="boards-milestone-list">{board.data && [...board.data.phases.phases]
              .sort((a, b) => Number(b.current) - Number(a.current) || Number(a.status === 'closed') - Number(b.status === 'closed') || a.position - b.position)
              .map(phase => <PhaseCard key={phase.slug} phase={phase} statuses={board.data!.settings.statuses} onViewTickets={onViewTickets} onOpenBoard={onOpenBoard} />)}</div>}
    </div>
  );
}
