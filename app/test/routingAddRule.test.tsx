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

async function openAdd(panel: ReturnType<typeof within>): Promise<HTMLElement> {
  fireEvent.click(panel.getByRole('button', { name: 'Add rule' }));
  await act(async () => {});
  return screen.getByRole('dialog');
}

function rawRules(settings: BoardSettings): Array<Record<string, unknown>> {
  return structuredClone(settings.board.config!.rules as Array<Record<string, unknown>>);
}

function withAddedRule(base: BoardSettings, rule: Record<string, unknown>, view: BoardSettings['rules'][number]): BoardSettings {
  const next = structuredClone(base);
  (next.board.config!.rules as Array<Record<string, unknown>>).push(rule);
  next.rules = [...next.rules, view];
  return next;
}

it('adds an agent rule for the first free status with the available defaults', async () => {
  const { panel } = await setup();
  const view = await openAdd(panel);
  expect(within(view).getByRole('heading', { name: 'Add rule' })).toBeTruthy();
  expect(within(view).getByText('Choose the status the rule is for and what happens to tickets in it.')).toBeTruthy();
  const status = within(view).getByLabelText('Status') as HTMLSelectElement;
  expect(Array.from(status.options, option => option.value)).toEqual(['dev-ready', 'done']);
  expect(status.value).toBe('dev-ready');
  expect(within(view).getByText('Only statuses without a rule are listed.')).toBeTruthy();
  expect(within(view).getByRole('radiogroup', { name: 'What happens' })).toBeTruthy();
  expect(within(view).getByRole('radio', { name: /An agent works it/ }).getAttribute('aria-checked')).toBe('true');
  expect(within(view).getByRole('radio', { name: /Built-in action: merge/ }).getAttribute('aria-checked')).toBe('false');
  expect((within(view).getByLabelText('Role') as HTMLSelectElement).value).toBe('Developer');
  expect((within(view).getByLabelText('Workflow') as HTMLSelectElement).value).toBe('board-develop');
  expect((within(view).getByLabelText('Works in') as HTMLSelectElement).value).toBe('worktree');
  expect((within(view).getByLabelText('If it passes') as HTMLSelectElement).value).toBe('done');
  expect((within(view).getByLabelText('If it fails') as HTMLSelectElement).value).toBe('backlog');
  expect((within(view).getByLabelText('If it is blocked') as HTMLSelectElement).value).toBe('');
  expect(within(view).getByRole('switch', { name: 'Sync the base branch first' }).getAttribute('aria-checked')).toBe('true');
  expect(within(view).getByText('Applies to every team using this board')).toBeTruthy();
  expect(within(view).queryByRole('button', { name: 'Remove rule' })).toBeNull();
});

it('adds an agent rule with sync base on by default and can turn it off', async () => {
  const base = routingSettingsFixture();
  const update = vi.fn(async () => ({ ok: true as const, data: {} }));
  const addedRule = { when: { status: 'dev-ready' }, role: 'Developer', workflow: 'board-develop', workspace: 'worktree', onPass: 'done', onFail: 'backlog' };
  const refreshed = withAddedRule(base, addedRule, {
    index: 5, status: 'dev-ready', type: 'agent', role: 'Developer', workflow: 'board-develop', action: null, onPass: 'done', onFail: 'backlog', onBlocked: null, workspace: 'worktree', syncBase: false, maxRounds: null, priority: null, onFailureLimit: null, protected: false,
  });
  const { panel } = await setup({ updateBoardSettings: update }, [base, refreshed]);
  const view = await openAdd(panel);
  const sync = within(view).getByRole('switch', { name: 'Sync the base branch first' });
  expect(sync.getAttribute('aria-checked')).toBe('true');
  fireEvent.click(sync);
  expect(sync.getAttribute('aria-checked')).toBe('false');
  await act(async () => { fireEvent.click(within(view).getByRole('button', { name: 'Add rule' })); });
  const expected = rawRules(base); expected.push(addedRule);
  expect(update).toHaveBeenCalledExactlyOnceWith('ws-a', { rules: expected }, base.board.sha256);
  expect(screen.getByText('Added a rule for dev-ready.')).toBeTruthy();
});

