// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MoveToTodoDialog, todoOptions } from '../src/renderer/boards/MoveToTodoDialog';
import { ticketActions } from '../src/renderer/boards/TicketScreen';
import { ticketEventRows } from '../src/renderer/boards/ticketPageModel';
import { boardSettingsFixture, fakeManagement } from './teamsFixtures';

afterEach(cleanup);
const settings = { ...boardSettingsFixture(), todoEntry: ['ready', 'review'], todoDefault: 'review', workflowStatuses: [{ id: 'ready', name: 'Ready for work', kind: null }, { id: 'review', name: 'Review', kind: null }] };

describe('workflow actions', () => {
  it('offers configured entry names and selects the default', () => {
    expect(todoOptions(settings)).toEqual([{ id: 'ready', name: 'Ready for work' }, { id: 'review', name: 'Review' }]);
    const view = render(<MoveToTodoDialog ticketKey="T-1" settings={settings} management={fakeManagement().api} workspaceId="ws" onClose={() => {}} onSuccess={() => {}} />);
    expect((view.getByLabelText('Workflow status') as HTMLSelectElement).value).toBe('review');
  });
  it('sends selected status and force for reopening, displaying backend errors', async () => {
    const move = vi.fn().mockResolvedValue({ ok: false, error: { message: 'Cannot move' } });
    const management = { ...fakeManagement().api, ticketMove: move };
    const view = render(<MoveToTodoDialog ticketKey="T-1" settings={settings} management={management} workspaceId="ws" force onClose={() => {}} onSuccess={() => {}} />);
    fireEvent.change(view.getByLabelText('Workflow status'), { target: { value: 'ready' } });
    fireEvent.click(view.getByRole('button', { name: 'Reopen' }));
    await waitFor(() => expect(view.getByRole('alert').textContent).toBe('Cannot move'));
    expect(move).toHaveBeenCalledWith('ws', { key: 'T-1', to: 'todo', workflowStatus: 'ready', force: true });
  });
  it('sends the selected entry status for an ordinary move to Todo', async () => {
    const move = vi.fn().mockResolvedValue({ ok: true, data: {} });
    const success = vi.fn();
    const view = render(<MoveToTodoDialog ticketKey="T-2" settings={settings} management={{ ...fakeManagement().api, ticketMove: move }} workspaceId="ws" onClose={() => {}} onSuccess={success} />);
    fireEvent.click(view.getByRole('button', { name: 'Move to Todo' }));
    await waitFor(() => expect(success).toHaveBeenCalledOnce());
    expect(move).toHaveBeenCalledWith('ws', { key: 'T-2', to: 'todo', workflowStatus: 'review' });
  });
  it('selects actions by column and claim', () => {
    for (const assignee of [null, 'agent']) {
      expect(ticketActions({ status: 'backlog', assignee })).toEqual(['Move to Todo']);
      for (const status of ['done', 'closed'] as const) expect(ticketActions({ status, assignee })).toEqual(['Reopen']);
    }
    for (const status of ['todo', 'in-progress'] as const) {
      expect(ticketActions({ status, assignee: null })).toEqual(['Change workflow status', 'Back to Backlog', 'Close']);
      expect(ticketActions({ status, assignee: 'agent' })).toEqual([]);
    }
  });
  it('renders workflow changes and migrations with their endpoints', () => {
    const events = ['ticket.workflow_changed', 'ticket.migrated'].map((name, id) => ({ id, name, at: '', actor: 'operator', from: 'old', to: 'new', payload: {} }));
    expect(ticketEventRows(events).map(row => [row.title, row.detail])).toEqual([['Workflow status changed', 'old → new'], ['Workflow status migrated', 'old → new']]);
  });
});
