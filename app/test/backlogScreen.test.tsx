// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BACKLOG_FILTERS } from '../src/renderer/boards/backlogFilters';
import { BacklogScreen } from '../src/renderer/boards/BacklogScreen';
import { boardPhasesFixture, boardTicketListFixture, boardTicketSummary } from './boardFixtures';
import { workspaceA } from './dashboardFixtures';
import { boardSettingsFixture, deferred, fakeManagement, managementError } from './teamsFixtures';

afterEach(() => { cleanup(); vi.useRealTimers(); });
const ok = <T,>(data: T) => ({ ok: true as const, data });
const list = (count: number) => boardTicketListFixture({ tickets: Array.from({ length: count }, (_, i) => boardTicketSummary({ key: `T-${i}`, phase: 'phase-05' })) });
const settle = () => act(async () => {});

describe('BacklogScreen', () => {
  it('exposes a keyboard reachable action menu and submits a confirmed phase change', async () => {
    const ticketPhase = vi.fn(async () => ok({ ticket: { key: 'T-21', status: 'todo' } }));
    const fake = fakeManagement({ boardTickets: [ok(boardTicketListFixture({ tickets: [boardTicketSummary({ key: 'T-21', phase: 'phase-05' })] }))], calls: { ticketPhase } });
    const view = render(<BacklogScreen workspace={workspaceA} management={fake.api} refreshMs={0} />);
    await settle();
    const menu = view.getByRole('button', { name: 'Actions for T-21' });
    menu.focus();
    await userEvent.keyboard('{Enter}');
    expect(view.getByRole('group', { name: 'T-21 actions' })).toBeTruthy();
    await userEvent.click(view.getByRole('button', { name: 'Change phase' }));
    expect(view.getByRole('dialog', { name: /Change phase for T-21/ })).toBeTruthy();
    fireEvent.change(view.getByLabelText('Phase'), { target: { value: 'phase-06' } });
    fireEvent.click(view.getByRole('button', { name: 'Move ticket' }));
    await settle();
    expect(ticketPhase).toHaveBeenCalledWith(workspaceA.id, { key: 'T-21', phase: 'phase-06' });
    expect(view.queryByRole('dialog')).toBeNull();
  });

  it('cancels a phase change without calling the backend', async () => {
    const ticketPhase = vi.fn();
    const fake = fakeManagement({ boardTickets: [ok(boardTicketListFixture({ tickets: [boardTicketSummary({ key: 'T-22', phase: 'phase-05' })] }))], calls: { ticketPhase } });
    const view = render(<BacklogScreen workspace={workspaceA} management={fake.api} refreshMs={0} />);
    await settle();
    fireEvent.click(view.getByRole('button', { name: 'Actions for T-22' }));
    fireEvent.click(view.getByRole('button', { name: 'Change phase' }));
    fireEvent.change(view.getByLabelText('Phase'), { target: { value: 'phase-06' } });
    fireEvent.click(view.getByRole('button', { name: 'Cancel' }));
    expect(ticketPhase).not.toHaveBeenCalled();
    expect(view.queryByRole('dialog')).toBeNull();
  });

  it('moves a ticket into an already loaded phase without clearing its neighbours', async () => {
    const move = vi.fn(async () => ok({ ticket: { key: 'T-21', status: 'todo' } }));
    const fake = fakeManagement({ boardTickets: [ok(boardTicketListFixture({ tickets: [boardTicketSummary({ key: 'T-21', phase: 'phase-05' })] })), ok(boardTicketListFixture({ tickets: [boardTicketSummary({ key: 'T-22', phase: 'phase-06' })] }))], calls: { ticketPhase: move } });
    const view = render(<BacklogScreen workspace={workspaceA} management={fake.api} refreshMs={0} />);
    await settle();
    fireEvent.click(view.getByRole('button', { name: /Phase 06 .*tickets/ }));
    await settle();
    const gate = deferred<ReturnType<typeof ok<ReturnType<typeof boardPhasesFixture>>>>();
    fake.boardPhases.mockImplementation(() => gate.promise);
    fireEvent.click(view.getByRole('button', { name: 'Actions for T-21' }));
    fireEvent.click(view.getByRole('button', { name: 'Change phase' }));
    fireEvent.change(view.getByLabelText('Phase'), { target: { value: 'phase-06' } });
    fireEvent.click(view.getByRole('button', { name: 'Move ticket' }));
    await settle();
    const row = view.getByRole('button', { name: /Open T-21/ });
    expect(row.closest('section')?.textContent).toContain('Phase 06');
    expect(row.closest('section')?.textContent).toContain('T-22');
  });

  it('updates a column and workflow together, respects filters, and preserves other rows', async () => {
    const statuses = [{ id: 'new', name: 'New', kind: 'initial' as const }, { id: 'ready', name: 'Ready', kind: null }, { id: 'review', name: 'Review', kind: null }];
    const settings = { ...boardSettingsFixture(), statuses, workflowStatuses: statuses, todoEntry: ['ready', 'review'], todoDefault: 'ready' };
    const gate = deferred<ReturnType<typeof ok<ReturnType<typeof boardPhasesFixture>>>>();
    const move = vi.fn(async () => ok({ ticket: { key: 'T-21', status: 'todo' } }));
    const fake = fakeManagement({ boardSettings: [ok(settings)], boardTickets: [ok(boardTicketListFixture({ tickets: [boardTicketSummary({ key: 'T-21', phase: 'phase-05', status: 'backlog', workflowStatus: 'new' }), boardTicketSummary({ key: 'T-22', phase: 'phase-05', status: 'backlog', workflowStatus: 'new' })] }))], calls: { ticketMove: move } });
    const view = render(<BacklogScreen workspace={workspaceA} management={fake.api} refreshMs={0} filters={{ ...DEFAULT_BACKLOG_FILTERS, columns: ['backlog'] }} />);
    await settle();
    fake.boardPhases.mockImplementation(() => gate.promise);
    fireEvent.click(view.getByRole('button', { name: 'Actions for T-21' }));
    fireEvent.click(view.getByRole('button', { name: 'Change column or workflow status' }));
    fireEvent.change(view.getByLabelText('Workflow status'), { target: { value: 'review' } });
    fireEvent.click(view.getByRole('button', { name: 'Move ticket' }));
    await settle();
    expect(move).toHaveBeenCalledWith(workspaceA.id, { key: 'T-21', to: 'todo', workflowStatus: 'review' });
    expect(view.queryByRole('button', { name: /Open T-21/ })).toBeNull();
    expect(view.getByRole('button', { name: /Open T-22/ })).toBeTruthy();
  });

  it('retries a failed workflow-only change without duplicate submissions', async () => {
    const statuses = [{ id: 'ready', name: 'Ready', kind: null }, { id: 'review', name: 'Review', kind: null }];
    const settings = { ...boardSettingsFixture(), statuses, workflowStatuses: statuses, todoEntry: ['ready'], todoDefault: 'ready' };
    const gate = deferred<any>();
    const workflow = vi.fn().mockResolvedValueOnce(managementError('FAILED', 'Try again')).mockReturnValueOnce(gate.promise);
    const fake = fakeManagement({ boardSettings: [ok(settings)], boardTickets: [ok(boardTicketListFixture({ tickets: [boardTicketSummary({ key: 'T-21', phase: 'phase-05', status: 'todo', workflowStatus: 'ready' })] }))], calls: { ticketWorkflow: workflow } });
    const view = render(<BacklogScreen workspace={workspaceA} management={fake.api} refreshMs={0} />);
    await settle();
    fireEvent.click(view.getByRole('button', { name: 'Actions for T-21' }));
    fireEvent.click(view.getByRole('button', { name: 'Change column or workflow status' }));
    fireEvent.change(view.getByLabelText('Column'), { target: { value: 'todo' } });
    fireEvent.change(view.getByLabelText('Workflow status'), { target: { value: 'review' } });
    const submit = view.getByRole('button', { name: 'Move ticket' });
    fireEvent.click(submit);
    await settle();
    expect(view.getByRole('alert').textContent).toContain('Try again');
    expect(view.getByRole('button', { name: /Open T-21/ }).textContent).toContain('Ready');
    fireEvent.click(submit); fireEvent.click(submit);
    expect(workflow).toHaveBeenCalledTimes(2);
    expect(workflow).toHaveBeenLastCalledWith(workspaceA.id, { key: 'T-21', to: 'review' });
    await act(async () => { gate.resolve(ok({ ticket: { key: 'T-21', status: 'todo' } })); await gate.promise; });
  });

  it('returns focus to the action trigger when a dialog is cancelled with Escape', async () => {
    const fake = fakeManagement({ boardTickets: [ok(boardTicketListFixture({ tickets: [boardTicketSummary({ key: 'T-21', phase: 'phase-05' })] }))] });
    const view = render(<BacklogScreen workspace={workspaceA} management={fake.api} refreshMs={0} />);
    await settle();
    const trigger = view.getByRole('button', { name: 'Actions for T-21' });
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.click(view.getByRole('button', { name: 'Change phase' }));
    await userEvent.keyboard('{Escape}');
    expect(document.activeElement).toBe(trigger);
  });

  it('shows and loads only selected phases, reuses their cache and restores default expansion', async () => {
    const phaseTicket = (key: string, phase: string) => ok(boardTicketListFixture({ tickets: [boardTicketSummary({ key, phase })] }));
    const fake = fakeManagement({ boardTickets: [phaseTicket('T-1', 'phase-05'), phaseTicket('T-2', 'phase-06')] });
    const view = render(<BacklogScreen workspace={workspaceA} management={fake.api} refreshMs={0} />);
    await settle();
    fireEvent.click(view.getByRole('button', { name: 'Phase' }));
    fireEvent.click(view.getByLabelText('Phase 06'));
    await settle();
    expect(view.queryByRole('button', { name: /Phase 05 Current/ })).toBeNull();
    expect(view.queryByRole('button', { name: /No phase/ })).toBeNull();
    expect(view.getByRole('button', { name: /Phase 06 .*tickets/ }).getAttribute('aria-expanded')).toBe('true');
    expect(view.getByRole('button', { name: /Open T-2/ })).toBeTruthy();
    expect(fake.boardTickets.mock.calls).toEqual([[workspaceA.id, { phase: 'phase-05' }], [workspaceA.id, { phase: 'phase-06' }]]);
    fireEvent.click(view.getByLabelText('Phase 05'));
    await settle();
    expect(view.getByRole('button', { name: /Phase 05 Current/ }).getAttribute('aria-expanded')).toBe('true');
    expect(view.getByRole('button', { name: /Phase 06 .*tickets/ }).getAttribute('aria-expanded')).toBe('true');
    expect(view.getByRole('button', { name: /Open T-1/ })).toBeTruthy();
    expect(view.getByRole('button', { name: /Open T-2/ })).toBeTruthy();
    expect(view.queryByRole('button', { name: /No phase/ })).toBeNull();
    expect(view.getByTestId('backlog-body').querySelectorAll('.boards-backlog-group')).toHaveLength(2);
    expect(fake.boardTickets).toHaveBeenCalledTimes(2);
    fireEvent.click(view.getByLabelText('Phase 06'));
    expect(view.queryByRole('button', { name: /Phase 06 .*tickets/ })).toBeNull();
    fireEvent.click(view.getByLabelText('Phase 06'));
    await settle();
    expect(view.getByRole('button', { name: /Open T-2/ })).toBeTruthy();
    expect(fake.boardTickets).toHaveBeenCalledTimes(2);
    fireEvent.click(view.getByRole('button', { name: 'Clear all' }));
    expect(view.getByRole('button', { name: /Phase 05 Current/ }).getAttribute('aria-expanded')).toBe('true');
    expect(view.getByRole('button', { name: /Phase 06 .*tickets/ }).getAttribute('aria-expanded')).toBe('false');
    expect(view.getByRole('button', { name: /No phase/ }).getAttribute('aria-expanded')).toBe('false');
  });

  it('loads unassigned tickets on expansion, counts them initially and caches them', async () => {
    const phases = boardPhasesFixture({ unassignedTicketCount: 1 });
    const count = phases.phases.reduce((sum, phase) => sum + phase.ticketCount, 0);
    const unassigned = boardTicketSummary({ key: 'T-99', phase: null });
    const assigned = boardTicketSummary({ key: 'T-98', phase: 'phase-05' });
    const fake = fakeManagement({ boardPhases: [ok(phases)], boardTickets: [ok(boardTicketListFixture({ tickets: [assigned] })), ok(boardTicketListFixture({ tickets: [unassigned] }))] });
    const onTicketCount = vi.fn();
    const view = render(<BacklogScreen workspace={workspaceA} management={fake.api} onTicketCount={onTicketCount} refreshMs={0} />);
    await settle();
    const group = view.getByRole('button', { name: /No phase 1 tickets/ });
    expect(group.getAttribute('aria-expanded')).toBe('false');
    expect(view.queryByRole('button', { name: /Open T-99/ })).toBeNull();
    expect(view.getByText(`${count + 1} tickets`)).toBeTruthy();
    expect(onTicketCount).toHaveBeenLastCalledWith(count + 1);
    expect(fake.boardTickets.mock.calls).toEqual([[workspaceA.id, { phase: 'phase-05' }]]);
    fireEvent.click(group);
    await settle();
    expect(fake.boardTickets.mock.calls).toEqual([[workspaceA.id, { phase: 'phase-05' }], [workspaceA.id, { unassigned: true }]]);
    expect(fake.boardTickets.mock.calls.some(([, input]) => Object.keys(input as object).length === 0)).toBe(false);
    expect(view.getByRole('button', { name: /Open T-99/ })).toBeTruthy();
    expect(view.getAllByRole('button', { name: /Open T-98/ })).toHaveLength(1);
    fireEvent.click(group);
    fireEvent.click(group);
    await settle();
    expect(fake.boardTickets).toHaveBeenCalledTimes(2);
  });
  it('retries and refreshes the unassigned group after it has been loaded', async () => {
    const unassigned = (key: string) => ok(boardTicketListFixture({ tickets: [boardTicketSummary({ key, phase: null })] }));
    const fake = fakeManagement({ boardPhases: [ok(boardPhasesFixture({ unassignedTicketCount: 1 }))], boardTickets: [ok(list(1)), managementError('DOWN', 'Unavailable'), unassigned('T-99'), ok(list(1)), unassigned('T-100')] });
    const view = render(<BacklogScreen workspace={workspaceA} management={fake.api} refreshMs={0} />);
    await settle();
    fireEvent.click(view.getByRole('button', { name: /No phase/ }));
    await settle();
    expect(view.getByRole('alert').textContent).toContain('DOWN');
    fireEvent.click(view.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(view.getByRole('button', { name: /Open T-99/ })).toBeTruthy();
    await act(async () => { window.dispatchEvent(new Event('board-changed')); });
    await settle();
    expect(fake.boardTickets.mock.calls.slice(-2)).toEqual([[workspaceA.id, { phase: 'phase-05' }], [workspaceA.id, { unassigned: true }]]);
    expect(view.getByRole('button', { name: /Open T-100/ })).toBeTruthy();
  });
  it('limits initially rendered rows for a 300 ticket backlog and removes collapsed rows', async () => {
    const tickets = Array.from({ length: 300 }, (_, i) => boardTicketSummary({ key: `T-${i}`, phase: 'phase-05' }));
    const view = render(<BacklogScreen workspace={workspaceA} management={fakeManagement({ boardTickets: [ok(boardTicketListFixture({ tickets }))] }).api} />);
    await settle();
    expect(view.container.querySelectorAll('.boards-backlog-row')).toHaveLength(50);
    expect(view.getByRole('button', { name: 'Show 250 more' })).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: /Phase 05 Current/ }));
    expect(view.container.querySelectorAll('.boards-backlog-row')).toHaveLength(0);
  });

  it('loads only the current phase, then caches phases expanded by the operator', async () => {
    const phases = boardPhasesFixture();
    phases.phases[0] = { ...phases.phases[0]!, ticketCount: 1, counts: { done: 1, blocked: 0 } };
    phases.phases[1] = { ...phases.phases[1]!, ticketCount: 1, counts: { blocked: 1 } };
    const fake = fakeManagement({ boardPhases: [ok(phases)], boardTickets: [ok(boardTicketListFixture({ tickets: [boardTicketSummary({ key: 'T-1', phase: 'phase-05' })] })), ok(boardTicketListFixture({ tickets: [boardTicketSummary({ key: 'T-2', phase: 'phase-06' })] }))] });
    const view = render(<BacklogScreen workspace={workspaceA} management={fake.api} />);
    await settle();
    expect(fake.boardTickets.mock.calls).toEqual([[workspaceA.id, { phase: 'phase-05' }]]);
    const current = view.getByRole('button', { name: /Phase 05 Current 1 tickets · 1 done/ });
    const other = view.getByRole('button', { name: /Phase 06 1 tickets · 0 done · 1 blocked/ });
    expect(current.getAttribute('aria-expanded')).toBe('true');
    expect(other.getAttribute('aria-expanded')).toBe('false');
    expect(view.queryByRole('button', { name: /Open T-2/ })).toBeNull();
    fireEvent.click(other);
    await settle();
    expect(fake.boardTickets.mock.calls).toEqual([[workspaceA.id, { phase: 'phase-05' }], [workspaceA.id, { phase: 'phase-06' }]]);
    expect(view.getByRole('button', { name: /Open T-2/ })).toBeTruthy();
    fireEvent.click(other);
    expect(view.queryByRole('button', { name: /Open T-2/ })).toBeNull();
    fireEvent.click(other);
    await settle();
    expect(fake.boardTickets).toHaveBeenCalledTimes(2);
    expect(view.getByRole('button', { name: /Open T-2/ })).toBeTruthy();
  });
  it('keeps non-current open phases collapsed and applies the row limit within a loaded phase', async () => {
    const phases = boardPhasesFixture();
    phases.phases[0] = { ...phases.phases[0]!, status: 'open', current: false, ticketCount: 0 };
    phases.phases[1] = { ...phases.phases[1]!, status: 'open', current: false, ticketCount: 51 };
    const tickets = Array.from({ length: 51 }, (_, index) => boardTicketSummary({ key: `T-${index + 1}`, phase: 'phase-06' }));
    const fake = fakeManagement({ boardPhases: [ok(phases)], boardTickets: [ok(boardTicketListFixture({ tickets }))] });
    const view = render(<BacklogScreen workspace={workspaceA} management={fake.api} />);
    await settle();

    expect(fake.boardTickets.mock.calls).toEqual([]);
    expect(view.getByRole('button', { name: /^Phase 05 / }).getAttribute('aria-expanded')).toBe('false');
    const later = view.getByRole('button', { name: /Phase 06 51 tickets/ });
    expect(later.getAttribute('aria-expanded')).toBe('false');
    const body = view.container.querySelector(`#${later.getAttribute('aria-controls')}`)!;
    expect(body.querySelectorAll('.boards-backlog-row')).toHaveLength(0);

    fireEvent.click(later);
    await settle();
    expect(fake.boardTickets.mock.calls).toEqual([[workspaceA.id, { phase: 'phase-06' }]]);
    expect(view.container.querySelectorAll('.boards-backlog-row')).toHaveLength(50);
    expect(view.getByRole('button', { name: 'Show 1 more' })).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: 'Show 1 more' }));
    expect(view.container.querySelectorAll('.boards-backlog-row')).toHaveLength(51);
  });
  it('shows a phase-scoped loading state and refreshes every loaded phase', async () => {
    let resolveTickets!: (value: ReturnType<typeof ok<ReturnType<typeof boardTicketListFixture>>>) => void;
    const pending = new Promise<ReturnType<typeof ok<ReturnType<typeof boardTicketListFixture>>>>(resolve => { resolveTickets = resolve; });
    const fake = fakeManagement({ boardTickets: [ok(list(1)), pending, ok(boardTicketListFixture({ tickets: [boardTicketSummary({ key: 'T-3', phase: 'phase-05' })] })), ok(boardTicketListFixture({ tickets: [boardTicketSummary({ key: 'T-4', phase: 'phase-06' })] }))] });
    const view = render(<BacklogScreen workspace={workspaceA} management={fake.api} refreshMs={0} />);
    await settle();
    fireEvent.click(view.getByRole('button', { name: /^Phase 06 / }));
    expect(view.getByRole('status').textContent).toContain('Loading tickets');
    expect(view.getByRole('button', { name: /Open T-0/ })).toBeTruthy();
    await act(async () => { resolveTickets(ok(boardTicketListFixture({ tickets: [boardTicketSummary({ key: 'T-2', phase: 'phase-06' })] }))); });
    fireEvent.click(view.getByRole('button', { name: /^Phase 06 / }));
    await act(async () => { window.dispatchEvent(new Event('board-changed')); });
    await settle();
    expect(fake.boardTickets.mock.calls.slice(-2)).toEqual([[workspaceA.id, { phase: 'phase-05' }], [workspaceA.id, { phase: 'phase-06' }]]);
    expect(view.queryByRole('button', { name: /Open T-0/ })).toBeNull();
    expect(view.getByRole('button', { name: /Open T-3/ })).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: /^Phase 06 / }));
    expect(view.getByRole('button', { name: /Open T-4/ })).toBeTruthy();
  });
  it('retries a failed phase request when that phase is expanded', async () => {
    const failure = managementError('DOWN', 'Unavailable');
    const fake = fakeManagement({ boardTickets: [ok(list(1)), failure, ok(boardTicketListFixture({ tickets: [boardTicketSummary({ key: 'T-2', phase: 'phase-06' })] }))] });
    const view = render(<BacklogScreen workspace={workspaceA} management={fake.api} refreshMs={0} />);
    await settle();
    const phase = view.getByRole('button', { name: /^Phase 06 / });
    fireEvent.click(phase);
    await settle();
    expect(view.getByRole('alert').textContent).toContain('DOWN');
    expect(fake.boardTickets.mock.calls).toEqual([[workspaceA.id, { phase: 'phase-05' }], [workspaceA.id, { phase: 'phase-06' }]]);
    fireEvent.click(view.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(fake.boardTickets.mock.calls).toEqual([[workspaceA.id, { phase: 'phase-05' }], [workspaceA.id, { phase: 'phase-06' }], [workspaceA.id, { phase: 'phase-06' }]]);
    expect(view.queryByRole('alert')).toBeNull();
    expect(view.getByRole('button', { name: /Open T-2/ })).toBeTruthy();
  });
  it('shows row activity, priority, owner, status, time and navigates', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-01T13:12:00Z'));
    const tickets = [
      boardTicketSummary({ key: 'T-1', title: 'Working title', priority: 10, activity: { state: 'working', agent: 'Senior Developer' } }),
      boardTicketSummary({ key: 'T-2', activity: { state: 'blocked' } }),
      boardTicketSummary({ key: 'T-3', openDependsOn: ['T-12'] }),
      boardTicketSummary({ key: 'T-4', status: 'done', activity: { state: 'finished' } }),
      boardTicketSummary({ key: 'T-5', status: 'dev-ready', activity: { state: 'not started', waitingFor: 'Developer' } }),
      boardTicketSummary({ key: 'T-6', status: 'backlog' }),
    ];
    const open = vi.fn();
    const view = render(<BacklogScreen workspace={workspaceA} management={fakeManagement({ boardTickets: [ok(boardTicketListFixture({ tickets }))] }).api} onOpenTicket={open} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const row = view.getByRole('button', { name: 'Open T-1: Working title' });
    expect(row.querySelectorAll('button, a, input, select, [tabindex]')).toHaveLength(0);
    for (const chip of row.querySelectorAll('.boards-backlog-status, .boards-ticket-chip')) {
      expect(chip.textContent?.trim().length).toBeGreaterThan(0);
    }
    expect(row.textContent).toContain('Working');
    expect(row.textContent).toContain('Priority 10');
    expect(row.textContent).toContain('SDSenior Developer');
    expect(row.textContent).toContain('2h ago');
    expect(row.textContent).toContain('Dev ready');
    expect(row.querySelector('[title="Working title"]')).toBeTruthy();
    expect(row.querySelector('time')?.getAttribute('title')).toBeTruthy();
    expect(view.getByRole('button', { name: /Open T-2/ }).textContent).toContain('Blocked');
    expect(view.getByRole('button', { name: /Open T-3/ }).textContent).toContain('Waits for T-12');
    expect(view.getByRole('button', { name: /Open T-4/ }).textContent).toContain('Merged');
    expect(view.getByRole('button', { name: /Open T-4/ }).textContent).not.toContain('Priority');
    expect(view.getByRole('button', { name: /Open T-4/ }).textContent).toContain('Done');
    expect(view.getByRole('button', { name: /Open T-5/ }).textContent).toContain('Ready, queued');
    expect(view.getByRole('button', { name: /Open T-6/ }).textContent).toContain('Not started');
    vi.useRealTimers();
    const user = userEvent.setup();
    row.focus();
    await user.keyboard('{Enter}');
    expect(open.mock.calls).toEqual([['T-1']]);
    await user.click(row);
    expect(open.mock.calls).toEqual([['T-1'], ['T-1']]);
  });
  it.each([null, 'agent'])('opens the status picker from a backlog row with assignee %s', async (assignee) => {
    const settings = boardSettingsFixture();
    settings.todoEntry = ['dev-ready'];
    settings.todoDefault = 'dev-ready';
    settings.workflowStatuses = [{ id: 'dev-ready', name: 'Ready for dev', kind: null }];
    const tickets = [boardTicketSummary({ key: 'T-7', status: 'backlog', assignee })];
    const view = render(<BacklogScreen workspace={workspaceA} management={fakeManagement({ boardSettings: [ok(settings)], boardTickets: [ok(boardTicketListFixture({ tickets }))] }).api} />);
    await settle();
    fireEvent.click(view.getByRole('button', { name: 'Actions for T-7' }));
    fireEvent.click(view.getByRole('button', { name: 'Change column or workflow status' }));
    expect(view.getByRole('dialog', { name: 'Move T-7' })).toBeTruthy();
    expect((view.getByLabelText('Workflow status') as HTMLSelectElement).value).toBe('dev-ready');
  });
  it('reveals remaining tickets after the first 50', async () => {
    const tickets = Array.from({ length: 51 }, (_, i) => boardTicketSummary({ key: `T-${i + 1}` }));
    const view = render(<BacklogScreen workspace={workspaceA} management={fakeManagement({ boardTickets: [ok(boardTicketListFixture({ tickets }))] }).api} />);
    await settle();
    expect(view.queryByRole('button', { name: /Open T-51:/ })).toBeNull();
    fireEvent.click(view.getByRole('button', { name: 'Show 1 more' }));
    expect(view.getByRole('button', { name: /Open T-51:/ })).toBeTruthy();
  });
  it('shows loading while a read is pending', () => {
    const fake = fakeManagement({ boardPhases: [new Promise<never>(() => {})] });
    const view = render(<BacklogScreen workspace={workspaceA} management={fake.api} />);
    expect(view.getByRole('status').textContent).toContain('Loading the backlog');
  });
  it.each(['boardPhases', 'boardSettings', 'boardTickets'] as const)('shows errors from %s and retries', async (key) => {
    const failure = managementError('DOWN', 'Unavailable');
    const fake = fakeManagement({
      boardPhases: key === 'boardPhases' ? [failure, ok(boardPhasesFixture())] : undefined,
      boardSettings: key === 'boardSettings' ? [failure, ok(boardSettingsFixture())] : undefined,
      boardTickets: key === 'boardTickets' ? [failure, ok(list(1))] : undefined,
    });
    const view = render(<BacklogScreen workspace={workspaceA} management={fake.api} />);
    await settle();
    expect(view.getByRole('alert').textContent).toContain('DOWN');
    fireEvent.click(view.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(view.queryByRole('alert')).toBeNull();
    expect(view.getByTestId('backlog-body')).toBeTruthy();
  });
  it('shows the empty board state', async () => {
    const view = render(<BacklogScreen workspace={workspaceA} management={fakeManagement({ boardTickets: [ok(list(0))] }).api} />);
    await settle();
    expect(view.getByText('No tickets in this phase.')).toBeTruthy();
  });
  it('refreshes on the event and five second poll', async () => {
    vi.useFakeTimers();
    const fake = fakeManagement({ boardTickets: [ok(list(1)), ok(list(2)), ok(list(3))] });
    const view = render(<BacklogScreen workspace={workspaceA} management={fake.api} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { window.dispatchEvent(new Event('board-changed')); });
    expect(view.getByRole('button', { name: /Open T-1/ })).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(view.getByRole('button', { name: /Open T-2/ })).toBeTruthy();
    expect(fake.boardSettings).toHaveBeenCalledTimes(3);
  });

  it('keeps an expanded phase and its unchanged rows visible while a background refresh is pending', async () => {
    const initial = boardTicketListFixture({ tickets: [boardTicketSummary({ key: 'T-1', title: 'Alpha' }), boardTicketSummary({ key: 'T-2', title: 'Beta' })] });
    const refreshed = boardTicketListFixture({ tickets: [boardTicketSummary({ key: 'T-1', title: 'Alpha' }), boardTicketSummary({ key: 'T-2', title: 'Beta' })] });
    const pending = deferred<{ ok: true; data: ReturnType<typeof boardTicketListFixture> }>();
    const fake = fakeManagement({ boardPhases: [ok(boardPhasesFixture())], boardSettings: [ok(boardSettingsFixture())], boardTickets: [ok(initial), pending.promise] });
    const view = render(<BacklogScreen workspace={workspaceA} management={fake.api} refreshMs={0} />);
    await settle();
    const first = view.getByRole('button', { name: 'Open T-1: Alpha' });
    const second = view.getByRole('button', { name: 'Open T-2: Beta' });
    const header = view.getByRole('button', { name: /Phase 05 Current/ });
    expect(header.getAttribute('aria-expanded')).toBe('true');

    await act(async () => { window.dispatchEvent(new Event('board-changed')); });
    expect(view.queryByText('Loading tickets…')).toBeNull();
    expect(view.queryByText('Loading the backlog…')).toBeNull();
    expect(view.getByRole('button', { name: 'Open T-1: Alpha' })).toBe(first);
    expect(view.getByRole('button', { name: 'Open T-2: Beta' })).toBe(second);
    expect(header.getAttribute('aria-expanded')).toBe('true');

    await act(async () => { pending.resolve(ok(refreshed)); });
    await settle();
    expect(view.getByRole('button', { name: 'Open T-1: Alpha' })).toBe(first);
    expect(view.getByRole('button', { name: 'Open T-2: Beta' })).toBe(second);
    expect(header.getAttribute('aria-expanded')).toBe('true');
  });

  it('updates one changed ticket in place', async () => {
    const initial = boardTicketListFixture({ tickets: [boardTicketSummary({ key: 'T-1', title: 'Alpha' }), boardTicketSummary({ key: 'T-2', title: 'Beta' })] });
    const refreshed = boardTicketListFixture({ tickets: [boardTicketSummary({ key: 'T-1', title: 'Alpha edited', priority: 20 }), boardTicketSummary({ key: 'T-2', title: 'Beta' })] });
    const fake = fakeManagement({ boardTickets: [ok(initial), ok(refreshed)] });
    const view = render(<BacklogScreen workspace={workspaceA} management={fake.api} refreshMs={0} />);
    await settle();
    const row = view.getByRole('button', { name: 'Open T-1: Alpha' });
    await act(async () => { window.dispatchEvent(new Event('board-changed')); });
    await settle();
    const updated = view.getByRole('button', { name: 'Open T-1: Alpha edited' });
    expect(updated).toBe(row);
    expect(updated.textContent).toContain('Priority 20');
  });

  it('inserts a new ticket and keeps the existing rows', async () => {
    const initial = boardTicketListFixture({ tickets: [boardTicketSummary({ key: 'T-1', title: 'Alpha' })] });
    const refreshed = boardTicketListFixture({ tickets: [boardTicketSummary({ key: 'T-1', title: 'Alpha' }), boardTicketSummary({ key: 'T-2', title: 'Beta', priority: 50 })] });
    const fake = fakeManagement({ boardTickets: [ok(initial), ok(refreshed)] });
    const view = render(<BacklogScreen workspace={workspaceA} management={fake.api} refreshMs={0} />);
    await settle();
    const row = view.getByRole('button', { name: 'Open T-1: Alpha' });
    await act(async () => { window.dispatchEvent(new Event('board-changed')); });
    await settle();
    expect(view.getByRole('button', { name: 'Open T-1: Alpha' })).toBe(row);
    expect(view.getByRole('button', { name: 'Open T-2: Beta' })).toBeTruthy();
  });

  it('removes a vanished ticket and keeps the remaining row', async () => {
    const initial = boardTicketListFixture({ tickets: [boardTicketSummary({ key: 'T-1', title: 'Alpha' }), boardTicketSummary({ key: 'T-2', title: 'Beta' })] });
    const refreshed = boardTicketListFixture({ tickets: [boardTicketSummary({ key: 'T-2', title: 'Beta' })] });
    const fake = fakeManagement({ boardTickets: [ok(initial), ok(refreshed)] });
    const view = render(<BacklogScreen workspace={workspaceA} management={fake.api} refreshMs={0} />);
    await settle();
    const row = view.getByRole('button', { name: 'Open T-2: Beta' });
    await act(async () => { window.dispatchEvent(new Event('board-changed')); });
    await settle();
    expect(view.queryByRole('button', { name: 'Open T-1: Alpha' })).toBeNull();
    expect(view.getByRole('button', { name: 'Open T-2: Beta' })).toBe(row);
  });

  it('reorders tickets without recreating their rows', async () => {
    const initial = boardTicketListFixture({ tickets: [boardTicketSummary({ key: 'T-1', title: 'Alpha', priority: 10 }), boardTicketSummary({ key: 'T-2', title: 'Beta', priority: 20 })] });
    const refreshed = boardTicketListFixture({ tickets: [boardTicketSummary({ key: 'T-1', title: 'Alpha', priority: 30 }), boardTicketSummary({ key: 'T-2', title: 'Beta', priority: 10 })] });
    const fake = fakeManagement({ boardTickets: [ok(initial), ok(refreshed)] });
    const view = render(<BacklogScreen workspace={workspaceA} management={fake.api} refreshMs={0} />);
    await settle();
    const keys = () => Array.from(view.getByTestId('backlog-body').querySelectorAll('.boards-backlog-row')).map(row => row.getAttribute('aria-label')?.match(/^Open (T-\d+)/)?.[1]);
    const first = view.getByRole('button', { name: 'Open T-1: Alpha' });
    const second = view.getByRole('button', { name: 'Open T-2: Beta' });
    expect(keys()).toEqual(['T-1', 'T-2']);
    await act(async () => { window.dispatchEvent(new Event('board-changed')); });
    await settle();
    expect(keys()).toEqual(['T-2', 'T-1']);
    expect(view.getByRole('button', { name: 'Open T-1: Alpha' })).toBe(first);
    expect(view.getByRole('button', { name: 'Open T-2: Beta' })).toBe(second);
  });

  it('preserves collapsed and expanded phases across a successful refresh', async () => {
    const phase05 = (key: string, title: string) => ok(boardTicketListFixture({ tickets: [boardTicketSummary({ key, title, phase: 'phase-05' })] }));
    const phase06 = (key: string, title: string) => ok(boardTicketListFixture({ tickets: [boardTicketSummary({ key, title, phase: 'phase-06' })] }));
    const fake = fakeManagement({ boardTickets: [phase05('T-1', 'Alpha'), phase06('T-2', 'Beta'), phase05('T-1', 'Alpha'), phase06('T-2', 'Beta')] });
    const view = render(<BacklogScreen workspace={workspaceA} management={fake.api} refreshMs={0} />);
    await settle();
    fireEvent.click(view.getByRole('button', { name: /^Phase 06 / }));
    await settle();
    const row = view.getByRole('button', { name: 'Open T-2: Beta' });
    fireEvent.click(view.getByRole('button', { name: /Phase 05 Current/ }));
    expect(view.getByRole('button', { name: /Phase 05 Current/ }).getAttribute('aria-expanded')).toBe('false');

    await act(async () => { window.dispatchEvent(new Event('board-changed')); });
    await settle();
    expect(view.getByRole('button', { name: /Phase 05 Current/ }).getAttribute('aria-expanded')).toBe('false');
    expect(view.getByRole('button', { name: /^Phase 06 / }).getAttribute('aria-expanded')).toBe('true');
    expect(view.getByRole('button', { name: 'Open T-2: Beta' })).toBe(row);
  });

  it('keeps the loaded rows and shows a retry when a background phase refresh fails', async () => {
    const initial = boardTicketListFixture({ tickets: [boardTicketSummary({ key: 'T-1', title: 'Alpha' })] });
    const recovered = boardTicketListFixture({ tickets: [boardTicketSummary({ key: 'T-1', title: 'Alpha after retry' })] });
    const fake = fakeManagement({ boardTickets: [ok(initial), managementError('DOWN', 'Unavailable'), ok(recovered)] });
    const view = render(<BacklogScreen workspace={workspaceA} management={fake.api} refreshMs={0} />);
    await settle();
    const row = view.getByRole('button', { name: 'Open T-1: Alpha' });
    await act(async () => { window.dispatchEvent(new Event('board-changed')); });
    await settle();
    expect(view.getByRole('button', { name: 'Open T-1: Alpha' })).toBe(row);
    const alert = view.getByRole('alert');
    expect(alert.textContent).toContain('DOWN');
    expect(alert.textContent).toContain('last loaded tickets are still shown');
    fireEvent.click(view.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(view.queryByRole('alert')).toBeNull();
    const retried = view.getByRole('button', { name: 'Open T-1: Alpha after retry' });
    expect(retried).toBe(row);
  });

  it('keeps the loaded phase and tickets when a background phase/settings refresh fails', async () => {
    const initial = boardTicketListFixture({ tickets: [boardTicketSummary({ key: 'T-1', title: 'Alpha' })] });
    const fake = fakeManagement({
      boardPhases: [ok(boardPhasesFixture()), managementError('DOWN', 'Unavailable'), ok(boardPhasesFixture())],
      boardTickets: [ok(initial)],
    });
    const view = render(<BacklogScreen workspace={workspaceA} management={fake.api} refreshMs={0} />);
    await settle();
    const row = view.getByRole('button', { name: 'Open T-1: Alpha' });
    await act(async () => { window.dispatchEvent(new Event('board-changed')); });
    await settle();
    expect(view.getByRole('button', { name: 'Open T-1: Alpha' })).toBe(row);
    const alert = view.getByRole('alert');
    expect(alert.textContent).toContain('Could not refresh the backlog');
    expect(alert.textContent).toContain('DOWN');
    expect(view.queryByText('Loading the backlog…')).toBeNull();
    fireEvent.click(view.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(view.queryByRole('alert')).toBeNull();
    expect(view.getByRole('button', { name: 'Open T-1: Alpha' })).toBe(row);
  });
});

describe('backlog toolbar', () => {
  it('filters, removes chips, clears filters and hides empty groups', async () => {
    const settings = boardSettingsFixture();
    settings.workflowStatuses = [{ id: 'dev-ready', name: 'Dev ready', kind: null }];
    const tickets = [
      boardTicketSummary({ key: 'T-1', status: 'todo', workflowStatus: 'dev-ready', activity: { state: 'working', agent: 'Alex' } }),
      boardTicketSummary({ key: 'T-2', status: 'backlog' }),
      boardTicketSummary({ key: 'T-3', phase: 'phase-06', status: 'backlog' }),
    ];
    const view = render(<BacklogScreen workspace={workspaceA} management={fakeManagement({ boardSettings: [ok(settings)], boardTickets: [ok(boardTicketListFixture({ tickets }))] }).api} />);
    await settle();
    const user = userEvent.setup();
    expect(view.getByRole('button', { name: /Open T-1/ }).textContent).toContain('Todo · Dev ready');
    await user.click(view.getByRole('button', { name: 'Column' }));
    await user.click(view.getByRole('checkbox', { name: 'To do' }));
    expect(view.getByText('1 of 3 tickets')).toBeTruthy();
    await user.click(view.getByRole('button', { name: 'Remove Column: To do' }));
    await user.click(view.getByRole('button', { name: 'Workflow status' }));
    await user.click(view.getByRole('checkbox', { name: 'Dev ready' }));
    expect(view.getByRole('button', { name: 'Workflow status · 1' }).getAttribute('aria-expanded')).toBe('true');
    expect(view.getByText('1 of 3 tickets')).toBeTruthy();
    expect(view.getByRole('button', { name: /Phase 05 Current/ })).toBeTruthy();
    expect(view.getByRole('button', { name: /^Phase 06 / })).toBeTruthy();
    await user.click(view.getByRole('checkbox', { name: 'Dev ready' }));
    expect(view.queryByText('1 of 3 tickets')).toBeNull();
    expect(view.getByRole('button', { name: 'Workflow status' })).toBeTruthy();
    await user.click(view.getByRole('checkbox', { name: 'Dev ready' }));
    await user.click(view.getByRole('button', { name: 'Remove Workflow status: Dev ready' }));
    expect(view.queryByText('1 of 3 tickets')).toBeNull();
    await user.selectOptions(view.getByLabelText('Owner'), 'Alex');
    await user.selectOptions(view.getByLabelText('Priority'), 'low');
    expect(view.getByText('No tickets match these filters')).toBeTruthy();
    await user.click(view.getByRole('button', { name: 'Clear filters' }));
    expect(view.queryByText('No tickets match these filters')).toBeNull();
    await user.selectOptions(view.getByLabelText('Dependencies'), 'yes');
    await user.click(view.getByRole('button', { name: 'Clear all' }));
    expect(view.getByLabelText<HTMLSelectElement>('Dependencies').value).toBe('any');
  });

  it('supports keyboard selection and returns focus on Escape', async () => {
    const view = render(<BacklogScreen workspace={workspaceA} management={fakeManagement().api} />);
    await settle();
    const user = userEvent.setup();
    const button = view.getByRole('button', { name: 'Activity' });
    await user.click(button);
    expect(document.activeElement).toBe(view.getByRole('checkbox', { name: 'Working' }));
    expect(button.getAttribute('aria-controls')).toBe(view.getByRole('dialog', { name: 'Activity options' }).id);
    await user.keyboard(' ');
    expect(view.getByRole<HTMLInputElement>('checkbox', { name: 'Working' }).checked).toBe(true);
    await user.keyboard('{ArrowDown} ');
    expect(view.getByRole<HTMLInputElement>('checkbox', { name: 'Blocked' }).checked).toBe(true);
    await user.keyboard(' ');
    expect(view.getByRole<HTMLInputElement>('checkbox', { name: 'Blocked' }).checked).toBe(false);
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('debounces search and changes the sort order', async () => {
    vi.useFakeTimers();
    const tickets = [boardTicketSummary({ key: 'T-1', title: 'Alpha', priority: 1 }), boardTicketSummary({ key: 'T-2', title: 'Beta', priority: 2 })];
    const view = render(<BacklogScreen workspace={workspaceA} management={fakeManagement({ boardTickets: [ok(boardTicketListFixture({ tickets }))] }).api} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.change(view.getByLabelText('Sort'), { target: { value: 'key' } });
    expect(view.getAllByRole('button', { name: /Open T-/ })[0]?.getAttribute('aria-label')).toContain('T-2');
    fireEvent.change(view.getByLabelText('Search tickets'), { target: { value: 'Alpha' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(149); });
    expect(view.getByRole('button', { name: /Open T-2/ })).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(view.queryByRole('button', { name: /Open T-2/ })).toBeNull();
    expect(view.getByText('1 of 2 tickets')).toBeTruthy();
  });

  it('sorts by recently updated time and configured status order', async () => {
    const tickets = [
      boardTicketSummary({ key: 'T-1', status: 'backlog', updatedAt: '2026-10-01T00:00:00Z', priority: 30 }),
      boardTicketSummary({ key: 'T-2', status: 'dev-ready', updatedAt: '2026-10-03T00:00:00Z', priority: 20 }),
      boardTicketSummary({ key: 'T-3', status: 'backlog', updatedAt: '2026-10-02T00:00:00Z', priority: 10 }),
    ];
    const listData = boardTicketListFixture({ tickets, statuses: ['dev-ready', 'backlog'] });
    const view = render(<BacklogScreen workspace={workspaceA} management={fakeManagement({ boardTickets: [ok(listData)] }).api} />);
    await settle();
    const keys = () => Array.from(view.getByTestId('backlog-body').querySelectorAll('.boards-backlog-row')).map(row => row.getAttribute('aria-label')?.match(/^Open (T-\d+)/)?.[1]);
    fireEvent.change(view.getByLabelText('Sort'), { target: { value: 'updated' } });
    expect(keys()).toEqual(['T-2', 'T-3', 'T-1']);
    fireEvent.change(view.getByLabelText('Sort'), { target: { value: 'status' } });
    expect(keys()).toEqual(['T-2', 'T-3', 'T-1']);
  });
});
