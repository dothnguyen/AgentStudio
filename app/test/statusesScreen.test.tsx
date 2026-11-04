// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
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

it('validates and submits an editable generated ID and kind with the board SHA', async () => {
  const fake = fakeManagement();
  fake.api.boardStatuses = async () => ({ ok: true, data: { statuses: [], sha256: 'sha' } });
  const add = vi.fn(async () => ({ ok: true as const, data: {} as never }));
  fake.api.addStatus = add;
  const view = render(<StatusesScreen workspace={workspaceA} management={fake.api} />);
  await waitFor(() => expect(view.getByText('No statuses found.')).toBeTruthy());
  fireEvent.click(view.getByText('+ Add status'));
  const dialog = within(view.getByRole('dialog'));
  expect(dialog.getByRole('button', { name: 'Add status' }).hasAttribute('disabled')).toBe(true);
  fireEvent.change(dialog.getByLabelText('Name'), { target: { value: 'Fact checking' } });
  expect((dialog.getByLabelText('ID') as HTMLInputElement).value).toBe('fact-checking');
  fireEvent.change(dialog.getByLabelText('ID'), { target: { value: 'custom' } });
  fireEvent.change(dialog.getByLabelText('Name'), { target: { value: 'Published' } });
  fireEvent.click(dialog.getByRole('radio', { name: /Done/ }));
  fireEvent.click(dialog.getByRole('button', { name: 'Add status' }));
  await waitFor(() => expect(add).toHaveBeenCalledWith('a', { id: 'custom', name: 'Published', kind: 'done', expectedSha256: 'sha' }));
});

it('rejects blank names and duplicate IDs before submitting', async () => {
  const fake = fakeManagement();
  fake.api.boardStatuses = async () => ({ ok: true, data: { sha256: 'sha', statuses: [
    { id: 'existing', name: 'Existing', kind: null, type: 'unused', usedBy: [], ticketCount: 0 },
  ] } });
  const add = vi.fn(); fake.api.addStatus = add;
  const view = render(<StatusesScreen workspace={workspaceA} management={fake.api} />);
  await waitFor(() => expect(view.getByText('Existing')).toBeTruthy());
  fireEvent.click(view.getByText('+ Add status'));
  const dialog = within(view.getByRole('dialog'));
  fireEvent.change(dialog.getByLabelText('Name'), { target: { value: 'Existing' } });
  expect(dialog.getByRole('button', { name: 'Add status' }).hasAttribute('disabled')).toBe(true);
  expect(dialog.getByRole('alert').textContent).toBe('A status with this ID already exists.');
  fireEvent.change(dialog.getByLabelText('ID'), { target: { value: 'new-id' } });
  fireEvent.change(dialog.getByLabelText('ID'), { target: { value: 'bad id' } });
  expect(dialog.getByRole('alert').textContent).toContain('ID must start');
  expect(dialog.getByRole('button', { name: 'Add status' }).hasAttribute('disabled')).toBe(true);
  fireEvent.change(dialog.getByLabelText('ID'), { target: { value: 'blocked' } });
  expect(dialog.getByRole('button', { name: 'Add status' }).hasAttribute('disabled')).toBe(true);
  fireEvent.change(dialog.getByLabelText('ID'), { target: { value: 'new-id' } });
  fireEvent.change(dialog.getByLabelText('Name'), { target: { value: '  ' } });
  expect(dialog.getByRole('button', { name: 'Add status' }).hasAttribute('disabled')).toBe(true);
  expect(add).not.toHaveBeenCalled();
});

it('shows a return banner only for workflow navigation and passes its draft key back', () => {
  const fake = fakeManagement(); const back = vi.fn();
  const view = render(<StatusesScreen workspace={workspaceA} management={fake.api} />);
  expect(view.queryByText(/You came here from/)).toBeNull();
  const state = { returnTo: 'edit-workflow' as const, draftKey: 'draft-1' };
  view.rerender(<StatusesScreen workspace={workspaceA} management={fake.api} routeState={state} onReturn={back} />);
  fireEvent.click(view.getByRole('button', { name: /Back to Edit workflow/ }));
  expect(back).toHaveBeenCalledWith(state);
});

