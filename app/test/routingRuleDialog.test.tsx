// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RoutingScreen } from '../src/renderer/routing/RoutingScreen';
import type { BoardSettings } from '../src/renderer/api';
import { workspaceA } from './dashboardFixtures';
import { escalationSettingsFixture, fakeManagement, routingSettingsFixture } from './teamsFixtures';
import { rolesFixture } from './rolesFixtures';

afterEach(cleanup);

async function setup(calls: Parameters<typeof fakeManagement>[0]['calls'] = {}, boards: BoardSettings[] = [routingSettingsFixture()]) {
  const fake = fakeManagement({ calls, boardSettings: boards.map(data => ({ ok: true as const, data })) });
  const view = render(<RoutingScreen workspace={workspaceA} management={fake.api} />);
  await act(async () => {});
  const panel = within(view.getByRole('region', { name: 'Workspace board routing' }));
  return { fake, view, panel };
}

function dialog(): HTMLElement {
  return screen.getByRole('dialog');
}

async function openRule(panel: ReturnType<typeof within>, index: number): Promise<HTMLElement> {
  const row = panel.getByRole('list', { name: 'Routing transitions' }).querySelectorAll('li')[index]!;
  fireEvent.click(within(row as HTMLElement).getByRole('button', { name: /^Edit rule/ }));
  await act(async () => {});
  return dialog();
}

function rawRules(settings: BoardSettings): Array<Record<string, unknown>> {
  return structuredClone(settings.board.config!.rules as Array<Record<string, unknown>>);
}

it('edits an action rule without role, workflow, blocked or escalation fields', async () => {
  const { panel } = await setup();
  const view = await openRule(panel, 1);
  expect(within(view).getByText('When a ticket is in merge-ready')).toBeTruthy();
  expect(within(view).getByText('Runs the built-in merge action. No role or workflow to choose.')).toBeTruthy();
  expect(within(view).queryByLabelText('Role')).toBeNull();
  expect(within(view).queryByLabelText('Workflow')).toBeNull();
  expect(within(view).queryByLabelText('If it is blocked')).toBeNull();
  expect(within(view).queryByLabelText('Escalate after repeated failures')).toBeNull();
  expect((within(view).getByLabelText('If it passes') as HTMLSelectElement).value).toBe('done');
  expect((within(view).getByLabelText('If it fails') as HTMLSelectElement).value).toBe('merge-conflict');
  expect((within(view).getByRole('button', { name: 'Remove rule' }) as HTMLButtonElement).disabled).toBe(false);
  expect(within(view).getByText('Applies to every team using this board')).toBeTruthy();
});

it('uses backend choices, dynamic status labels and disables unavailable workflows', async () => {
  const s = routingSettingsFixture();
  s.statuses = s.statuses.map(status => status.id === 'dev-ready' ? { ...status, name: 'Same name' } : status);
  s.workflows = [...s.workflows, { name: 'broken-flow', builtin: false, roles: ['Developer'], errors: ['bad'] }];
  const { panel } = await setup({}, [s]);
  const view = await openRule(panel, 0);
  const values = (label: string) => Array.from((within(view).getByLabelText(label) as HTMLSelectElement).options, option => option.value);
  expect(values('Role')).toEqual(s.roles.items.map(role => role.id));
  expect(values('Workflow')).toEqual(s.workflows.map(workflow => workflow.name));
  expect(within(within(view).getByLabelText('Workflow')).getByRole('option', { name: 'broken-flow — unavailable' })).toHaveProperty('disabled', true);
  expect(within(within(view).getByLabelText('If it passes')).getByRole('option', { name: 'Same name (dev-ready)' })).toBeTruthy();
  expect(values('Works in')).toEqual(['worktree', 'main', 'none']);
});

it('saves one rule with the sha and preserves every other raw field', async () => {
  const s = routingSettingsFixture();
  const update = vi.fn(async () => ({ ok: true as const, data: {} }));
  const { panel, fake } = await setup({ updateBoardSettings: update }, [s, s]);
  const view = await openRule(panel, 0);
  fireEvent.change(within(view).getByLabelText('If it fails'), { target: { value: 'backlog' } });
  await act(async () => { fireEvent.click(within(view).getByRole('button', { name: 'Save rule' })); });
  const expected = rawRules(s); expected[0] = { ...expected[0], onFail: 'backlog' };
  expect(update).toHaveBeenCalledExactlyOnceWith('ws-a', { rules: expected }, s.board.sha256);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByText('Saved rule 1.')).toBeTruthy();
  expect(document.activeElement).toBe(panel.getByRole('button', { name: 'Edit rule 1, backlog' }));
  for (const method of ['createRole', 'updateRole', 'updateRoleInstructions', 'deleteRole', 'addMember', 'updateMember', 'removeMember', 'runBoard', 'stopBoard', 'switchMemberAgent', 'resumeMemberAgent'] as const) {
    expect(fake.api[method]).not.toHaveBeenCalled();
  }
});

