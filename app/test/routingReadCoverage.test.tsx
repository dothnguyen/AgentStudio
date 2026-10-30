// @vitest-environment jsdom
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RoutingSettingsPanel } from '../src/renderer/teams/RoutingSettingsPanel';
import { escalationRoutingFixture, fakeManagement, routingSettingsFixture } from './teamsFixtures';
import { roleItem } from './rolesFixtures';

afterEach(cleanup);
const section = (data: ReturnType<typeof routingSettingsFixture> | null) => ({ state: 'ready' as const, data, error: null, loading: false, lastUpdatedAt: null, reload: vi.fn(async () => {}) });

it('preserves configured rule order and labels blocked statuses from the returned catalog', () => {
  const s = escalationRoutingFixture();
  s.rules = [s.rules[6], s.rules[5], ...s.rules.slice(0, 5), s.rules[7]];
  s.statuses = s.statuses.filter(x => x.id !== 'blocked-x');
  const view = render(<RoutingSettingsPanel workspaceId="ws-a" management={fakeManagement().api} connected section={section(s)} />);
  const table = within(view.getByRole('table', { name: 'Routing transitions' }));
  expect(table.getAllByRole('columnheader').map(x => x.textContent)).toEqual(['Order', 'Source status', 'Type', 'Role or action', 'Workflow', 'Workspace', 'Pass', 'Fail', 'Blocked', 'Max rounds', 'Priority', 'Failure escalation']);
  const rows = table.getAllByRole('row').slice(1);
  expect(rows.map(x => x.getAttribute('data-rule-index'))).toEqual(s.rules.map(x => String(x.index)));
  expect(rows[0].querySelectorAll('td')[8].textContent).toBe('blocked-x (unknown status)');
  s.statuses = [...s.statuses, { id: 'blocked-x', name: null, kind: null }];
  view.rerender(<RoutingSettingsPanel workspaceId="ws-a" management={fakeManagement().api} connected section={section(s)} />);
  expect(within(view.getByRole('table')).getAllByRole('row')[1].querySelectorAll('td')[8].textContent).toBe('blocked-x');
});

it('links duplicate role names by stable id and diagnoses missing or unavailable roles', () => {
  const s = routingSettingsFixture();
  s.rules[0] = { ...s.rules[0], role: 'qa-a' };
  s.rules[3] = { ...s.rules[3], role: 'qa-b' };
  const onViewRole = vi.fn();
  const props = { workspaceId: 'ws-a', management: fakeManagement().api, connected: true, section: section(s), onViewRole };
  const view = render(<RoutingSettingsPanel {...props} roleItems={[roleItem('qa-a', { name: 'QA' }), roleItem('qa-b', { name: 'QA' })]} />);
  fireEvent.click(view.getByRole('button', { name: 'View QA in Roles (rule 1)' }));
  fireEvent.click(view.getByRole('button', { name: 'View QA in Roles (rule 4)' }));
  expect(onViewRole.mock.calls).toEqual([['qa-a'], ['qa-b']]);
  expect(view.getAllByText('Role not in catalog').length).toBeGreaterThan(0);
  view.rerender(<RoutingSettingsPanel {...props} />);
  expect(view.getByText('Role names are unavailable; rules show stable role ids.')).toBeTruthy();
  expect(view.getAllByText('Role catalog unavailable').length).toBeGreaterThan(0);
  expect(view.queryByRole('button', { name: /in Roles/ })).toBeNull();
  expect(view.queryByText('Develops')).toBeNull(); expect(view.queryByText('Leads')).toBeNull();
  expect(view.queryByRole('textbox')).toBeNull();
});

