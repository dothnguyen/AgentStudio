// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  BoardRuleView,
  BoardSettings,
  BoardTicketList,
  BoardTicketSummary,
  Result,
  TicketActionResult,
} from '../src/renderer/api';
import { CurrentPhaseScreen } from '../src/renderer/boards/CurrentPhaseScreen';
import { boardPhasesFixture, boardTicketListFixture, boardTicketSummary } from './boardFixtures';
import { workspaceA } from './dashboardFixtures';
import { boardSettingsFixture, deferred, fakeManagement } from './teamsFixtures';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const STATUSES: BoardSettings['statuses'] = [
  { id: 'backlog', name: 'Backlog', kind: 'initial' },
  { id: 'dev-ready', name: 'Dev ready', kind: null },
  { id: 'qa-ready', name: 'QA ready', kind: null },
  { id: 'review-ready', name: 'Review ready', kind: null },
  { id: 'done', name: 'Done', kind: 'done' },
  { id: 'close', name: 'Closed', kind: 'closed' },
];

function rule(status: string, index: number): BoardRuleView {
  return {
    index, status, type: 'agent', role: 'Developer', workflow: 'board-develop', during: null, action: null,
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
    todoEntry: ['dev-ready'],
    todoDefault: 'dev-ready',
    rules: RULES,
    ...overrides,
  };
}

const TICKETS: BoardTicketSummary[] = [
  boardTicketSummary({ key: 'T-100', title: 'Backlog ticket', status: 'backlog', workflowStatus: 'backlog' }),
  boardTicketSummary({ key: 'T-101', title: 'Todo ticket', status: 'todo', workflowStatus: 'dev-ready' }),
];

const okR = <T,>(data: T) => ({ ok: true as const, data });

async function settle(): Promise<void> {
  await act(async () => {});
}

function ticketList(tickets: BoardTicketSummary[] = TICKETS): BoardTicketList {
  return boardTicketListFixture({ phase: 'phase-05', statuses: STATUSES.map((status) => status.id), tickets });
}

async function renderBoard(options: {
  overrides?: Partial<BoardSettings>;
  ticketMove?: ReturnType<typeof vi.fn>;
} = {}) {
  const fake = fakeManagement({
    boardPhases: [okR(boardPhasesFixture())],
    boardSettings: [okR(settings(options.overrides))],
    boardTickets: [okR(ticketList())],
    ...(options.ticketMove === undefined ? {} : { calls: { ticketMove: options.ticketMove } }),
  });
  const view = render(<CurrentPhaseScreen workspace={workspaceA} management={fake.api} refreshMs={0} />);
  await settle();
  return { view, fake };
}

function column(view: ReturnType<typeof render>, label: string): HTMLElement {
  return view.getByLabelText(`${label} column`);
}

function cardColumn(view: ReturnType<typeof render>, key: string): HTMLElement {
  return view.container.querySelector(`[data-ticket-key="${key}"]`)!.closest('.boards-column') as HTMLElement;
}

function openMove(view: ReturnType<typeof render>, key = 'T-100'): HTMLElement {
  fireEvent.click(view.getByRole('button', { name: `Move ${key}` }));
  return view.getByRole('dialog', { name: `Move ${key}` });
}

