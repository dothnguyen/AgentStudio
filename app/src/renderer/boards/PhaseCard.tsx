import { useId, type JSX } from 'react';
import type { BoardPhase } from '../api';
import type { BoardStatusInfo } from './boardLaneModel';
import { percentDone, phaseSegments, phaseState, type PhaseSegments } from './phaseProgressModel';

const CATEGORIES: { key: keyof PhaseSegments; label: string; accessible: string }[] = [
  { key: 'done', label: 'Done', accessible: 'done' },
  { key: 'inReview', label: 'Review', accessible: 'in review' },
  { key: 'inProgress', label: 'In progress', accessible: 'in progress' },
  { key: 'intake', label: 'Intake', accessible: 'intake' },
  { key: 'blocked', label: 'Blocked', accessible: 'blocked' },
  { key: 'other', label: 'Other', accessible: 'other' },
];

export function PhaseCard({ phase, statuses, onViewTickets, onOpenBoard }: {
  phase: BoardPhase; statuses: readonly BoardStatusInfo[];
  onViewTickets(slug: string): void; onOpenBoard(): void;
}): JSX.Element {
  const headingId = useId();
  const segments = phaseSegments(phase, statuses);
  const state = phaseState(phase);
  const visible = CATEGORIES.filter(category => segments[category.key] > 0);
  const label = [`${segments.done} of ${phase.ticketCount} done`, ...visible.filter(category => category.key !== 'done').map(category => `${segments[category.key]} ${category.accessible}`)].join(', ');
  return <section className="boards-milestone-card" aria-labelledby={headingId}>
    <div className="boards-milestone-heading">
      <div className="boards-milestone-title"><h2 id={headingId}><button type="button" className="boards-phase-name-link" onClick={() => onViewTickets(phase.slug)}>{phase.name}</button></h2>
        {state === 'current' && <span className="boards-phase-pill">Current</span>}
        {state === 'closed' && <span className="boards-phase-pill boards-backlog-closed">Closed</span>}
      </div>
      <span className="boards-milestone-count">{segments.done} of {phase.ticketCount} done · {percentDone(phase)}%</span>
    </div>
    <p className="boards-milestone-description">{phase.description?.trim() || 'No description'}</p>
    <div className="boards-milestone-track" role="img" aria-label={label}>
      {phase.ticketCount > 0 && visible.map(category => <span key={category.key} className={`boards-milestone-segment boards-milestone-${category.key}`} title={`${category.label}: ${segments[category.key]}`} style={{ width: `${segments[category.key] / phase.ticketCount * 100}%` }} />)}
    </div>
    {phase.ticketCount === 0 ? <p className="boards-milestone-empty">No tickets yet</p> :
      <ul className="boards-milestone-legend">{visible.map(category => <li key={category.key}><span aria-hidden="true" className={`boards-milestone-dot boards-milestone-${category.key}`} />{category.label} {segments[category.key]}</li>)}</ul>}
    <div className="boards-milestone-actions">
      <button type="button" onClick={() => onViewTickets(phase.slug)}>View tickets</button>
      {state === 'current' && <button type="button" onClick={onOpenBoard}>Open board</button>}
    </div>
  </section>;
}
