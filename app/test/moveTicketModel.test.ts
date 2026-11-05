import { describe, expect, it } from 'vitest';
import type { BoardRuleView, BoardSettings } from '../src/renderer/api';
import {
  buildMoveDestinations,
  defaultDestination,
  moveRequestFor,
} from '../src/renderer/boards/moveTicketModel';
import { boardTicketSummary } from './boardFixtures';
import { boardSettingsFixture } from './teamsFixtures';

const STATUSES: BoardSettings['statuses'] = [
  { id: 'backlog', name: 'Backlog', kind: 'initial' },
  { id: 'dev-ready', name: 'Dev ready', kind: null },
  { id: 'qa-ready', name: 'QA ready', kind: null },
  { id: 'review-ready', name: 'Review ready', kind: null },
  { id: 'done', name: 'Done', kind: 'done' },
  { id: 'close', name: 'Closed', kind: 'closed' },
];

function rule(status: string, index: number, during: string | null = null): BoardRuleView {
  return {
    index, status, type: 'agent', role: 'Developer', workflow: 'board-develop', during, action: null,
    onPass: 'done', onFail: 'dev-ready', onBlocked: null, workspace: 'worktree',
    syncBase: false, maxRounds: null, priority: null, onFailureLimit: null, protected: false,
  };
}

const RULES = [rule('dev-ready', 0), rule('qa-ready', 1), rule('review-ready', 2)];

function settings(overrides: Partial<BoardSettings> = {}): BoardSettings {
  return {
    ...boardSettingsFixture(),
    statuses: STATUSES,
    workflowStatuses: STATUSES,
    todoEntry: ['dev-ready', 'qa-ready'],
    todoDefault: 'qa-ready',
    rules: RULES,
    ...overrides,
  };
}

const backlogTicket = () => boardTicketSummary({ key: 'T-100', status: 'backlog', workflowStatus: 'backlog' });

function destination(overrides: Partial<BoardSettings>, column: 'backlog' | 'todo' | 'in-progress' | 'done' | 'closed') {
  return buildMoveDestinations(backlogTicket(), settings(overrides)).find((item) => item.column === column)!;
}

describe('buildMoveDestinations', () => {
  it('derives Todo statuses from todoEntry and selects todoDefault', () => {
    const todo = destination({}, 'todo');
    expect(todo.statuses).toEqual([
      { id: 'dev-ready', name: 'Dev ready' },
      { id: 'qa-ready', name: 'QA ready' },
    ]);
    expect(todo.defaultStatus).toBe('qa-ready');
    expect(todo.disabled).toBe(false);
  });

  it('derives In Progress statuses from the configured workflow rules', () => {
    expect(destination({}, 'in-progress').statuses.map((status) => status.id)).toEqual([
      'dev-ready', 'qa-ready', 'review-ready',
    ]);
  });

  it('derives Done and Closed statuses from their configured kinds', () => {
    expect(destination({}, 'done').statuses).toEqual([{ id: 'done', name: 'Done' }]);
    expect(destination({}, 'closed').statuses).toEqual([{ id: 'close', name: 'Closed' }]);
    expect(destination({}, 'backlog').statuses).toEqual([{ id: 'backlog', name: 'Backlog' }]);
  });

  it('disables the current column with an explanation', () => {
    const backlog = destination({}, 'backlog');
    expect(backlog.disabled).toBe(true);
    expect(backlog.reason).toBe('This ticket is already in Backlog.');
    expect(defaultDestination(buildMoveDestinations(backlogTicket(), settings()))?.column).toBe('todo');
  });

  it('disables columns that have no workflow status in the board settings', () => {
    const destinations = buildMoveDestinations(backlogTicket(), settings({ todoEntry: [], todoDefault: null, rules: [] }));
    expect(destinations.filter((item) => item.disabled).map((item) => [item.column, item.reason])).toEqual([
      ['backlog', 'This ticket is already in Backlog.'],
      ['todo', 'No workflow status is configured for Todo.'],
      ['in-progress', 'No workflow rule is configured for In Progress.'],
    ]);
    expect(defaultDestination(destinations)?.column).toBe('done');
  });

  it('only offers the reopen paths for a finished ticket and marks the move forced', () => {
    const done = boardTicketSummary({ key: 'T-100', status: 'done', workflowStatus: 'done' });
    const destinations = buildMoveDestinations(done, settings());
    expect(destinations.map((item) => item.column)).toEqual(['backlog', 'todo']);
    expect(destinations.every((item) => item.force)).toBe(true);
  });
});

describe('moveRequestFor', () => {
  it('sends the column and chosen workflow status, adding force for a finished ticket', () => {
    const todo = destination({}, 'todo');
    expect(moveRequestFor(backlogTicket(), todo, 'dev-ready'))
      .toEqual({ key: 'T-100', to: 'todo', workflowStatus: 'dev-ready' });

    const done = boardTicketSummary({ key: 'T-100', status: 'done', workflowStatus: 'done' });
    const reopen = buildMoveDestinations(done, settings()).find((item) => item.column === 'todo')!;
    expect(moveRequestFor(done, reopen, 'dev-ready'))
      .toEqual({ key: 'T-100', to: 'todo', workflowStatus: 'dev-ready', force: true });
  });
});