it('adds a rule for a free protected status without locking it as a protected route', async () => {
  const base = routingSettingsFixture();
  (base.board.config!.rules as Array<Record<string, unknown>>).splice(3, 1);
  base.rules = base.rules.filter(rule => rule.status !== 'merge-conflict').map((rule, index) => ({ ...rule, index }));
  const addedRule = { when: { status: 'merge-conflict' }, role: 'TeamLead', workflow: 'board-resolve-merge', workspace: 'worktree', syncBase: true, onPass: 'done', onFail: 'backlog' };
  const refreshed = structuredClone(base);
  (refreshed.board.config!.rules as Array<Record<string, unknown>>).push(addedRule);
  refreshed.rules = [...refreshed.rules, {
    index: refreshed.rules.length, status: 'merge-conflict', type: 'agent', role: 'TeamLead', workflow: 'board-resolve-merge', action: null,
    onPass: 'done', onFail: 'backlog', onBlocked: null, workspace: 'worktree', syncBase: true, maxRounds: null, priority: null, onFailureLimit: null, protected: true,
  }];
  const update = vi.fn(async () => ({ ok: true as const, data: {} }));
  const { panel } = await setup({ updateBoardSettings: update }, [base, refreshed]);
  const view = await openAdd(panel);
  fireEvent.change(within(view).getByLabelText('Status'), { target: { value: 'merge-conflict' } });
  expect(within(view).queryByText(/This is a protected route/)).toBeNull();
  expect(within(view).queryByText('Protected routes cannot be removed')).toBeNull();
  expect((within(view).getByLabelText('Workflow') as HTMLSelectElement).disabled).toBe(false);
  expect((within(view).getByLabelText('Works in') as HTMLSelectElement).disabled).toBe(false);
  fireEvent.change(within(view).getByLabelText('Role'), { target: { value: 'TeamLead' } });
  fireEvent.change(within(view).getByLabelText('Workflow'), { target: { value: 'board-resolve-merge' } });
  await act(async () => { fireEvent.click(within(view).getByRole('button', { name: 'Add rule' })); });
  const expected = rawRules(base); expected.push(addedRule);
  expect(update).toHaveBeenCalledExactlyOnceWith('ws-a', { rules: expected }, base.board.sha256);
  expect(screen.getByText('Added a rule for merge-conflict.')).toBeTruthy();
});

it('returns to the agent defaults when switching back from the merge action', async () => {
  const base = routingSettingsFixture();
  const update = vi.fn(async () => ({ ok: true as const, data: {} }));
  const addedRule = { when: { status: 'dev-ready' }, role: 'Developer', workflow: 'board-develop', workspace: 'worktree', syncBase: true, onPass: 'done', onFail: 'backlog' };
  const refreshed = withAddedRule(base, addedRule, {
    index: 5, status: 'dev-ready', type: 'agent', role: 'Developer', workflow: 'board-develop', action: null, onPass: 'done', onFail: 'backlog', onBlocked: null, workspace: 'worktree', syncBase: true, maxRounds: null, priority: null, onFailureLimit: null, protected: false,
  });
  const { panel } = await setup({ updateBoardSettings: update }, [base, refreshed]);
  const view = await openAdd(panel);
  fireEvent.click(within(view).getByRole('radio', { name: /Built-in action: merge/ }));
  expect(within(view).queryByLabelText('Role')).toBeNull();
  fireEvent.click(within(view).getByRole('radio', { name: /An agent works it/ }));
  expect((within(view).getByLabelText('Role') as HTMLSelectElement).value).toBe('Developer');
  expect((within(view).getByLabelText('Workflow') as HTMLSelectElement).value).toBe('board-develop');
  expect(within(view).getByRole('switch', { name: 'Sync the base branch first' }).getAttribute('aria-checked')).toBe('true');
  await act(async () => { fireEvent.click(within(view).getByRole('button', { name: 'Add rule' })); });
  const expected = rawRules(base); expected.push(addedRule);
  expect(update).toHaveBeenCalledExactlyOnceWith('ws-a', { rules: expected }, base.board.sha256);
  expect(screen.getByText('Added a rule for dev-ready.')).toBeTruthy();
});

