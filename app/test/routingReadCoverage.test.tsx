// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { BoardSettings } from '../src/renderer/api';
import { RoutingScreen } from '../src/renderer/routing/RoutingScreen';
import { deferred, escalationRoutingFixture, fakeManagement, managementError, routingSettingsFixture } from './teamsFixtures';
import { roleItem, rolesFixture } from './rolesFixtures';
import { workspaceA } from './dashboardFixtures';

afterEach(cleanup);

async function renderRouting(
  settings: BoardSettings,
  opts: { board?: Parameters<typeof fakeManagement>[0]['boardSettings']; roles?: Parameters<typeof fakeManagement>[0]['roles']; calls?: Parameters<typeof fakeManagement>[0]['calls'] } = {},
) {
  const fake = fakeManagement({ boardSettings: opts.board ?? [{ ok: true, data: settings }], roles: opts.roles, calls: opts.calls });
  const view = render(<RoutingScreen workspace={workspaceA} management={fake.api} />);
  await act(async () => {});
  return { view, fake, panel: within(view.getByRole('region', { name: 'Workspace board routing' })) };
}

it('preserves configured rule order and labels blocked statuses from the returned catalog', async () => {
  const s = escalationRoutingFixture();
  s.rules = [s.rules[6], s.rules[5], ...s.rules.slice(0, 5), s.rules[7]];
  s.statuses = s.statuses.filter(x => x.id !== 'blocked-x');
  const first = await renderRouting(s);
  const table = within(first.view.getByRole('table', { name: 'Routing transitions' }));
  expect(table.getAllByRole('columnheader').map(x => x.textContent)).toEqual(['Order', 'Source status', 'Type', 'Role or action', 'Workflow', 'Workspace', 'Pass', 'Fail', 'Blocked', 'Max rounds', 'Priority', 'Failure escalation']);
  const rows = table.getAllByRole('row').slice(1);
  expect(rows.map(x => x.getAttribute('data-rule-index'))).toEqual(s.rules.map(x => String(x.index)));
  expect(rows[0].querySelectorAll('td')[8].textContent).toBe('blocked-x (unknown status)');
  first.view.unmount();
  const known = { ...s, statuses: [...s.statuses, { id: 'blocked-x', name: null, kind: null }] };
  const second = await renderRouting(known);
  expect(within(second.view.getByRole('table')).getAllByRole('row')[1].querySelectorAll('td')[8].textContent).toBe('blocked-x');
});

it('links duplicate role names by stable id and diagnoses missing or unavailable roles', async () => {
  const s = routingSettingsFixture();
  s.rules[0] = { ...s.rules[0], role: 'qa-a' };
  s.rules[3] = { ...s.rules[3], role: 'qa-b' };
  const onViewRole = vi.fn();
  const fake = fakeManagement({
    boardSettings: [{ ok: true, data: s }],
    roles: [{ ok: true, data: rolesFixture({ items: [roleItem('qa-a', { name: 'QA' }), roleItem('qa-b', { name: 'QA' })] }) }],
  });
  const view = render(<RoutingScreen workspace={workspaceA} management={fake.api} onViewRole={onViewRole} />);
  await act(async () => {});
  fireEvent.click(view.getByRole('button', { name: 'View QA in Roles (rule 1)' }));
  fireEvent.click(view.getByRole('button', { name: 'View QA in Roles (rule 4)' }));
  expect(onViewRole.mock.calls).toEqual([['qa-a'], ['qa-b']]);
  expect(view.getAllByText('Role not in catalog').length).toBeGreaterThan(0);
  view.unmount();

  const unavailable = await renderRouting(s, { roles: [managementError('ROLES_DOWN', 'roles unreadable')] });
  expect(unavailable.panel.getByText('Role names are unavailable; rules show stable role ids.')).toBeTruthy();
  expect(unavailable.panel.getAllByText('Role catalog unavailable').length).toBeGreaterThan(0);
  expect(unavailable.panel.queryByRole('button', { name: /in Roles/ })).toBeNull();
  expect(unavailable.panel.queryByText('Develops')).toBeNull(); expect(unavailable.panel.queryByText('Leads')).toBeNull();
  expect(unavailable.panel.queryByRole('textbox')).toBeNull();
});

