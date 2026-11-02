import { describe, expect, it } from 'vitest';
import { DEFAULT_BACKLOG_FILTERS as defaults, activeFilterCount, filterBacklogTickets, isDefaultFilters, matchesBacklogFilters, ownersOf } from '../src/renderer/boards/backlogFilters';
import { boardTicketSummary } from './boardFixtures';

describe('backlog filters', () => {
  const ticket = boardTicketSummary({ key: 'T-114', title: 'Edit Dialogs', status: 'dev-ready', phase: 'phase-05', priority: 99,
    activity: { state: 'working', agent: 'dev' }, openDependsOn: ['T-1'] });

  it('provides empty filters with priority sorting by default', () => {
    expect(defaults).toEqual({
      query: '', statuses: [], phases: [], activity: [], owner: null,
      priority: 'any', hasOpenDeps: 'any', sort: 'priority',
    });
    expect(isDefaultFilters(defaults)).toBe(true);
  });

  it('searches key fragments and titles without case or surrounding whitespace', () => {
    for (const query of ['t-11', ' EDIT dialogs ', '  ']) expect(matchesBacklogFilters(ticket, { ...defaults, query })).toBe(true);
    expect(matchesBacklogFilters(ticket, { ...defaults, query: 'T-115' })).toBe(false);
  });

  it('matches each selection and combines selections with AND and values with OR', () => {
    expect(matchesBacklogFilters(ticket, { ...defaults, statuses: ['backlog', 'dev-ready'] })).toBe(true);
    expect(matchesBacklogFilters(ticket, { ...defaults, statuses: ['backlog'] })).toBe(false);
    expect(matchesBacklogFilters(ticket, { ...defaults, phases: ['phase-06', 'phase-05'] })).toBe(true);
    expect(matchesBacklogFilters(boardTicketSummary({ phase: null }), { ...defaults, phases: ['phase-05'] })).toBe(false);
    expect(matchesBacklogFilters(ticket, { ...defaults, activity: ['blocked', 'working'] })).toBe(true);
    expect(matchesBacklogFilters(ticket, { ...defaults, owner: 'dev' })).toBe(true);
    expect(matchesBacklogFilters(ticket, { ...defaults, owner: 'other' })).toBe(false);
    expect(matchesBacklogFilters(ticket, { ...defaults, hasOpenDeps: 'yes' })).toBe(true);
    expect(matchesBacklogFilters(ticket, { ...defaults, hasOpenDeps: 'no' })).toBe(false);
    expect(matchesBacklogFilters(boardTicketSummary(), { ...defaults, hasOpenDeps: 'no' })).toBe(true);
    const filters = { ...defaults, query: 'dialog', statuses: ['dev-ready'], phases: ['phase-05'], activity: ['working' as const], owner: 'dev', priority: 'urgent' as const, hasOpenDeps: 'yes' as const };
    expect(matchesBacklogFilters(ticket, filters)).toBe(true);
    expect(matchesBacklogFilters(ticket, { ...filters, phases: ['phase-06'] })).toBe(false);
    expect(filterBacklogTickets([boardTicketSummary(), ticket], filters)).toEqual([ticket]);
  });

  it('uses strict priority boundaries', () => {
    for (const [priority, bucket] of [[99, 'urgent'], [100, 'normal'], [101, 'low']] as const) {
      for (const selected of ['urgent', 'normal', 'low'] as const) {
        expect(matchesBacklogFilters(boardTicketSummary({ priority }), { ...defaults, priority: selected })).toBe(selected === bucket);
      }
    }
  });

  it('maps activity states including waiting and ready separately', () => {
    const cases = [
      [{ state: 'working' }, 'working'], [{ state: 'blocked' }, 'blocked'],
      [{ state: 'finished' }, 'finished'], [{ state: 'not started', waitingFor: 'Developer' }, 'waiting'],
      [{ state: 'not started' }, 'ready'], [{ state: 'not started', waitingFor: '' }, 'ready'],
    ] as const;
    for (const [activity, expected] of cases) {
      for (const selected of ['working', 'blocked', 'finished', 'waiting', 'ready'] as const) {
        expect(matchesBacklogFilters(boardTicketSummary({ activity }), { ...defaults, activity: [selected] })).toBe(selected === expected);
      }
    }
  });

  it('counts filter categories and treats sort as a non-default without counting it', () => {
    expect(activeFilterCount(defaults)).toBe(0);
    expect(isDefaultFilters({ ...defaults, statuses: [] })).toBe(true);
    expect(activeFilterCount({ ...defaults, sort: 'key' })).toBe(0);
    expect(isDefaultFilters({ ...defaults, sort: 'key' })).toBe(false);
    const filters = { ...defaults, query: 'x', statuses: ['a', 'b'], phases: ['p'], activity: ['ready' as const], owner: 'dev', priority: 'low' as const, hasOpenDeps: 'no' as const };
    expect(activeFilterCount(filters)).toBe(7);
    expect(isDefaultFilters(filters)).toBe(false);
    for (const filter of [{ query: 'x' }, { statuses: ['a'] }, { phases: ['p'] }, { activity: ['ready' as const] }, { owner: 'dev' }, { priority: 'low' as const }, { hasOpenDeps: 'no' as const }]) {
      expect(activeFilterCount({ ...defaults, ...filter })).toBe(1);
      expect(isDefaultFilters({ ...defaults, ...filter })).toBe(false);
    }
  });

  it('returns sorted distinct activity agent names, excluding missing owners', () => {
    expect(ownersOf([ticket, boardTicketSummary({ activity: { state: 'blocked', agent: 'amy' } }), ticket, boardTicketSummary(), boardTicketSummary({ activity: { state: 'finished', agent: null } })])).toEqual(['amy', 'dev']);
    expect(ownersOf([])).toEqual([]);
  });
});
