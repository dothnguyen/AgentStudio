// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardPhases, BoardPhase, BoardTicketList } from '../src/renderer/api';
import { CurrentPhaseScreen } from '../src/renderer/boards/CurrentPhaseScreen';
import { workspaceA } from './dashboardFixtures';
import { boardPhasesFixture, boardTicketListFixture, boardTicketSummary } from './boardFixtures';
import { fakeManagement, managementError } from './teamsFixtures';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const CURRENT: BoardPhase = {
  id: 'phase-06-id',
  slug: 'phase-06',
  name: 'Phase 06 - Roles, Routing and Skills redesign',
  description: 'Redesign the Roles screen, move Routing to its own screen, and add a Skills screen, in the style of the Teams screen.',
  position: 0,
  status: 'open',
  current: true,
  ticketCount: 16,
  counts: {},
};

const PHASES: BoardPhases = {
  workspace: workspaceA.id,
  currentPhase: CURRENT,
  phases: [CURRENT],
};

function tickets(count: number, done: number): BoardTicketList {
  return boardTicketListFixture({
    phase: CURRENT.slug,
    tickets: Array.from({ length: count }, (_, index) => boardTicketSummary({
      key: `T-${100 + index}`,
      phase: CURRENT.slug,
      status: index < done ? 'done' : 'dev-ready',
    })),
  });
}

const okR = <T,>(data: T) => ({ ok: true as const, data });

async function settle(): Promise<void> {
  await act(async () => {});
}

describe('CurrentPhaseScreen', () => {
  it('renders the header, current pill, description, notice and six percent progress from fake data', async () => {
    const fake = fakeManagement({
      boardPhases: [okR(PHASES)],
      boardTickets: [okR(tickets(16, 1))],
    });
    const view = render(<CurrentPhaseScreen workspace={workspaceA} management={fake.api} />);
    await settle();

    const breadcrumb = view.getByRole('navigation', { name: 'Breadcrumb' });
    expect(breadcrumb.textContent).toContain('Boards');
    expect(breadcrumb.textContent).toContain('Current Phase');
    expect(breadcrumb.querySelector('[aria-current="page"]')?.textContent).toBe('Current Phase');

    expect(view.getByRole('heading', { level: 1 }).textContent).toBe(CURRENT.name);
    expect(view.getByText('Current')).toBeTruthy();
    expect(view.getByText(CURRENT.description!)).toBeTruthy();
    expect(view.getByText('1 of 16 tickets done')).toBeTruthy();
    expect(view.getByText('6%')).toBeTruthy();
    expect(view.getByText('While a team is running, tickets in this phase are worked automatically by the routing rules. Tickets in other phases wait until their phase is current.')).toBeTruthy();

    const progress = view.getByRole('progressbar', { name: 'Phase progress' });
    expect(progress.getAttribute('aria-valuenow')).toBe('6');
    expect(progress.getAttribute('aria-valuetext')).toBe('1 of 16 tickets done');
    expect((progress.querySelector('.boards-phase-progress-fill') as HTMLElement).style.width).toBe('6%');

    expect(fake.boardTickets).toHaveBeenCalledWith(workspaceA.id, { phase: CURRENT.slug });
    expect(fake.boardSettings).toHaveBeenCalledTimes(1);
  });

  it('shows a loading skeleton and no error while the board reads are pending', async () => {
    const fake = fakeManagement({ boardPhases: [new Promise<never>(() => {})], boardTickets: [okR(tickets(0, 0))] });
    const view = render(<CurrentPhaseScreen workspace={workspaceA} management={fake.api} />);
    await settle();

    expect(view.getByRole('status').textContent).toContain('Loading the current phase…');
    expect(view.getByRole('heading', { level: 1 }).textContent).toBe('Current Phase');
    expect(view.queryByRole('alert')).toBeNull();
  });

  it('shows an error card with Retry and recovers on retry', async () => {
    const fake = fakeManagement({
      boardPhases: [managementError('PHASE_DOWN', 'the phase list is unreadable'), okR(PHASES)],
      boardTickets: [okR(tickets(16, 1))],
    });
    const view = render(<CurrentPhaseScreen workspace={workspaceA} management={fake.api} />);
    await settle();

    const alert = view.getByRole('alert');
    expect(alert.textContent).toContain('PHASE_DOWN');
    expect(alert.textContent).toContain('the phase list is unreadable');

    fireEvent.click(view.getByRole('button', { name: 'Retry' }));
    await settle();

    expect(fake.boardPhases).toHaveBeenCalledTimes(2);
    expect(view.queryByRole('alert')).toBeNull();
    expect(view.getByRole('heading', { level: 1 }).textContent).toBe(CURRENT.name);
  });

  it('shows the empty phase state when the current phase has no tickets', async () => {
    const fake = fakeManagement({
      boardPhases: [okR({ ...PHASES, currentPhase: { ...CURRENT, ticketCount: 0 }, phases: [{ ...CURRENT, ticketCount: 0 }] })],
      boardTickets: [okR(tickets(0, 0))],
    });
    const view = render(<CurrentPhaseScreen workspace={workspaceA} management={fake.api} />);
    await settle();

    expect(view.getByText('No tickets in this phase yet')).toBeTruthy();
    expect(view.getByText('0 of 0 tickets done')).toBeTruthy();
    expect(view.getByText('0%')).toBeTruthy();
  });

  it('points at Phases when no current phase is set', async () => {
    const onOpenPhases = vi.fn();
    const noCurrent: BoardPhases = {
      ...PHASES,
      phases: [{ ...CURRENT, current: false }],
    };
    const fake = fakeManagement({ boardPhases: [okR(noCurrent)] });
    const view = render(<CurrentPhaseScreen workspace={workspaceA} management={fake.api} onOpenPhases={onOpenPhases} />);
    await settle();

    expect(view.getByRole('heading', { level: 1 }).textContent).toBe('No current phase');
    expect(view.getByText('Set a current phase in Phases to see its board here.')).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: 'Open Phases' }));
    expect(onOpenPhases).toHaveBeenCalledTimes(1);
    expect(fake.boardTickets).not.toHaveBeenCalled();
  });

  it('refreshes the board every five seconds', async () => {
    vi.useFakeTimers();
    const fake = fakeManagement({
      boardPhases: [okR(PHASES), okR(PHASES)],
      boardTickets: [okR(tickets(16, 1)), okR(tickets(16, 2))],
    });
    const view = render(<CurrentPhaseScreen workspace={workspaceA} management={fake.api} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fake.boardPhases).toHaveBeenCalledTimes(1);
    expect(view.getByText('1 of 16 tickets done')).toBeTruthy();

    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(fake.boardPhases).toHaveBeenCalledTimes(2);
    expect(fake.boardTickets).toHaveBeenCalledTimes(2);
    expect(view.getByText('2 of 16 tickets done')).toBeTruthy();
    expect(view.queryByRole('status')).toBeNull();
    view.unmount();
  });

  it('refreshes immediately on the board-changed event', async () => {
    const fake = fakeManagement({
      boardPhases: [okR(PHASES), okR(PHASES)],
      boardTickets: [okR(tickets(16, 1)), okR(tickets(16, 2))],
    });
    const view = render(<CurrentPhaseScreen workspace={workspaceA} management={fake.api} refreshMs={0} />);
    await settle();
    expect(fake.boardPhases).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new Event('board-changed'));
    });
    await settle();
    expect(fake.boardPhases).toHaveBeenCalledTimes(2);
    expect(view.getByText('2 of 16 tickets done')).toBeTruthy();
  });
});