it('reflects and toggles the sync base switch for worktree agent rules', async () => {
  const s = routingSettingsFixture();
  const update = vi.fn(async () => ({ ok: true as const, data: {} }));
  const { panel } = await setup({ updateBoardSettings: update }, [s, s]);
  const view = await openRule(panel, 0);
  const sync = within(view).getByRole('switch', { name: 'Sync the base branch first' });
  expect(sync.getAttribute('aria-checked')).toBe('true');
  fireEvent.click(sync);
  expect(sync.getAttribute('aria-checked')).toBe('false');
  await act(async () => { fireEvent.click(within(view).getByRole('button', { name: 'Save rule' })); });
  const expected = rawRules(s); delete expected[0]!.syncBase;
  expect(update).toHaveBeenCalledExactlyOnceWith('ws-a', { rules: expected }, s.board.sha256);
});

it('hides sync base for action and non-worktree rules and drops it when moving away', async () => {
  const s = routingSettingsFixture();
  const update = vi.fn(async () => ({ ok: true as const, data: {} }));
  const { panel } = await setup({ updateBoardSettings: update }, [s, s]);
  const action = await openRule(panel, 1);
  expect(within(action).queryByRole('switch', { name: 'Sync the base branch first' })).toBeNull();
  fireEvent.click(within(action).getByRole('button', { name: 'Cancel' }));
  const view = await openRule(panel, 0);
  fireEvent.change(within(view).getByLabelText('Works in'), { target: { value: 'main' } });
  expect(within(view).queryByRole('switch', { name: 'Sync the base branch first' })).toBeNull();
  await act(async () => { fireEvent.click(within(view).getByRole('button', { name: 'Save rule' })); });
  const expected = rawRules(s); expected[0] = { ...expected[0], workspace: 'main' }; delete expected[0]!.syncBase;
  expect(update).toHaveBeenCalledExactlyOnceWith('ws-a', { rules: expected }, s.board.sha256);
});

it('links an inline rule problem to its field with aria-describedby', async () => {
  const { panel } = await setup();
  const view = await openRule(panel, 0);
  fireEvent.change(within(view).getByLabelText('Role'), { target: { value: 'TeamLead' } });
  const workflow = within(view).getByLabelText('Workflow');
  expect(workflow.getAttribute('aria-invalid')).toBe('true');
  const describedBy = workflow.getAttribute('aria-describedby')!.split(' ');
  expect(describedBy.map(id => document.getElementById(id)?.textContent ?? '').join(' ')).toContain('rules[0].workflow: The workflow must use role "TeamLead".');
});

