// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RoutingScreen } from '../src/renderer/routing/RoutingScreen';
import { boardSettingsFixture, fakeManagement, routingSettingsFixture } from './teamsFixtures';
import { workspaceA } from './dashboardFixtures';
import fixture from './fixtures/convertedBoard.json';
import type { BoardStatuses } from '../src/shared/management';
afterEach(() => { cleanup(); sessionStorage.clear(); });
function setup(empty = false, callbacks: { onAdd?(): void; onEdit?(name: string): void; onStatuses?(): void } = {}, board = fixture.board) {
  const base = fakeManagement().api;
  const management = { ...base,
    boardSettings: vi.fn().mockResolvedValue({ ok: true, data: { ...routingSettingsFixture(), ...fixture.starts } }),
    boardStatuses: vi.fn().mockResolvedValue({ ok: true, data: fixture.statuses as BoardStatuses }),
    boardWorkflows: vi.fn().mockResolvedValue({ ok: true, data: empty ? { workflows: [], problems: [] } : board }),
    boardWorkflow: vi.fn().mockImplementation((_workspace: string, name: string) => Promise.resolve({ ok: true, data: fixture.details.find(d => d.name === name) })),
  };
  return render(<RoutingScreen workspace={workspaceA} management={management} onStatuses={callbacks.onStatuses ?? vi.fn()} onAdd={callbacks.onAdd} onEdit={callbacks.onEdit} />);
}
it('renders grouped workflow cards with pickup, steps and outcomes and supports collapse and filtering', async () => {
  const view = setup();
  await view.findByText('Main path');
  expect(view.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  expect(view.getByRole('region', { name: 'Workspace board routing' })).toBeTruthy();
  expect(view.queryByRole('list', { name: 'Routing transitions' })).toBeNull();
  expect(view.getByText(/workflows · /)).toBeTruthy();
  expect(view.getByText('Detours')).toBeTruthy();
  const card = view.getByRole('button', { name: /Develop.*board-develop.yaml/ }).closest('article')!;
  expect(within(card).getByText('Picks up')).toBeTruthy();
  expect(within(card).getByText('Steps')).toBeTruthy();
  expect(within(card).getByText('Ends')).toBeTruthy();
  expect(within(card).getByText('Limits')).toBeTruthy();
  fireEvent.click(within(card).getByRole('button', { name: /^Develop/ }));
  expect(within(card).queryByText('Picks up')).toBeNull();
  fireEvent.click(view.getByText('Expand all'));
  expect(within(card).getByText('Picks up')).toBeTruthy();
  fireEvent.click(view.getByText('Collapse all'));
  expect(within(card).queryByText('Picks up')).toBeNull();
  fireEvent.change(view.getByLabelText('Filter workflows'), { target: { value: 'develop' } });
  expect(view.queryByText('Unpack')).toBeNull();
  fireEvent.change(view.getByLabelText('Filter workflows'), { target: { value: 'no-such-workflow' } });
  expect(view.getByText('No workflows match the filter.')).toBeTruthy();
});
it('wires add workflow, edit workflow and manage statuses actions', async () => {
  const onAdd = vi.fn();
  const onEdit = vi.fn();
  const onStatuses = vi.fn();
  const view = setup(false, { onAdd, onEdit, onStatuses });
  await view.findByText('Main path');
  fireEvent.click(view.getByRole('button', { name: '+ Add workflow' }));
  expect(onAdd).toHaveBeenCalledOnce();
  fireEvent.click(view.getByRole('button', { name: 'Edit Develop' }));
  expect(onEdit).toHaveBeenCalledWith('board-develop');
  fireEvent.click(view.getByRole('button', { name: /Manage statuses \(\d+\) →/ }));
  expect(onStatuses).toHaveBeenCalledOnce();
});
it('hides the worktrees button when no workflow works in a worktree', async () => {
  const noWorktree = { ...fixture.board, workflows: fixture.board.workflows.map(workflow => ({ ...workflow, workspace: 'main' })) };
  const view = setup(false, {}, noWorktree);
  await view.findByText('Main path');
  expect(view.queryByRole('button', { name: /Worktrees:/ })).toBeNull();
});
it('renders an empty board', async () => {
  const view = setup(true);
  expect(await view.findByText('A new board with no workflows yet')).toBeTruthy();
});
it('opens the worktree dialog and restores focus when cancelled', async () => {
  const view = setup();
  const button = await view.findByRole('button', { name: /Worktrees:/ });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
  const dialog = view.getByRole('dialog');
  expect(within(dialog).getByLabelText('Base branch')).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(view.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(button);
});
it('retains card expansion when the screen is reopened in the same session', async () => {
  const first = setup();
  const toggle = await first.findByRole('button', { name: /Develop.*board-develop.yaml/ });
  fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  first.unmount();
  const second = setup();
  expect((await second.findByRole('button', { name: /Develop.*board-develop.yaml/ })).getAttribute('aria-expanded')).toBe('false');
});
it('shows unreachable workflows and a problem banner', async () => {
  const base = fakeManagement().api;
  const lost = { ...fixture.board.workflows[0]!, name: 'lost', title: 'Lost', startsAt: 'unreachable' };
  const management = { ...base, boardSettings: vi.fn().mockResolvedValue({ ok: true, data: { ...boardSettingsFixture(), ...fixture.starts } }), boardStatuses: vi.fn().mockResolvedValue({ ok: true, data: fixture.statuses }), boardWorkflows: vi.fn().mockResolvedValue({ ok: true, data: { workflows: [lost], problems: [] } }), boardWorkflow: vi.fn().mockResolvedValue({ ok: false, error: { code: 'NOT_FOUND', message: 'missing' } }) };
  const view = render(<RoutingScreen workspace={workspaceA} management={management} />);
  await waitFor(() => expect(view.getByRole('alert').textContent).toContain('Lost'));
  expect(view.getByText('Not reachable')).toBeTruthy();
});
