// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PhasesScreen } from '../src/renderer/boards/PhasesScreen';
import { boardPhase, boardPhasesFixture } from './boardFixtures';
import { workspaceA } from './dashboardFixtures';
import { boardSettingsFixture, fakeManagement, managementError } from './teamsFixtures';

afterEach(() => { cleanup(); vi.useRealTimers(); });
const ok = <T,>(data: T) => ({ ok: true as const, data });
const settle = () => act(async () => {});

describe('PhasesScreen', () => {
  it('orders cards, shows state pills and passes action targets to callbacks', async () => {
    const phases = [
      boardPhase({ slug: 'closed-late', name: 'Closed late', current: false, status: 'closed', position: 4 }),
      boardPhase({ slug: 'open-late', name: 'Open late', current: false, position: 3 }),
      boardPhase({ slug: 'current', name: 'Current phase', current: true, position: 9 }),
      boardPhase({ slug: 'closed-early', name: 'Closed early', current: false, status: 'closed', position: 1 }),
      boardPhase({ slug: 'open-early', name: 'Open early', current: false, position: 0 }),
    ];
    const onViewTickets = vi.fn();
    const onOpenBoard = vi.fn();
    const fake = fakeManagement({ boardPhases: [ok(boardPhasesFixture({ phases }))] });
    const view = render(<PhasesScreen workspace={workspaceA} management={fake.api} onViewTickets={onViewTickets} onOpenBoard={onOpenBoard} />);
    await settle();
    expect(view.getAllByRole('heading', { level: 2 }).map(heading => heading.textContent)).toEqual(['Current phase', 'Open early', 'Open late', 'Closed early', 'Closed late']);
    const current = within(view.getByRole('region', { name: 'Current phase' }));
    const open = within(view.getByRole('region', { name: 'Open early' }));
    const closed = within(view.getByRole('region', { name: 'Closed early' }));
    expect(current.getByText('Current')).toBeTruthy();
    expect(open.queryByText('Current')).toBeNull();
    expect(open.queryByText('Closed')).toBeNull();
    expect(closed.getByText('Closed')).toBeTruthy();
    expect(view.getAllByRole('button', { name: 'Open board' })).toHaveLength(1);
    fireEvent.click(open.getByRole('button', { name: 'View tickets' }));
    fireEvent.click(closed.getByRole('button', { name: 'Closed early' }));
    fireEvent.click(current.getByRole('button', { name: 'Open board' }));
    expect(onViewTickets).toHaveBeenCalledWith('open-early');
    expect(onViewTickets).toHaveBeenCalledWith('closed-early');
    expect(onOpenBoard).toHaveBeenCalledOnce();
  });
  it('shows counted segments, accessible progress and a legend without zero counts', async () => {
    const phase = boardPhase({ name: 'Milestone', ticketCount: 20, counts: { done: 10, closed: 2, 'in-progress': 3, todo: 1, backlog: 3, custom: 1 } });
    const fake = fakeManagement({ boardPhases: [ok(boardPhasesFixture({ phases: [phase] }))] });
    const view = render(<PhasesScreen workspace={workspaceA} management={fake.api} />);
    await settle();
    expect(view.getByText('12 of 20 done · 60%')).toBeTruthy();
    const bar = view.getByRole('img', { name: '12 of 20 done, 2 closed, 3 in progress, 1 to do, 3 backlog, 1 other' });
    const segments = Array.from(bar.children) as HTMLElement[];
    expect(segments.map(segment => segment.title)).toEqual(['Done: 10', 'Closed: 2', 'In progress: 3', 'To do: 1', 'Backlog: 3', 'Other: 1']);
    expect(segments.reduce((sum, segment) => sum + parseFloat(segment.style.width), 0)).toBe(100);
    for (const label of ['Done 10', 'Closed 2', 'In progress 3', 'To do 1', 'Backlog 3', 'Other 1']) expect(view.getByText(label)).toBeTruthy();
  });
  it('shows an empty track and no zero-count legend entries', async () => {
    const phase = boardPhase({ name: 'Empty', description: '  ', counts: {}, ticketCount: 0 });
    const fake = fakeManagement({ boardPhases: [ok(boardPhasesFixture({ phases: [phase] }))] });
    const view = render(<PhasesScreen workspace={workspaceA} management={fake.api} />);
    await settle();
    expect(view.getByText('No description')).toBeTruthy();
    expect(view.getByText('No tickets yet')).toBeTruthy();
    expect(view.getByRole('img', { name: '0 of 0 done' }).children).toHaveLength(0);
    expect(view.queryByText('Done 0')).toBeNull();
  });
  it('omits zero categories from populated tracks and legends', async () => {
    const phase = boardPhase({ ticketCount: 1, counts: { done: 1, blocked: 0 } });
    const fake = fakeManagement({ boardPhases: [ok(boardPhasesFixture({ phases: [phase] }))] });
    const view = render(<PhasesScreen workspace={workspaceA} management={fake.api} />);
    await settle();
    expect(view.getByRole('img', { name: '1 of 1 done' }).children).toHaveLength(1);
    expect(view.queryByText('Blocked 0')).toBeNull();
  });
  it('shows the header and phase names and loads both data sources', async () => {
    const phases = boardPhasesFixture();
    const fake = fakeManagement({ boardPhases: [ok(phases)] });
    const view = render(<PhasesScreen workspace={workspaceA} management={fake.api} />);
    await settle();
    expect(view.getByRole('navigation', { name: 'Breadcrumb' }).textContent).toBe('Boards/Phases');
    expect(view.getByRole('heading', { level: 1 }).textContent).toBe('Phases');
    expect(view.getByText('Progress of each phase, by ticket counts.')).toBeTruthy();
    for (const phase of phases.phases) expect(view.getByText(phase.name)).toBeTruthy();
    expect(fake.boardPhases).toHaveBeenCalledWith(workspaceA.id);
    expect(fake.boardSettings).toHaveBeenCalledWith(workspaceA.id);
  });
  it('shows loading and the header while a read is pending', () => {
    const fake = fakeManagement({ boardPhases: [new Promise<never>(() => {})] });
    const view = render(<PhasesScreen workspace={workspaceA} management={fake.api} />);
    expect(view.getByRole('status').textContent).toContain('Loading phases');
    expect(view.getByRole('heading', { level: 1 }).textContent).toBe('Phases');
  });
  it.each(['boardPhases', 'boardSettings'] as const)('shows errors from %s and retries', async key => {
    const failure = managementError('DOWN', 'Unavailable');
    const fake = fakeManagement({
      boardPhases: key === 'boardPhases' ? [failure, ok(boardPhasesFixture())] : undefined,
      boardSettings: key === 'boardSettings' ? [failure, ok(boardSettingsFixture())] : undefined,
    });
    const view = render(<PhasesScreen workspace={workspaceA} management={fake.api} />);
    await settle();
    expect(view.getByRole('alert').textContent).toContain('DOWN');
    fireEvent.click(view.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(view.queryByRole('alert')).toBeNull();
    expect(view.getByText(boardPhasesFixture().phases[0]!.name)).toBeTruthy();
  });
  it('shows an empty state', async () => {
    const fake = fakeManagement({ boardPhases: [ok(boardPhasesFixture({ phases: [] }))] });
    const view = render(<PhasesScreen workspace={workspaceA} management={fake.api} />);
    await settle();
    expect(view.getByText('No phases yet')).toBeTruthy();
  });
  it('reconciles the production phase-add payload once, preserves the current phase and visible cards when refresh fails', async () => {
    const initial = boardPhasesFixture();
    const createPhase = vi.fn(async () => ({ ok: true as const, data: { phase: { id: 'phase-x-id', slug: 'phase-x', name: 'Phase X', description: null, position: 1, status: 'open' as const } } }));
    const failure = managementError('DOWN', 'Refresh unavailable');
    const fake = fakeManagement({ boardPhases: [ok(initial), failure], calls: { createPhase } });
    const view = render(<PhasesScreen workspace={workspaceA} management={fake.api} refreshMs={0} />);
    await settle();
    const trigger = view.getByRole('button', { name: 'New phase' });
    await userEvent.setup().click(trigger);
    await userEvent.setup().type(view.getByRole('textbox', { name: 'Phase name' }), 'Phase X');
    await userEvent.setup().click(view.getByRole('button', { name: 'Create phase' }));
    await waitFor(() => expect(view.getByRole('heading', { name: 'Phase X' })).toBeTruthy());
    expect(view.queryByRole('dialog')).toBeNull();
    expect(view.getByRole('heading', { level: 1 }).textContent).toBe('Phases');
    expect(view.getAllByRole('heading', { level: 2 }).map(item => item.textContent)).toEqual(['Phase 05', 'Phase X', 'Phase 06']);
    expect(view.getAllByRole('heading', { name: 'Phase X' })).toHaveLength(1);
    expect(view.getByRole('region', { name: 'Phase 05' }).querySelector('.boards-phase-pill')?.textContent).toBe('Current');
    expect(view.getByRole('region', { name: 'Phase X' }).querySelector('.boards-phase-pill')).toBeNull();
    expect(view.getByText(/Could not refresh phases: Refresh unavailable/)).toBeTruthy();
    expect(document.activeElement).toBe(trigger);
  });

  it('normalizes missing UI fields in a malformed successful response', async () => {
    const createPhase = vi.fn(async () => ({ ok: true as const, data: { phase: {} } }));
    const view = render(<PhasesScreen workspace={workspaceA} management={fakeManagement({ calls: { createPhase } }).api} refreshMs={0} />);
    await settle();
    await userEvent.setup().click(view.getByRole('button', { name: 'New phase' }));
    await userEvent.setup().type(view.getByRole('textbox', { name: 'Phase name' }), 'Malformed');
    await userEvent.setup().click(view.getByRole('button', { name: 'Create phase' }));
    await waitFor(() => expect(view.queryByRole('dialog')).toBeNull());
    expect(view.getByRole('heading', { level: 1 }).textContent).toBe('Phases');
    expect(view.getByRole('heading', { name: 'Malformed' })).toBeTruthy();
    expect(view.getByRole('region', { name: 'Malformed' }).querySelector('.boards-phase-pill')).toBeNull();
    expect(view.getByText('Phase 05')).toBeTruthy();
    expect(view.getByText('Phase 06')).toBeTruthy();
  });
  it('keeps a delayed create acknowledgement when the follow-up phase read is stale', async () => {
    const initial = boardPhasesFixture();
    let finishCreate!: (value: ReturnType<typeof ok<{ phase: { id: string; slug: string; name: string; position: number; status: 'open' } }>>) => void;
    const createPhase = vi.fn(() => new Promise<any>(resolve => { finishCreate = resolve; }));
    const fake = fakeManagement({ boardPhases: [ok(initial), ok(initial)], calls: { createPhase } });
    const view = render(<PhasesScreen workspace={workspaceA} management={fake.api} refreshMs={0} />);
    await settle();
    await userEvent.setup().click(view.getByRole('button', { name: 'New phase' }));
    await userEvent.setup().type(view.getByRole('textbox', { name: 'Phase name' }), 'Delayed Phase');
    await userEvent.setup().click(view.getByRole('button', { name: 'Create phase' }));
    expect(view.getByRole('dialog')).toBeTruthy();
    await act(async () => finishCreate(ok({ phase: { id: 'phase-delayed', slug: 'delayed-phase', name: 'Delayed Phase', position: 1, status: 'open' } })));
    await waitFor(() => expect(view.queryByRole('dialog')).toBeNull());
    await settle();
    expect(view.getAllByRole('heading', { name: 'Delayed Phase' })).toHaveLength(1);
    expect(view.getAllByRole('heading', { level: 2 }).map(item => item.textContent)).toEqual(['Phase 05', 'Delayed Phase', 'Phase 06']);
  });
  it('refreshes both reads on board changes and polling', async () => {
    vi.useFakeTimers();
    const fake = fakeManagement({});
    render(<PhasesScreen workspace={workspaceA} management={fake.api} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { window.dispatchEvent(new Event('board-changed')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(fake.boardPhases).toHaveBeenCalledTimes(3);
    expect(fake.boardSettings).toHaveBeenCalledTimes(3);
  });
});
