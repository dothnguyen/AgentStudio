import { describe, expect, it } from 'vitest';
import { currentPhaseOf, phaseProgress } from '../src/renderer/boards/currentPhaseModel';
import { boardPhasesFixture, boardTicketSummary } from './boardFixtures';

describe('phaseProgress', () => {
  it('counts done and closed tickets against every ticket in the phase', () => {
    const tickets = [
      boardTicketSummary({ status: 'done' }),
      boardTicketSummary({ status: 'closed' }),
      boardTicketSummary({ status: 'close' }),
      boardTicketSummary({ status: 'dev-ready' }),
    ];
    expect(phaseProgress(tickets)).toEqual({ done: 3, total: 4, percent: 75 });
  });

  it('renders one of sixteen as six percent', () => {
    const tickets = Array.from({ length: 16 }, (_, index) =>
      boardTicketSummary({ key: `T-${100 + index}`, status: index === 0 ? 'done' : 'dev-ready' }),
    );
    expect(phaseProgress(tickets)).toEqual({ done: 1, total: 16, percent: 6 });
  });

  it('is zero percent for an empty phase', () => {
    expect(phaseProgress([])).toEqual({ done: 0, total: 0, percent: 0 });
  });
});

describe('currentPhaseOf', () => {
  it('returns the phase flagged current', () => {
    expect(currentPhaseOf(boardPhasesFixture())?.slug).toBe('phase-05');
  });

  it('returns null when no phase is flagged current', () => {
    const fixture = boardPhasesFixture();
    const phases = fixture.phases.map(entry => ({ ...entry, current: false }));
    expect(currentPhaseOf({ ...fixture, phases })).toBeNull();
  });

  it('returns null when the response has no current phase reference', () => {
    const fixture = boardPhasesFixture();
    const withoutReference = { ...fixture, currentPhase: null } as unknown as typeof fixture;
    expect(currentPhaseOf(withoutReference)).toBeNull();
  });

  it('returns null without phase data', () => {
    expect(currentPhaseOf(null)).toBeNull();
  });
});
