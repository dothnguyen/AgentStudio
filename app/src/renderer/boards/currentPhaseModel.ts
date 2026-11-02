import type { BoardPhase, BoardPhaseRef, BoardPhases, BoardTicketSummary } from '../api';

/** Statuses that count as finished for the Current Phase progress. */
export const DONE_TICKET_STATUSES: readonly string[] = ['done', 'closed', 'close'];

export interface PhaseProgress {
  done: number;
  total: number;
  percent: number;
}

/** Counts only the tickets returned for the phase; a phase with no tickets is 0 of 0 and 0%. */
export function phaseProgress(tickets: readonly Pick<BoardTicketSummary, 'status'>[]): PhaseProgress {
  const total = tickets.length;
  const done = tickets.filter(ticket => DONE_TICKET_STATUSES.includes(ticket.status)).length;
  return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
}

/**
 * The phase marked current by `phase.list`. A missing marker means no current phase is set,
 * so the screen can point the operator at Phases instead of guessing from the default phase.
 */
export function currentPhaseOf(phases: BoardPhases | null): BoardPhase | null {
  if (phases === null) return null;
  const ref = phases.currentPhase as BoardPhaseRef | null | undefined;
  if (ref === null || ref === undefined || typeof ref.slug !== 'string' || ref.slug === '') return null;
  return phases.phases.find(phase => phase.current) ?? null;
}
