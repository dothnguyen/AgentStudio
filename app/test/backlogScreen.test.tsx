// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
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
  it('loads all tickets and renders the header and empty body', async () => {
    const fake = fakeManagement({ boardTickets: [ok(list(2))] });
    const view = render(<BacklogScreen workspace={workspaceA} management={fake.api} />);
    await settle();
    expect(view.getByRole('navigation', { name: 'Breadcrumb' }).textContent).toBe('Boards/Backlog');
    expect(view.getByRole('heading', { level: 1 }).textContent).toBe('Backlog');
    expect(view.getByText('Every ticket on the board, grouped by phase.')).toBeTruthy();
    expect(view.getByText('2 tickets')).toBeTruthy();
    expect(view.getByTestId('backlog-body').children.length).toBe(0);
    expect(fake.boardTickets).toHaveBeenCalledWith(workspaceA.id, {});
    expect(fake.boardPhases).toHaveBeenCalledWith(workspaceA.id);
    expect(fake.boardSettings).toHaveBeenCalledWith(workspaceA.id);
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
