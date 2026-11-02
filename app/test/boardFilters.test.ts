import { describe, expect, it } from 'vitest';
import type { BoardTicketSummary } from '../src/renderer/api';
import {
  DEFAULT_BOARD_FILTERS,
  filterBoardTickets,
  filteredCountLabel,
  matchesBoardFilters,
} from '../src/renderer/boards/boardFilters';
import { boardTicketSummary } from './boardFixtures';

function ticket(key: string, title: string, overrides: NonNullable<Parameters<typeof boardTicketSummary>[0]> = {}): BoardTicketSummary {
  return boardTicketSummary({ key, title, ...overrides });
}

const NOT_STARTED = ticket('T-100', 'Boards Phase A: current phase board');
const WORKING = ticket('T-114', 'Roles v2: edit dialogs', {
  activity: { state: 'working', agent: 'dev', role: 'Developer', run: 'run-t-114', workflow: 'board-develop' },
});
const BLOCKED = ticket('T-136', 'Fix flaky teamsA11y focus test', {
  status: 'blocked',
  returnStatus: 'qa-ready',
  activity: { state: 'blocked', note: 'The run was stopped.' },
});
const TICKETS = [NOT_STARTED, WORKING, BLOCKED];

describe('matchesBoardFilters', () => {
  it('searches keys and titles case-insensitively, including partial keys', () => {
    expect(matchesBoardFilters(NOT_STARTED, { ...DEFAULT_BOARD_FILTERS, query: 't-10' })).toBe(true);
    expect(matchesBoardFilters(WORKING, { ...DEFAULT_BOARD_FILTERS, query: 'T-11' })).toBe(true);
    expect(matchesBoardFilters(WORKING, { ...DEFAULT_BOARD_FILTERS, query: 'edit DIALOGS' })).toBe(true);
    expect(matchesBoardFilters(NOT_STARTED, { ...DEFAULT_BOARD_FILTERS, query: 'scheduler' })).toBe(false);
  });

  it('trims the query and ignores surrounding whitespace', () => {
    expect(matchesBoardFilters(WORKING, { ...DEFAULT_BOARD_FILTERS, query: '  roles  ' })).toBe(true);
    expect(matchesBoardFilters(WORKING, { ...DEFAULT_BOARD_FILTERS, query: '   ' })).toBe(true);
  });

  it('matches blocked and working activity independently', () => {
    expect(matchesBoardFilters(BLOCKED, { ...DEFAULT_BOARD_FILTERS, blockedOnly: true })).toBe(true);
    expect(matchesBoardFilters(WORKING, { ...DEFAULT_BOARD_FILTERS, blockedOnly: true })).toBe(false);
    expect(matchesBoardFilters(WORKING, { ...DEFAULT_BOARD_FILTERS, workingOnly: true })).toBe(true);
    expect(matchesBoardFilters(NOT_STARTED, { ...DEFAULT_BOARD_FILTERS, workingOnly: true })).toBe(false);
  });

  it('matches any selected workflow status and combines it with other filters', () => {
    const filters = { ...DEFAULT_BOARD_FILTERS, workflowStatuses: ['dev-ready', 'blocked'] };
    expect(filterBoardTickets(TICKETS, filters)).toEqual(TICKETS);
    expect(filterBoardTickets(TICKETS, { ...filters, workflowStatuses: ['blocked'] })).toEqual([BLOCKED]);
    expect(filterBoardTickets(TICKETS, { ...filters, workflowStatuses: ['blocked'], workingOnly: true })).toEqual([]);
    expect(filterBoardTickets(TICKETS, { ...filters, query: 'roles' })).toEqual([WORKING]);
  });

  it('combines search and both chips with AND', () => {
    const filters = { ...DEFAULT_BOARD_FILTERS, query: 'roles', workingOnly: true, blockedOnly: true };
    expect(matchesBoardFilters(WORKING, filters)).toBe(false);
    expect(matchesBoardFilters(WORKING, { ...filters, blockedOnly: false })).toBe(true);
  });
});

describe('filterBoardTickets', () => {
  it('returns only matching tickets and preserves their order', () => {
    expect(filterBoardTickets(TICKETS, { ...DEFAULT_BOARD_FILTERS, query: 't-1' })).toEqual(TICKETS);
    expect(filterBoardTickets(TICKETS, { ...DEFAULT_BOARD_FILTERS, blockedOnly: true })).toEqual([BLOCKED]);
    expect(filterBoardTickets(TICKETS, { ...DEFAULT_BOARD_FILTERS, workingOnly: true })).toEqual([WORKING]);
    expect(filterBoardTickets(TICKETS, { ...DEFAULT_BOARD_FILTERS, query: 'nope' })).toEqual([]);
  });

  it('labels the filtered ticket count with singular and plural forms', () => {
    expect(filteredCountLabel(0)).toBe('0 tickets');
    expect(filteredCountLabel(1)).toBe('1 ticket');
    expect(filteredCountLabel(12)).toBe('12 tickets');
  });
});
