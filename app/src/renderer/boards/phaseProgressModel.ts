import type { BoardPhase, BoardTicketSummary } from '../api';
import { BLOCKED_STATUS, BOARD_LANES, type BoardStatusInfo } from './boardLaneModel';
import { DONE_TICKET_STATUSES } from './currentPhaseModel';

export interface PhaseSegments {
  done: number;
  inReview: number;
  inProgress: number;
  intake: number;
  blocked: number;
  other: number;
}

/** Counts are authoritative, including statuses no longer present in board settings. */
export function phaseSegments(phase: BoardPhase, _statuses: readonly BoardStatusInfo[], tickets?: readonly Pick<BoardTicketSummary, 'status'>[]): PhaseSegments {
  const segments: PhaseSegments = { done: 0, inReview: 0, inProgress: 0, intake: 0, blocked: 0, other: 0 };
  for (const [status, count] of Object.entries(phase.counts)) {
    if (DONE_TICKET_STATUSES.includes(status)) segments.done += count;
    else if (status === BLOCKED_STATUS) segments.blocked += count;
    else {
      const lane = BOARD_LANES.find(candidate => candidate.statuses.includes(status));
      if (lane?.id === 'review') segments.inReview += count;
      else if (lane?.id === 'build') segments.inProgress += count;
      else if (lane?.id === 'intake') segments.intake += count;
      else segments.other += count;
    }
  }
  if (!Object.prototype.hasOwnProperty.call(phase.counts, BLOCKED_STATUS) && tickets !== undefined) {
    segments.blocked = tickets.filter(ticket => ticket.status === BLOCKED_STATUS).length;
  }
  return segments;
}

export function percentDone(phase: BoardPhase): number {
  const done = DONE_TICKET_STATUSES.reduce((sum, status) => sum + (phase.counts[status] ?? 0), 0);
  return phase.ticketCount === 0 ? 0 : Math.round(done / phase.ticketCount * 100);
}

export function phaseState(phase: BoardPhase): 'current' | 'open' | 'closed' {
  return phase.current ? 'current' : phase.status;
}

export function emptyPhase(phase: BoardPhase): boolean {
  return phase.ticketCount === 0;
}
