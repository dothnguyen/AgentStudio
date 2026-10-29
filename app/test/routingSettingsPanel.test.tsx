// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TeamsScreen } from '../src/renderer/teams/TeamsScreen';
import { workspaceA } from './dashboardFixtures';
import { fakeManagement, routingSettingsFixture } from './teamsFixtures';
afterEach(cleanup);
it.each([
  ['routing', 'board'], ['routing', 'roles'], ['role', 'board'], ['role', 'roles'],
] as const)('blocks an open %s editor when refreshed %s configuration becomes invalid', async (kind, invalidFile) => {
  const { RoutingSettingsPanel } = await import('../src/renderer/teams/RoutingSettingsPanel');
  const boardWrite = vi.fn(); const roleWrite = vi.fn();
  const fake = fakeManagement({ calls: { updateBoardSettings: boardWrite, updateRole: roleWrite } });
  const settings = routingSettingsFixture();
  const section = { state: 'ready' as const, data: settings, error: null, loading: false, lastUpdatedAt: null, reload: vi.fn(async () => {}) };
  const view = render(<RoutingSettingsPanel workspaceId="ws-a" management={fake.api} connected section={section} />);
  const panel = within(view.getByRole('region', { name: 'Worktree and routing settings' }));
  if (kind === 'routing') {
    fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
    fireEvent.change(panel.getByLabelText('Base branch'), { target: { value: 'draft' } });
  } else {
    fireEvent.click(panel.getAllByRole('button', { name: 'Edit description' })[1]);
    fireEvent.change(panel.getByLabelText('Description for TeamLead'), { target: { value: 'draft' } });
  }
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
  return { fake, panel: within(view.getByRole('region', { name: 'Worktree and routing settings' })) };
}
it('renders live paths and protected routes', async () => {
  const { panel } = await setup(); expect(panel.getByText(/Base branch: main/)).toBeTruthy();
  expect(panel.getByText(/backlog → Developer → board-develop/)).toBeTruthy();
  expect(panel.getByText(/^merge-ready → merge → pass: done/)).toBeTruthy();
  expect(panel.getByText(/plan-merge-ready → merge → pass: done/)).toBeTruthy();
  expect(panel.getByText(/^merge-conflict → TeamLead — Protected/)).toBeTruthy(); expect(panel.getByText(/plan-merge-conflict → TeamLead — Protected/)).toBeTruthy();
  expect(panel.getByText(/Develops/)).toBeTruthy(); expect(panel.getByText('board-develop')).toBeTruthy(); expect(panel.queryByText('sentinel')).toBeNull();
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
it('saves role descriptions with roles SHA', async () => {
  const update = vi.fn(async () => ({ ok: true as const, data: {} })); const { panel, fake } = await setup({ updateRole: update });
  fireEvent.click(panel.getAllByRole('button', { name: 'Edit description' })[1]); fireEvent.change(panel.getByLabelText('Description for TeamLead'), { target: { value: ' new text ' } });
  await act(async () => { fireEvent.submit(panel.getByRole('button', { name: 'Save' }).closest('form')!); }); expect(update).toHaveBeenCalledWith('ws-a', 'TeamLead', { description: 'new text' }, 'b'.repeat(64)); expect(fake.boardSettings).toHaveBeenCalledTimes(2); expect(panel.getByText('Role description saved.')).toBeTruthy();
});
it('shows backend validation inline without reloading', async () => {
  const update = vi.fn(async () => ({ ok: false as const, error: { code: 'BOARD_CONFIG_INVALID', message: 'invalid', retryable: false, data: { problems: [{ path: 'rules[0].role', message: 'Rejected role' }] } } }));
  const { panel, fake } = await setup({ updateBoardSettings: update }); fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' })); fireEvent.change(panel.getByLabelText('Base branch'), { target: { value: 'new' } });
  await act(async () => { fireEvent.submit(panel.getByRole('button', { name: 'Save' }).closest('form')!); }); expect(panel.getByText('rules[0].role: Rejected role')).toBeTruthy(); expect(panel.getByText(/backlog → Developer → board-develop/)).toBeTruthy(); expect(fake.boardSettings).toHaveBeenCalledTimes(1);
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
  expect(panel.getByText(/backlog → Developer → board-develop → pass: merge-ready/)).toBeTruthy();
  expect(update).not.toHaveBeenCalled();
});

it('does not write unchanged routing or normalized role descriptions', async () => {
  const boardWrite = vi.fn(); const roleWrite = vi.fn(); const { panel } = await setup({ updateBoardSettings: boardWrite, updateRole: roleWrite });
  fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
  fireEvent.submit(panel.getByRole('button', { name: 'Save' }).closest('form')!);
  expect(panel.getByText('No routing changes to save.')).toBeTruthy(); expect(boardWrite).not.toHaveBeenCalled();
  fireEvent.click(panel.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(panel.getAllByRole('button', { name: 'Edit description' })[1]);
  fireEvent.change(panel.getByLabelText('Description for TeamLead'), { target: { value: ' Leads ' } });
  fireEvent.submit(panel.getByRole('button', { name: 'Save' }).closest('form')!);
  expect(panel.getByText('No role description changes to save.')).toBeTruthy(); expect(roleWrite).not.toHaveBeenCalled();
});

it('sends a blank role description as null', async () => {
  const update = vi.fn(async () => ({ ok: true as const, data: {} })); const { panel } = await setup({ updateRole: update });
  fireEvent.click(panel.getAllByRole('button', { name: 'Edit description' })[1]);
  fireEvent.change(panel.getByLabelText('Description for TeamLead'), { target: { value: '  ' } });
  await act(async () => { fireEvent.submit(panel.getByRole('button', { name: 'Save' }).closest('form')!); });
  expect(update).toHaveBeenCalledWith('ws-a', 'TeamLead', { description: null }, 'b'.repeat(64));
});

it.each(['ROLE_NOT_FOUND', 'ROLES_CONFIG_INVALID', 'CONFIG_CHANGED'])('keeps role form and displays %s details', async code => {
  const update = vi.fn(async () => ({ ok: false as const, error: { code, message: 'backend message', remediation: 'repair it', retryable: false, data: { problems: [{ path: 'roles.TeamLead', message: 'bad role' }] } } }));
  const { panel, fake } = await setup({ updateRole: update });
  fireEvent.click(panel.getAllByRole('button', { name: 'Edit description' })[1]);
  fireEvent.change(panel.getByLabelText('Description for TeamLead'), { target: { value: 'draft' } });
  await act(async () => { fireEvent.submit(panel.getByRole('button', { name: 'Save' }).closest('form')!); });
  expect((panel.getByLabelText('Description for TeamLead') as HTMLTextAreaElement).value).toBe('draft');
  expect(panel.getByText(`${code}: backend message`)).toBeTruthy(); expect(panel.getByText('repair it')).toBeTruthy(); expect(panel.getByText('roles.TeamLead: bad role')).toBeTruthy();
  expect(fake.boardSettings).toHaveBeenCalledTimes(1);
  if (code === 'CONFIG_CHANGED') {
    await act(async () => { fireEvent.click(panel.getByRole('button', { name: 'Reload latest settings' })); });
    expect(fake.boardSettings).toHaveBeenCalledTimes(2); expect(panel.queryByLabelText('Description for TeamLead')).toBeNull();
  }
});

it('uses dynamic status labels and disables unavailable workflows', async () => {
  const s = routingSettingsFixture();
  s.statuses = s.statuses.map(x => x.id === 'dev-ready' || x.id === 'merge-ready' ? { ...x, name: 'Same name' } : x);
  s.workflows = [...s.workflows, { name: 'broken-flow', builtin: false, roles: ['Developer'], errors: ['bad'] }];
  const { panel } = await setup({}, [s]);
  expect(panel.getByText('broken-flow — unavailable')).toBeTruthy();
  fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
  const source = panel.getAllByLabelText('Source status')[0];
  expect(within(source).getByRole('option', { name: 'Same name (dev-ready)' })).toBeTruthy();
  expect(within(source).getByRole('option', { name: 'Same name (merge-ready)' })).toBeTruthy();
  expect((within(panel.getAllByLabelText('Workflow')[0]).getByRole('option', { name: 'broken-flow — unavailable' }) as HTMLOptionElement).disabled).toBe(true);
});

it('disables routing and role edits when disconnected', async () => {
  const { RoutingSettingsPanel } = await import('../src/renderer/teams/RoutingSettingsPanel');
  const fake = fakeManagement();
  const view = render(<RoutingSettingsPanel workspaceId="ws-a" management={fake.api} connected={false} section={{ state: 'ready', data: routingSettingsFixture(), error: null, loading: false, lastUpdatedAt: null, reload: vi.fn(async () => {}) }} />);
  const panel = within(view.getByRole('region', { name: 'Worktree and routing settings' }));
  expect((panel.getByRole('button', { name: 'Edit routing settings' }) as HTMLButtonElement).disabled).toBe(true);
  expect(panel.getAllByRole('button', { name: 'Edit description' }).every(button => (button as HTMLButtonElement).disabled)).toBe(true);
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
  const panel = within(view.getByRole('region', { name: 'Worktree and routing settings' }));
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
  const panel = within(view.getByRole('region', { name: 'Worktree and routing settings' }));
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

it('keeps a role description draft after a rejected write', async () => {
  const update = vi.fn(async () => { throw new Error('connection lost'); });
  const { panel, fake } = await setup({ updateRole: update });
  fireEvent.click(panel.getAllByRole('button', { name: 'Edit description' })[1]);
  fireEvent.change(panel.getByLabelText('Description for TeamLead'), { target: { value: 'draft text' } });
  await act(async () => { fireEvent.submit(panel.getByRole('button', { name: 'Save' }).closest('form')!); });
  expect(panel.getByText('INTERNAL: connection lost')).toBeTruthy();
  expect((panel.getByLabelText('Description for TeamLead') as HTMLTextAreaElement).value).toBe('draft text');
  expect(fake.boardSettings).toHaveBeenCalledTimes(1);
});

it('keeps a saved role draft open until a failed reload succeeds', async () => {
  const initial = routingSettingsFixture();
  const latest = routingSettingsFixture();
  latest.roles.items = latest.roles.items.map(role => role.id === 'TeamLead' ? { ...role, description: 'updated' } : role);
  const boardSettings = vi.fn().mockResolvedValueOnce({ ok: true, data: initial })
    .mockResolvedValueOnce({ ok: false, error: { code: 'OFFLINE', message: 'reload failed', retryable: true } })
    .mockResolvedValueOnce({ ok: true, data: latest });
  const updateRole = vi.fn(async () => ({ ok: true as const, data: {} }));
  const fake = fakeManagement({ calls: { boardSettings, updateRole } });
  const view = render(<TeamsScreen workspace={workspaceA} management={fake.api} />); await act(async () => {});
  const panel = within(view.getByRole('region', { name: 'Worktree and routing settings' }));
  fireEvent.click(panel.getAllByRole('button', { name: 'Edit description' })[1]);
  fireEvent.change(panel.getByLabelText('Description for TeamLead'), { target: { value: 'updated' } });
  await act(async () => { fireEvent.submit(panel.getByRole('button', { name: 'Save' }).closest('form')!); });
  expect((panel.getByLabelText('Description for TeamLead') as HTMLTextAreaElement).value).toBe('updated');
  expect(panel.getByText('Reload failed: OFFLINE: reload failed')).toBeTruthy();
  expect(panel.queryByText('Role description saved.')).toBeNull();
  await act(async () => { fireEvent.click(panel.getByRole('button', { name: 'Retry latest settings' })); });
  expect(panel.queryByLabelText('Description for TeamLead')).toBeNull();
  expect(panel.getByText('Role description saved.')).toBeTruthy();
  expect(panel.getByText('TeamLead').closest('li')?.textContent).toContain('updated');
  expect(updateRole).toHaveBeenCalledTimes(1);
});

it.each(['routing', 'role'] as const)('locks the saved %s draft after a reload failure until retry succeeds', async kind => {
  const initial = routingSettingsFixture();
  const boardSettings = vi.fn().mockResolvedValueOnce({ ok: true, data: initial })
    .mockResolvedValueOnce({ ok: false, error: { code: 'OFFLINE', message: 'reload failed', retryable: true } })
    .mockResolvedValueOnce({ ok: true, data: initial });
  const updateBoardSettings = vi.fn(async () => ({ ok: true as const, data: {} }));
  const updateRole = vi.fn(async () => ({ ok: true as const, data: {} }));
  const fake = fakeManagement({ calls: { boardSettings, updateBoardSettings, updateRole } });
  const view = render(<TeamsScreen workspace={workspaceA} management={fake.api} />); await act(async () => {});
  const panel = within(view.getByRole('region', { name: 'Worktree and routing settings' }));
  if (kind === 'routing') fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
  else fireEvent.click(panel.getAllByRole('button', { name: 'Edit description' })[1]);
  const control = panel.getByLabelText(kind === 'routing' ? 'Base branch' : 'Description for TeamLead') as HTMLInputElement | HTMLTextAreaElement;
  fireEvent.change(control, { target: { value: 'saved-value' } });
  await act(async () => { fireEvent.submit(panel.getByRole('button', { name: 'Save' }).closest('form')!); });
  expect(panel.getByText('Reload failed: OFFLINE: reload failed')).toBeTruthy();
  expect(control.disabled).toBe(true);
  if (kind === 'routing') expect(panel.getAllByRole('combobox').every(select => (select as HTMLSelectElement).disabled)).toBe(true);
  expect((panel.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  expect((panel.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
  expect((panel.getByRole('button', { name: 'Retry latest settings' }) as HTMLButtonElement).disabled).toBe(false);
  await act(async () => { fireEvent.click(panel.getByRole('button', { name: 'Retry latest settings' })); });
  expect(panel.queryByLabelText(kind === 'routing' ? 'Base branch' : 'Description for TeamLead')).toBeNull();
  expect(kind === 'routing' ? updateBoardSettings : updateRole).toHaveBeenCalledTimes(1);
});

it.each(['board', 'roles'] as const)('disables editing when the %s concurrency token is missing', async missing => {
  const settings = routingSettingsFixture();
  settings[missing].sha256 = null;
  const { panel } = await setup({}, [settings]);
  expect((panel.getByRole('button', { name: 'Edit routing settings' }) as HTMLButtonElement).disabled).toBe(true);
});

it.each(['routing', 'role'] as const)('uses the original %s snapshot after a background refresh', async kind => {
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
  if (kind === 'routing') {
    fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
    fireEvent.change(panel.getByLabelText('Base branch'), { target: { value: 'draft' } });
  } else {
    fireEvent.click(panel.getAllByRole('button', { name: 'Edit description' })[1]);
    fireEvent.change(panel.getByLabelText('Description for TeamLead'), { target: { value: 'draft' } });
  }
  // The dashboard refresh changes the live view while the editor remains open.
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await act(async () => {});
  await act(async () => { fireEvent.submit(panel.getByRole('button', { name: 'Save' }).closest('form')!); });
  if (kind === 'routing') expect(updateBoardSettings).toHaveBeenCalledWith('ws-a', { baseBranch: 'draft' }, initial.board.sha256);
  else expect(updateRole).toHaveBeenCalledWith('ws-a', 'TeamLead', { description: 'draft' }, initial.roles.sha256);
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
  expect(panel.getAllByRole('button', { name: 'Edit description' }).every(button => (button as HTMLButtonElement).disabled)).toBe(true);
});

it('discards routing and role drafts on cancel', async () => {
  const boardWrite = vi.fn(); const roleWrite = vi.fn();
  const { panel } = await setup({ updateBoardSettings: boardWrite, updateRole: roleWrite });
  fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
  fireEvent.change(panel.getByLabelText('Base branch'), { target: { value: 'discarded' } });
  fireEvent.click(panel.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(panel.getByRole('button', { name: 'Edit routing settings' }));
  expect((panel.getByLabelText('Base branch') as HTMLInputElement).value).toBe('main');
  fireEvent.click(panel.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(panel.getAllByRole('button', { name: 'Edit description' })[1]);
  fireEvent.change(panel.getByLabelText('Description for TeamLead'), { target: { value: 'discarded' } });
  fireEvent.click(panel.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(panel.getAllByRole('button', { name: 'Edit description' })[1]);
  expect((panel.getByLabelText('Description for TeamLead') as HTMLTextAreaElement).value).toBe('Leads');
  expect(boardWrite).not.toHaveBeenCalled(); expect(roleWrite).not.toHaveBeenCalled();
});

it('waits for the role reload before closing the form and showing the saved description', async () => {
  const { RoutingSettingsPanel } = await import('../src/renderer/teams/RoutingSettingsPanel');
  let finishReload!: () => void;
  const reload = vi.fn(() => new Promise<void>(resolve => { finishReload = resolve; }));
  const updateRole = vi.fn(async () => ({ ok: true as const, data: {} }));
  const fake = fakeManagement({ calls: { updateRole } });
  const settings = routingSettingsFixture();
  const section = { state: 'ready' as const, data: settings, error: null, loading: false, lastUpdatedAt: null, reload };
  const view = render(<RoutingSettingsPanel workspaceId="ws-a" management={fake.api} connected section={section} />);
  const panel = within(view.getByRole('region', { name: 'Worktree and routing settings' }));
  fireEvent.click(panel.getAllByRole('button', { name: 'Edit description' })[1]);
  fireEvent.change(panel.getByLabelText('Description for TeamLead'), { target: { value: 'new text' } });
  await act(async () => { fireEvent.submit(panel.getByRole('button', { name: 'Save' }).closest('form')!); });
  expect(reload).toHaveBeenCalledTimes(1);
  expect(panel.getByLabelText('Description for TeamLead')).toBeTruthy();
  expect(panel.queryByText('Role description saved.')).toBeNull();
  await act(async () => { finishReload(); });
  expect(panel.queryByLabelText('Description for TeamLead')).toBeNull();
  expect(panel.getByText('Role description saved.')).toBeTruthy();
});
