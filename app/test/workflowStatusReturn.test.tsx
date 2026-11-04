// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceShell } from '../src/renderer/shell/WorkspaceShell';
import { fakeManagement } from './teamsFixtures';
import type { DashboardApi, Workspace } from '../src/renderer/api';

afterEach(cleanup);
const workspace: Workspace = { id: 'a', name: 'A', path: '/a', exists: true, missing: false };
const dashboard = {} as DashboardApi;

it.each(['add', 'edit'] as const)('returns to the same %s workflow draft and refreshes status choices', async mode => {
  const fake = fakeManagement();
  fake.api.boardWorkflows = async () => ({ ok: true, data: { workflows: [{ name: 'dev', title: 'Develop', startsAt: 'ready', whileRunning: 'working', role: 'worker', steps: [], end: {}, limits: {} }], problems: [] } });
  fake.api.boardWorkflow = async () => ({ ok: true, data: { name: 'dev', definition: { version: 2, title: 'Develop', startsAt: 'ready', whileRunning: 'working', role: 'worker', steps: [{ id: 'work', agent: { prompt: 'dev.md', access: 'write' } }] }, text: '', sha256: 'workflow-sha', problems: [], start: { allowed: false, default: false } } });
  let added = false;
  fake.api.boardStatuses = async () => ({ ok: true, data: { sha256: 'board-sha', statuses: added ? [{ id: 'new', name: 'New status', kind: null, type: 'unused', usedBy: [], ticketCount: 0 }] : [] } });
  fake.api.addStatus = vi.fn(async () => { added = true; return { ok: true, data: {} as never }; });
  const view = render(<WorkspaceShell workspace={workspace} dashboard={dashboard} management={fake.api} connection={{ state: 'connected', error: null, distro: null, command: 'serve' }} onSwitchWorkspace={() => {}} renderSection={id => id === 'home' ? <div>Home</div> : undefined} />);
  fireEvent.click(within(view.getByRole('navigation', { name: 'Workspace' })).getByRole('button', { name: 'Routing' }));
  await waitFor(() => expect(view.getByRole('button', { name: 'Edit Develop' })).toBeTruthy());
  fireEvent.click(view.getByRole('button', { name: mode === 'add' ? '+ Add workflow' : 'Edit Develop' }));
  await waitFor(() => expect(view.getByRole('heading', { name: mode === 'add' ? 'Add workflow' : 'Edit workflow: Develop' })).toBeTruthy());
  fireEvent.change(view.getByLabelText('Name'), { target: { value: 'Unsaved title' } });
  fireEvent.click(view.getByRole('button', { name: 'Manage statuses →' }));
  expect(view.getByText(/You came here from/).textContent).toContain(mode === 'add' ? 'Add workflow' : 'Edit workflow');
  await waitFor(() => expect(view.getByRole('button', { name: '+ Add status' }).hasAttribute('disabled')).toBe(false));
  fireEvent.click(view.getByRole('button', { name: '+ Add status' }));
  const dialog = within(view.getByRole('dialog'));
  fireEvent.change(dialog.getByLabelText('Name'), { target: { value: 'New status' } });
  fireEvent.change(dialog.getByLabelText('ID'), { target: { value: 'new' } });
  fireEvent.click(dialog.getByRole('button', { name: 'Add status' }));
  await waitFor(() => expect(view.queryByRole('dialog')).toBeNull());
  fireEvent.click(view.getByRole('button', { name: /Back to .* workflow/ }));
  expect((view.getByLabelText('Name') as HTMLInputElement).value).toBe('Unsaved title');
  await waitFor(() => expect(within(view.getByLabelText('Starts when a ticket is in')).getByRole('option', { name: 'New status' })).toBeTruthy());
  fireEvent.click(within(view.getByRole('navigation', { name: 'Workspace' })).getByRole('button', { name: 'Statuses' }));
  expect(view.queryByText(/You came here from/)).toBeNull();
});
