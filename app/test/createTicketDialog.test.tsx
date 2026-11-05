// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  BoardPhases,
  BoardPhase,
  BoardSettings,
  BoardTicket,
  BoardTicketList,
  BoardTicketSummary,
} from '../src/renderer/api';
import { BacklogScreen } from '../src/renderer/boards/BacklogScreen';
import { CurrentPhaseScreen } from '../src/renderer/boards/CurrentPhaseScreen';
import { DEFAULT_BACKLOG_FILTERS } from '../src/renderer/boards/backlogFilters';
import { boardTicketListFixture, boardTicketSummary } from './boardFixtures';
import { workspaceA } from './dashboardFixtures';
import { boardSettingsFixture, deferred, fakeManagement, managementError } from './teamsFixtures';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const ok = <T,>(data: T) => ({ ok: true as const, data });
const settle = () => act(async () => {});

const STATUSES: BoardSettings['statuses'] = [
  { id: 'backlog', name: 'Backlog', kind: 'initial' },
  { id: 'ready', name: 'Ready for dev', kind: null },
  { id: 'building', name: 'Building', kind: null },
  { id: 'done', name: 'Merged', kind: 'done' },
  { id: 'closed', name: 'Closed', kind: 'closed' },
];

function createSettings(): BoardSettings {
  return {
    ...boardSettingsFixture(),
    statuses: STATUSES,
    workflowStatuses: STATUSES,
    todoEntry: ['ready'],
    todoDefault: 'ready',
    rules: [{
      index: 0, status: 'ready', type: 'agent', role: 'Developer', workflow: 'develop', during: 'building',
      action: null, onPass: 'done', onFail: 'ready', onBlocked: null, workspace: 'worktree', syncBase: false,
      maxRounds: null, priority: null, onFailureLimit: null, protected: false,
    }],
  };
}

const PHASE_05: BoardPhase = {
  id: 'phase-05-id', slug: 'phase-05', name: 'Phase 05', description: null, position: 0, status: 'open',
  current: true, ticketCount: 1, counts: { backlog: 1 },
};
const PHASE_06: BoardPhase = {
  id: 'phase-06-id', slug: 'phase-06', name: 'Phase 06', description: null, position: 1, status: 'open',
  current: false, ticketCount: 0, counts: {},
};
const PHASES: BoardPhases = {
  workspace: workspaceA.id,
  currentPhase: PHASE_05,
  phases: [PHASE_05, PHASE_06],
};

function phaseTickets(tickets: BoardTicketSummary[], phase = PHASE_05.slug): BoardTicketList {
  return boardTicketListFixture({ phase, statuses: STATUSES.map((status) => status.id), tickets });
}

function createdTicket(overrides: Parameters<typeof boardTicketSummary>[0] = {}): BoardTicket {
  const summary = boardTicketSummary({
    key: 'T-201', title: 'Write docs', phase: PHASE_05.slug, status: 'todo', workflowStatus: 'ready', ...overrides,
  });
  const { dependsOn: _dependsOn, openDependsOn: _openDependsOn, ...ticket } = summary;
  return { ...ticket, body: 'The details' } as BoardTicket;
}

function createResult(ticket: BoardTicket) {
  return ok({
    ticket,
    phase: { id: PHASE_05.id, slug: PHASE_05.slug, name: PHASE_05.name, description: null, position: 0, status: 'open' as const },
  });
}

async function openCurrentTicketDialog(view: ReturnType<typeof render>): Promise<HTMLElement> {
  fireEvent.click(view.getByRole('button', { name: 'New ticket' }));
  await settle();
  return view.getByRole('dialog', { name: 'New ticket' });
}

async function openBacklogTicketDialog(view: ReturnType<typeof render>, name = 'New ticket'): Promise<HTMLElement> {
  fireEvent.click(view.getByRole('button', { name }));
  await settle();
  return view.getByRole('dialog', { name: 'New ticket' });
}

