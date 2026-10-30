// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TeamsScreen } from '../src/renderer/teams/TeamsScreen';
import { workspaceA } from './dashboardFixtures';
import userEvent from '@testing-library/user-event';
import type { BoardSettings } from '../src/renderer/api';
import { RoutingSettingsPanel } from '../src/renderer/teams/RoutingSettingsPanel';
import { rolesFixture, roleItem } from './rolesFixtures';
import { fakeManagement, routingSettingsFixture, escalationSettingsFixture, invalidBoardSettings, missingBoardSettings, longRoutingSettings, onFailureLimitRouting, LONG_UNBROKEN, managementError } from './teamsFixtures';
afterEach(cleanup);
it.each(['board', 'roles'] as const)('blocks an open routing editor when refreshed %s configuration becomes invalid', async invalidFile => {
  const { RoutingSettingsPanel } = await import('../src/renderer/teams/RoutingSettingsPanel');
  const boardWrite = vi.fn(); const roleWrite = vi.fn();
  const fake = fakeManagement({ calls: { updateBoardSettings: boardWrite, updateRole: roleWrite } });
  const settings = routingSettingsFixture();
  const section = { state: 'ready' as const, data: settings, error: null, loading: false, lastUpdatedAt: null, reload: vi.fn(async () => {}) };
  const view = render(<RoutingSettingsPanel workspaceId="ws-a" management={fake.api} connected section={section} />);
  const panel = within(view.getByRole('region', { name: 'Workspace board routing' }));
  fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
  fireEvent.change(panel.getByLabelText('Base branch'), { target: { value: 'draft' } });
  const invalid = invalidFile === 'board'
    ? { ...settings, board: { ...settings.board, state: 'invalid' as const, message: 'Board invalid' } }
    : { ...settings, roles: { ...settings.roles, state: 'invalid' as const, message: 'Roles invalid' } };
  view.rerender(<RoutingSettingsPanel workspaceId="ws-a" management={fake.api} connected section={{ ...section, data: invalid }} />);
  const save = panel.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  fireEvent.submit(save.closest('form')!);
  expect(boardWrite).not.toHaveBeenCalled(); expect(roleWrite).not.toHaveBeenCalled();
  expect(panel.getByText(invalidFile === 'board' ? 'Board invalid' : 'Roles invalid')).toBeTruthy();
});
async function setup(calls: Parameters<typeof fakeManagement>[0]['calls'] = {}, boards = [routingSettingsFixture()]) {
  const fake = fakeManagement({ calls, boardSettings: boards.map(data => ({ ok: true as const, data })) });
  const view = render(<TeamsScreen workspace={workspaceA} management={fake.api} />); await act(async () => {});
  fireEvent.click(view.getByRole('tab', { name: 'Routing' })); await act(async () => {});
  return { fake, panel: within(view.getByRole('region', { name: 'Workspace board routing' })) };
}
it('renders live paths and protected routes', async () => {
  const { panel } = await setup(); fireEvent.click(panel.getByRole('button', { name: 'Merge and worktree settings' }));
  expect(panel.getByText('Base branch: main')).toBeTruthy();
  const rows = panel.getAllByRole('row').slice(1);
  expect(rows).toHaveLength(5);
  expect(Array.from(rows[0].querySelectorAll('td'), td => td.textContent)).toEqual(['1','backlog','Agent','Developer','board-develop','Isolated worktree · sync base','merge-ready','dev-ready','—','3','—','—']);
  expect(rows[1].textContent).toContain('Action: merge'); expect(rows[3].textContent).toContain('Protected');
  fireEvent.click(panel.getByRole('button', { name: 'Protected conflict routing' }));
  expect(panel.getAllByText(/merge-conflict must be handled by role/) ).toBeTruthy();
});
it('saves raw rules with SHA and reloads', async () => {
  const update = vi.fn(async () => ({ ok: true as const, data: {} })); const s = routingSettingsFixture(); const next = routingSettingsFixture({ worktree: { baseBranch: 'new-base', worktreeStatuses: [] } });
  const { panel, fake } = await setup({ updateBoardSettings: update }, [s, next]); fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
  fireEvent.change(panel.getByLabelText('Base branch'), { target: { value: 'new-base' } }); fireEvent.change(panel.getAllByLabelText('Workspace')[0], { target: { value: 'main' } });
  await act(async () => { fireEvent.submit(panel.getByRole('button', { name: 'Save' }).closest('form')!); });
  expect(update).toHaveBeenCalledWith('ws-a', { baseBranch: 'new-base', rules: expect.arrayContaining([expect.objectContaining({ maxRounds: 3, syncBase: true, onFailPriority: 2, onPassCreatedTickets: { status: 'backlog' }, workspace: 'main' })]) }, s.board.sha256);
  expect(fake.boardSettings).toHaveBeenCalledTimes(2); expect(panel.getByText('Routing settings saved.')).toBeTruthy(); expect(panel.getByText('Base branch: new-base')).toBeTruthy();
});
it('keeps invalid and conflicting edits until explicit reload', async () => {
  const update = vi.fn(async () => ({ ok: false as const, error: { code: 'CONFIG_CHANGED', message: 'changed', retryable: false } })); const { panel, fake } = await setup({ updateBoardSettings: update });
  fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
  fireEvent.change(panel.getAllByLabelText('Role')[1], { target: { value: 'Developer' } });
  expect(panel.getByText(/rules\[3\].role: This protected/)).toBeTruthy(); expect((panel.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(panel.getByLabelText(/Role.*rules\[3\]/), { target: { value: 'TeamLead' } });
  fireEvent.change(panel.getAllByLabelText('Role')[2], { target: { value: 'Developer' } });
  expect(panel.getByText(/rules\[4\].role: This protected/)).toBeTruthy(); expect((panel.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(panel.getByLabelText(/Role.*rules\[4\]/), { target: { value: 'TeamLead' } }); fireEvent.change(panel.getByLabelText('Base branch'), { target: { value: 'other' } });
  await act(async () => { fireEvent.submit(panel.getByRole('button', { name: 'Save' }).closest('form')!); }); expect(panel.getByText('CONFIG_CHANGED: changed')).toBeTruthy(); expect((panel.getByLabelText('Base branch') as HTMLInputElement).value).toBe('other');
  await act(async () => { fireEvent.click(panel.getByRole('button', { name: 'Reload latest settings' })); }); expect(fake.boardSettings).toHaveBeenCalledTimes(2); expect(panel.queryByLabelText('Base branch')).toBeNull();
});
it.each(['merge-conflict', 'plan-merge-conflict'])('shows the protected role problem for an action rule using %s', async status => {
  const update = vi.fn();
  const { panel } = await setup({ updateBoardSettings: update });
  fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
  fireEvent.change(panel.getAllByLabelText('Source status')[1], { target: { value: status } });
  expect(within(panel.getByRole('alert')).getByText('rules[1].role: This protected merge-conflict route must use TeamLead.')).toBeTruthy();
  expect((panel.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  expect(update).not.toHaveBeenCalled();
});
it('shows backend validation inline without reloading', async () => {
  const update = vi.fn(async () => ({ ok: false as const, error: { code: 'BOARD_CONFIG_INVALID', message: 'invalid', retryable: false, data: { problems: [{ path: 'rules[0].role', message: 'Rejected role' }] } } }));
  const { panel, fake } = await setup({ updateBoardSettings: update }); fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' })); fireEvent.change(panel.getByLabelText('Base branch'), { target: { value: 'new' } });
  await act(async () => { fireEvent.submit(panel.getByRole('button', { name: 'Save' }).closest('form')!); }); expect(panel.getByText('rules[0].role: Rejected role')).toBeTruthy(); expect(panel.getAllByRole('row')[1].textContent).toContain('Developer'); expect(fake.boardSettings).toHaveBeenCalledTimes(1);
});
it('missing configuration is inspect only', async () => {
  const s = routingSettingsFixture(); s.board = { ...s.board, state: 'missing', message: 'Board missing' }; s.roles = { ...s.roles, state: 'invalid', message: 'Roles invalid' };
  const { panel } = await setup({}, [s]); expect(panel.getByText('Board missing')).toBeTruthy(); expect(panel.getByText('Roles invalid')).toBeTruthy(); expect((panel.getByRole('button', { name: 'Edit routing settings' }) as HTMLButtonElement).disabled).toBe(true);
});
it('reports rejected writes and locks double submission', async () => {
  let reject!: (error: Error) => void; const update = vi.fn(() => new Promise((_resolve, r) => { reject = r; })); const { panel } = await setup({ updateBoardSettings: update });
  fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' })); fireEvent.change(panel.getByLabelText('Base branch'), { target: { value: 'new' } }); const form = panel.getByRole('button', { name: 'Save' }).closest('form')!;
  fireEvent.submit(form); fireEvent.submit(form); expect(update).toHaveBeenCalledTimes(1); await act(async () => { reject(new Error('failure')); }); expect(panel.getByText('INTERNAL: failure')).toBeTruthy();
});

it('blocks duplicate routes and unreachable done without changing the live view', async () => {
  const update = vi.fn(); const { panel } = await setup({ updateBoardSettings: update });
  fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
  fireEvent.change(panel.getAllByLabelText('Source status')[1], { target: { value: 'backlog' } });
  fireEvent.change(panel.getAllByLabelText('Pass status')[0], { target: { value: 'dev-ready' } });
  fireEvent.change(panel.getAllByLabelText('Pass status')[1], { target: { value: 'dev-ready' } });
  expect(panel.getByText('rules[1].when.status: Only one rule can start from status "backlog".')).toBeTruthy();
  expect(panel.getByText('rules: No routing path reaches a done status.')).toBeTruthy();
  expect((panel.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  expect(panel.getAllByRole('row')[1].querySelectorAll('td')[6].textContent).toBe('merge-ready');
  expect(update).not.toHaveBeenCalled();
});

it('does not write unchanged routing', async () => {
  const boardWrite = vi.fn(); const roleWrite = vi.fn(); const { panel } = await setup({ updateBoardSettings: boardWrite, updateRole: roleWrite });
  fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
  fireEvent.submit(panel.getByRole('button', { name: 'Save' }).closest('form')!);
  expect(panel.getByText('No routing changes to save.')).toBeTruthy(); expect(boardWrite).not.toHaveBeenCalled();
  expect(roleWrite).not.toHaveBeenCalled();
});

it('uses dynamic status labels and disables unavailable workflows', async () => {
  const s = routingSettingsFixture();
  s.statuses = s.statuses.map(x => x.id === 'dev-ready' || x.id === 'merge-ready' ? { ...x, name: 'Same name' } : x);
  s.workflows = [...s.workflows, { name: 'broken-flow', builtin: false, roles: ['Developer'], errors: ['bad'] }];
  const { panel } = await setup({}, [s]);
  fireEvent.click(panel.getByRole('button', { name: 'Workflow availability' }));
  expect(panel.getByText('broken-flow (workspace) — roles: Developer — Unavailable')).toBeTruthy();
  fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
  const source = panel.getAllByLabelText('Source status')[0];
  expect(within(source).getByRole('option', { name: 'Same name (dev-ready)' })).toBeTruthy();
  expect(within(source).getByRole('option', { name: 'Same name (merge-ready)' })).toBeTruthy();
  expect((within(panel.getAllByLabelText('Workflow')[0]).getByRole('option', { name: 'broken-flow — unavailable' }) as HTMLOptionElement).disabled).toBe(true);
});

it('disables routing edits when disconnected', async () => {
  const { RoutingSettingsPanel } = await import('../src/renderer/teams/RoutingSettingsPanel');
  const fake = fakeManagement();
  const view = render(<RoutingSettingsPanel workspaceId="ws-a" management={fake.api} connected={false} section={{ state: 'ready', data: routingSettingsFixture(), error: null, loading: false, lastUpdatedAt: null, reload: vi.fn(async () => {}) }} />);
  const panel = within(view.getByRole('region', { name: 'Workspace board routing' }));
  expect((panel.getByRole('button', { name: 'Edit routing settings' }) as HTMLButtonElement).disabled).toBe(true);
});

it('waits for an in-flight settings refresh before reporting a saved route', async () => {
  const initial = routingSettingsFixture();
  const refreshed = routingSettingsFixture({ worktree: { baseBranch: 'new-base', worktreeStatuses: [] } });
  let finishRefresh!: (value: { ok: true; data: typeof initial }) => void;
  let finishWrite!: (value: { ok: true; data: {} }) => void;
  let finishLatest!: (value: { ok: true; data: typeof initial }) => void;
  const boardSettings = vi.fn().mockResolvedValueOnce({ ok: true, data: initial }).mockImplementationOnce(() => new Promise(resolve => { finishRefresh = resolve; })).mockImplementationOnce(() => new Promise(resolve => { finishLatest = resolve; }));
  const updateBoardSettings = vi.fn(() => new Promise<{ ok: true; data: {} }>(resolve => { finishWrite = resolve; }));
  const fake = fakeManagement({ calls: { boardSettings, updateBoardSettings } });
  const view = render(<TeamsScreen workspace={workspaceA} management={fake.api} />);
  await act(async () => {});
  fireEvent.click(view.getByRole('tab', { name: 'Routing' })); await act(async () => {});
  const panel = within(view.getByRole('region', { name: 'Workspace board routing' }));
  fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
  fireEvent.change(panel.getByLabelText('Base branch'), { target: { value: 'new-base' } });
  fireEvent.submit(panel.getByRole('button', { name: 'Save' }).closest('form')!);
  fireEvent.click(view.getByRole('button', { name: 'Refresh' }));
  await act(async () => { finishWrite({ ok: true, data: {} }); });
  expect(panel.queryByText('Routing settings saved.')).toBeNull();
  expect(boardSettings).toHaveBeenCalledTimes(3);
  await act(async () => { finishRefresh({ ok: true, data: initial }); });
  expect(panel.queryByText('Routing settings saved.')).toBeNull();
  await act(async () => { finishLatest({ ok: true, data: refreshed }); });
  expect(panel.getByText('Routing settings saved.')).toBeTruthy();
  expect(panel.getByText('Base branch: new-base')).toBeTruthy();
});

it.each(['write', 'conflict'])('keeps the %s draft when latest settings fail to load', async kind => {
  const initial = routingSettingsFixture();
  const latest = routingSettingsFixture({ worktree: { baseBranch: 'latest', worktreeStatuses: [] } });
  const boardSettings = vi.fn().mockResolvedValueOnce({ ok: true, data: initial }).mockResolvedValueOnce({ ok: false, error: { code: 'OFFLINE', message: 'reload failed', retryable: true } }).mockResolvedValueOnce({ ok: true, data: latest });
  const updateBoardSettings = vi.fn(async () => kind === 'write' ? { ok: true as const, data: {} } : { ok: false as const, error: { code: 'CONFIG_CHANGED', message: 'changed', retryable: false } });
  const fake = fakeManagement({ calls: { boardSettings, updateBoardSettings } });
  const view = render(<TeamsScreen workspace={workspaceA} management={fake.api} />); await act(async () => {});
  fireEvent.click(view.getByRole('tab', { name: 'Routing' })); await act(async () => {});
  const panel = within(view.getByRole('region', { name: 'Workspace board routing' }));
  fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
  fireEvent.change(panel.getByLabelText('Base branch'), { target: { value: 'draft' } });
  await act(async () => { fireEvent.submit(panel.getByRole('button', { name: 'Save' }).closest('form')!); });
  if (kind === 'conflict') await act(async () => { fireEvent.click(panel.getByRole('button', { name: 'Reload latest settings' })); });
  expect((panel.getByLabelText('Base branch') as HTMLInputElement).value).toBe('draft');
  expect(panel.getByText('Reload failed: OFFLINE: reload failed')).toBeTruthy();
  expect(panel.queryByText('Routing settings saved.')).toBeNull();
  await act(async () => { fireEvent.click(panel.getByRole('button', { name: 'Retry latest settings' })); });
  expect(panel.queryByLabelText('Base branch')).toBeNull();
  expect(panel.getByText('Base branch: latest')).toBeTruthy();
  if (kind === 'write') expect(panel.getByText('Routing settings saved.')).toBeTruthy();
  expect(updateBoardSettings).toHaveBeenCalledTimes(1);
});

it('submits all edited fields and preserves the exact remaining raw rules', async () => {
  const s = routingSettingsFixture();
  const update = vi.fn(async () => ({ ok: true as const, data: {} }));
  const { panel } = await setup({ updateBoardSettings: update }, [s]);
  fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
  const firstRule = within(panel.getByRole('group', { name: 'Rule 1 — agent' }));
  fireEvent.change(panel.getByLabelText('Base branch'), { target: { value: 'release-2' } });
  fireEvent.change(firstRule.getByLabelText('Role'), { target: { value: 'TeamLead' } });
  fireEvent.change(firstRule.getByLabelText(/^Workflow/), { target: { value: 'board-resolve-merge' } });
  fireEvent.change(firstRule.getByLabelText('Workspace'), { target: { value: '' } });
  fireEvent.change(firstRule.getByLabelText('Pass status'), { target: { value: 'plan-merge-ready' } });
  const rules = structuredClone(s.board.config!.rules as Array<Record<string, unknown>>);
  rules[0] = { ...rules[0], role: 'TeamLead', workflow: 'board-resolve-merge', onPass: 'plan-merge-ready' };
  delete rules[0].workspace;
  await act(async () => { fireEvent.submit(panel.getByRole('button', { name: 'Save' }).closest('form')!); });
  expect(update).toHaveBeenCalledWith('ws-a', { baseBranch: 'release-2', rules }, s.board.sha256);
});

it('keeps a selected unavailable workflow visible and blocks saving until repaired', async () => {
  const s = routingSettingsFixture();
  s.workflows = s.workflows.map(w => w.name === 'board-develop' ? { ...w, errors: ['invalid'] } : w);
  const { panel } = await setup({}, [s]);
  fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
  const workflow = within(panel.getByRole('group', { name: 'Rule 1 — agent' })).getByLabelText(/^Workflow/) as HTMLSelectElement;
  expect(workflow.value).toBe('board-develop');
  expect(within(workflow).getByRole('option', { name: 'board-develop — unavailable' })).toBeTruthy();
  expect(workflow.getAttribute('aria-invalid')).toBe('true');
  expect(panel.getByText('rules[0].workflow: Choose a valid workflow.')).toBeTruthy();
  expect((panel.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
});

it('locks the saved routing draft after a reload failure until retry succeeds', async () => {
  const initial = routingSettingsFixture();
  const boardSettings = vi.fn().mockResolvedValueOnce({ ok: true, data: initial })
    .mockResolvedValueOnce({ ok: false, error: { code: 'OFFLINE', message: 'reload failed', retryable: true } })
    .mockResolvedValueOnce({ ok: true, data: initial });
  const updateBoardSettings = vi.fn(async () => ({ ok: true as const, data: {} }));
  const updateRole = vi.fn(async () => ({ ok: true as const, data: {} }));
  const fake = fakeManagement({ calls: { boardSettings, updateBoardSettings, updateRole } });
  const view = render(<TeamsScreen workspace={workspaceA} management={fake.api} />); await act(async () => {});
  fireEvent.click(view.getByRole('tab', { name: 'Routing' })); await act(async () => {});
  const panel = within(view.getByRole('region', { name: 'Workspace board routing' }));
  fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
  const control = panel.getByLabelText('Base branch') as HTMLInputElement;
  fireEvent.change(control, { target: { value: 'saved-value' } });
  await act(async () => { fireEvent.submit(panel.getByRole('button', { name: 'Save' }).closest('form')!); });
  expect(panel.getByText('Reload failed: OFFLINE: reload failed')).toBeTruthy();
  expect(control.disabled).toBe(true);
  expect(panel.getAllByRole('combobox').every(select => (select as HTMLSelectElement).disabled)).toBe(true);
  expect((panel.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  expect((panel.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
  expect((panel.getByRole('button', { name: 'Retry latest settings' }) as HTMLButtonElement).disabled).toBe(false);
  await act(async () => { fireEvent.click(panel.getByRole('button', { name: 'Retry latest settings' })); });
  expect(panel.queryByLabelText('Base branch')).toBeNull();
  expect(updateBoardSettings).toHaveBeenCalledTimes(1);
});

it.each(['board', 'roles'] as const)('disables editing when the %s concurrency token is missing', async missing => {
  const settings = routingSettingsFixture();
  settings[missing].sha256 = null;
  const { panel } = await setup({}, [settings]);
  expect((panel.getByRole('button', { name: 'Edit routing settings' }) as HTMLButtonElement).disabled).toBe(true);
});

it('uses the original routing snapshot after a background refresh', async () => {
  const initial = routingSettingsFixture();
  const latest = routingSettingsFixture();
  latest.board.sha256 = 'c'.repeat(64);
  latest.roles.sha256 = 'd'.repeat(64);
  latest.worktree.baseBranch = 'other-operator';
  latest.roles.items = latest.roles.items.map(r => r.id === 'TeamLead' ? { ...r, description: 'other operator' } : r);
  const conflict = { ok: false as const, error: { code: 'CONFIG_CHANGED', message: 'changed since read', retryable: false } };
  const updateBoardSettings = vi.fn(async () => conflict);
  const updateRole = vi.fn(async () => conflict);
  const { panel, fake } = await setup({ updateBoardSettings, updateRole }, [initial, latest]);
  fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
  fireEvent.change(panel.getByLabelText('Base branch'), { target: { value: 'draft' } });
  // The dashboard refresh changes the live view while the editor remains open.
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await act(async () => {});
  await act(async () => { fireEvent.submit(panel.getByRole('button', { name: 'Save' }).closest('form')!); });
  expect(updateBoardSettings).toHaveBeenCalledWith('ws-a', { baseBranch: 'draft' }, initial.board.sha256);
  expect(updateRole).not.toHaveBeenCalled();
  expect(panel.getByText('CONFIG_CHANGED: changed since read')).toBeTruthy();
  expect(fake.boardSettings).toHaveBeenCalledTimes(2);
});

it('associates validation messages with invalid controls and graph errors with an alert', async () => {
  const { panel } = await setup();
  fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
  const base = panel.getByLabelText('Base branch');
  fireEvent.change(base, { target: { value: 'INVALID' } });
  expect(base.getAttribute('aria-invalid')).toBe('true');
  const descriptionId = base.getAttribute('aria-describedby');
  expect(descriptionId).toBeTruthy();
  expect(document.getElementById(descriptionId!)?.textContent).toContain('baseBranch: Use 1–64 lowercase letters');
  fireEvent.change(panel.getAllByLabelText('Pass status')[0], { target: { value: 'dev-ready' } });
  expect(within(panel.getByRole('alert')).getByText('rules: No routing path reaches a done status.')).toBeTruthy();
});

it('routing_validation_alert_does_not_duplicate_section_error_alert', async () => {
  const fake = fakeManagement({ boardSettings: [{ ok: true as const, data: routingSettingsFixture() }], roles: [{ ok: true as const, data: rolesFixture() }, managementError('ROLES_DOWN', 'roles unreadable')] });
  const view = render(<TeamsScreen workspace={workspaceA} management={fake.api} />); await act(async () => {});
  fireEvent.click(view.getByRole('tab', { name: 'Routing' })); await act(async () => {});
  const panel = within(view.getByRole('region', { name: 'Workspace board routing' }));
  fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
  fireEvent.click(view.getByRole('button', { name: 'Refresh' })); await act(async () => {});
  fireEvent.change(panel.getAllByLabelText('Pass status')[0], { target: { value: 'dev-ready' } });
  expect(view.getAllByRole('alert')).toHaveLength(1);
  expect(document.body.textContent).toContain('ROLES_DOWN: roles unreadable');
  expect(document.body.textContent).toContain('No routing path reaches a done status.');
});

it('removes an existing optional blocked route from the submitted raw rule', async () => {
  const settings = routingSettingsFixture();
  (settings.board.config!.rules as Array<Record<string, unknown>>)[0].onBlocked = 'merge-conflict';
  const update = vi.fn(async () => ({ ok: true as const, data: {} }));
  const { panel } = await setup({ updateBoardSettings: update }, [settings]);
  fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
  const first = within(panel.getByRole('group', { name: 'Rule 1 — agent' }));
  fireEvent.change(first.getByLabelText('Blocked status'), { target: { value: '' } });
  const expected = structuredClone(settings.board.config!.rules) as Array<Record<string, unknown>>;
  delete expected[0].onBlocked;
  await act(async () => { fireEvent.submit(panel.getByRole('button', { name: 'Save' }).closest('form')!); });
  expect(update).toHaveBeenCalledWith('ws-a', { rules: expected }, settings.board.sha256);
});

it('uses only backend choices and retains unnamed status ids', async () => {
  const settings = routingSettingsFixture();
  settings.statuses = settings.statuses.map(status => status.id === 'dev-ready' ? { ...status, name: null } : status);
  const { panel } = await setup({}, [settings]);
  fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
  const first = within(panel.getByRole('group', { name: 'Rule 1 — agent' }));
  const values = (label: string) => Array.from((first.getByLabelText(label) as HTMLSelectElement).options, option => option.value);
  expect(values('Source status')).toEqual(settings.statuses.map(status => status.id));
  expect(within(first.getByLabelText('Source status')).getByRole('option', { name: 'dev-ready' })).toBeTruthy();
  expect(values('Role')).toEqual(settings.roles.items.map(role => role.id));
  expect(values('Workflow')).toEqual(settings.workflows.map(workflow => workflow.name));
});

it.each(['board', 'roles'] as const)('makes an invalid %s file inspect-only independently', async invalid => {
  const settings = routingSettingsFixture();
  if (invalid === 'board') settings.board = { ...settings.board, state: 'invalid', message: 'Invalid board', problems: [{ path: 'rules[0]', message: 'broken rule' }] };
  else settings.roles = { ...settings.roles, state: 'invalid', message: 'Invalid roles' };
  const { panel } = await setup({}, [settings]);
  expect(panel.getByText(invalid === 'board' ? 'Invalid board' : 'Invalid roles')).toBeTruthy();
  if (invalid === 'board') expect(panel.getByText('rules[0]: broken rule')).toBeTruthy();
  expect((panel.getByRole('button', { name: 'Edit routing settings' }) as HTMLButtonElement).disabled).toBe(true);
});

it('discards routing drafts on cancel', async () => {
  const boardWrite = vi.fn(); const roleWrite = vi.fn();
  const { panel } = await setup({ updateBoardSettings: boardWrite, updateRole: roleWrite });
  fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
  fireEvent.change(panel.getByLabelText('Base branch'), { target: { value: 'discarded' } });
  fireEvent.click(panel.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
  expect((panel.getByLabelText('Base branch') as HTMLInputElement).value).toBe('main');
  expect(boardWrite).not.toHaveBeenCalled(); expect(roleWrite).not.toHaveBeenCalled();
});


it('does_not_render_or_call_role_metadata_editing', async () => {
  const updateRole = vi.fn();
  const { panel } = await setup({ updateRole });
  expect(panel.queryByRole('heading', { name: 'Roles' })).toBeNull();
  expect(panel.queryByRole('button', { name: 'Edit description' })).toBeNull();
  expect(panel.queryByLabelText(/Description for/)).toBeNull();
  expect(panel.queryByText('Develops')).toBeNull();
  fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
  expect(panel.getAllByLabelText('Role').length).toBeGreaterThan(0);
  expect(updateRole).not.toHaveBeenCalled();
});

it('renders configured policies and accessible disclosures from returned data', async () => {
  const { escalationSettingsFixture } = await import('./teamsFixtures');
  const { RoutingSettingsPanel } = await import('../src/renderer/teams/RoutingSettingsPanel');
  const { roleItem } = await import('./rolesFixtures');
  const s = escalationSettingsFixture();
  s.statuses = s.statuses.map(x => x.id === 'qa-ready' ? { ...x, name: 'QA ready' } : x.id === 'need-escalate' ? { ...x, name: 'Escalate' } : x);
  s.rules[5] = { ...s.rules[5], maxRounds: 4, priority: 5, onBlocked: 'unknown' };
  s.protectedRoutes[0].satisfied = false;
  s.actionRules = [{ status: 'merge-ready', action: 'merge', onPass: 'done', onFail: 'merge-conflict', onPassCreatedTickets: 'backlog' }];
  const onViewRole = vi.fn();
  const view = render(<RoutingSettingsPanel workspaceId="ws-a" management={fakeManagement().api} connected section={{ state: 'ready', data: s, error: null, loading: false, lastUpdatedAt: null, reload: vi.fn(async () => {}) }} roleItems={[roleItem('QA', { name: 'Quality' })]} onViewRole={onViewRole} />);
  const panel = within(view.getByRole('region', { name: 'Workspace board routing' }));
  const rows = panel.getAllByRole('row').slice(1);
  expect(rows).toHaveLength(s.rules.length);
  expect(Array.from(rows[5].querySelectorAll('td'), td => td.textContent)).toEqual(['6', 'QA ready (qa-ready)', 'Agent', 'Quality QA', 'board-qa', 'Isolated worktree', 'merge-ready', 'dev-ready', 'unknown (unknown status)', '4', '5', '3 fails → Escalate (need-escalate)']);
  fireEvent.click(panel.getByRole('button', { name: 'View Quality in Roles (rule 6)' })); expect(onViewRole).toHaveBeenCalledWith('QA');
  expect(rows[3].textContent).toContain('Needs repair'); expect(rows[3].textContent).toContain('Role not in catalog');
  for (const title of ['Merge and worktree settings', 'Failure escalation', 'Protected conflict routing', 'Action rules', 'Workflow availability']) {
    const toggle = panel.getByRole('button', { name: title }); toggle.focus(); expect(document.activeElement).toBe(toggle);
    expect(toggle.tagName).toBe('BUTTON'); expect(toggle.getAttribute('type')).toBe('button'); expect(toggle.tabIndex).not.toBe(-1);
    const content = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false'); expect(content.hasAttribute('hidden')).toBe(true);
    fireEvent.click(toggle); expect(toggle.getAttribute('aria-expanded')).toBe('true'); expect(content.hasAttribute('hidden')).toBe(false);
    fireEvent.click(toggle); expect(toggle.getAttribute('aria-expanded')).toBe('false'); expect(content.hasAttribute('hidden')).toBe(true);
    fireEvent.click(toggle);
  }
  expect(panel.getByText(/QA ready \(qa-ready\) \(role QA\): after 3 failed runs/)).toBeTruthy();
  expect(panel.getAllByText('Escalate (need-escalate) is handled by role SeniorDeveloper using workflow board-senior-develop.')).toBeTruthy();
  expect(panel.getByText('Change the rule for merge-conflict to use role TeamLead.')).toBeTruthy();
  expect(panel.getByText('merge-ready: action merge → pass done, fail merge-conflict; tickets created on pass: backlog')).toBeTruthy();
});

it('shows missing, stale and disconnected states without invented routes', async () => {
  const { RoutingSettingsPanel } = await import('../src/renderer/teams/RoutingSettingsPanel');
  const s = routingSettingsFixture(); s.rules = []; s.board = { ...s.board, state: 'invalid', problems: [{ path: 'rules[0]', message: 'broken rule' }] };
  const section = { state: 'ready' as const, data: s, error: null, loading: false, lastUpdatedAt: null, reload: vi.fn(async () => {}) };
  const fake = fakeManagement();
  const view = render(<RoutingSettingsPanel workspaceId="ws-a" management={fake.api} connected section={section} />);
  expect(view.getByText('rules[0]: broken rule')).toBeTruthy(); expect(view.queryByRole('table')).toBeNull();
  view.rerender(<RoutingSettingsPanel workspaceId="ws-a" management={fake.api} connected={false} section={{ ...section, data: null, error: { code: 'OFFLINE', message: 'offline', retryable: true } }} />);
  expect(view.getByText(/Showing the last loaded routing/)).toBeTruthy(); expect(view.getByText(/Disconnected from the backend/)).toBeTruthy();
  expect(view.getByText('Role names are unavailable; rules show stable role ids.')).toBeTruthy();
});

it('uses renamed routing identifiers and reports missing workflows and handlers', async () => {
  const { escalationRoutingFixture } = await import('./teamsFixtures');
  const { RoutingSettingsPanel } = await import('../src/renderer/teams/RoutingSettingsPanel');
  const s = escalationRoutingFixture();
  s.statuses = s.statuses.map(x => x.id === 'need-escalate' ? { ...x, id: 'triage', name: 'Triage' } : x);
  s.rules = s.rules.filter(r => r.status !== 'need-escalate').map(r => ({ ...r, workflow: r.workflow === 'board-develop' ? 'flow-a' : r.workflow, onFailureLimit: r.onFailureLimit && { ...r.onFailureLimit, status: 'triage' } }));
  s.workflows = s.workflows.filter(w => w.name !== 'board-develop' && w.name !== 'board-senior' && w.name !== 'board-senior-develop');
  const view = render(<RoutingSettingsPanel workspaceId="ws-a" management={fakeManagement().api} connected section={{ state: 'ready', data: s, error: null, loading: false, lastUpdatedAt: null, reload: vi.fn(async () => {}) }} />);
  const panel = within(view.getByRole('region', { name: 'Workspace board routing' }));
  expect(panel.getAllByText('flow-a — not found').length).toBeGreaterThan(0);
  expect(panel.getAllByText('3 fails → Triage (triage)')).toHaveLength(2);
  expect(panel.queryByText(/need-escalate|SeniorDeveloper|board-develop/)).toBeNull();
  fireEvent.click(panel.getByRole('button', { name: 'Failure escalation' }));
  expect(panel.getAllByText('No rule starts from Triage (triage); escalated tickets wait there.')).toHaveLength(2);
  expect(panel.queryByRole('button', { name: /in Roles/ })).toBeNull();
});

it('edits and submits existing failure escalation with the original SHA', async () => {
  const { escalationSettingsFixture } = await import('./teamsFixtures');
  const s = escalationSettingsFixture(); const update = vi.fn(async () => ({ ok: true as const, data: {} }));
  const { panel } = await setup({ updateBoardSettings: update }, [s]);
  fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
  const qa = within(panel.getByRole('group', { name: 'Rule 6 — agent' }));
  const review = within(panel.getByRole('group', { name: 'Rule 7 — agent' }));
  expect((review.getByLabelText('Failure count') as HTMLInputElement).value).toBe('3');
  expect((review.getByLabelText('Escalation target status') as HTMLSelectElement).value).toBe('need-escalate');
  fireEvent.change(qa.getByLabelText('Failure count'), { target: { value: '4' } });
  fireEvent.change(qa.getByLabelText('Escalation target status'), { target: { value: 'dev-ready' } });
  const rules = structuredClone(s.board.config!.rules) as Array<Record<string, unknown>>;
  rules[5].onFailureLimit = { count: 4, status: 'dev-ready' };
  await act(async () => { fireEvent.submit(panel.getByRole('button', { name: 'Save' }).closest('form')!); });
  expect(update).toHaveBeenCalledWith('ws-a', { rules }, s.board.sha256);
});

it('enables and removes failure escalation without changing another rule', async () => {
  const s = routingSettingsFixture(); const update = vi.fn(async () => ({ ok: true as const, data: {} }));
  const { panel } = await setup({ updateBoardSettings: update }, [s]);
  fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
  const first = within(panel.getByRole('group', { name: 'Rule 1 — agent' }));
  const toggle = first.getByLabelText('Escalate after repeated failures');
  fireEvent.click(toggle); expect((first.getByLabelText('Failure count') as HTMLInputElement).value).toBe('1');
  expect(document.activeElement).toBe(first.getByLabelText('Failure count'));
  fireEvent.click(toggle); fireEvent.click(toggle);
  const rules = structuredClone(s.board.config!.rules) as Array<Record<string, unknown>>;
  rules[0].onFailureLimit = { count: 1, status: s.statuses[0].id };
  await act(async () => { fireEvent.submit(panel.getByRole('button', { name: 'Save' }).closest('form')!); });
  expect(update).toHaveBeenCalledWith('ws-a', { rules }, s.board.sha256);
});

it('blocks invalid escalation and maps backend escalation problems inline', async () => {
  const { escalationSettingsFixture } = await import('./teamsFixtures'); const s = escalationSettingsFixture();
  const update = vi.fn(async () => ({ ok: false as const, error: { code: 'BOARD_CONFIG_INVALID', message: 'invalid', retryable: false, data: { problems: [{ path: 'rules[5].onFailureLimit.count', message: 'Rejected count' }, { path: 'rules[5].onFailureLimit.status', message: 'Rejected target' }] } } }));
  const { panel } = await setup({ updateBoardSettings: update }, [s]); fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
  const qa = within(panel.getByRole('group', { name: 'Rule 6 — agent' })); const count = qa.getByLabelText('Failure count');
  fireEvent.change(count, { target: { value: '0' } }); expect(count.getAttribute('aria-invalid')).toBe('true');
  expect(update).not.toHaveBeenCalled(); fireEvent.change(count, { target: { value: '4' } });
  await act(async () => { fireEvent.submit(panel.getByRole('button', { name: 'Save' }).closest('form')!); });
  expect(qa.getAllByText('rules[5].onFailureLimit.count: Rejected count')).toHaveLength(1);
  expect(qa.getAllByText('rules[5].onFailureLimit.status: Rejected target')).toHaveLength(1);
  expect(qa.getByLabelText(/Escalation target status/).getAttribute('aria-invalid')).toBe('true');
});

it.each(['', 'unknown-status'])('blocks a client-invalid escalation target %s', async status => {
  const { escalationSettingsFixture } = await import('./teamsFixtures');
  const settings = escalationSettingsFixture();
  (settings.board.config!.rules as Array<Record<string, unknown>>)[5].onFailureLimit = { count: 3, status };
  const update = vi.fn();
  const { panel } = await setup({ updateBoardSettings: update }, [settings]);
  fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
  const qa = within(panel.getByRole('group', { name: 'Rule 6 — agent' }));
  expect(qa.getByLabelText(/Escalation target status/).getAttribute('aria-invalid')).toBe('true');
  expect(qa.getByText('rules[5].onFailureLimit.status: Choose a status from this board.')).toBeTruthy();
  const save = panel.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  fireEvent.submit(save.closest('form')!);
  expect(update).not.toHaveBeenCalled();
});

it('clears the no-op notice when the base branch changes', async () => {
  const update = vi.fn();
  const { panel } = await setup({ updateBoardSettings: update });
  fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
  fireEvent.submit(panel.getByRole('button', { name: 'Save' }).closest('form')!);
  expect(panel.getByText('No routing changes to save.')).toBeTruthy();
  fireEvent.change(panel.getByLabelText('Base branch'), { target: { value: 'new-base' } });
  expect(panel.queryByText('No routing changes to save.')).toBeNull();
  expect(update).not.toHaveBeenCalled();
});

it('states workspace-wide future timing without calling other mutation APIs', async () => {
  const { panel, fake } = await setup();
  fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
  expect(panel.getByText('Saved changes apply workspace-wide to future board claims and transitions. They do not change member roles or shared role instructions, cancel current assignments, or reroute work already in flight.')).toBeTruthy();
  fireEvent.click(panel.getByRole('button', { name: 'Cancel' }));
  expect(fake.api.updateRole).not.toHaveBeenCalled();
});

it('submits removal of an existing escalation without altering other raw fields', async () => {
  const { escalationSettingsFixture } = await import('./teamsFixtures');
  const settings = escalationSettingsFixture();
  const update = vi.fn(async () => ({ ok: true as const, data: {} }));
  const { panel } = await setup({ updateBoardSettings: update }, [settings]);
  fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
  const qa = within(panel.getByRole('group', { name: 'Rule 6 — agent' }));
  fireEvent.click(qa.getByLabelText('Escalate after repeated failures'));
  expect(qa.queryByLabelText('Failure count')).toBeNull();
  const rules = structuredClone(settings.board.config!.rules) as Array<Record<string, unknown>>;
  delete rules[5].onFailureLimit;
  await act(async () => { fireEvent.submit(panel.getByRole('button', { name: 'Save' }).closest('form')!); });
  expect(update).toHaveBeenCalledExactlyOnceWith('ws-a', { rules }, settings.board.sha256);
});

it('keeps edit choices and validation on the captured snapshot after refresh', async () => {
  const { RoutingSettingsPanel } = await import('../src/renderer/teams/RoutingSettingsPanel');
  const initial = routingSettingsFixture();
  const latest = structuredClone(initial);
  latest.statuses = latest.statuses.map(s => s.id === 'dev-ready' ? { ...s, name: 'New label' } : s);
  latest.workflows = latest.workflows.filter(w => w.name !== 'board-develop');
  latest.board.sha256 = 'c'.repeat(64);
  const update = vi.fn(async () => ({ ok: true as const, data: {} }));
  const fake = fakeManagement({ calls: { updateBoardSettings: update } });
  const section = { state: 'ready' as const, data: initial, error: null, loading: false, lastUpdatedAt: null, reload: vi.fn(async () => {}) };
  const view = render(<RoutingSettingsPanel workspaceId="ws-a" management={fake.api} connected section={section} />);
  const panel = within(view.getByRole('region', { name: 'Workspace board routing' }));
  fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
  view.rerender(<RoutingSettingsPanel workspaceId="ws-a" management={fake.api} connected section={{ ...section, data: latest }} />);
  const first = within(panel.getByRole('group', { name: 'Rule 1 — agent' }));
  expect(within(first.getByLabelText('Source status')).queryByRole('option', { name: 'New label (dev-ready)' })).toBeNull();
  expect((within(first.getByLabelText('Workflow')).getByRole('option', { name: 'board-develop' }) as HTMLOptionElement).disabled).toBe(false);
  fireEvent.change(panel.getByLabelText('Base branch'), { target: { value: 'draft' } });
  await act(async () => { fireEvent.submit(panel.getByRole('button', { name: 'Save' }).closest('form')!); });
  expect(update).toHaveBeenCalledExactlyOnceWith('ws-a', { baseBranch: 'draft' }, initial.board.sha256);
});

it.each(['board', 'roles', 'rules'] as const)('makes independently missing or malformed %s inspect-only', async kind => {
  const settings = routingSettingsFixture();
  if (kind === 'board') settings.board = { ...settings.board, state: 'missing' };
  else if (kind === 'roles') settings.roles = { ...settings.roles, state: 'missing' };
  else settings.board.config!.rules = [null];
  const update = vi.fn();
  const { panel } = await setup({ updateBoardSettings: update }, [settings]);
  expect((panel.getByRole('button', { name: 'Edit routing settings' }) as HTMLButtonElement).disabled).toBe(true);
  expect(update).not.toHaveBeenCalled();
});

it.each(['board', 'roles'] as const)('makes a missing %s SHA inspect-only', async kind => {
  const settings = routingSettingsFixture();
  settings[kind].sha256 = null;
  const update = vi.fn();
  const { panel } = await setup({ updateBoardSettings: update }, [settings]);
  const edit = panel.getByRole('button', { name: 'Edit routing settings' }) as HTMLButtonElement;
  expect(edit.disabled).toBe(true);
  fireEvent.click(edit);
  expect(panel.queryByRole('button', { name: 'Save' })).toBeNull();
  expect(update).not.toHaveBeenCalled();
});

it('uses returned status labels and ids for both existing escalation policies', async () => {
  const { escalationSettingsFixture } = await import('./teamsFixtures');
  const settings = escalationSettingsFixture();
  settings.statuses = settings.statuses.map(s => s.id === 'need-escalate' ? { ...s, name: 'Custom escalation' } : s).reverse();
  const { panel } = await setup({}, [settings]);
  fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
  for (const rule of [6, 7]) {
    const group = within(panel.getByRole('group', { name: `Rule ${rule} — agent` }));
    const target = group.getByLabelText('Escalation target status') as HTMLSelectElement;
    expect(target.value).toBe('need-escalate');
    expect(within(target).getByRole('option', { name: 'Custom escalation (need-escalate)' })).toBeTruthy();
    expect((group.getByLabelText('Failure count') as HTMLInputElement).value).toBe('3');
  }
});

it('only writes board settings when saving a routing change', async () => {
  const update = vi.fn(async () => ({ ok: true as const, data: {} }));
  const { panel, fake } = await setup({ updateBoardSettings: update });
  fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
  fireEvent.change(panel.getByLabelText('Base branch'), { target: { value: 'new-base' } });
  await act(async () => { fireEvent.submit(panel.getByRole('button', { name: 'Save' }).closest('form')!); });
  expect(update).toHaveBeenCalledTimes(1);
  for (const method of ['createRole', 'updateRole', 'updateRoleInstructions', 'deleteRole', 'addMember', 'updateMember', 'removeMember', 'runBoard', 'stopBoard', 'switchMemberAgent', 'resumeMemberAgent'] as const) {
    expect(fake.api[method]).not.toHaveBeenCalled();
  }
});

type Section = Parameters<typeof RoutingSettingsPanel>[0]['section'];
const sectionOf = (over: Partial<Section>): Section => ({ state: 'ready', data: null, error: null, loading: false, lastUpdatedAt: null, reload: vi.fn(async () => {}), ...over });
const noWrites = () => ({ updateBoardSettings: vi.fn(), updateRole: vi.fn(), updateMember: vi.fn(), switchMemberAgent: vi.fn(), cancelAssignment: vi.fn() });
const saveForm = (panel: ReturnType<typeof within>) => panel.getByRole('button', { name: 'Save' }).closest('form')!;

it('loading_missing_invalid_disconnected_stale_and_retry_states', async () => {
  const fake = fakeManagement();
  const mount = (section: Section, connected = true) => render(<RoutingSettingsPanel workspaceId="ws-a" management={fake.api} connected={connected} section={section} />);
  const loading = mount(sectionOf({ state: 'loading', loading: true }));
  expect(loading.getByRole('status').textContent).toBe('Loading settings…');
  expect(loading.queryByRole('table')).toBeNull(); expect(loading.queryByRole('button', { name: 'Edit routing settings' })).toBeNull();
  loading.unmount();
  const reloadFresh = vi.fn(async () => ({ ok: false as const, error: { code: 'READ_FAILED', message: 'boom', retryable: true } }));
  const failed = mount(sectionOf({ state: 'error', error: { code: 'READ_FAILED', message: 'boom', retryable: true, remediation: 'Restart the coordinator.' }, reloadFresh }));
  expect(failed.getByRole('alert').textContent).toContain('READ_FAILED: boom');
  expect(failed.getByRole('alert').textContent).toContain('Restart the coordinator.');
  await act(async () => { fireEvent.click(failed.getByRole('button', { name: 'Retry' })); });
  expect(reloadFresh).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(failed.getByRole('button', { name: 'Retry' }));
  failed.unmount();
  const noRemediation = mount(sectionOf({ state: 'error', error: { code: 'X', message: 'y', retryable: false } }));
  expect(noRemediation.getByRole('alert').querySelectorAll('p')[1]!.textContent!.length).toBeGreaterThan(0);
  noRemediation.unmount();
  const missing = mount(sectionOf({ data: missingBoardSettings() }));
  expect(missing.getByText('No workspace board is configured, so no routing is shown.')).toBeTruthy();
  expect((missing.queryByRole('button', { name: 'Edit routing settings' }) as HTMLButtonElement).disabled).toBe(true);
  missing.unmount();
  const invalid = mount(sectionOf({ data: invalidBoardSettings() }));
  expect(invalid.getByText(/configuration is invalid/)).toBeTruthy(); expect(invalid.getByText('rules[0]: bad rule')).toBeTruthy();
  invalid.unmount();
  const stale = mount(sectionOf({ state: 'error', data: null, error: { code: 'READ_FAILED', message: 'boom', retryable: true } }), false);
  stale.unmount();
  const good = routingSettingsFixture();
  const first = mount(sectionOf({ data: good }), false);
  expect(first.getByText('Disconnected from the backend. Routing is read-only until the connection returns.')).toBeTruthy();
  expect((first.getByRole('button', { name: 'Edit routing settings' }) as HTMLButtonElement).disabled).toBe(true);
  first.rerender(<RoutingSettingsPanel workspaceId="ws-a" management={fake.api} connected section={sectionOf({ state: 'error', data: null, error: { code: 'READ_FAILED', message: 'boom', retryable: true } })} />);
  expect(first.getByText('Showing the last loaded routing; it may be out of date.')).toBeTruthy();
  expect(first.getByRole('table', { name: 'Routing transitions' })).toBeTruthy();
  expect((first.getByRole('button', { name: 'Edit routing settings' }) as HTMLButtonElement).disabled).toBe(true);
  expect(first.getAllByRole('alert')).toHaveLength(1);
});

it('failed_board_refresh_keeps_open_routing_draft_read_only_until_retry_succeeds', async () => {
  const settings = routingSettingsFixture();
  const update = vi.fn(async () => ({ ok: true as const, data: {} }));
  const fake = fakeManagement({
    boardSettings: [{ ok: true, data: settings }, managementError('BOARD_DOWN', 'board unreadable'), { ok: true, data: settings }],
    calls: { updateBoardSettings: update },
  });
  const view = render(<TeamsScreen workspace={workspaceA} management={fake.api} />);
  await act(async () => {});
  fireEvent.click(view.getByRole('tab', { name: 'Routing' }));
  const panel = within(view.getByRole('region', { name: 'Workspace board routing' }));
  fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
  fireEvent.change(panel.getByLabelText('Base branch'), { target: { value: 'draft-branch' } });
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Refresh' })); });
  expect(panel.getByText('Showing the last loaded routing; it may be out of date.')).toBeTruthy();
  expect((panel.getByLabelText('Base branch') as HTMLInputElement).value).toBe('draft-branch');
  const save = panel.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  fireEvent.submit(save.closest('form')!);
  expect(update).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(panel.getByRole('button', { name: 'Retry' })); });
  expect(fake.boardSettings).toHaveBeenCalledTimes(3);
  expect((panel.getByLabelText('Base branch') as HTMLInputElement).value).toBe('draft-branch');
  expect((panel.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false);
});

it('failed_board_refresh_identifies_previously_loaded_routing_in_its_warning', async () => {
  const fake = fakeManagement({ boardSettings: [{ ok: true, data: routingSettingsFixture() }, managementError('BOARD_DOWN', 'board unreadable')] });
  const view = render(<TeamsScreen workspace={workspaceA} management={fake.api} />);
  await act(async () => {});
  fireEvent.click(view.getByRole('tab', { name: 'Routing' }));
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Refresh' })); });
  const alert = within(view.getByRole('region', { name: 'Workspace board routing' })).getByRole('alert');
  expect(alert.textContent).toContain('Showing previously loaded data.');
  expect(alert.textContent).toContain('BOARD_DOWN: board unreadable');
});

it('routing_disclosures_are_native_and_keyboard_operable', async () => {
  const { panel } = await setup();
  const toggles = ['Merge and worktree settings', 'Failure escalation', 'Protected conflict routing', 'Action rules', 'Workflow availability'].map(n => panel.getByRole('button', { name: n }));
  for (const t of toggles) {
    expect(t.tagName).toBe('BUTTON'); expect(t.getAttribute('aria-expanded')).toBe('false');
    const region = document.getElementById(t.getAttribute('aria-controls')!)!;
    expect(region.hidden).toBe(true); expect(region.getAttribute('aria-labelledby')).toBe(t.id);
    t.focus();
    await userEvent.keyboard('{Enter}');
    expect(t.getAttribute('aria-expanded')).toBe('true'); expect(region.hidden).toBe(false); expect(document.activeElement).toBe(t);
    await userEvent.keyboard(' ');
    expect(t.getAttribute('aria-expanded')).toBe('false'); expect(region.hidden).toBe(true);
  }
  expect(panel.getByRole('region', { name: 'Routing transitions (scrollable)' }).tabIndex).toBe(0);
});

it('long_dynamic_routes_and_failure_escalation_are_not_hard_coded', async () => {
  const long = await setup({}, [longRoutingSettings()]);
  expect(long.panel.getAllByText(new RegExp(LONG_UNBROKEN)).length).toBeGreaterThan(0);
  cleanup();
  const custom = await setup({}, [onFailureLimitRouting(7, 'custom-escalation')]);
  fireEvent.click(custom.panel.getByRole('button', { name: 'Failure escalation' }));
  const chains = custom.panel.getByRole('list', { name: 'Failure escalation chains' }).textContent!;
  expect(chains).toContain('after 7 failed runs'); expect(chains).toContain('custom-escalation');
  expect(chains).not.toContain('after 3 failed runs');
  cleanup();
  const none = await setup({}, [onFailureLimitRouting(null)]);
  fireEvent.click(none.panel.getByRole('button', { name: 'Failure escalation' }));
  expect(none.panel.getByText('No failure escalation is configured.')).toBeTruthy();
});

it('role_links_use_stable_ids_or_render_diagnostics', async () => {
  const fake = fakeManagement(); const onViewRole = vi.fn();
  const settings = routingSettingsFixture();
  const items = rolesFixture({ items: [roleItem('Developer', { name: 'Developer Display' })] }).items;
  const view = render(<RoutingSettingsPanel workspaceId="ws-a" management={fake.api} connected section={sectionOf({ data: settings })} roleItems={items} onViewRole={onViewRole} />);
  fireEvent.click(view.getByRole('button', { name: 'View Developer Display in Roles (rule 1)' }));
  expect(onViewRole).toHaveBeenCalledTimes(1); expect(onViewRole).toHaveBeenCalledWith('Developer');
  expect(view.getAllByText('Role not in catalog').length).toBeGreaterThan(0);
  expect(view.queryByRole('button', { name: /View TeamLead/ })).toBeNull();
  view.rerender(<RoutingSettingsPanel workspaceId="ws-a" management={fake.api} connected section={sectionOf({ data: settings })} roleItems={null} onViewRole={onViewRole} />);
  expect(view.queryAllByRole('button', { name: /in Roles/ })).toHaveLength(0);
  expect(view.getAllByText('Role catalog unavailable').length).toBeGreaterThan(0);
  expect(view.getByText('Role names are unavailable; rules show stable role ids.')).toBeTruthy();
});

it('validation_focuses_first_invalid_field_and_announces_once', async () => {
  const update = vi.fn(async () => ({ ok: false as const, error: { code: 'BOARD_CONFIG_INVALID', message: 'invalid', retryable: false, data: { problems: [{ path: 'rules[1].onPass', message: 'Rejected pass' }, { path: 'rules[0].role', message: 'Rejected role' }] } } }));
  const { panel } = await setup({ updateBoardSettings: update });
  fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
  fireEvent.change(panel.getByLabelText('Base branch'), { target: { value: 'next' } });
  const save = panel.getByRole('button', { name: 'Save' }); save.focus();
  await act(async () => { fireEvent.submit(saveForm(panel)); });
  const invalid = Array.from(document.querySelectorAll<HTMLElement>('[aria-invalid="true"]'));
  expect(invalid.length).toBe(2);
  expect(document.activeElement).toBe(save);
  expect(panel.getAllByRole('alert')).toHaveLength(1);
  expect(panel.getAllByText('rules[0].role: Rejected role')).toHaveLength(1);
  expect(update).toHaveBeenCalledTimes(1);
});

it('client_validation_moves_focus_to_the_first_invalid_field', async () => {
  const update = vi.fn(); const { panel } = await setup({ updateBoardSettings: update });
  fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
  fireEvent.change(panel.getAllByLabelText('Source status')[1], { target: { value: 'backlog' } });
  const invalid = Array.from(document.querySelectorAll<HTMLElement>('[aria-invalid="true"]'));
  expect(invalid.length).toBeGreaterThan(0);
  expect(document.activeElement).toBe(invalid[0]);
  expect((panel.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  expect(update).not.toHaveBeenCalled();
});

it('client_validation_focuses_the_first_of_multiple_invalid_fields', async () => {
  const update = vi.fn(); const { panel } = await setup({ updateBoardSettings: update });
  fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
  const base = panel.getByLabelText('Base branch');
  fireEvent.change(base, { target: { value: '' } });
  const source = panel.getAllByLabelText('Source status')[1];
  source.focus();
  fireEvent.change(source, { target: { value: 'backlog' } });
  const invalid = Array.from(document.querySelectorAll<HTMLElement>('[aria-invalid="true"]'));
  expect(invalid.length).toBeGreaterThan(1);
  expect(document.activeElement).toBe(invalid[0]);
  expect((panel.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  expect(update).not.toHaveBeenCalled();
});

it('routing_server_failure_retains_keyboard_submit_focus_and_draft', async () => {
  const update = vi.fn(async () => ({ ok: false as const, error: { code: 'INTERNAL', message: 'Save failed', retryable: true } }));
  const { panel } = await setup({ updateBoardSettings: update });
  const user = userEvent.setup();
  await user.click(panel.getByRole('button', { name: 'Edit routing settings' }));
  const base = panel.getByLabelText('Base branch') as HTMLInputElement;
  await user.clear(base); await user.type(base, 'next');
  const save = panel.getByRole('button', { name: 'Save' });
  save.focus(); await user.keyboard('{Enter}');
  expect(update).toHaveBeenCalledTimes(1);
  expect(panel.getByText('INTERNAL: Save failed')).toBeTruthy();
  expect(base.value).toBe('next');
  expect(document.activeElement).toBe(save);
});

it('routing_write_failure_without_backend_remediation_offers_a_next_step', async () => {
  const update = vi.fn(async () => ({ ok: false as const, error: { code: 'WRITE_FAILED', message: 'Could not save routing', retryable: true } }));
  const { panel } = await setup({ updateBoardSettings: update });
  fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
  fireEvent.change(panel.getByLabelText('Base branch'), { target: { value: 'next' } });
  await act(async () => { fireEvent.submit(saveForm(panel)); });
  const alert = panel.getByRole('alert');
  expect(within(alert).getByText('WRITE_FAILED: Could not save routing')).toBeTruthy();
  expect(alert.querySelectorAll('p').length).toBeGreaterThan(1);
  expect(Array.from(alert.querySelectorAll('p')).slice(1).some(p => p.textContent?.trim())).toBe(true);
  expect((panel.getByLabelText('Base branch') as HTMLInputElement).value).toBe('next');
  expect(update).toHaveBeenCalledTimes(1);
});

it('no_op_cancel_double_submit_and_config_changed_reload_are_safe', async () => {
  const hold: { resolve?: (v: unknown) => void } = {};
  const update = vi.fn()
    .mockImplementationOnce(() => new Promise(resolve => { hold.resolve = resolve; }))
    .mockResolvedValue({ ok: false as const, error: { code: 'CONFIG_CHANGED', message: 'changed', retryable: false } });
  const s = routingSettingsFixture(); const latest = routingSettingsFixture({ worktree: { baseBranch: 'fresh', worktreeStatuses: [] } });
  const { panel, fake } = await setup({ updateBoardSettings: update }, [s, latest]);
  const edit = panel.getByRole('button', { name: 'Edit routing settings' });
  fireEvent.click(edit);
  await act(async () => { fireEvent.submit(saveForm(panel)); });
  expect(update).not.toHaveBeenCalled(); expect(panel.getByText('No routing changes to save.')).toBeTruthy();
  fireEvent.click(panel.getByRole('button', { name: 'Cancel' })); expect(document.activeElement).toBe(panel.getByRole('button', { name: 'Edit routing settings' }));
  expect(panel.queryByLabelText('Base branch')).toBeNull();
  fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
  fireEvent.change(panel.getByLabelText('Base branch'), { target: { value: 'draft' } });
  fireEvent.submit(saveForm(panel)); fireEvent.submit(saveForm(panel));
  expect(update).toHaveBeenCalledTimes(1);
  expect(update).toHaveBeenCalledWith('ws-a', expect.objectContaining({ baseBranch: 'draft' }), s.board.sha256);
  await act(async () => { hold.resolve!({ ok: false, error: { code: 'CONFIG_CHANGED', message: 'changed', retryable: false } }); });
  expect((panel.getByLabelText('Base branch') as HTMLInputElement).value).toBe('draft');
  const reload = panel.getByRole('button', { name: 'Reload latest settings' });
  expect(document.activeElement).toBe(reload);
  expect(panel.getAllByRole('alert')).toHaveLength(1);
  expect((panel.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { fireEvent.click(reload); });
  expect(fake.boardSettings).toHaveBeenCalledTimes(2);
  expect(panel.queryByLabelText('Base branch')).toBeNull();
  expect(panel.getByText('Base branch: fresh')).toBeTruthy();
  expect(document.activeElement).toBe(panel.getByRole('heading', { name: 'Workspace board routing' }));
});

it('failed_config_changed_reload_retains_draft_and_focus', async () => {
  const update = vi.fn().mockResolvedValue({ ok: false as const, error: { code: 'CONFIG_CHANGED', message: 'changed', retryable: false } });
  const view = await (async () => {
    const fake = fakeManagement({ calls: { updateBoardSettings: update } });
    const reloadFresh = vi.fn(async () => ({ ok: false as const, error: { code: 'READ_FAILED', message: 'still down', retryable: true } }));
    const section = sectionOf({ data: routingSettingsFixture(), reloadFresh });
    const v = render(<RoutingSettingsPanel workspaceId="ws-a" management={fake.api} connected section={section} />);
    return { v, reloadFresh };
  })();
  const panel = within(view.v.getByRole('region', { name: 'Workspace board routing' }));
  fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
  fireEvent.change(panel.getByLabelText('Base branch'), { target: { value: 'draft' } });
  await act(async () => { fireEvent.submit(saveForm(panel)); });
  await act(async () => { fireEvent.click(panel.getByRole('button', { name: 'Reload latest settings' })); });
  expect(view.reloadFresh).toHaveBeenCalledTimes(1);
  expect((panel.getByLabelText('Base branch') as HTMLInputElement).value).toBe('draft');
  expect(panel.getByText(/READ_FAILED: still down/)).toBeTruthy();
  expect(panel.getAllByRole('button', { name: /Reload latest settings|Retry latest settings/ }).some(b => b === document.activeElement)).toBe(true);
});

it('failed_conflict_reload_shows_backend_remediation_with_the_error', async () => {
  const update = vi.fn().mockResolvedValue({ ok: false as const, error: { code: 'CONFIG_CHANGED', message: 'changed', retryable: false } });
  const fake = fakeManagement({ calls: { updateBoardSettings: update } });
  const reloadFresh = vi.fn(async () => ({ ok: false as const, error: { code: 'READ_FAILED', message: 'still down', retryable: true, remediation: 'Check the workspace configuration.' } }));
  const view = render(<RoutingSettingsPanel workspaceId="ws-a" management={fake.api} connected section={sectionOf({ data: routingSettingsFixture(), reloadFresh })} />);
  const panel = within(view.getByRole('region', { name: 'Workspace board routing' }));
  fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
  fireEvent.change(panel.getByLabelText('Base branch'), { target: { value: 'draft' } });
  await act(async () => { fireEvent.submit(saveForm(panel)); });
  await act(async () => { fireEvent.click(panel.getByRole('button', { name: 'Reload latest settings' })); });
  const alert = panel.getByRole('alert');
  expect(alert.textContent).toContain('READ_FAILED: still down');
  expect(alert.textContent).toContain('Check the workspace configuration.');
  expect((panel.getByLabelText('Base branch') as HTMLInputElement).value).toBe('draft');
  expect(update).toHaveBeenCalledTimes(1);
});

it('thrown_conflict_reload_has_actionable_internal_error_and_retains_draft', async () => {
  const update = vi.fn().mockResolvedValue({ ok: false as const, error: { code: 'CONFIG_CHANGED', message: 'changed', retryable: false } });
  const fake = fakeManagement({ calls: { updateBoardSettings: update } });
  const reloadFresh = vi.fn().mockRejectedValue(new Error('read unavailable'));
  const view = render(<RoutingSettingsPanel workspaceId="ws-a" management={fake.api} connected section={sectionOf({ data: routingSettingsFixture(), reloadFresh })} />);
  const panel = within(view.getByRole('region', { name: 'Workspace board routing' }));
  fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
  fireEvent.change(panel.getByLabelText('Base branch'), { target: { value: 'draft' } });
  await act(async () => { fireEvent.submit(saveForm(panel)); });
  await act(async () => { fireEvent.click(panel.getByRole('button', { name: 'Reload latest settings' })); });
  const alert = panel.getByRole('alert');
  expect(alert.textContent).toContain('INTERNAL: read unavailable');
  expect(alert.textContent).toContain('Retry loading the latest settings');
  expect(alert.textContent).not.toContain('Error: read unavailable');
  expect((panel.getByLabelText('Base branch') as HTMLInputElement).value).toBe('draft');
  expect(document.activeElement).toBe(panel.getByRole('button', { name: 'Reload latest settings' }));
  expect(update).toHaveBeenCalledTimes(1);
});

it('unknown_fields_protected_routes_and_failure_escalation_survive_submit', async () => {
  const s = escalationSettingsFixture();
  const raw = s.board.config!.rules as Array<Record<string, unknown>>;
  raw[0] = { ...raw[0], futureField: { nested: ['kept'] } };
  (s.board.config as Record<string, unknown>).topLevelUnknown = 'kept';
  const update = vi.fn(async () => ({ ok: true as const, data: {} }));
  const { panel } = await setup({ updateBoardSettings: update }, [s]);
  fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
  fireEvent.change(panel.getByLabelText('Base branch'), { target: { value: 'trunk' } });
  fireEvent.change(within(panel.getByRole('group', { name: 'Rule 1 — agent' })).getByLabelText('Workspace'), { target: { value: 'main' } });
  await act(async () => { fireEvent.submit(saveForm(panel)); });
  expect(update).toHaveBeenCalledTimes(1);
  const expected = structuredClone(raw); expected[0] = { ...expected[0], workspace: 'main' };
  expect(update).toHaveBeenCalledWith('ws-a', { baseBranch: 'trunk', rules: expected }, s.board.sha256);
  const sent = (update.mock.calls[0] as unknown as [string, { rules: Array<Record<string, unknown>> }])[1].rules;
  expect(sent[0]!.futureField).toEqual({ nested: ['kept'] });
  expect(sent[5]!.onFailureLimit).toEqual({ count: 3, status: 'need-escalate' });
  expect(sent[3]).toEqual(raw[3]); expect(sent[4]).toEqual(raw[4]);
});

it('routing_never_calls_role_member_or_assignment_apis', async () => {
  const calls = noWrites();
  const update = vi.fn(async () => ({ ok: true as const, data: {} }));
  const { panel } = await setup({ ...calls, updateBoardSettings: update });
  fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
  fireEvent.change(panel.getByLabelText('Base branch'), { target: { value: 'trunk' } });
  await act(async () => { fireEvent.submit(saveForm(panel)); });
  expect(update).toHaveBeenCalledTimes(1);
  for (const [name, fn] of Object.entries(calls)) if (name !== 'updateBoardSettings') expect(fn).not.toHaveBeenCalled();
});