it('renders empty summaries independently of transition rows', () => {
  const s = routingSettingsFixture();
  s.actionRules = []; s.protectedRoutes = []; s.workflows = []; s.worktree = { baseBranch: null, worktreeStatuses: [] };
  s.rules = s.rules.map(r => ({ ...r, syncBase: false }));
  const view = render(<RoutingSettingsPanel workspaceId="ws-a" management={fakeManagement().api} connected section={section(s)} />);
  for (const name of ['Merge and worktree settings', 'Failure escalation', 'Protected conflict routing', 'Action rules', 'Workflow availability']) fireEvent.click(view.getByRole('button', { name }));
  for (const text of ['Base branch: unavailable', 'Isolated worktree statuses: none', 'Sync with base before work: none', 'No failure escalation is configured.', 'This board has no protected conflict statuses.', 'No action rules are configured.', 'No workflows were returned.']) expect(view.getByText(text)).toBeTruthy();
  expect(view.getAllByText('Action: merge')).toHaveLength(2);
});

it('shows loading, missing, invalid, and retained error states without invented rules', () => {
  const fake = fakeManagement();
  const loading = { ...section(null), state: 'loading' as const, loading: true };
  const view = render(<RoutingSettingsPanel workspaceId="ws-a" management={fake.api} connected section={loading} />);
  expect(view.getByText('Loading settings…')).toBeTruthy(); expect(view.queryByRole('table')).toBeNull();
  const s = routingSettingsFixture(); s.rules = []; s.board = { ...s.board, state: 'missing' };
  view.rerender(<RoutingSettingsPanel workspaceId="ws-a" management={fake.api} connected section={section(s)} />);
  expect(view.getByText('No workspace board is configured, so no routing is shown.')).toBeTruthy(); expect(view.queryByRole('table')).toBeNull();
  const invalid = { ...s, board: { ...s.board, state: 'invalid' as const, problems: [{ path: 'rules[0]', message: 'broken rule' }] }, roles: { ...s.roles, state: 'invalid' as const, message: 'Roles invalid' } };
  view.rerender(<RoutingSettingsPanel workspaceId="ws-a" management={fake.api} connected section={section(invalid)} />);
  expect(view.getByText('The workspace board configuration is invalid. Routing cannot be shown until it is repaired.')).toBeTruthy();
  expect(view.getByText('rules[0]: broken rule')).toBeTruthy(); expect(view.getByText('Roles invalid')).toBeTruthy(); expect(view.queryByRole('table')).toBeNull();
  view.rerender(<RoutingSettingsPanel workspaceId="ws-a" management={fake.api} connected section={section(routingSettingsFixture())} />);
  view.rerender(<RoutingSettingsPanel workspaceId="ws-a" management={fake.api} connected={false} section={{ ...section(null), error: { code: 'OFFLINE', message: 'offline', retryable: true } }} />);
  expect(view.getByRole('alert').textContent).toContain('OFFLINE: offline');
  expect(view.getByText('Showing the last loaded routing; it may be out of date.')).toBeTruthy();
  expect(view.getByText('Disconnected from the backend. Routing is read-only until the connection returns.')).toBeTruthy();
  expect(view.getByRole('table')).toBeTruthy();
});

it('uses returned protected routes instead of rule flags and names the required role', () => {
  const s = routingSettingsFixture();
  s.rules[0] = { ...s.rules[0], protected: true };
  s.protectedRoutes = [{ status: 'dev-ready', role: 'Maintainer', satisfied: false }];
  s.rules[3] = { ...s.rules[3], status: 'dev-ready', protected: false };
  const view = render(<RoutingSettingsPanel workspaceId="ws-a" management={fakeManagement().api} connected section={section(s)} />);
  const rows = within(view.getByRole('table')).getAllByRole('row').slice(1);
  expect(rows[0].textContent).not.toContain('Protected');
  expect(rows[3].textContent).toContain('Needs repair');
  fireEvent.click(view.getByRole('button', { name: 'Protected conflict routing' }));
  const list = within(view.getByRole('list', { name: 'Protected conflict routes' }));
  expect(list.getByText('Change the rule for dev-ready to use role Maintainer.')).toBeTruthy();
  expect(list.getByRole('listitem').textContent).toContain('dev-ready must be handled by role Maintainer — Needs repair');
});