describe('ticket creation from Current Phase', () => {
  it('opens with the current phase and configured choices, focuses the title, and restores focus on Escape', async () => {
    const settings = createSettings();
    const fake = fakeManagement({
      boardSettings: [ok(settings)],
      boardPhases: [ok(PHASES)],
      boardTickets: [ok(phaseTickets([boardTicketSummary({ key: 'T-1', phase: PHASE_05.slug, status: 'backlog', workflowStatus: 'backlog' })]))],
    });
    const view = render(<CurrentPhaseScreen workspace={workspaceA} management={fake.api} refreshMs={0} />);
    await settle();

    const trigger = view.getByRole('button', { name: 'New ticket' });
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    const dialog = view.getByRole('dialog', { name: 'New ticket' });

    expect((within(dialog).getByLabelText('Phase') as HTMLSelectElement).value).toBe(PHASE_05.slug);
    expect(document.activeElement).toBe(within(dialog).getByLabelText('Title'));

    const column = within(dialog).getByLabelText('Column') as HTMLSelectElement;
    expect(Array.from(column.options).map((option) => option.textContent)).toEqual([
      'Backlog', 'Todo', 'In Progress', 'Done', 'Closed',
    ]);
    fireEvent.change(column, { target: { value: 'todo' } });
    expect((within(dialog).getByLabelText('Workflow status') as HTMLSelectElement).value).toBe('ready');
    expect(Array.from((within(dialog).getByLabelText('Workflow status') as HTMLSelectElement).options).map((option) => option.textContent))
      .toEqual(['Ready for dev']);
    fireEvent.change(column, { target: { value: 'done' } });
    expect(Array.from((within(dialog).getByLabelText('Workflow status') as HTMLSelectElement).options).map((option) => option.textContent))
      .toEqual(['Merged']);
    fireEvent.change(column, { target: { value: 'closed' } });
    expect(Array.from((within(dialog).getByLabelText('Workflow status') as HTMLSelectElement).options).map((option) => option.textContent))
      .toEqual(['Closed']);

    await userEvent.keyboard('{Escape}');
    expect(view.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('creates a ticket with every entered field and inserts it into the current phase without a reload', async () => {
    const existing = boardTicketSummary({ key: 'T-1', title: 'Existing', phase: PHASE_05.slug, status: 'backlog', workflowStatus: 'backlog' });
    const createTicket = vi.fn(async () => createResult(createdTicket()));
    const fake = fakeManagement({
      boardSettings: [ok(createSettings())],
      boardPhases: [ok(PHASES)],
      boardTickets: [ok(phaseTickets([existing]))],
      calls: { createTicket },
    });
    const view = render(<CurrentPhaseScreen workspace={workspaceA} management={fake.api} refreshMs={0} />);
    await settle();
    const dialog = await openCurrentTicketDialog(view);

    fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: '  Write docs  ' } });
    fireEvent.change(within(dialog).getByLabelText('Description'), { target: { value: 'The details' } });
    fireEvent.change(within(dialog).getByLabelText('Priority'), { target: { value: '25' } });
    fireEvent.change(within(dialog).getByLabelText('Column'), { target: { value: 'todo' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create ticket' }));
    await settle();

    expect(createTicket).toHaveBeenCalledWith(workspaceA.id, {
      title: 'Write docs', body: 'The details', priority: 25, phase: PHASE_05.slug, status: 'todo', workflowStatus: 'ready',
    });
    expect(view.queryByRole('dialog')).toBeNull();
    expect(view.getByRole('button', { name: 'Open T-1: Existing' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'Open T-201: Write docs' })).toBeTruthy();
    expect(fake.boardTickets).toHaveBeenCalledTimes(1);
  });

  it('does not offer closed phases and explains columns without a configured status', async () => {
    const closed: BoardPhase = { ...PHASE_06, id: 'phase-07-id', slug: 'phase-07', name: 'Closed phase', status: 'closed' };
    const settings: BoardSettings = { ...createSettings(), todoEntry: [], todoDefault: null, rules: [] };
    const fake = fakeManagement({
      boardSettings: [ok(settings)],
      boardPhases: [ok({ ...PHASES, phases: [PHASE_05, PHASE_06, closed] })],
      boardTickets: [ok(phaseTickets([]))],
    });
    const view = render(<CurrentPhaseScreen workspace={workspaceA} management={fake.api} refreshMs={0} />);
    await settle();
    const dialog = await openCurrentTicketDialog(view);

    expect(Array.from((within(dialog).getByLabelText('Phase') as HTMLSelectElement).options).map((option) => option.textContent))
      .toEqual(['Phase 05', 'Phase 06']);
    const todo = (within(dialog).getByLabelText('Column') as HTMLSelectElement).querySelector('option[value="todo"]') as HTMLOptionElement;
    expect(todo.disabled).toBe(true);
    expect(todo.textContent).toContain('No workflow status is configured for Todo.');
  });

  it('shows required-field errors inline without losing the rest of the form', async () => {
    const createTicket = vi.fn();
    const fake = fakeManagement({
      boardSettings: [ok(createSettings())],
      boardPhases: [ok(PHASES)],
      boardTickets: [ok(phaseTickets([]))],
      calls: { createTicket },
    });
    const view = render(<CurrentPhaseScreen workspace={workspaceA} management={fake.api} refreshMs={0} />);
    await settle();
    const dialog = await openCurrentTicketDialog(view);

    fireEvent.change(within(dialog).getByLabelText('Description'), { target: { value: 'Keep me' } });
    fireEvent.change(within(dialog).getByLabelText('Priority'), { target: { value: '2000' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create ticket' }));
    await settle();

    expect(within(dialog).getByText('Title is required.')).toBeTruthy();
    expect(within(dialog).getByText('Priority must be a whole number from 0 to 1000.')).toBeTruthy();
    expect((within(dialog).getByLabelText('Description') as HTMLTextAreaElement).value).toBe('Keep me');
    expect((within(dialog).getByLabelText('Priority') as HTMLInputElement).value).toBe('2000');
    expect(createTicket).not.toHaveBeenCalled();
  });
});

describe('ticket creation from Backlog', () => {
  it('opens from a phase group with that phase as context and from the header with the current phase', async () => {
    const fake = fakeManagement({
      boardSettings: [ok(createSettings())],
      boardPhases: [ok(PHASES)],
      boardTickets: [ok(phaseTickets([]))],
    });
    const view = render(<BacklogScreen workspace={workspaceA} management={fake.api} refreshMs={0} />);
    await settle();

    const groupTrigger = view.getByRole('button', { name: 'New ticket in Phase 06' });
    const firstDialog = await openBacklogTicketDialog(view, 'New ticket in Phase 06');
    expect((within(firstDialog).getByLabelText('Phase') as HTMLSelectElement).value).toBe(PHASE_06.slug);
    fireEvent.click(within(firstDialog).getByRole('button', { name: 'Cancel' }));
    expect(view.queryByRole('dialog')).toBeNull();

    groupTrigger.focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard('{Escape}');
    expect(document.activeElement).toBe(groupTrigger);

    const headerDialog = await openBacklogTicketDialog(view);
    expect((within(headerDialog).getByLabelText('Phase') as HTMLSelectElement).value).toBe(PHASE_05.slug);
    expect(Array.from((within(headerDialog).getByLabelText('Phase') as HTMLSelectElement).options).map((option) => option.textContent))
      .toEqual(['Phase 05', 'Phase 06']);
  });

  it('adds the created ticket to the loaded phase without clearing or reloading other rows', async () => {
    const existing = boardTicketSummary({ key: 'T-1', title: 'Existing', phase: PHASE_05.slug, status: 'backlog', workflowStatus: 'backlog' });
    const createTicket = vi.fn(async () => createResult(createdTicket()));
    const fake = fakeManagement({
      boardSettings: [ok(createSettings())],
      boardPhases: [ok(PHASES)],
      boardTickets: [ok(phaseTickets([existing]))],
      calls: { createTicket },
    });
    const view = render(<BacklogScreen workspace={workspaceA} management={fake.api} refreshMs={0} />);
    await settle();
    const existingRow = view.getByRole('button', { name: 'Open T-1: Existing' });
    const dialog = await openBacklogTicketDialog(view);

    fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: 'Write docs' } });
    fireEvent.change(within(dialog).getByLabelText('Column'), { target: { value: 'todo' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create ticket' }));
    await settle();

    expect(view.getByRole('button', { name: 'Open T-1: Existing' })).toBe(existingRow);
    expect(view.getByRole('button', { name: 'Open T-201: Write docs' })).toBeTruthy();
    expect(fake.boardTickets).toHaveBeenCalledTimes(1);
  });

  it('applies active filters to the reconciled ticket', async () => {
    const existing = boardTicketSummary({ key: 'T-1', title: 'Existing', phase: PHASE_05.slug, status: 'backlog', workflowStatus: 'backlog' });
    const createTicket = vi.fn(async () => createResult(createdTicket()));
    const fake = fakeManagement({
      boardSettings: [ok(createSettings())],
      boardPhases: [ok(PHASES)],
      boardTickets: [ok(phaseTickets([existing]))],
      calls: { createTicket },
    });
    const view = render(
      <BacklogScreen
        workspace={workspaceA}
        management={fake.api}
        refreshMs={0}
        filters={{ ...DEFAULT_BACKLOG_FILTERS, columns: ['backlog'] }}
      />,
    );
    await settle();
    const dialog = await openBacklogTicketDialog(view);

    fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: 'Write docs' } });
    fireEvent.change(within(dialog).getByLabelText('Column'), { target: { value: 'todo' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create ticket' }));
    await settle();

    expect(view.getByRole('button', { name: 'Open T-1: Existing' })).toBeTruthy();
    expect(view.queryByRole('button', { name: 'Open T-201: Write docs' })).toBeNull();
  });

  it('keeps the form values and shows the backend error inline', async () => {
    const createTicket = vi.fn(async () => managementError('TICKET_DUPLICATE', 'An open ticket with this title already exists (T-1).', 'Change the title.'));
    const fake = fakeManagement({
      boardSettings: [ok(createSettings())],
      boardPhases: [ok(PHASES)],
      boardTickets: [ok(phaseTickets([]))],
      calls: { createTicket },
    });
    const view = render(<BacklogScreen workspace={workspaceA} management={fake.api} refreshMs={0} />);
    await settle();
    const dialog = await openBacklogTicketDialog(view);

    fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: 'Existing' } });
    fireEvent.change(within(dialog).getByLabelText('Description'), { target: { value: 'Do not lose me' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create ticket' }));
    await settle();

    expect(view.getByRole('dialog', { name: 'New ticket' })).toBe(dialog);
    expect(within(dialog).getByRole('alert').textContent).toContain('An open ticket with this title already exists (T-1).');
    expect(within(dialog).getByRole('alert').textContent).toContain('Change the title.');
    expect((within(dialog).getByLabelText('Title') as HTMLInputElement).value).toBe('Existing');
    expect((within(dialog).getByLabelText('Description') as HTMLTextAreaElement).value).toBe('Do not lose me');
  });

  it('prevents duplicate submissions while creation is pending', async () => {
    const gate = deferred<ReturnType<typeof createResult>>();
    const createTicket = vi.fn(() => gate.promise);
    const fake = fakeManagement({
      boardSettings: [ok(createSettings())],
      boardPhases: [ok(PHASES)],
      boardTickets: [ok(phaseTickets([]))],
      calls: { createTicket },
    });
    const view = render(<BacklogScreen workspace={workspaceA} management={fake.api} refreshMs={0} />);
    await settle();
    const dialog = await openBacklogTicketDialog(view);

    fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: 'Write docs' } });
    const submit = within(dialog).getByRole('button', { name: 'Create ticket' });
    fireEvent.click(submit);
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(createTicket).toHaveBeenCalledTimes(1);
    expect(submit.hasAttribute('disabled')).toBe(true);

    await act(async () => { gate.resolve(createResult(createdTicket())); await gate.promise; });
    await settle();
    expect(view.queryByRole('dialog')).toBeNull();
    expect(view.getByRole('button', { name: 'Open T-201: Write docs' })).toBeTruthy();
  });

  it('cancels without writing when the header action is dismissed', async () => {
    const createTicket = vi.fn();
    const fake = fakeManagement({
      boardSettings: [ok(createSettings())],
      boardPhases: [ok(PHASES)],
      boardTickets: [ok(phaseTickets([]))],
      calls: { createTicket },
    });
    const view = render(<BacklogScreen workspace={workspaceA} management={fake.api} refreshMs={0} />);
    await settle();
    const trigger = view.getByRole('button', { name: 'New ticket' });
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.click(view.getByRole('button', { name: 'Cancel' }));
    expect(createTicket).not.toHaveBeenCalled();
    expect(view.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
