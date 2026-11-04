import { expect, it } from 'vitest';
import { filterStatuses, statusCounts, statusPresentation, type Status } from '../src/renderer/workflow/statusesModel';

const make = (type: Status['type'], overrides: Partial<Status> = {}): Status => ({ id: type, name: type, type, kind: type === 'start' ? 'initial' : type === 'done' ? 'done' : type === 'closed' ? 'closed' : null, usedBy: [], ticketCount: 0, ...overrides });

it('maps each status type to its chip and board column', () => {
  expect(Object.values(statusPresentation).map(p => [p.label, p.column, p.tone])).toEqual([
    ['Start', 'Backlog', 'neutral'], ['Starts a workflow', 'Todo or In Progress', 'blue'],
    ['While running', 'In Progress', 'amber'], ['Done', 'Done', 'green'],
    ['Closed', 'Closed', 'neutral'], ['Not used', 'Set by hand', 'muted'],
  ]);
});
it('counts categories and filters statuses with no workflow users', () => {
  const statuses = [make('start'), make('done'), make('closed'), make('startsWorkflow', { usedBy: [{ workflow: 'x', title: 'X', how: 'startsAt' }] }), make('whileRunning', { usedBy: [{ workflow: 'x', title: 'X', how: 'whileRunning' }] }), make('unused'), make('unused', { usedBy: [{ workflow: 'x', title: 'X', how: 'end.pass' }] })];
  expect(statusCounts(statuses)).toEqual({ starts: 1, running: 1, protected: 3, unused: 1 });
  expect(filterStatuses(statuses, '', true)).toEqual([statuses[5]]);
});
it('filters name or id case insensitively and combines filters', () => {
  const statuses = [make('unused', { id: 'abc', name: 'Waiting' }), make('start', { id: 'wait-id', name: 'Start' })];
  expect(filterStatuses(statuses, ' WAIT ', false)).toEqual(statuses);
  expect(filterStatuses(statuses, 'ABC', true)).toEqual([statuses[0]]);
  expect(filterStatuses(statuses, 'missing', false)).toEqual([]);
});
