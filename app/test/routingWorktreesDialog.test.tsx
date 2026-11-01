// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RoutingScreen } from '../src/renderer/routing/RoutingScreen';
import type { BoardSettings } from '../src/renderer/api';
import { workspaceA } from './dashboardFixtures';
import { fakeManagement, routingSettingsFixture } from './teamsFixtures';

afterEach(cleanup);

async function setup(calls: Parameters<typeof fakeManagement>[0]['calls'] = {}, boards: BoardSettings[] = [routingSettingsFixture()]) {
  const fake = fakeManagement({ calls, boardSettings: boards.map(data => ({ ok: true as const, data })) });
  const view = render(<RoutingScreen workspace={workspaceA} management={fake.api} />);
  await act(async () => {});
  const panel = within(view.getByRole('region', { name: 'Workspace board routing' }));
  return { fake, view, panel };
}

async function openWorktrees(panel: ReturnType<typeof within>): Promise<HTMLElement> {
  fireEvent.click(panel.getByRole('button', { name: 'Edit worktrees' }));
  await act(async () => {});
  return screen.getByRole('dialog');
}

it('edits the base branch with its hint and keeps an unchanged value read-only for saving', async () => {
  const { panel } = await setup();
  const view = await openWorktrees(panel);
  expect(within(view).getByRole('heading', { name: 'Edit worktrees' })).toBeTruthy();
  const base = within(view).getByLabelText('Base branch') as HTMLInputElement;
  expect(base.value).toBe('main');
  expect(base.required).toBe(true);
  expect(base.getAttribute('aria-required')).toBe('true');
  const hintId = base.getAttribute('aria-describedby')!;
  expect(document.getElementById(hintId)?.textContent).toBe('Isolated worktrees branch from here, and finished work is merged back into it.');
  expect((within(view).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  expect(within(view).getByText('Applies to every team using this board')).toBeTruthy();
});

it('saves the base branch with the sha, announces it and returns focus', async () => {
  const base = routingSettingsFixture();
  const refreshed = routingSettingsFixture({ worktree: { baseBranch: 'release-2', worktreeStatuses: [] } });
  const update = vi.fn(async () => ({ ok: true as const, data: {} }));
  const { panel } = await setup({ updateBoardSettings: update }, [base, refreshed]);
  const view = await openWorktrees(panel);
  fireEvent.change(within(view).getByLabelText('Base branch'), { target: { value: 'release-2' } });
  await act(async () => { fireEvent.click(within(view).getByRole('button', { name: 'Save' })); });
  expect(update).toHaveBeenCalledExactlyOnceWith('ws-a', { baseBranch: 'release-2' }, base.board.sha256);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByText('Saved base branch.')).toBeTruthy();
  expect(document.activeElement).toBe(panel.getByRole('button', { name: 'Edit worktrees' }));
});

it('marks an invalid base branch, describes it and blocks saving', async () => {
  const update = vi.fn();
  const { panel } = await setup({ updateBoardSettings: update });
  const view = await openWorktrees(panel);
  const base = within(view).getByLabelText('Base branch');
  fireEvent.change(base, { target: { value: 'INVALID' } });
  const describedBy = base.getAttribute('aria-describedby')!;
  expect(base.getAttribute('aria-invalid')).toBe('true');
  expect(describedBy.split(' ').map(id => document.getElementById(id)?.textContent ?? '').join(' ')).toContain('Use 1–64 lowercase letters, numbers, or hyphens');
  expect((within(view).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(base, { target: { value: '' } });
  expect(base.getAttribute('aria-invalid')).toBe('true');
  expect((within(view).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  expect(update).not.toHaveBeenCalled();
});

it('shows returned board problems next to the field and in the dialog', async () => {
  const update = vi.fn(async () => ({ ok: false as const, error: { code: 'BOARD_CONFIG_INVALID', message: 'invalid', retryable: false, data: { problems: [{ path: 'baseBranch', message: 'Rejected branch' }, { path: 'rules', message: 'Rejected rules' }] } } }));
  const { panel } = await setup({ updateBoardSettings: update });
  const view = await openWorktrees(panel);
  const base = within(view).getByLabelText('Base branch');
  fireEvent.change(base, { target: { value: 'release-2' } });
  await act(async () => { fireEvent.click(within(view).getByRole('button', { name: 'Save' })); });
  expect(within(view).getByText('baseBranch: Rejected branch')).toBeTruthy();
  expect(within(view).getByText('rules: Rejected rules')).toBeTruthy();
  expect(base.getAttribute('aria-invalid')).toBe('true');
  expect(base.getAttribute('aria-describedby')!.split(' ').map(id => document.getElementById(id)?.textContent ?? '').join(' ')).toContain('Rejected branch');
  expect(screen.getByRole('dialog')).toBeTruthy();
});

it('discards the draft on Cancel and Escape', async () => {
  const update = vi.fn();
  const { panel } = await setup({ updateBoardSettings: update });
  const first = await openWorktrees(panel);
  fireEvent.change(within(first).getByLabelText('Base branch'), { target: { value: 'discarded' } });
  fireEvent.click(within(first).getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(panel.getByRole('button', { name: 'Edit worktrees' }));
  const second = await openWorktrees(panel);
  expect((within(second).getByLabelText('Base branch') as HTMLInputElement).value).toBe('main');
  fireEvent.change(within(second).getByLabelText('Base branch'), { target: { value: 'discarded' } });
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(update).not.toHaveBeenCalled();
});

it('keeps the dialog busy while saving and ignores Escape', async () => {
  let finish!: (value: { ok: true; data: Record<string, never> }) => void;
  const update = vi.fn(() => new Promise<{ ok: true; data: Record<string, never> }>(resolve => { finish = resolve; }));
  const { panel } = await setup({ updateBoardSettings: update }, [routingSettingsFixture(), routingSettingsFixture()]);
  const view = await openWorktrees(panel);
  fireEvent.change(within(view).getByLabelText('Base branch'), { target: { value: 'release-3' } });
  fireEvent.click(within(view).getByRole('button', { name: 'Save' }));
  expect((within(view).getByLabelText('Base branch') as HTMLInputElement).disabled).toBe(true);
  expect((within(view).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.getByRole('dialog')).toBeTruthy();
  await act(async () => { finish({ ok: true, data: {} }); });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByText('Saved base branch.')).toBeTruthy();
});

it('keeps the dialog open on CONFIG_CHANGED and focuses Reload latest', async () => {
  const update = vi.fn(async () => ({ ok: false as const, error: { code: 'CONFIG_CHANGED', message: 'changed', retryable: false } }));
  const { panel } = await setup({ updateBoardSettings: update }, [routingSettingsFixture(), routingSettingsFixture()]);
  const view = await openWorktrees(panel);
  fireEvent.change(within(view).getByLabelText('Base branch'), { target: { value: 'release-2' } });
  await act(async () => { fireEvent.click(within(view).getByRole('button', { name: 'Save' })); });
  expect(within(view).getByText('CONFIG_CHANGED: changed')).toBeTruthy();
  const reload = within(view).getByRole('button', { name: 'Reload latest' });
  expect(document.activeElement).toBe(reload);
  await act(async () => { fireEvent.click(reload); });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByText('Saved base branch.')).toBeNull();
  expect(document.activeElement).toBe(panel.getByRole('button', { name: 'Edit worktrees' }));
});
