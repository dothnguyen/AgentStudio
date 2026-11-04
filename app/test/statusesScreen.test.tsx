// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { StatusesScreen } from '../src/renderer/workflow/StatusesScreen';
import { fakeManagement } from './teamsFixtures';

const workspaceA = { id: 'a', name: 'A', path: '/a', exists: true, missing: false };

afterEach(cleanup);

it('loads and filters statuses and disables removal for workflow and ticket usage', async () => {
  const fake = fakeManagement();
  fake.api.boardStatuses = async () => ({ ok: true, data: { sha256: 'x', statuses: [
    { id: 'start', name: 'Backlog', hasName: true, kind: 'start', type: 'start', usedBy: [], ticketCount: 0 },
    { id: 'trigger', name: 'Ready', hasName: true, kind: null, type: 'startsWorkflow', usedBy: [{ workflow: 'dev', title: 'Develop', how: 'startsWorkflow' }], ticketCount: 0 },
    { id: 'working', name: 'working', hasName: false, kind: null, type: 'whileRunning', usedBy: [{ workflow: 'dev', title: 'Develop', how: 'whileRunning' }], ticketCount: 0 },
    { id: 'waiting', name: 'waiting', hasName: true, kind: null, type: 'unused', usedBy: [], ticketCount: 1 },
    { id: 'free', name: 'Free', kind: null, type: 'unused', usedBy: [], ticketCount: 0 },
  ] } });
  const view = render(<StatusesScreen workspace={workspaceA} management={fake.api} />);
  await waitFor(() => expect(view.getByText('Ready')).toBeTruthy());
  expect(view.getByText('needs a name')).toBeTruthy();
  const rows = view.getAllByRole('row');
  expect(Array.from(view.container.querySelectorAll('.statuses-card')).map(card => card.textContent)).toEqual([
    expect.stringContaining('Starts a workflow1'),
    expect.stringContaining('While running1'),
    expect.stringContaining('Start, Done, Closed1'),
    expect.stringContaining('Not used2'),
  ]);
  expect(within(rows[2]).getByText('Starts a workflow')).toBeTruthy();
  expect(within(rows[2]).getByText('Develop')).toBeTruthy();
  expect(within(rows[2]).getByText('Todo or In Progress')).toBeTruthy();
  expect(within(rows[3]).getByText('While running')).toBeTruthy();
  expect(within(rows[3]).getByText('In Progress')).toBeTruthy();
  expect(within(rows[3]).getByText('needs a name')).toBeTruthy();
  expect(within(rows[2]).getByRole('button', { name: 'Remove' }).hasAttribute('disabled')).toBe(true);
  expect(within(rows[2]).getByRole('button', { name: 'Remove' }).parentElement?.getAttribute('title')).toContain('used by a workflow or ticket');
  expect(within(rows[3]).getByRole('button', { name: 'Remove' }).hasAttribute('disabled')).toBe(true);
  expect(within(rows[4]).getByRole('button', { name: 'Remove' }).hasAttribute('disabled')).toBe(true);
  expect(within(rows[5]).getByRole('button', { name: 'Remove' }).hasAttribute('disabled')).toBe(false);
  fireEvent.change(view.getByLabelText('Status usage'), { target: { value: 'unused' } });
  expect(view.queryByText('Develop')).toBeNull();
  fireEvent.change(view.getByLabelText('Filter by name or id'), { target: { value: 'free' } });
  expect(view.getAllByRole('row')).toHaveLength(2);
  fireEvent.change(view.getByLabelText('Filter by name or id'), { target: { value: 'absent' } });
  expect(view.getByText('No statuses match your filters.')).toBeTruthy();
});

it('shows loading, errors, and an empty state', async () => {
  const fake = fakeManagement();
  let resolve!: (value: Awaited<ReturnType<typeof fake.api.boardStatuses>>) => void;
  fake.api.boardStatuses = () => new Promise(r => { resolve = r; });
  const view = render(<StatusesScreen workspace={workspaceA} management={fake.api} />);
  expect(view.getByText('Loading statuses…')).toBeTruthy();
  resolve({ ok: false, error: { code: 'ERROR', message: 'Failed', retryable: true } });
  await waitFor(() => expect(view.getByRole('alert').textContent).toContain('Failed'));
  fake.api.boardStatuses = async () => ({ ok: true, data: { statuses: [], sha256: 'x' } });
  view.rerender(<StatusesScreen workspace={workspaceA} management={fake.api} />);
  await waitFor(() => expect(view.getByText('No statuses found.')).toBeTruthy());
});
