// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BacklogScreen } from '../src/renderer/boards/BacklogScreen';
import { boardPhasesFixture, boardTicketListFixture, boardTicketSummary } from './boardFixtures';
import { workspaceA } from './dashboardFixtures';
import { boardSettingsFixture, fakeManagement, managementError } from './teamsFixtures';

afterEach(() => { cleanup(); vi.useRealTimers(); });
const ok = <T,>(data: T) => ({ ok: true as const, data });
const list = (count: number) => boardTicketListFixture({ tickets: Array.from({ length: count }, (_, i) => boardTicketSummary({ key: `T-${i}`, phase: i ? null : 'phase-05' })) });
const settle = () => act(async () => {});

describe('BacklogScreen', () => {
  it('loads all tickets and renders the header and grouped body', async () => {
    const fake = fakeManagement({ boardTickets: [ok(list(2))] });
    const view = render(<BacklogScreen workspace={workspaceA} management={fake.api} />);
    await settle();
    expect(view.getByRole('navigation', { name: 'Breadcrumb' }).textContent).toBe('Boards/Backlog');
    expect(view.getByRole('heading', { level: 1 }).textContent).toBe('Backlog');
    expect(view.getByText('Every ticket on the board, grouped by phase.')).toBeTruthy();
    expect(view.getByText('2 tickets')).toBeTruthy();
    expect(view.getByTestId('backlog-body').children.length).toBe(3);
    expect(view.getByRole('button', { name: /Phase 05 Current 1 tickets/ })).toBeTruthy();
    expect(fake.boardTickets).toHaveBeenCalledWith(workspaceA.id, {});
    expect(fake.boardPhases).toHaveBeenCalledWith(workspaceA.id);
    expect(fake.boardSettings).toHaveBeenCalledWith(workspaceA.id);
  });

  it('orders groups, displays counts, and toggles closed and open groups', async () => {
    const phases = boardPhasesFixture();
    phases.phases[1] = { ...phases.phases[1]!, status: 'closed' };
    const tickets = [
      boardTicketSummary({ key: 'T-1', status: 'done', activity: { state: 'finished' } }),
      boardTicketSummary({ key: 'T-2', activity: { state: 'blocked' } }),
      boardTicketSummary({ key: 'T-3', phase: 'phase-06' }),
    ];
    const view = render(<BacklogScreen workspace={workspaceA} management={fakeManagement({ boardPhases: [ok(phases)], boardTickets: [ok(boardTicketListFixture({ tickets }))] }).api} />);
    await settle();
    const headers = Array.from(view.getByTestId('backlog-body').querySelectorAll('.boards-backlog-group-header'));
    expect(headers.map((header) => header.textContent)).toEqual(['▾Phase 05Current2 tickets · 1 done · 1 blocked', '▸Phase 06Closed1 tickets · 0 done']);
    expect(headers[0]?.getAttribute('aria-expanded')).toBe('true');
    expect(headers[1]?.getAttribute('aria-expanded')).toBe('false');
    const user = userEvent.setup();
    headers[0]!.focus();
    await user.keyboard('{Enter}');
    expect(headers[0]?.getAttribute('aria-expanded')).toBe('false');
    headers[1]!.focus();
    await user.keyboard(' ');
    expect(view.getByRole('button', { name: /Open T-3/ })).toBeTruthy();
  });
  it('keeps non-current open groups expanded and sorts tickets by priority by default', async () => {
    const phases = boardPhasesFixture();
    phases.phases[0] = { ...phases.phases[0]!, current: false };
    const tickets = [
      boardTicketSummary({ key: 'T-30', phase: 'phase-06', priority: 30 }),
      boardTicketSummary({ key: 'T-10', phase: 'phase-06', priority: 10 }),
      boardTicketSummary({ key: 'T-20', phase: 'phase-06', priority: 20 }),
    ];
    const view = render(<BacklogScreen workspace={workspaceA} management={fakeManagement({ boardPhases: [ok(phases)], boardTickets: [ok(boardTicketListFixture({ tickets }))] }).api} />);
    await settle();

    const headers = Array.from(view.getByTestId('backlog-body').querySelectorAll('.boards-backlog-group-header'));
    expect(Array.from(view.getByTestId('backlog-body').querySelectorAll('.boards-backlog-group-header strong')).map((name) => name.textContent))
      .toEqual(['Phase 05', 'Phase 06']);
    expect(headers[0]?.getAttribute('aria-expanded')).toBe('true');
    expect(headers[1]?.getAttribute('aria-expanded')).toBe('true');
    expect(Array.from(view.getByTestId('backlog-body').querySelectorAll('.boards-backlog-row')).map((row) => row.getAttribute('aria-label')))
      .toEqual([
        'Open T-10: Boards v1: Current Phase board and ticket page',
        'Open T-20: Boards v1: Current Phase board and ticket page',
        'Open T-30: Boards v1: Current Phase board and ticket page',
      ]);
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
    expect(view.getByText('0 tickets')).toBeTruthy();
    expect(view.getByText('No tickets yet')).toBeTruthy();
    expect(view.getAllByText('No tickets in this phase.').length).toBeGreaterThan(0);
  });
  it('refreshes on the event and five second poll', async () => {
    vi.useFakeTimers();
    const fake = fakeManagement({ boardTickets: [ok(list(1)), ok(list(2)), ok(list(3))] });
    const view = render(<BacklogScreen workspace={workspaceA} management={fake.api} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { window.dispatchEvent(new Event('board-changed')); });
    expect(view.getByText('2 tickets')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(view.getByText('3 tickets')).toBeTruthy();
    expect(fake.boardSettings).toHaveBeenCalledTimes(3);
  });
});
