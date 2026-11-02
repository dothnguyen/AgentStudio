import type { BoardPhase } from '../api';
import type { BoardStatusInfo } from './boardLaneModel';

export interface PhaseSegments {
  done: number;
  closed: number;
  inProgress: number;
  todo: number;
  backlog: number;
  other: number;
}

/** Phase counts are keyed by board column, independent of workflow status. */
export function phaseSegments(phase: BoardPhase, _statuses: readonly BoardStatusInfo[]): PhaseSegments {
  const counts = phase.counts;
  const known = new Set(['done', 'closed', 'in-progress', 'todo', 'backlog']);
  return {
    done: counts.done ?? 0, closed: counts.closed ?? 0,
    inProgress: counts['in-progress'] ?? 0, todo: counts.todo ?? 0,
    backlog: counts.backlog ?? 0,
    other: Object.entries(counts).reduce((sum, [column, count]) => sum + (known.has(column) ? 0 : count), 0),
  };
}

export function percentDone(phase: BoardPhase): number {
  return phase.ticketCount === 0 ? 0 : Math.round(((phase.counts.done ?? 0) + (phase.counts.closed ?? 0)) / phase.ticketCount * 100);
}

export function phaseState(phase: BoardPhase): 'current' | 'open' | 'closed' {
  return phase.current ? 'current' : phase.status;
}

export function emptyPhase(phase: BoardPhase): boolean {
  return phase.ticketCount === 0;
}