it('shows returned board problems and keeps the add dialog open', async () => {
  const update = vi.fn(async () => ({ ok: false as const, error: { code: 'BOARD_CONFIG_INVALID', message: 'invalid', retryable: false, data: { problems: [{ path: 'rules[5].role', message: 'Rejected role' }, { path: 'rules', message: 'Rejected path' }] } } }));
  const { panel } = await setup({ updateBoardSettings: update });
  const view = await openAdd(panel);
  await act(async () => { fireEvent.click(within(view).getByRole('button', { name: 'Add rule' })); });
  expect(within(view).getByText('rules[5].role: Rejected role')).toBeTruthy();
  expect(within(view).getByText('rules: Rejected path')).toBeTruthy();
  expect(within(view).getByLabelText('Role').getAttribute('aria-invalid')).toBe('true');
  expect(screen.getByRole('dialog')).toBeTruthy();
});

it('switches to the built-in merge action and adds it without a role or workflow', async () => {
  const base = routingSettingsFixture();
  const update = vi.fn(async () => ({ ok: true as const, data: {} }));
  const addedRule = { when: { status: 'dev-ready' }, action: 'merge', onPass: 'done', onFail: 'backlog' };
  const refreshed = withAddedRule(base, addedRule, {
    index: 5, status: 'dev-ready', type: 'action', role: null, workflow: null, action: 'merge', onPass: 'done', onFail: 'backlog', onBlocked: null, workspace: null, syncBase: false, maxRounds: null, priority: null, onFailureLimit: null, protected: false,
  });
  const { panel } = await setup({ updateBoardSettings: update }, [base, refreshed]);
  const view = await openAdd(panel);
  fireEvent.click(within(view).getByRole('radio', { name: /Built-in action: merge/ }));
  expect(within(view).getByRole('radio', { name: /Built-in action: merge/ }).getAttribute('aria-checked')).toBe('true');
  expect(within(view).getByText('Runs the built-in merge action. No role or workflow to choose.')).toBeTruthy();
  expect(within(view).queryByLabelText('Role')).toBeNull();
  expect(within(view).queryByLabelText('Workflow')).toBeNull();
  expect(within(view).queryByLabelText('If it is blocked')).toBeNull();
  expect(within(view).queryByLabelText('Escalate after repeated failures')).toBeNull();
  await act(async () => { fireEvent.click(within(view).getByRole('button', { name: 'Add rule' })); });
  const expected = rawRules(base); expected.push(addedRule);
  expect(update).toHaveBeenCalledExactlyOnceWith('ws-a', { rules: expected }, base.board.sha256);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByText('Added a rule for dev-ready.')).toBeTruthy();
  expect(document.activeElement).toBe(panel.getByRole('button', { name: 'Edit rule 6, dev-ready' }));
});

it('changes the status to another free status', async () => {
  const base = routingSettingsFixture();
  const update = vi.fn(async () => ({ ok: true as const, data: {} }));
  const addedRule = { when: { status: 'done' }, role: 'Developer', workflow: 'board-develop', workspace: 'worktree', syncBase: true, onPass: 'done', onFail: 'backlog' };
  const refreshed = withAddedRule(base, addedRule, {
    index: 5, status: 'done', type: 'agent', role: 'Developer', workflow: 'board-develop', action: null, onPass: 'done', onFail: 'backlog', onBlocked: null, workspace: 'worktree', syncBase: true, maxRounds: null, priority: null, onFailureLimit: null, protected: false,
  });
  const { panel } = await setup({ updateBoardSettings: update }, [base, refreshed]);
  const view = await openAdd(panel);
  fireEvent.change(within(view).getByLabelText('Status'), { target: { value: 'done' } });
  await act(async () => { fireEvent.click(within(view).getByRole('button', { name: 'Add rule' })); });
  const expected = rawRules(base); expected.push(addedRule);
  expect(update).toHaveBeenCalledWith('ws-a', { rules: expected }, base.board.sha256);
  expect(screen.getByText('Added a rule for done.')).toBeTruthy();
});

