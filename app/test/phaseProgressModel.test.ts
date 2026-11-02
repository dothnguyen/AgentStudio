import { describe, expect, it } from 'vitest';
import { emptyPhase, percentDone, phaseSegments, phaseState } from '../src/renderer/boards/phaseProgressModel';
import { boardPhase } from './boardFixtures';

describe('phase progress', () => {
  it('counts columns separately including unknown columns', () => {
    const phase = boardPhase({ ticketCount: 12, counts: { done: 2, closed: 1, 'in-progress': 3, todo: 2, backlog: 2, custom: 2 } });
    const segments = phaseSegments(phase, []);
    expect(segments).toEqual({ done: 2, closed: 1, inProgress: 3, todo: 2, backlog: 2, other: 2 });
    expect(Object.values(segments).reduce((a, b) => a + b, 0)).toBe(12);
    expect(percentDone(phase)).toBe(25);
  });
  it('rounds completion including closed and identifies empty and phase states', () => {
    const phase = boardPhase({ ticketCount: 3, counts: { done: 1, closed: 1 } });
    expect(percentDone(phase)).toBe(67);
    expect(phaseState(phase)).toBe('current');
    expect(phaseState({ ...phase, current: false })).toBe('open');
    expect(phaseState({ ...phase, current: false, status: 'closed' })).toBe('closed');
    expect(emptyPhase(phase)).toBe(false);
    expect(emptyPhase(boardPhase())).toBe(true);
    expect(percentDone(boardPhase())).toBe(0);
  });
});