it('renders empty summaries independently of transition rows', async () => {
  const s = routingSettingsFixture();
  s.actionRules = []; s.protectedRoutes = []; s.workflows = []; s.worktree = { baseBranch: null, worktreeStatuses: [] };
  s.rules = s.rules.map(r => ({ ...r, syncBase: false }));
  const { panel } = await renderRouting(s);
  for (const name of ['Merge and worktree settings', 'Failure escalation', 'Protected conflict routing', 'Action rules', 'Workflow availability']) fireEvent.click(panel.getByRole('button', { name }));
  for (const text of ['Base branch: unavailable', 'Isolated worktree statuses: none', 'Sync with base before work: none', 'No failure escalation is configured.', 'This board has no protected conflict statuses.', 'No action rules are configured.', 'No workflows were returned.']) expect(panel.getByText(text)).toBeTruthy();
  expect(panel.getAllByText('Action: merge')).toHaveLength(2);
});

it('shows loading, missing, invalid, and retained error states without invented rules', async () => {
  const gate = deferred<{ ok: true; data: BoardSettings }>();
  const loading = await renderRouting(routingSettingsFixture(), { board: [gate.promise] });
  expect(loading.panel.getByText('Loading settings…')).toBeTruthy(); expect(loading.panel.queryByRole('table')).toBeNull();
  loading.view.unmount();

  const missingSettings = routingSettingsFixture(); missingSettings.rules = []; missingSettings.board = { ...missingSettings.board, state: 'missing' };
  const missing = await renderRouting(missingSettings);
  expect(missing.panel.getByText('No workspace board is configured, so no routing is shown.')).toBeTruthy(); expect(missing.panel.queryByRole('table')).toBeNull();
  missing.view.unmount();

  const invalidSettings = routingSettingsFixture();
  invalidSettings.rules = [];
  invalidSettings.board = { ...invalidSettings.board, state: 'invalid', problems: [{ path: 'rules[0]', message: 'broken rule' }] };
  invalidSettings.roles = { ...invalidSettings.roles, state: 'invalid', message: 'Roles invalid' };
  const invalid = await renderRouting(invalidSettings);
  expect(invalid.panel.getByText('The workspace board configuration is invalid. Routing cannot be shown until it is repaired.')).toBeTruthy();
  expect(invalid.panel.getByText('rules[0]: broken rule')).toBeTruthy(); expect(invalid.panel.getByText('Roles invalid')).toBeTruthy(); expect(invalid.panel.queryByRole('table')).toBeNull();
  invalid.view.unmount();

  const fake = fakeManagement({ boardSettings: [{ ok: true, data: routingSettingsFixture() }, managementError('OFFLINE', 'offline')] });
  const retained = render(<RoutingScreen workspace={workspaceA} management={fake.api} connection={{ state: 'lost', error: null, distro: null, command: null }} />);
  await act(async () => {});
  await act(async () => { fireEvent.click(retained.getByRole('button', { name: 'Refresh' })); });
  expect(retained.getByRole('alert').textContent).toContain('OFFLINE: offline');
  expect(retained.getByText('Showing the last loaded routing; it may be out of date.')).toBeTruthy();
  expect(retained.getByText('Disconnected from the backend. Routing is read-only until the connection returns.')).toBeTruthy();
  expect(retained.getByRole('table')).toBeTruthy();
});

it('uses returned protected routes instead of rule flags and names the required role', async () => {
  const s = routingSettingsFixture();
  s.rules[0] = { ...s.rules[0], protected: true };
  s.protectedRoutes = [{ status: 'dev-ready', role: 'Maintainer', satisfied: false }];
  s.rules[3] = { ...s.rules[3], status: 'dev-ready', protected: false };
  const { view } = await renderRouting(s);
  const rows = within(view.getByRole('table')).getAllByRole('row').slice(1);
  expect(rows[0].textContent).not.toContain('Protected');
  expect(rows[3].textContent).toContain('Needs repair');
  fireEvent.click(view.getByRole('button', { name: 'Protected conflict routing' }));
  const list = within(view.getByRole('list', { name: 'Protected conflict routes' }));
  expect(list.getByText('Change the rule for dev-ready to use role Maintainer.')).toBeTruthy();
  expect(list.getByRole('listitem').textContent).toContain('dev-ready must be handled by role Maintainer — Needs repair');
});

