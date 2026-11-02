import { describe, expect, it } from 'vitest';
import { emptyPhase, percentDone, phaseSegments, phaseState } from '../src/renderer/boards/phaseProgressModel';
import { boardPhase } from './boardFixtures';

describe('phase progress', () => {
  it('groups all status counts including unknown statuses and sums to the ticket count', () => {
    const phase = boardPhase({ ticketCount: 12, counts: { done: 2, close: 1, 'review-ready': 2, 'merge-conflict': 1, 'dev-ready': 2, backlog: 1, blocked: 1, custom: 2 } });
    const segments = phaseSegments(phase, []);
    expect(segments).toEqual({ done: 3, inReview: 3, inProgress: 2, intake: 1, blocked: 1, other: 2 });
    expect(Object.values(segments).reduce((a, b) => a + b, 0)).toBe(phase.ticketCount);
  });
  it('uses blocked tickets only when the count is absent', () => {
    const tickets = [{ status: 'blocked' }, { status: 'blocked' }, { status: 'done' }];
    const phase = boardPhase({ ticketCount: 3, counts: { done: 1 } });
    const segments = phaseSegments(phase, [], tickets);
    expect(segments.blocked).toBe(2);
    expect(Object.values(segments).reduce((a, b) => a + b, 0)).toBe(phase.ticketCount);
    expect(phaseSegments({ ...phase, counts: { done: 1, blocked: 0 } }, [], tickets).blocked).toBe(0);
  });
  it('rounds finished percentages and identifies empty and phase states', () => {
    const phase = boardPhase({ ticketCount: 3, counts: { done: 1, close: 1 } });
    expect(percentDone(phase)).toBe(67);
    expect(phaseState(phase)).toBe('current');
    expect(phaseState({ ...phase, current: false })).toBe('open');
    expect(phaseState({ ...phase, current: false, status: 'closed' })).toBe('closed');
    expect(emptyPhase(phase)).toBe(false);
    expect(emptyPhase(boardPhase())).toBe(true);
    expect(percentDone(boardPhase())).toBe(0);
  });
});
