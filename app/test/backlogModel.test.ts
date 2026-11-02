import { describe, expect, it } from 'vitest';
import { buildBacklogGroups } from '../src/renderer/boards/backlogModel';
import { boardPhase, boardPhasesFixture, boardTicketListFixture, boardTicketSummary } from './boardFixtures';

const ticket = boardTicketSummary;
const list = (tickets: ReturnType<typeof ticket>[], statuses = ['qa-ready', 'dev-ready', 'done']) =>
  boardTicketListFixture({ tickets, statuses });

describe('buildBacklogGroups', () => {
  it('orders current, open, closed and unassigned groups and keeps empty phases', () => {
    const phases = boardPhasesFixture({ phases: [
      boardPhase({ slug: 'closed', current: false, status: 'closed', position: 0 }),
      boardPhase({ slug: 'later', current: false, position: 3 }),
      boardPhase({ slug: 'current', current: true, position: 10 }),
      boardPhase({ slug: 'earlier', current: false, position: 1 }),
      boardPhase({ slug: 'closed-later', current: false, status: 'closed', position: 2 }),
    ] });
    const groups = buildBacklogGroups(phases, list([ticket({ phase: null }), ticket({ phase: 'unknown' })]));
    expect(groups.map((group) => group.slug)).toEqual(['current', 'earlier', 'later', 'closed', 'closed-later', null]);
    expect(groups[0].tickets).toEqual([]);
    expect(groups[3].closed).toBe(true);
    expect(groups[5].name).toBe('No phase');
    expect(groups[5].counts.total).toBe(2);
  });

  it('sorts within groups by priority, numeric key, update time and configured status', () => {
    const phases = boardPhasesFixture();
    const entries = [
      ticket({ key: 'T-99', priority: 2, status: 'dev-ready', updatedAt: '2026-01-03T00:00:00Z' }),
      ticket({ key: 'T-100', priority: 2, status: 'qa-ready', updatedAt: '2026-01-01T00:00:00Z' }),
      ticket({ key: 'T-2', priority: 1, status: 'unknown', updatedAt: '2026-01-02T00:00:00Z' }),
      ticket({ key: 'T-3', priority: 1, status: 'qa-ready', updatedAt: '2026-01-04T00:00:00Z' }),
    ];
    const keys = (sort?: 'priority' | 'key' | 'updated' | 'status') =>
      buildBacklogGroups(phases, list(entries), sort)[0].tickets.map((entry) => entry.key);
    expect(keys()).toEqual(['T-2', 'T-3', 'T-99', 'T-100']);
    expect(keys('key')).toEqual(['T-100', 'T-99', 'T-3', 'T-2']);
    expect(keys('updated')).toEqual(['T-3', 'T-99', 'T-2', 'T-100']);
    expect(keys('status')).toEqual(['T-3', 'T-100', 'T-99', 'T-2']);
    expect(entries.map((entry) => entry.key)).toEqual(['T-99', 'T-100', 'T-2', 'T-3']);
  });

  it('counts terminal statuses first and classifies all open activities', () => {
    const entries = [
      ticket({ status: 'done', activity: { state: 'working' } }),
      ticket({ status: 'close' }),
      ticket({ activity: { state: 'working' } }),
      ticket({ activity: { state: 'blocked' } }),
      ticket({ activity: { state: 'not started', waitingFor: 'Developer' } }),
      ticket({ activity: { state: 'not started' } }),
      ticket({ activity: { state: 'finished' } }),
    ];
    expect(buildBacklogGroups(boardPhasesFixture(), list(entries))[0].counts)
      .toEqual({ total: 7, done: 2, working: 1, blocked: 1, waiting: 1, ready: 2 });
  });

  it('tolerates missing fields and puts unknown statuses last', () => {
    const incomplete = { key: 'T-5', phase: 'phase-05' } as ReturnType<typeof ticket>;
    const groups = buildBacklogGroups(boardPhasesFixture(), list([incomplete, ticket({ key: 'T-6', status: 'qa-ready' })]), 'status');
    expect(groups[0].tickets.map((entry) => entry.key)).toEqual(['T-6', 'T-5']);
    expect(groups[0].counts.ready).toBe(2);
  });

  it('returns an empty result when phase and ticket collections are absent', () => {
    expect(buildBacklogGroups({} as never, {} as never)).toEqual([]);
  });
});