it('shows all escalation handlers in returned order, including action handlers', async () => {
  const s = escalationRoutingFixture();
  s.rules[5] = { ...s.rules[5], onFailureLimit: { count: 1, status: 'need-escalate' } };
  s.rules.splice(7, 0, { ...s.rules[1], index: 20, status: 'need-escalate', action: 'notify' });
  const { view } = await renderRouting(s);
  fireEvent.click(view.getByRole('button', { name: 'Failure escalation' }));
  const chain = within(view.getByRole('list', { name: 'Failure escalation chains' })).getAllByRole('listitem')[0];
  expect(chain.textContent).toContain('after 1 failed run → Escalate (need-escalate). The count resets when a run passes.');
  expect(Array.from(chain.querySelectorAll('p'), p => p.textContent)).toEqual([
    'Escalate (need-escalate) runs action notify.',
    'Escalate (need-escalate) is handled by role SeniorDeveloper using workflow board-senior.',
  ]);
});

it('shows the empty-board message for a valid board without rules', async () => {
  const s = routingSettingsFixture(); s.rules = [];
  const { view } = await renderRouting(s);
  expect(view.getByText('This workspace board has no routing rules.')).toBeTruthy();
  expect(view.queryByRole('table')).toBeNull();
});

it('renders renamed escalation handlers and workflows from the returned configuration', async () => {
  const s = escalationRoutingFixture();
  s.statuses = s.statuses.map(x => x.id === 'need-escalate' ? { ...x, id: 'triage', name: 'Triage' } : x);
  s.rules = s.rules.map(r => ({ ...r, status: r.status === 'need-escalate' ? 'triage' : r.status, onFail: r.onFail === 'need-escalate' ? 'triage' : r.onFail, role: r.role === 'SeniorDeveloper' ? 'Expert' : r.role, workflow: r.workflow === 'board-develop' ? 'flow-a' : r.workflow, onFailureLimit: r.onFailureLimit && { ...r.onFailureLimit, status: 'triage' } }));
  s.workflows = s.workflows.map(w => ({ ...w, name: w.name === 'board-develop' ? 'flow-a' : w.name, roles: w.roles.map(r => r === 'SeniorDeveloper' ? 'Expert' : r) }));
  const { view } = await renderRouting(s);
  fireEvent.click(view.getByRole('button', { name: 'Failure escalation' }));
  const chains = within(view.getByRole('list', { name: 'Failure escalation chains' }));
  expect(chains.getAllByText('Triage (triage) is handled by role Expert using workflow board-senior.')).toHaveLength(2);
  expect(view.getAllByText('3 fails → Triage (triage)')).toHaveLength(2);
  expect(view.container.textContent).not.toMatch(/need-escalate|SeniorDeveloper|board-develop/);
});

it('shows unavailable workflow diagnostics and keeps role metadata out of routing', async () => {
  const s = routingSettingsFixture();
  s.workflows = s.workflows.map(w => w.name === 'board-develop' ? { ...w, errors: ['Broken workflow'] } : w);
  const updateRole = vi.fn(); const updateRoleInstructions = vi.fn();
  const { view } = await renderRouting(s, { roles: [{ ok: true, data: rolesFixture() }], calls: { updateRole, updateRoleInstructions } });
  expect(view.getByText('board-develop — unavailable')).toBeTruthy();
  fireEvent.click(view.getByRole('button', { name: 'Workflow availability' }));
  expect(view.getByText('Broken workflow')).toBeTruthy();
  expect(view.container.textContent).not.toMatch(/Develops|Leads/);
  expect(view.queryByRole('textbox')).toBeNull();
  expect(updateRole).not.toHaveBeenCalled(); expect(updateRoleInstructions).not.toHaveBeenCalled();
});
