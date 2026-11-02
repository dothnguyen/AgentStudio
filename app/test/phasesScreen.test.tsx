// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PhasesScreen } from '../src/renderer/boards/PhasesScreen';
import { boardPhasesFixture } from './boardFixtures';
import { workspaceA } from './dashboardFixtures';
import { boardSettingsFixture, fakeManagement, managementError } from './teamsFixtures';

afterEach(() => { cleanup(); vi.useRealTimers(); });
const ok = <T,>(data: T) => ({ ok: true as const, data });
const settle = () => act(async () => {});

describe('PhasesScreen', () => {
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