it('renames and confirms removal, showing users if removal is rejected', async () => {
  const fake = fakeManagement();
  fake.api.boardStatuses = vi.fn(async () => ({ ok: true, data: { sha256: 'sha', statuses: [
    { id: 'free', name: 'Free', kind: null, type: 'unused', usedBy: [], ticketCount: 0 },
  ] } }));
  const rename = vi.fn(async () => ({ ok: true as const, data: {} as never }));
  const remove = vi.fn(async () => ({ ok: false as const, error: { code: 'STATUS_IN_USE', message: 'in use', retryable: false, data: { usedBy: [{ workflow: 'dev', title: 'Develop' }], ticketCount: 2 } } }));
  fake.api.renameStatus = rename; fake.api.removeStatus = remove;
  const view = render(<StatusesScreen workspace={workspaceA} management={fake.api} />);
  await waitFor(() => expect(view.getByText('Free')).toBeTruthy());
  fireEvent.click(view.getByRole('button', { name: 'Rename' }));
  let dialog = within(view.getByRole('dialog'));
  fireEvent.change(dialog.getByLabelText('Name'), { target: { value: 'New name' } });
  fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(rename).toHaveBeenCalledWith('a', { id: 'free', name: 'New name', expectedSha256: 'sha' }));
  await waitFor(() => expect(view.queryByRole('dialog')).toBeNull());
  fireEvent.click(view.getByRole('button', { name: 'Remove' }));
  dialog = within(view.getByRole('dialog'));
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(dialog.getByRole('button', { name: 'Remove status' }));
  await waitFor(() => expect(dialog.getByRole('alert').textContent).toContain('Develop; 2 ticket(s)'));
  expect(remove).toHaveBeenCalledWith('a', { id: 'free', expectedSha256: 'sha' });
});

it('reorders the full list and reloads after a configuration conflict', async () => {
  const fake = fakeManagement();
  const read = vi.fn(async () => ({ ok: true as const, data: { sha256: 'sha', statuses: [
    { id: 'a', name: 'Alpha', kind: null, type: 'unused' as const, usedBy: [], ticketCount: 0 },
    { id: 'b', name: 'Beta', kind: null, type: 'unused' as const, usedBy: [], ticketCount: 0 },
  ] } }));
  const reorder = vi.fn(async () => ({ ok: false as const, error: { code: 'CONFIG_CHANGED', message: 'changed', retryable: false } }));
  fake.api.boardStatuses = read; fake.api.reorderStatuses = reorder;
  const view = render(<StatusesScreen workspace={workspaceA} management={fake.api} />);
  await waitFor(() => expect(view.getByText('Alpha')).toBeTruthy());
  const setData = vi.fn();
  fireEvent.dragStart(view.getByRole('button', { name: 'Drag Alpha to reorder' }), { dataTransfer: { setData } });
  expect(setData).toHaveBeenCalledWith('text/plain', 'a');
  fireEvent.drop(view.getByText('Beta').closest('tr')!);
  await waitFor(() => expect(reorder).toHaveBeenCalledWith('a', { ids: ['b', 'a'], expectedSha256: 'sha' }));
  await waitFor(() => expect(view.getByRole('alert').textContent).toContain('Statuses changed elsewhere - reload'));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
});

it('disables writes after a conflict when reloading fails and recovers on retry', async () => {
  const fake = fakeManagement();
  const read = vi.fn()
    .mockResolvedValueOnce({ ok: true, data: { sha256: 'old', statuses: [] } })
    .mockResolvedValueOnce({ ok: false, error: { code: 'ERROR', message: 'Reload failed', retryable: true } })
    .mockResolvedValueOnce({ ok: true, data: { sha256: 'new', statuses: [] } });
  fake.api.boardStatuses = read;
  const add = vi.fn()
    .mockResolvedValueOnce({ ok: false, error: { code: 'CONFIG_CHANGED', message: 'changed', retryable: false } })
    .mockResolvedValueOnce({ ok: true, data: {} });
  fake.api.addStatus = add;
  const view = render(<StatusesScreen workspace={workspaceA} management={fake.api} />);
  await waitFor(() => expect(view.getByText('No statuses found.')).toBeTruthy());
  fireEvent.click(view.getByText('+ Add status'));
  fireEvent.change(within(view.getByRole('dialog')).getByLabelText('Name'), { target: { value: 'Ready' } });
  fireEvent.click(within(view.getByRole('dialog')).getByRole('button', { name: 'Add status' }));
  await waitFor(() => expect(view.getByText(/Reload failed/)).toBeTruthy());
  expect(view.getByText('+ Add status').hasAttribute('disabled')).toBe(true);
  fireEvent.click(view.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(view.getByText('+ Add status').hasAttribute('disabled')).toBe(false));
  fireEvent.click(view.getByText('+ Add status'));
  fireEvent.change(within(view.getByRole('dialog')).getByLabelText('Name'), { target: { value: 'Ready' } });
  fireEvent.click(within(view.getByRole('dialog')).getByRole('button', { name: 'Add status' }));
  await waitFor(() => expect(add).toHaveBeenLastCalledWith('a', { id: 'ready', name: 'Ready', kind: 'none', expectedSha256: 'new' }));
});
