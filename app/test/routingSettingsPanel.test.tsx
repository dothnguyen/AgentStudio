// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RoutingScreen } from '../src/renderer/routing/RoutingScreen';
import { RoutingSettingsPanel } from '../src/renderer/teams/RoutingSettingsPanel';
import type { BoardSettings } from '../src/renderer/api';
import { workspaceA } from './dashboardFixtures';
import { fakeManagement, invalidBoardSettings, managementError, missingBoardSettings, routingSettingsFixture } from './teamsFixtures';
import { rolesFixture } from './rolesFixtures';

afterEach(cleanup);

async function setup(calls: Parameters<typeof fakeManagement>[0]['calls'] = {}, boards: BoardSettings[] = [routingSettingsFixture()]) {
  const fake = fakeManagement({ calls, boardSettings: boards.map(data => ({ ok: true as const, data })) });
  const view = render(<RoutingScreen workspace={workspaceA} management={fake.api} />);
  await act(async () => {});
  const panel = within(view.getByRole('region', { name: 'Workspace board routing' }));
  return { fake, view, panel };
}

type Section = Parameters<typeof RoutingSettingsPanel>[0]['section'];
const sectionOf = (over: Partial<Section>): Section => ({ state: 'ready', data: null, error: null, loading: false, lastUpdatedAt: null, reload: vi.fn(async () => {}), ...over });

it('renders a per-row Edit, Add rule and Edit worktrees instead of the old all-rules form', async () => {
  const { panel } = await setup();
  expect(panel.queryByRole('button', { name: 'Edit routing settings' })).toBeNull();
  expect(panel.queryByRole('form')).toBeNull();
  const rules = panel.getByRole('list', { name: 'Routing transitions' });
  const rows = within(rules).getAllByRole('listitem');
  expect(rows).toHaveLength(5);
  expect(within(rows[0]!).getByRole('button', { name: 'Edit rule 1, backlog' })).toBeTruthy();
  expect(within(rows[1]!).getByRole('button', { name: 'Edit rule 2, merge-ready' })).toBeTruthy();
  expect(panel.getByRole('button', { name: 'Add rule' })).toBeTruthy();
  expect(panel.getByRole('button', { name: 'Edit worktrees' })).toBeTruthy();
});

it('disables every editing entry point when disconnected and shows the reason', async () => {
  const fake = fakeManagement();
  const view = render(<RoutingSettingsPanel workspaceId="ws-a" management={fake.api} connected={false} section={sectionOf({ data: routingSettingsFixture() })} />);
  const panel = within(view.getByRole('region', { name: 'Workspace board routing' }));
  for (const button of panel.getAllByRole('button', { name: /^(Edit rule|Add rule|Edit worktrees)/ })) expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(panel.getByText('Editing is unavailable while disconnected from the backend.')).toBeTruthy();
  expect(panel.getByText('Disconnected from the backend. Routing is read-only until the connection returns.')).toBeTruthy();
});

it('disables every editing entry point while the settings are stale', async () => {
  const section = sectionOf({ data: routingSettingsFixture(), state: 'error', error: { code: 'READ_FAILED', message: 'boom', retryable: true } });
  const view = render(<RoutingSettingsPanel workspaceId="ws-a" management={fakeManagement().api} connected section={section} />);
  const panel = within(view.getByRole('region', { name: 'Workspace board routing' }));
  for (const button of panel.getAllByRole('button', { name: /^(Edit rule|Add rule|Edit worktrees)/ })) expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(panel.getByText('Routing settings are not up to date. Refresh them before editing.')).toBeTruthy();
});