it('disables Add rule and explains when every status already has a rule', async () => {
  const s = routingSettingsFixture();
  const raw = s.board.config!.rules as Array<Record<string, unknown>>;
  raw.push({ when: { status: 'dev-ready' }, action: 'merge', onPass: 'done', onFail: 'backlog' });
  raw.push({ when: { status: 'done' }, action: 'merge', onPass: 'done', onFail: 'backlog' });
  const { panel } = await setup({}, [s]);
  const add = panel.getByRole('button', { name: 'Add rule' }) as HTMLButtonElement;
  expect(add.disabled).toBe(true);
  expect(panel.getByText('Every status already has a rule.')).toBeTruthy();
  expect(add.getAttribute('aria-describedby')).toBe('routing-add-rule-reason');
});

it('shows validation problems instead of saving an invalid default', async () => {
  const s = routingSettingsFixture();
  s.roles = { ...s.roles, items: [] };
  s.workflows = [];
  const update = vi.fn();
  const { panel } = await setup({ updateBoardSettings: update }, [s]);
  const view = await openAdd(panel);
  expect(within(view).getByText('rules[5].role: Choose a configured role.')).toBeTruthy();
  expect(within(view).getByText('rules[5].workflow: Choose a valid workflow.')).toBeTruthy();
  expect(within(view).getByRole('alert').textContent).toContain('rules[0].role: Choose a configured role.');
  expect((within(view).getByRole('button', { name: 'Add rule' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(within(view).getByRole('button', { name: 'Add rule' }));
  expect(update).not.toHaveBeenCalled();
});

it('keeps the add dialog busy while saving and ignores Escape and double submit', async () => {
  let finish!: (value: { ok: true; data: Record<string, never> }) => void;
  const update = vi.fn(() => new Promise<{ ok: true; data: Record<string, never> }>(resolve => { finish = resolve; }));
  const { panel } = await setup({ updateBoardSettings: update }, [routingSettingsFixture(), routingSettingsFixture()]);
  const view = await openAdd(panel);
  fireEvent.click(within(view).getByRole('button', { name: 'Add rule' }));
  expect(update).toHaveBeenCalledTimes(1);
  expect((within(view).getByRole('button', { name: 'Add rule' }) as HTMLButtonElement).disabled).toBe(true);
  expect((within(view).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
  expect((within(view).getByLabelText('Status') as HTMLSelectElement).disabled).toBe(true);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.getByRole('dialog')).toBeTruthy();
  fireEvent.click(within(view).getByRole('button', { name: 'Add rule' }));
  expect(update).toHaveBeenCalledTimes(1);
  await act(async () => { finish({ ok: true, data: {} }); });
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('discards a new rule on Cancel and Escape', async () => {
  const { panel } = await setup();
  const first = await openAdd(panel);
  fireEvent.change(within(first).getByLabelText('Status'), { target: { value: 'done' } });
  fireEvent.click(within(first).getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(panel.getByRole('button', { name: 'Add rule' }));
  const second = await openAdd(panel);
  expect((within(second).getByLabelText('Status') as HTMLSelectElement).value).toBe('dev-ready');
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('keeps the add dialog open on CONFIG_CHANGED and reloads the latest settings', async () => {
  const update = vi.fn(async () => ({ ok: false as const, error: { code: 'CONFIG_CHANGED', message: 'changed', retryable: false } }));
  const { panel } = await setup({ updateBoardSettings: update }, [routingSettingsFixture(), routingSettingsFixture()]);
  const view = await openAdd(panel);
  await act(async () => { fireEvent.click(within(view).getByRole('button', { name: 'Add rule' })); });
  expect(within(view).getByText('CONFIG_CHANGED: changed')).toBeTruthy();
  await act(async () => { fireEvent.click(within(view).getByRole('button', { name: 'Reload latest' })); });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(panel.getByRole('button', { name: 'Add rule' }));
});
