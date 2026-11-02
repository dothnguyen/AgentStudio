import { describe, expect, it } from 'vitest';
import { BOARD_CARD_LIMIT, buildBoardLanes } from '../src/renderer/boards/boardLaneModel';
import { boardTicketSummary } from './boardFixtures';

describe('Current Phase columns', () => {
  it('groups by board status in fixed order, including blocked workflow tickets', () => {
    const tickets = [
      boardTicketSummary({ key: 'T-1', status: 'backlog' }),
      boardTicketSummary({ key: 'T-2', status: 'todo', workflowStatus: 'blocked', returnStatus: null }),
      boardTicketSummary({ key: 'T-3', status: 'in-progress', workflowStatus: 'blocked', returnStatus: 'gone' }),
      boardTicketSummary({ key: 'T-4', status: 'done' }),
      boardTicketSummary({ key: 'T-5', status: 'closed' }),
      boardTicketSummary({ key: 'T-6', status: 'todo' }),
    ];
    const columns = buildBoardLanes(tickets);
    expect(columns.map(column => column.label)).toEqual(['Backlog', 'Todo', 'In Progress', 'Done', 'Closed']);
    expect(columns.map(column => column.tickets.map(ticket => ticket.key))).toEqual([
      ['T-1'], ['T-2', 'T-6'], ['T-3'], ['T-4'], ['T-5'],
    ]);
    expect(columns.map(column => column.tickets.length)).toEqual([1, 2, 1, 1, 1]);
    expect(BOARD_CARD_LIMIT).toBe(6);
  });

  it('keeps legacy and unknown statuses visible in the five columns', () => {
    const tickets = [
      boardTicketSummary({ key: 'T-1', status: 'dev-ready', activity: { state: 'not started' } }),
      boardTicketSummary({ key: 'T-2', status: 'qa-ready', activity: { state: 'working' } }),
      boardTicketSummary({ key: 'T-3', status: 'merge-ready', activity: { state: 'not started' } }),
      boardTicketSummary({ key: 'T-4', status: 'blocked', returnStatus: 'qa-ready' }),
      boardTicketSummary({ key: 'T-5', status: 'close' }),
      boardTicketSummary({ key: 'T-6', status: 'custom', activity: { state: 'not started' } }),
    ];
    const columns = buildBoardLanes(tickets, { hideEmpty: false });
    expect(columns.map(column => column.tickets.map(ticket => ticket.key))).toEqual([
      [], ['T-1', 'T-3', 'T-6'], ['T-2', 'T-4'], [], ['T-5'],
    ]);
    expect(columns.reduce((count, column) => count + column.tickets.length, 0)).toBe(tickets.length);
  });

  it('keeps dev-ready, qa-ready, and merge-ready tickets represented with accurate column counts', () => {
    const tickets = [
      boardTicketSummary({ key: 'T-10', status: 'dev-ready' }),
      boardTicketSummary({ key: 'T-11', status: 'qa-ready', activity: { state: 'working' } }),
      boardTicketSummary({ key: 'T-12', status: 'merge-ready' }),
    ];

    const columns = buildBoardLanes(tickets, { hideEmpty: false });

    expect(columns.map(column => column.tickets.length)).toEqual([0, 2, 1, 0, 0]);
    expect(columns.flatMap(column => column.tickets.map(ticket => ticket.key)).sort()).toEqual(['T-10', 'T-11', 'T-12']);
  });

  it('hides only empty Backlog and Closed and uses unfiltered occupancy', () => {
    const tickets = [boardTicketSummary({ status: 'backlog', key: 'T-1' })];
    expect(buildBoardLanes([]).map(column => column.id)).toEqual(['todo', 'in-progress', 'done']);
    expect(buildBoardLanes([], { hideEmpty: false })).toHaveLength(5);
    const columns = buildBoardLanes(tickets, { matches: () => false });
    expect(columns.map(column => column.id)).toEqual(['backlog', 'todo', 'in-progress', 'done']);
    expect(columns[0]!.tickets).toHaveLength(0);
  });
});