it('shows all escalation handlers in returned order, including action handlers', () => {
  const s = escalationRoutingFixture();
  s.rules[5] = { ...s.rules[5], onFailureLimit: { count: 1, status: 'need-escalate' } };
  s.rules.splice(7, 0, { ...s.rules[1], index: 20, status: 'need-escalate', action: 'notify' });
  const view = render(<RoutingSettingsPanel workspaceId="ws-a" management={fakeManagement().api} connected section={section(s)} />);
  fireEvent.click(view.getByRole('button', { name: 'Failure escalation' }));
  const chain = within(view.getByRole('list', { name: 'Failure escalation chains' })).getAllByRole('listitem')[0];
  expect(chain.textContent).toContain('after 1 failed run → Escalate (need-escalate). The count resets when a run passes.');
  expect(Array.from(chain.querySelectorAll('p'), p => p.textContent)).toEqual([
    'Escalate (need-escalate) runs action notify.',
    'Escalate (need-escalate) is handled by role SeniorDeveloper using workflow board-senior.',
  ]);
});

it('shows the empty-board message for a valid board without rules', () => {
  const s = routingSettingsFixture(); s.rules = [];
  const view = render(<RoutingSettingsPanel workspaceId="ws-a" management={fakeManagement().api} connected section={section(s)} />);
  expect(view.getByText('This workspace board has no routing rules.')).toBeTruthy();
  expect(view.queryByRole('table')).toBeNull();
});

it('renders renamed escalation handlers and workflows from the returned configuration', () => {
  const s = escalationRoutingFixture();
  s.statuses = s.statuses.map(x => x.id === 'need-escalate' ? { ...x, id: 'triage', name: 'Triage' } : x);
  s.rules = s.rules.map(r => ({ ...r, status: r.status === 'need-escalate' ? 'triage' : r.status, onFail: r.onFail === 'need-escalate' ? 'triage' : r.onFail, role: r.role === 'SeniorDeveloper' ? 'Expert' : r.role, workflow: r.workflow === 'board-develop' ? 'flow-a' : r.workflow, onFailureLimit: r.onFailureLimit && { ...r.onFailureLimit, status: 'triage' } }));
  s.workflows = s.workflows.map(w => ({ ...w, name: w.name === 'board-develop' ? 'flow-a' : w.name, roles: w.roles.map(r => r === 'SeniorDeveloper' ? 'Expert' : r) }));
  const view = render(<RoutingSettingsPanel workspaceId="ws-a" management={fakeManagement().api} connected section={section(s)} />);
  fireEvent.click(view.getByRole('button', { name: 'Failure escalation' }));
  const chains = within(view.getByRole('list', { name: 'Failure escalation chains' }));
  expect(chains.getAllByText('Triage (triage) is handled by role Expert using workflow board-senior.')).toHaveLength(2);
  expect(view.getAllByText('3 fails → Triage (triage)')).toHaveLength(2);
  expect(view.container.textContent).not.toMatch(/need-escalate|SeniorDeveloper|board-develop/);
});

it('shows unavailable workflow diagnostics and keeps role metadata out of routing', () => {
  const s = routingSettingsFixture();
  s.workflows = s.workflows.map(w => w.name === 'board-develop' ? { ...w, errors: ['Broken workflow'] } : w);
  const updateRole = vi.fn(); const updateRoleInstructions = vi.fn();
  const fake = fakeManagement({ calls: { updateRole, updateRoleInstructions } });
  const view = render(<RoutingSettingsPanel workspaceId="ws-a" management={fake.api} connected section={section(s)} />);
  expect(view.getByText('board-develop — unavailable')).toBeTruthy();
  fireEvent.click(view.getByRole('button', { name: 'Workflow availability' }));
  expect(view.getByText('Broken workflow')).toBeTruthy();
  expect(view.container.textContent).not.toMatch(/Develops|Leads/);
  expect(view.queryByRole('textbox')).toBeNull();
  expect(updateRole).not.toHaveBeenCalled(); expect(updateRoleInstructions).not.toHaveBeenCalled();
});
