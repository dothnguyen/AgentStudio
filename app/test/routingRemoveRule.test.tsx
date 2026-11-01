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

async function openEdit(panel: ReturnType<typeof within>, index: number): Promise<HTMLElement> {
  const row = panel.getByRole('list', { name: 'Routing transitions' }).querySelectorAll('li')[index]!;
  fireEvent.click(within(row as HTMLElement).getByRole('button', { name: /^Edit rule/ }));
  await act(async () => {});
  return screen.getByRole('dialog');
}

async function openRemove(panel: ReturnType<typeof within>, index: number): Promise<HTMLElement> {
  const edit = await openEdit(panel, index);
  fireEvent.click(within(edit).getByRole('button', { name: 'Remove rule' }));
  await act(async () => {});
  return screen.getByRole('alertdialog');
}

function rawRules(settings: BoardSettings): Array<Record<string, unknown>> {
  return structuredClone(settings.board.config!.rules as Array<Record<string, unknown>>);
}

function withoutRule(base: BoardSettings, index: number): BoardSettings {
  const next = structuredClone(base);
  (next.board.config!.rules as Array<Record<string, unknown>>).splice(index, 1);
  next.rules = next.rules.filter((_rule, i) => i !== index).map((rule, i) => ({ ...rule, index: i }));
  return next;
}

it('removes a rule, announces it and returns focus to Add rule', async () => {
  const base = routingSettingsFixture();
  const refreshed = withoutRule(base, 2);
  const update = vi.fn(async () => ({ ok: true as const, data: {} }));
  const { panel } = await setup({ updateBoardSettings: update }, [base, refreshed]);
  const view = await openRemove(panel, 2);
  expect(within(view).getByRole('heading', { name: 'Remove the rule for plan-merge-ready?' })).toBeTruthy();
  expect(within(view).getByText('Tickets in this status will no longer be worked automatically. You can still move them by hand. This applies to every team using this board.')).toBeTruthy();
  await act(async () => { fireEvent.click(within(view).getByRole('button', { name: 'Remove rule' })); });
  const expected = rawRules(base); expected.splice(2, 1);
  expect(update).toHaveBeenCalledExactlyOnceWith('ws-a', { rules: expected }, base.board.sha256);
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(screen.getByText('Removed the rule for plan-merge-ready.')).toBeTruthy();
  expect(document.activeElement).toBe(panel.getByRole('button', { name: 'Add rule' }));
});

it('keeps the rule and shows the problem when removal would break the path to done', async () => {
  const base = routingSettingsFixture();
  const update = vi.fn();
  const { panel } = await setup({ updateBoardSettings: update }, [base]);
  const view = await openRemove(panel, 1);
  await act(async () => { fireEvent.click(within(view).getByRole('button', { name: 'Remove rule' })); });
  expect(within(view).getByRole('alert').textContent).toContain('rules: No routing path reaches a done status.');
  expect(update).not.toHaveBeenCalled();
  expect(screen.getByRole('alertdialog')).toBeTruthy();
  fireEvent.click(within(view).getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(panel.getByRole('list', { name: 'Routing transitions' }).querySelectorAll('li')).toHaveLength(5);
  expect(document.activeElement).toBe(panel.getByRole('button', { name: 'Edit rule 2, merge-ready' }));
});

it('does not offer removal for a protected route', async () => {
  const { panel } = await setup();
  const edit = await openEdit(panel, 3);
  const remove = within(edit).getByRole('button', { name: 'Remove rule' }) as HTMLButtonElement;
  expect(remove.disabled).toBe(true);
  expect(within(edit).getByText('Protected routes cannot be removed')).toBeTruthy();
  fireEvent.click(remove);
  expect(screen.queryByRole('alertdialog')).toBeNull();
});

it('keeps the alertdialog busy while removing and ignores Escape and double submit', async () => {
  const base = routingSettingsFixture();
  let finish!: (value: { ok: true; data: Record<string, never> }) => void;
  const update = vi.fn(() => new Promise<{ ok: true; data: Record<string, never> }>(resolve => { finish = resolve; }));
  const { panel } = await setup({ updateBoardSettings: update }, [base, withoutRule(base, 2)]);
  const view = await openRemove(panel, 2);
  fireEvent.click(within(view).getByRole('button', { name: 'Remove rule' }));
  expect(update).toHaveBeenCalledTimes(1);
  expect((within(view).getByRole('button', { name: 'Remove rule' }) as HTMLButtonElement).disabled).toBe(true);
  expect((within(view).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.getByRole('alertdialog')).toBeTruthy();
  fireEvent.click(within(view).getByRole('button', { name: 'Remove rule' }));
  expect(update).toHaveBeenCalledTimes(1);
  await act(async () => { finish({ ok: true, data: {} }); });
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(screen.getByText('Removed the rule for plan-merge-ready.')).toBeTruthy();
});

it('discards removal on Cancel and Escape and returns focus to the row', async () => {
  const update = vi.fn();
  const { panel } = await setup({ updateBoardSettings: update });
  const first = await openRemove(panel, 2);
  fireEvent.click(within(first).getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(document.activeElement).toBe(panel.getByRole('button', { name: 'Edit rule 3, plan-merge-ready' }));
  const second = await openRemove(panel, 2);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(update).not.toHaveBeenCalled();
});

it('keeps the alertdialog open and shows returned board problems', async () => {
  const base = routingSettingsFixture();
  const update = vi.fn(async () => ({ ok: false as const, error: { code: 'BOARD_CONFIG_INVALID', message: 'invalid', retryable: false, data: { problems: [{ path: 'rules[2]', message: 'Rejected rule' }] } } }));
  const { panel } = await setup({ updateBoardSettings: update }, [base]);
  const view = await openRemove(panel, 2);
  await act(async () => { fireEvent.click(within(view).getByRole('button', { name: 'Remove rule' })); });
  expect(within(view).getByText('rules[2]: Rejected rule')).toBeTruthy();
  expect(screen.getByRole('alertdialog')).toBeTruthy();
});

it('keeps the alertdialog open on CONFIG_CHANGED and reloads', async () => {
  const base = routingSettingsFixture();
  const update = vi.fn(async () => ({ ok: false as const, error: { code: 'CONFIG_CHANGED', message: 'changed', retryable: false } }));
  const { panel } = await setup({ updateBoardSettings: update }, [base, withoutRule(base, 2)]);
  const view = await openRemove(panel, 2);
  await act(async () => { fireEvent.click(within(view).getByRole('button', { name: 'Remove rule' })); });
  expect(within(view).getByText('CONFIG_CHANGED: changed')).toBeTruthy();
  await act(async () => { fireEvent.click(within(view).getByRole('button', { name: 'Reload latest' })); });
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(document.activeElement).toBe(panel.getByRole('button', { name: 'Edit rule 3, merge-conflict' }));
});