it('disables every editing entry point while a save is pending and says why', async () => {
  const base = routingSettingsFixture();
  let finish!: (value: { ok: true; data: {} }) => void;
  const update = vi.fn(() => new Promise<{ ok: true; data: {} }>(resolve => { finish = resolve; }));
  const { panel } = await setup({ updateBoardSettings: update }, [base, base]);
  fireEvent.click(panel.getByRole('button', { name: 'Edit worktrees' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('Base branch'), { target: { value: 'release-2' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  for (const button of panel.getAllByRole('button', { name: /^(Edit rule|Add rule|Edit worktrees)/ })) {
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute('aria-describedby')).toBe('routing-edit-reason');
  }
  expect(panel.getByText('A save is in progress.')).toBeTruthy();
  await act(async () => { finish({ ok: true, data: {} }); });
});

it.each(['board', 'roles'] as const)('disables every editing entry point when the %s state is not ok', async invalidFile => {
  const settings = routingSettingsFixture();
  if (invalidFile === 'board') settings.board = { ...settings.board, state: 'invalid', message: 'Board invalid' };
  else settings.roles = { ...settings.roles, state: 'invalid', message: 'Roles invalid' };
  const view = render(<RoutingSettingsPanel workspaceId="ws-a" management={fakeManagement().api} connected section={sectionOf({ data: settings })} />);
  const panel = within(view.getByRole('region', { name: 'Workspace board routing' }));
  for (const button of panel.getAllByRole('button', { name: /^(Edit rule|Add rule|Edit worktrees)/ })) expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(panel.getByText(invalidFile === 'board' ? 'The workspace board configuration is not available.' : 'The workspace roles are not available.')).toBeTruthy();
});

it.each(['board', 'roles'] as const)('disables editing when the %s concurrency token is missing', async missing => {
  const settings = routingSettingsFixture();
  settings[missing].sha256 = null;
  const view = render(<RoutingSettingsPanel workspaceId="ws-a" management={fakeManagement().api} connected section={sectionOf({ data: settings })} />);
  const panel = within(view.getByRole('region', { name: 'Workspace board routing' }));
  for (const button of panel.getAllByRole('button', { name: /^(Edit rule|Add rule|Edit worktrees)/ })) expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(panel.getByText('The settings concurrency token is missing; refresh and retry.')).toBeTruthy();
});

it('makes a missing configuration inspect-only', async () => {
  const view = render(<RoutingSettingsPanel workspaceId="ws-a" management={fakeManagement().api} connected section={sectionOf({ data: missingBoardSettings() })} />);
  const panel = within(view.getByRole('region', { name: 'Workspace board routing' }));
  expect(panel.getByText('No workspace board is configured, so no routing is shown.')).toBeTruthy();
  expect((panel.getByRole('button', { name: 'Add rule' }) as HTMLButtonElement).disabled).toBe(true);
  expect((panel.getByRole('button', { name: 'Edit worktrees' }) as HTMLButtonElement).disabled).toBe(true);
});

it('keeps loading, section error, invalid and stale states readable', async () => {
  const fake = fakeManagement();
  const mount = (section: Section, connected = true) => render(<RoutingSettingsPanel workspaceId="ws-a" management={fake.api} connected={connected} section={section} />);
  const loading = mount(sectionOf({ state: 'loading', loading: true }));
  expect(loading.getByRole('status').textContent).toBe('Loading settings…');
  expect(loading.queryByRole('list', { name: 'Routing transitions' })).toBeNull();
  loading.unmount();

  const reloadFresh = vi.fn(async () => ({ ok: false as const, error: { code: 'READ_FAILED', message: 'boom', retryable: true } }));
  const failed = mount(sectionOf({ state: 'error', error: { code: 'READ_FAILED', message: 'boom', retryable: true, remediation: 'Restart the coordinator.' }, reloadFresh }));
  expect(failed.getByRole('alert').textContent).toContain('READ_FAILED: boom');
  expect(failed.getByRole('alert').textContent).toContain('Restart the coordinator.');
  await act(async () => { fireEvent.click(failed.getByRole('button', { name: 'Retry' })); });
  expect(reloadFresh).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(failed.getByRole('button', { name: 'Retry' }));
  failed.unmount();

  const invalid = mount(sectionOf({ data: invalidBoardSettings() }));
  expect(invalid.getByText(/configuration is invalid/)).toBeTruthy();
  expect(invalid.getByText('rules[0]: bad rule')).toBeTruthy();
  invalid.unmount();

  const stale = mount(sectionOf({ data: routingSettingsFixture(), error: { code: 'READ_FAILED', message: 'boom', retryable: true } }));
  expect(stale.getByText('Showing the last loaded routing; it may be out of date.')).toBeTruthy();
  expect(stale.getByRole('list', { name: 'Routing transitions' })).toBeTruthy();
});

it('waits for an in-flight settings refresh before announcing a saved base branch', async () => {
  const initial = routingSettingsFixture();
  const refreshed = routingSettingsFixture({ worktree: { baseBranch: 'new-base', worktreeStatuses: [] } });
  let finishRefresh!: (value: { ok: true; data: typeof initial }) => void;
  let finishWrite!: (value: { ok: true; data: {} }) => void;
  let finishLatest!: (value: { ok: true; data: typeof initial }) => void;
  const boardSettings = vi.fn().mockResolvedValueOnce({ ok: true, data: initial }).mockImplementationOnce(() => new Promise(resolve => { finishRefresh = resolve; })).mockImplementationOnce(() => new Promise(resolve => { finishLatest = resolve; }));
  const updateBoardSettings = vi.fn(() => new Promise<{ ok: true; data: {} }>(resolve => { finishWrite = resolve; }));
  const fake = fakeManagement({ calls: { boardSettings, updateBoardSettings } });
  const view = render(<RoutingScreen workspace={workspaceA} management={fake.api} />);
  await act(async () => {});
  const panel = within(view.getByRole('region', { name: 'Workspace board routing' }));
  fireEvent.click(panel.getByRole('button', { name: 'Edit worktrees' }));
  fireEvent.change(screen.getByLabelText('Base branch'), { target: { value: 'new-base' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  fireEvent.click(view.getByRole('button', { name: 'Refresh' }));
  await act(async () => { finishWrite({ ok: true, data: {} }); });
  expect(screen.queryByText('Saved base branch.')).toBeNull();
  expect(boardSettings).toHaveBeenCalledTimes(3);
  await act(async () => { finishRefresh({ ok: true, data: initial }); });
  expect(screen.queryByText('Saved base branch.')).toBeNull();
  await act(async () => { finishLatest({ ok: true, data: refreshed }); });
  expect(screen.getByText('Saved base branch.')).toBeTruthy();
  expect(within(panel.getByRole('region', { name: 'Worktrees' })).getByText('new-base')).toBeTruthy();
});

it('keeps dialog choices on the captured snapshot after a background refresh', async () => {
  const initial = routingSettingsFixture();
  const latest = structuredClone(initial);
  latest.statuses = latest.statuses.map(status => status.id === 'dev-ready' ? { ...status, name: 'New label' } : status);
  latest.workflows = latest.workflows.filter(workflow => workflow.name !== 'board-develop');
  latest.board.sha256 = 'c'.repeat(64);
  const update = vi.fn(async () => ({ ok: true as const, data: {} }));
  const fake = fakeManagement({ calls: { updateBoardSettings: update } });
  const section = sectionOf({ data: initial });
  const view = render(<RoutingSettingsPanel workspaceId="ws-a" management={fake.api} connected section={section} />);
  const panel = within(view.getByRole('region', { name: 'Workspace board routing' }));
  fireEvent.click(panel.getByRole('button', { name: 'Edit rule 1, backlog' }));
  view.rerender(<RoutingSettingsPanel workspaceId="ws-a" management={fake.api} connected section={{ ...section, data: latest }} />);
  const dialog = screen.getByRole('dialog');
  expect(within(within(dialog).getByLabelText('If it passes')).queryByRole('option', { name: 'New label (dev-ready)' })).toBeNull();
  expect((within(within(dialog).getByLabelText('Workflow')).getByRole('option', { name: 'board-develop' }) as HTMLOptionElement).disabled).toBe(false);
  fireEvent.change(within(dialog).getByLabelText('If it fails'), { target: { value: 'backlog' } });
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Save rule' })); });
  expect(update).toHaveBeenCalledWith('ws-a', expect.objectContaining({ rules: expect.any(Array) }), initial.board.sha256);
});

it('keeps a dialog open and read-only when a board refresh fails until retry succeeds', async () => {
  const settings = routingSettingsFixture();
  const update = vi.fn(async () => ({ ok: true as const, data: {} }));
  const fake = fakeManagement({
    boardSettings: [{ ok: true, data: settings }, managementError('BOARD_DOWN', 'board unreadable'), { ok: true, data: settings }],
    calls: { updateBoardSettings: update },
  });
  const view = render(<RoutingScreen workspace={workspaceA} management={fake.api} />);
  await act(async () => {});
  const panel = within(view.getByRole('region', { name: 'Workspace board routing' }));
  fireEvent.click(panel.getByRole('button', { name: 'Edit worktrees' }));
  fireEvent.change(screen.getByLabelText('Base branch'), { target: { value: 'draft-branch' } });
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Refresh' })); });
  expect(panel.getByText('Showing the last loaded routing; it may be out of date.')).toBeTruthy();
  expect((screen.getByLabelText('Base branch') as HTMLInputElement).value).toBe('draft-branch');
  const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  fireEvent.click(save);
  expect(update).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(panel.getByRole('button', { name: 'Retry' })); });
  expect(fake.boardSettings).toHaveBeenCalledTimes(3);
  expect((screen.getByLabelText('Base branch') as HTMLInputElement).value).toBe('draft-branch');
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false);
});

it('failed board refresh identifies previously loaded routing in its warning', async () => {
  const fake = fakeManagement({ boardSettings: [{ ok: true, data: routingSettingsFixture() }, managementError('BOARD_DOWN', 'board unreadable')] });
  const view = render(<RoutingScreen workspace={workspaceA} management={fake.api} />);
  await act(async () => {});
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Refresh' })); });
  const alert = within(view.getByRole('region', { name: 'Workspace board routing' })).getByRole('alert');
  expect(alert.textContent).toContain('Showing previously loaded data.');
  expect(alert.textContent).toContain('BOARD_DOWN: board unreadable');
});

it('routing validation alert does not duplicate the section error alert', async () => {
  const fake = fakeManagement({ boardSettings: [{ ok: true as const, data: routingSettingsFixture() }], roles: [{ ok: true as const, data: rolesFixture() }, managementError('ROLES_DOWN', 'roles unreadable')] });
  const view = render(<RoutingScreen workspace={workspaceA} management={fake.api} />);
  await act(async () => {});
  const panel = within(view.getByRole('region', { name: 'Workspace board routing' }));
  fireEvent.click(panel.getByRole('button', { name: 'Edit rule 1, backlog' }));
  fireEvent.click(view.getByRole('button', { name: 'Refresh' }));
  await act(async () => {});
  fireEvent.change(screen.getByLabelText('If it passes'), { target: { value: 'dev-ready' } });
  expect(view.getAllByRole('alert')).toHaveLength(1);
  expect(document.body.textContent).toContain('ROLES_DOWN: roles unreadable');
  expect(document.body.textContent).toContain('No routing path reaches a done status.');
});

it('shows no old disclosures or all-rules editor', async () => {
  const { panel } = await setup();
  for (const title of ['Merge and worktree settings', 'Failure escalation', 'Protected conflict routing', 'Action rules', 'Workflow availability', 'Edit routing settings']) {
    expect(panel.queryByRole('button', { name: title })).toBeNull();
  }
  expect(screen.queryByLabelText('Base branch')).toBeNull();
  expect(screen.queryByText(/Transitions/)).toBeNull();
});

it('shows a server rejection when removing a workflow status used by tickets', async () => {
  const s = routingSettingsFixture();
  const statuses = s.statuses.map(({ id, kind }) => kind ? { id, kind } : { id });
  const rules = structuredClone(s.board.config!.rules as Array<Record<string, unknown>>);
  rules.forEach((rule, i) => { if (!('action' in rule)) { const id = `active-${i}`; statuses.push({ id }); rule.during = id; } });
  statuses.push({ id: 'unused' });
  s.board.config = { ...s.board.config!, version: 3, workflowStatuses: statuses, rules };
  s.workflowStatuses = statuses.map(status => ({ ...status, name: null, kind: status.kind ?? null }));
  s.todoEntry = ['backlog']; s.todoDefault = 'backlog';
  const update = vi.fn(async () => ({ ok: false as const, error: { code: 'BOARD_CONFIG_INVALID', message: 'in use', retryable: false, data: { problems: [{ path: 'workflowStatuses', message: 'Status unused is used by tickets' }] } } }));
  const { panel } = await setup({ updateBoardSettings: update }, [s]);
  fireEvent.click(panel.getByRole('button', { name: 'Edit workflow statuses and Todo entry' }));
  const dialog = screen.getByRole('dialog');
  const idFields = within(dialog).getAllByLabelText('ID') as HTMLInputElement[];
  const row = idFields.find(input => input.value === 'unused')!.parentElement!.parentElement!;
  fireEvent.click(within(row).getByRole('button', { name: 'Remove' }));
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Save workflow settings' })); });
  expect(within(dialog).getByText('workflowStatuses: Status unused is used by tickets')).toBeTruthy();
  expect(update).toHaveBeenCalledOnce();
});

it('edits workflow statuses and Todo entry and submits all settings together', async () => {
  const s = routingSettingsFixture();
  const statuses = s.statuses.map(({ id, kind, name }) => ({ id, name, ...(kind ? { kind } : {}) }));
  const rules = structuredClone(s.board.config!.rules as Array<Record<string, unknown>>);
  rules.forEach((rule, i) => {
    if (!('action' in rule)) {
      const id = `active-${i}`;
      statuses.push({ id, name: id });
      rule.during = id;
    }
  });
  const statusBeforeUnused = statuses.at(-1)!.id;
  statuses.push({ id: 'unused', name: 'Unused' });
  s.board.config = { ...s.board.config!, version: 3, workflowStatuses: statuses, rules };
  s.workflowStatuses = statuses.map(status => ({ ...status, name: status.name ?? null, kind: status.kind ?? null }));
  s.todoEntry = ['backlog']; s.todoDefault = 'backlog';
  const update = vi.fn(async () => ({ ok: true as const, data: {} }));
  const { panel } = await setup({ updateBoardSettings: update }, [s, s]);
  fireEvent.click(panel.getByRole('button', { name: 'Edit workflow statuses and Todo entry' }));
  const dialog = screen.getByRole('dialog');
  const idFields = within(dialog).getAllByLabelText('ID') as HTMLInputElement[];
  const unusedRow = idFields.find(input => input.value === 'unused')!.parentElement!.parentElement!;
  fireEvent.change(within(unusedRow).getByLabelText('Name'), { target: { value: 'Review' } });
  fireEvent.change(within(unusedRow).getByLabelText('ID'), { target: { value: 'review' } });
  fireEvent.click(within(unusedRow).getByRole('button', { name: 'Move up' }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add status' }));
  const newId = (within(dialog).getAllByLabelText('ID') as HTMLInputElement[]).at(-1)!;
  const newRow = newId.parentElement!.parentElement!;
  fireEvent.change(newId, { target: { value: 'qa' } });
  fireEvent.change(within(newRow).getByLabelText('Name'), { target: { value: 'QA' } });
  fireEvent.click(within(dialog).getByRole('checkbox', { name: 'merge-conflict' }));
  fireEvent.change(within(dialog).getByLabelText('Default'), { target: { value: 'merge-conflict' } });
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Save workflow settings' })); });
  expect(update).toHaveBeenCalledOnce();
  const payload = update.mock.calls[0]![1] as Record<string, unknown>;
  expect(payload.workflowStatuses).toEqual(expect.arrayContaining([
    { id: 'review', name: 'Review' }, { id: 'qa', name: 'QA' },
  ]));
  expect((payload.workflowStatuses as Array<{ id: string }>).findIndex(status => status.id === 'review'))
    .toBeLessThan((payload.workflowStatuses as Array<{ id: string }>).findIndex(status => status.id === statusBeforeUnused));
  expect(payload.todoEntry).toEqual(['backlog', 'merge-conflict']);
  expect(payload.todoDefault).toBe('merge-conflict');
});