describe('Current Phase move control', () => {
  it('moves a Backlog ticket to Todo with the configured dev-ready status and updates the card in place', async () => {
    const move = vi.fn(async (): Promise<Result<TicketActionResult>> => ({
      ok: true,
      data: { ticket: { key: 'T-100', status: 'todo' } },
    }));
    const { view } = await renderBoard({ ticketMove: move });
    expect(column(view, 'Backlog').textContent).toContain('T-100');

    const dialog = openMove(view);
    expect((within(dialog).getByLabelText('Column') as HTMLSelectElement).value).toBe('todo');
    expect((within(dialog).getByLabelText('Workflow status') as HTMLSelectElement).value).toBe('dev-ready');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Move ticket' }));
    await settle();

    expect(move).toHaveBeenCalledWith(workspaceA.id, {
      key: 'T-100', to: 'todo', workflowStatus: 'dev-ready',
    });
    expect(view.queryByRole('dialog', { name: 'Move T-100' })).toBeNull();
    expect(cardColumn(view, 'T-100').getAttribute('data-status')).toBe('todo');
    expect(cardColumn(view, 'T-100').textContent).toContain('Dev ready');
  });

  it('moves a ticket to another valid destination chosen from the board settings', async () => {
    const move = vi.fn(async (): Promise<Result<TicketActionResult>> => ({
      ok: true,
      data: { ticket: { key: 'T-100', status: 'in-progress' } },
    }));
    const { view } = await renderBoard({ ticketMove: move });

    const dialog = openMove(view);
    fireEvent.change(within(dialog).getByLabelText('Column'), { target: { value: 'in-progress' } });
    expect((within(dialog).getByLabelText('Workflow status') as HTMLSelectElement).value).toBe('dev-ready');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Move ticket' }));
    await settle();

    expect(move).toHaveBeenCalledWith(workspaceA.id, {
      key: 'T-100', to: 'in-progress', workflowStatus: 'dev-ready',
    });
    expect(column(view, 'In Progress').textContent).toContain('T-100');
    expect(cardColumn(view, 'T-100').getAttribute('data-status')).toBe('in-progress');
  });

  it('cancels without sending a request', async () => {
    const move = vi.fn();
    const { view } = await renderBoard({ ticketMove: move });

    const dialog = openMove(view);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(view.queryByRole('dialog', { name: 'Move T-100' })).toBeNull();
    expect(move).not.toHaveBeenCalled();
    expect(column(view, 'Backlog').textContent).toContain('T-100');
  });

  it('disables destinations with no configured workflow status and explains why', async () => {
    const { view } = await renderBoard({ overrides: { todoEntry: [], todoDefault: null, rules: [] } });

    const dialog = openMove(view);
    const options = [...(within(dialog).getByLabelText('Column') as HTMLSelectElement).options];
    const byValue = Object.fromEntries(options.map((option) => [option.value, option]));

    expect((within(dialog).getByLabelText('Column') as HTMLSelectElement).value).toBe('done');
    expect(byValue.backlog!.disabled).toBe(true);
    expect(byValue.backlog!.textContent).toContain('already in Backlog');
    expect(byValue.todo!.disabled).toBe(true);
    expect(byValue.todo!.textContent).toContain('No workflow status is configured for Todo');
    expect(byValue['in-progress']!.disabled).toBe(true);
    expect(byValue['in-progress']!.textContent).toContain('No workflow rule is configured for In Progress');
    expect(within(dialog).getByLabelText('Workflow status').textContent).toBe('Done');
  });

  it('shows a backend failure and leaves the ticket in Backlog', async () => {
    const move = vi.fn(async (): Promise<Result<TicketActionResult>> => ({
      ok: false,
      error: {
        code: 'TICKET_TRANSITION_INVALID',
        message: 'Invalid column or workflow status transition.',
        retryable: false,
        remediation: 'Pick another column.',
      },
    }));
    const { view } = await renderBoard({ ticketMove: move });

    const dialog = openMove(view);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move ticket' }));
    const alert = await within(dialog).findByRole('alert');

    expect(alert.textContent).toContain('Invalid column or workflow status transition.');
    expect(alert.textContent).toContain('Pick another column.');
    expect(view.getByRole('dialog', { name: 'Move T-100' })).toBeTruthy();
    expect(column(view, 'Backlog').textContent).toContain('T-100');
    expect(column(view, 'Todo').textContent).not.toContain('T-100');
  });

  it('prevents duplicate submissions while the move is pending', async () => {
    const gate = deferred<Result<TicketActionResult>>();
    const move = vi.fn(() => gate.promise);
    const { view } = await renderBoard({ ticketMove: move });

    const dialog = openMove(view);
    const action = within(dialog).getByRole('button', { name: 'Move ticket' });
    fireEvent.click(action);
    fireEvent.click(action);
    expect(move).toHaveBeenCalledTimes(1);
    expect(action.hasAttribute('disabled')).toBe(true);

    await act(async () => {
      gate.resolve({ ok: true, data: { ticket: { key: 'T-100', status: 'todo' } } });
      await gate.promise;
    });
    await settle();

    expect(move).toHaveBeenCalledTimes(1);
    expect(view.queryByRole('dialog', { name: 'Move T-100' })).toBeNull();
    expect(column(view, 'Todo').textContent).toContain('T-100');
  });

  it('opens from the keyboard and returns focus to the move control on Escape', async () => {
    const user = userEvent.setup();
    const { view } = await renderBoard();
    const trigger = view.getByRole('button', { name: 'Move T-100' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');

    view.getByRole('button', { name: /Open T-100:/ }).focus();
    await user.tab();
    expect(document.activeElement).toBe(trigger);

    await user.keyboard('{Enter}');
    const dialog = view.getByRole('dialog', { name: 'Move T-100' });
    expect(within(dialog).getByLabelText('Column').tagName).toBe('SELECT');
    expect(within(dialog).getByLabelText('Workflow status').tagName).toBe('SELECT');

    await user.keyboard('{Escape}');
    expect(view.queryByRole('dialog', { name: 'Move T-100' })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