it('keeps save disabled while the rule is unchanged and discards on cancel and Escape', async () => {
  const update = vi.fn();
  const { panel } = await setup({ updateBoardSettings: update });
  const first = await openRule(panel, 0);
  expect((within(first).getByRole('button', { name: 'Save rule' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(within(first).getByLabelText('If it fails'), { target: { value: 'backlog' } });
  fireEvent.click(within(first).getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(panel.getByRole('button', { name: 'Edit rule 1, backlog' }));
  const reopened = await openRule(panel, 0);
  expect((within(reopened).getByLabelText('If it fails') as HTMLSelectElement).value).toBe('dev-ready');
  fireEvent.change(within(reopened).getByLabelText('If it fails'), { target: { value: 'backlog' } });
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  const again = await openRule(panel, 0);
  expect((within(again).getByLabelText('If it fails') as HTMLSelectElement).value).toBe('dev-ready');
  expect(update).not.toHaveBeenCalled();
});

it('removes an existing optional blocked route from the submitted raw rule', async () => {
  const s = routingSettingsFixture();
  (s.board.config!.rules as Array<Record<string, unknown>>)[0]!.onBlocked = 'merge-conflict';
  const update = vi.fn(async () => ({ ok: true as const, data: {} }));
  const { panel } = await setup({ updateBoardSettings: update }, [s, s]);
  const view = await openRule(panel, 0);
  expect((within(view).getByLabelText('If it is blocked') as HTMLSelectElement).value).toBe('merge-conflict');
  fireEvent.change(within(view).getByLabelText('If it is blocked'), { target: { value: '' } });
  await act(async () => { fireEvent.click(within(view).getByRole('button', { name: 'Save rule' })); });
  const expected = rawRules(s); delete expected[0]!.onBlocked;
  expect(update).toHaveBeenCalledExactlyOnceWith('ws-a', { rules: expected }, s.board.sha256);
});

it('shows the protected role problem for an action rule using a protected status', async () => {
  const s = routingSettingsFixture();
  (s.board.config!.rules as Array<Record<string, unknown>>)[3] = { when: { status: 'merge-conflict' }, action: 'merge', onPass: 'merge-ready', onFail: 'dev-ready' };
  const update = vi.fn();
  const { panel } = await setup({ updateBoardSettings: update }, [s]);
  const view = await openRule(panel, 3);
  expect(within(view).getByText('Runs the built-in merge action. No role or workflow to choose.')).toBeTruthy();
  expect(within(view).getByRole('alert').textContent).toContain('rules[3].role: This protected merge-conflict route must use TeamLead.');
  expect((within(view).getByRole('button', { name: 'Save rule' }) as HTMLButtonElement).disabled).toBe(true);
  expect(update).not.toHaveBeenCalled();
});

it('shows the graph problem in the dialog and blocks an unreachable rule', async () => {
  const { panel } = await setup();
  const view = await openRule(panel, 0);
  fireEvent.change(within(view).getByLabelText('If it passes'), { target: { value: 'dev-ready' } });
  expect(within(view).getByRole('alert').textContent).toContain('rules: No routing path reaches a done status.');
  expect((within(view).getByRole('button', { name: 'Save rule' }) as HTMLButtonElement).disabled).toBe(true);
});

it('shows returned board problems next to fields and in the dialog', async () => {
  const update = vi.fn(async () => ({ ok: false as const, error: { code: 'BOARD_CONFIG_INVALID', message: 'invalid', retryable: false, data: { problems: [{ path: 'rules[0].role', message: 'Rejected role' }, { path: 'rules[0].onPass', message: 'Rejected pass' }] } } }));
  const { panel } = await setup({ updateBoardSettings: update });
  const view = await openRule(panel, 0);
  fireEvent.change(within(view).getByLabelText('If it fails'), { target: { value: 'backlog' } });
  await act(async () => { fireEvent.click(within(view).getByRole('button', { name: 'Save rule' })); });
  expect(within(view).getByText('rules[0].role: Rejected role')).toBeTruthy();
  expect(within(view).getByText('rules[0].onPass: Rejected pass')).toBeTruthy();
  expect(within(view).getByLabelText('Role').getAttribute('aria-invalid')).toBe('true');
  expect(within(view).getByLabelText('If it passes').getAttribute('aria-invalid')).toBe('true');
  expect(within(view).getByText('BOARD_CONFIG_INVALID: invalid')).toBeTruthy();
});

it('shows a returned status problem next to the Status field instead of the summary', async () => {
  const update = vi.fn(async () => ({ ok: false as const, error: { code: 'BOARD_CONFIG_INVALID', message: 'invalid', retryable: false, data: { problems: [{ path: 'rules[5].when.status', message: 'Rejected status' }] } } }));
  const { panel } = await setup({ updateBoardSettings: update });
  fireEvent.click(panel.getByRole('button', { name: 'Add rule' }));
  await act(async () => {});
  const view = screen.getByRole('dialog');
  await act(async () => { fireEvent.click(within(view).getByRole('button', { name: 'Add rule' })); });
  const status = within(view).getByLabelText('Status');
  expect(status.getAttribute('aria-invalid')).toBe('true');
  const describedBy = status.getAttribute('aria-describedby')!.split(' ');
  expect(describedBy.map(id => document.getElementById(id)?.textContent ?? '').join(' ')).toContain('rules[5].when.status: Rejected status');
  expect(within(view).getByRole('alert').textContent).not.toContain('Rejected status');
  expect(screen.getByRole('dialog')).toBeTruthy();
});

it('keeps max rounds and priority read-only', async () => {
  const { panel } = await setup();
  const view = await openRule(panel, 0);
  expect(within(view).queryByLabelText(/max rounds/i)).toBeNull();
  expect(within(view).queryByLabelText(/priority/i)).toBeNull();
  expect(within(view).queryByRole('spinbutton')).toBeNull();
});

it('locks a protected route workflow and workspace and never lets it be removed', async () => {
  const { panel } = await setup();
  const view = await openRule(panel, 3);
  expect(within(view).getByText('When a ticket is in merge-conflict')).toBeTruthy();
  expect(within(view).getByText('This is a protected route. Its workflow and workspace are fixed so merge conflicts keep being resolved; you can still change the role and what happens next.')).toBeTruthy();
  expect((within(view).getByLabelText('Workflow') as HTMLSelectElement).disabled).toBe(true);
  expect((within(view).getByLabelText('Works in') as HTMLSelectElement).disabled).toBe(true);
  expect((within(view).getByLabelText('Role') as HTMLSelectElement).disabled).toBe(false);
  expect((within(view).getByLabelText('If it passes') as HTMLSelectElement).disabled).toBe(false);
  expect((within(view).getByLabelText('If it fails') as HTMLSelectElement).disabled).toBe(false);
  expect((within(view).getByLabelText('If it is blocked') as HTMLSelectElement).disabled).toBe(false);
  expect((within(view).getByRole('button', { name: 'Remove rule' }) as HTMLButtonElement).disabled).toBe(true);
  expect(within(view).getByText('Protected routes cannot be removed')).toBeTruthy();
  fireEvent.change(within(view).getByLabelText('Role'), { target: { value: 'Developer' } });
  expect(within(view).getByText(/rules\[3\]\.role: This protected merge-conflict route must use TeamLead\./)).toBeTruthy();
  expect((within(view).getByRole('button', { name: 'Save rule' }) as HTMLButtonElement).disabled).toBe(true);
});

it('locks a protected route that needs repair', async () => {
  const s = routingSettingsFixture();
  s.protectedRoutes = s.protectedRoutes.map(route => ({ ...route, satisfied: false }));
  const { panel } = await setup({}, [s]);
  const view = await openRule(panel, 3);
  expect(within(view).getByText(/This is a protected route/)).toBeTruthy();
  expect((within(view).getByLabelText('Workflow') as HTMLSelectElement).disabled).toBe(true);
  expect((within(view).getByRole('button', { name: 'Remove rule' }) as HTMLButtonElement).disabled).toBe(true);
});

it('keeps a selected unavailable workflow visible and blocks saving until repaired', async () => {
  const s = routingSettingsFixture();
  s.workflows = s.workflows.map(workflow => workflow.name === 'board-develop' ? { ...workflow, errors: ['invalid'] } : workflow);
  const { panel } = await setup({}, [s]);
  const view = await openRule(panel, 0);
  const workflow = within(view).getByLabelText('Workflow') as HTMLSelectElement;
  expect(workflow.value).toBe('board-develop');
  expect(within(workflow).getByRole('option', { name: 'board-develop — unavailable' })).toHaveProperty('disabled', true);
  expect(workflow.getAttribute('aria-invalid')).toBe('true');
  expect(within(view).getByText('rules[0].workflow: Choose a valid workflow.')).toBeTruthy();
  expect((within(view).getByRole('button', { name: 'Save rule' }) as HTMLButtonElement).disabled).toBe(true);
});

it('edits and submits existing failure escalation with the original sha', async () => {
  const s = escalationSettingsFixture();
  const update = vi.fn(async () => ({ ok: true as const, data: { rules: [] } }));
  const { panel } = await setup({ updateBoardSettings: update }, [s, s]);
  const view = await openRule(panel, 5);
  expect((within(view).getByLabelText('After this many fails') as HTMLInputElement).value).toBe('3');
  expect((within(view).getByLabelText('Move it to') as HTMLSelectElement).value).toBe('need-escalate');
  fireEvent.change(within(view).getByLabelText('After this many fails'), { target: { value: '4' } });
  fireEvent.change(within(view).getByLabelText('Move it to'), { target: { value: 'dev-ready' } });
  await act(async () => { fireEvent.click(within(view).getByRole('button', { name: 'Save rule' })); });
  const expected = rawRules(s); expected[5] = { ...expected[5], onFailureLimit: { count: 4, status: 'dev-ready' } };
  expect(update).toHaveBeenCalledWith('ws-a', { rules: expected }, s.board.sha256);
});

it('enables escalation with a focusable count, removes it, and submits it again', async () => {
  const s = routingSettingsFixture();
  const update = vi.fn(async () => ({ ok: true as const, data: {} }));
  const { panel } = await setup({ updateBoardSettings: update }, [s, s]);
  const view = await openRule(panel, 0);
  const toggle = within(view).getByLabelText('Escalate after repeated failures');
  fireEvent.click(toggle);
  const count = within(view).getByLabelText('After this many fails') as HTMLInputElement;
  expect(count.value).toBe('1');
  expect(document.activeElement).toBe(count);
  expect((within(view).getByLabelText('Move it to') as HTMLSelectElement).value).toBe(s.statuses[0].id);
  fireEvent.click(toggle);
  expect(within(view).queryByLabelText('After this many fails')).toBeNull();
  fireEvent.click(toggle);
  await act(async () => { fireEvent.click(within(view).getByRole('button', { name: 'Save rule' })); });
  const expected = rawRules(s); expected[0] = { ...expected[0], onFailureLimit: { count: 1, status: s.statuses[0].id } };
  expect(update).toHaveBeenCalledWith('ws-a', { rules: expected }, s.board.sha256);
});

it('blocks invalid escalation and maps backend escalation problems inline', async () => {
  const s = escalationSettingsFixture();
  const update = vi.fn(async () => ({ ok: false as const, error: { code: 'BOARD_CONFIG_INVALID', message: 'invalid', retryable: false, data: { problems: [{ path: 'rules[5].onFailureLimit.count', message: 'Rejected count' }, { path: 'rules[5].onFailureLimit.status', message: 'Rejected target' }] } } }));
  const { panel } = await setup({ updateBoardSettings: update }, [s]);
  const view = await openRule(panel, 5);
  const count = within(view).getByLabelText('After this many fails');
  fireEvent.change(count, { target: { value: '0' } });
  expect(count.getAttribute('aria-invalid')).toBe('true');
  expect(within(view).getByText('rules[5].onFailureLimit.count: Enter a positive whole number.')).toBeTruthy();
  expect((within(view).getByRole('button', { name: 'Save rule' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(count, { target: { value: '4' } });
  await act(async () => { fireEvent.click(within(view).getByRole('button', { name: 'Save rule' })); });
  expect(within(view).getAllByText('rules[5].onFailureLimit.count: Rejected count')).toHaveLength(1);
  expect(within(view).getAllByText('rules[5].onFailureLimit.status: Rejected target')).toHaveLength(1);
  expect(within(view).getByLabelText('Move it to').getAttribute('aria-invalid')).toBe('true');
});

it('keeps the dialog open on CONFIG_CHANGED, focuses reload and returns focus to the row after reloading', async () => {
  const update = vi.fn(async () => ({ ok: false as const, error: { code: 'CONFIG_CHANGED', message: 'changed', retryable: false } }));
  const s = routingSettingsFixture(); const latest = routingSettingsFixture({ worktree: { baseBranch: 'fresh', worktreeStatuses: [] } });
  const { panel } = await setup({ updateBoardSettings: update }, [s, latest]);
  const view = await openRule(panel, 0);
  fireEvent.change(within(view).getByLabelText('If it fails'), { target: { value: 'backlog' } });
  await act(async () => { fireEvent.click(within(view).getByRole('button', { name: 'Save rule' })); });
  expect(within(view).getByText('CONFIG_CHANGED: changed')).toBeTruthy();
  expect((within(view).getByRole('button', { name: 'Save rule' }) as HTMLButtonElement).disabled).toBe(true);
  const reload = within(view).getByRole('button', { name: 'Reload latest' });
  expect(document.activeElement).toBe(reload);
  await act(async () => { fireEvent.click(reload); });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByText(/Saved rule/)).toBeNull();
  expect(document.activeElement).toBe(panel.getByRole('button', { name: 'Edit rule 1, backlog' }));
});

it('keeps the draft and shows the reload failure when the conflict reload also fails', async () => {
  const update = vi.fn(async () => ({ ok: false as const, error: { code: 'CONFIG_CHANGED', message: 'changed', retryable: false } }));
  const fake = fakeManagement({
    boardSettings: [{ ok: true as const, data: routingSettingsFixture() }, { ok: false as const, error: { code: 'READ_FAILED', message: 'still down', retryable: true, remediation: 'Check the workspace configuration.' } }],
    calls: { updateBoardSettings: update },
  });
  const view = render(<RoutingScreen workspace={workspaceA} management={fake.api} />);
  await act(async () => {});
  const panel = within(view.getByRole('region', { name: 'Workspace board routing' }));
  const rule = await openRule(panel, 0);
  fireEvent.change(within(rule).getByLabelText('If it fails'), { target: { value: 'backlog' } });
  await act(async () => { fireEvent.click(within(rule).getByRole('button', { name: 'Save rule' })); });
  await act(async () => { fireEvent.click(within(rule).getByRole('button', { name: 'Reload latest' })); });
  expect(within(rule).getByText('CONFIG_CHANGED: changed')).toBeTruthy();
  expect(within(rule).getByText('Reload failed: READ_FAILED: still down')).toBeTruthy();
  expect(within(rule).getByText('Check the workspace configuration.')).toBeTruthy();
  expect((within(rule).getByLabelText('If it fails') as HTMLSelectElement).value).toBe('backlog');
  expect(within(rule).getByRole('button', { name: 'Retry latest settings' })).toBeTruthy();
  expect(update).toHaveBeenCalledTimes(1);
});

it('keeps the draft and locks the dialog while saving, ignoring Escape and double submit', async () => {
  let finish!: (value: { ok: true; data: Record<string, never> }) => void;
  const update = vi.fn(() => new Promise<{ ok: true; data: Record<string, never> }>(resolve => { finish = resolve; }));
  const { panel } = await setup({ updateBoardSettings: update }, [routingSettingsFixture(), routingSettingsFixture()]);
  const view = await openRule(panel, 0);
  fireEvent.change(within(view).getByLabelText('If it fails'), { target: { value: 'backlog' } });
  fireEvent.click(within(view).getByRole('button', { name: 'Save rule' }));
  expect(update).toHaveBeenCalledTimes(1);
  expect((within(view).getByRole('button', { name: 'Save rule' }) as HTMLButtonElement).disabled).toBe(true);
  expect((within(view).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
  expect((within(view).getByLabelText('If it fails') as HTMLSelectElement).disabled).toBe(true);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.getByRole('dialog')).toBeTruthy();
  fireEvent.click(within(view).getByRole('button', { name: 'Save rule' }));
  expect(update).toHaveBeenCalledTimes(1);
  await act(async () => { finish({ ok: true, data: {} }); });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByText('Saved rule 1.')).toBeTruthy();
});

it('keeps the dialog open with a retry when refreshing after a write fails', async () => {
  const s = routingSettingsFixture();
  const boardSettings = vi.fn().mockResolvedValueOnce({ ok: true as const, data: s })
    .mockResolvedValueOnce({ ok: false as const, error: { code: 'OFFLINE', message: 'reload failed', retryable: true } })
    .mockResolvedValueOnce({ ok: true as const, data: s });
  const update = vi.fn(async () => ({ ok: true as const, data: {} }));
  const fake = fakeManagement({ calls: { boardSettings, updateBoardSettings: update } });
  const view = render(<RoutingScreen workspace={workspaceA} management={fake.api} />);
  await act(async () => {});
  const panel = within(view.getByRole('region', { name: 'Workspace board routing' }));
  const rule = await openRule(panel, 0);
  fireEvent.change(within(rule).getByLabelText('If it fails'), { target: { value: 'backlog' } });
  await act(async () => { fireEvent.click(within(rule).getByRole('button', { name: 'Save rule' })); });
  expect(within(rule).getByText('Reload failed: OFFLINE: reload failed')).toBeTruthy();
  expect((within(rule).getByLabelText('If it fails') as HTMLSelectElement).disabled).toBe(true);
  expect((within(rule).getByRole('button', { name: 'Save rule' }) as HTMLButtonElement).disabled).toBe(true);
  expect((within(rule).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { fireEvent.click(within(rule).getByRole('button', { name: 'Retry latest settings' })); });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByText('Saved rule 1.')).toBeTruthy();
  expect(update).toHaveBeenCalledTimes(1);
});

it('accepts a role catalog label and keeps role ids in the payload', async () => {
  const fake = fakeManagement({
    boardSettings: [{ ok: true, data: routingSettingsFixture() }, { ok: true, data: routingSettingsFixture() }],
    roles: [{ ok: true, data: rolesFixture() }],
    calls: { updateBoardSettings: vi.fn(async () => ({ ok: true as const, data: {} })) },
  });
  const view = render(<RoutingScreen workspace={workspaceA} management={fake.api} />);
  await act(async () => {});
  const panel = within(view.getByRole('region', { name: 'Workspace board routing' }));
  const rule = await openRule(panel, 0);
  expect(within(rule).getByRole('option', { name: 'Developer' })).toBeTruthy();
});
