// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { BoardSettings, TeamOverview } from '../src/renderer/api';
import { RoutingScreen } from '../src/renderer/routing/RoutingScreen';
import { deferred, escalationRoutingFixture, fakeManagement, managementError, member, overviewFixture, routingSettingsFixture, team } from './teamsFixtures';
import { roleItem, rolesFixture } from './rolesFixtures';
import { workspaceA } from './dashboardFixtures';

afterEach(cleanup);

type OverviewResponse = { ok: true; data: TeamOverview } | ReturnType<typeof managementError>;

async function renderRouting(
  settings: BoardSettings,
  opts: { board?: Parameters<typeof fakeManagement>[0]['boardSettings']; roles?: Parameters<typeof fakeManagement>[0]['roles']; overview?: OverviewResponse[]; calls?: Parameters<typeof fakeManagement>[0]['calls'] } = {},
) {
  const fake = fakeManagement({ boardSettings: opts.board ?? [{ ok: true, data: settings }], roles: opts.roles, overview: opts.overview, calls: opts.calls });
  const view = render(<RoutingScreen workspace={workspaceA} management={fake.api} />);
  await act(async () => {});
  return { view, fake, panel: within(view.getByRole('region', { name: 'Workspace board routing' })) };
}

function ruleRows(view: ReturnType<typeof render>): HTMLElement[] {
  return within(view.getByRole('list', { name: 'Routing transitions' })).getAllByRole('listitem');
}

function runningOverview(overrides: { id: string; name: string; members?: ReturnType<typeof member>[] }[]): TeamOverview {
  return overviewFixture(overrides.map(entry => team({
    id: entry.id,
    name: entry.name,
    runtime: { state: 'running', teamId: `live-${entry.id}`, status: 'running' },
    members: entry.members ?? [member({ memberId: `${entry.id}-dev`, name: `${entry.id} dev`, role: 'Developer' })],
  })));
}

it('shows the three summary cards for a running team', async () => {
  const { view } = await renderRouting(routingSettingsFixture());
  const execution = within(view.getByRole('region', { name: 'Autonomous execution' }));
  expect(execution.getByText('The team that works the board.')).toBeTruthy();
  expect(execution.getByText('Dev Team')).toBeTruthy();
  expect(execution.getByText('2 members')).toBeTruthy();
  expect(execution.getByText('Running')).toBeTruthy();
  expect(execution.getByRole('button', { name: 'Open Dev Team' })).toBeTruthy();
  expect(execution.queryByText('Release Team')).toBeNull();

  const worktrees = within(view.getByRole('region', { name: 'Worktrees' }));
  expect(worktrees.getByText('Where isolated work starts from.')).toBeTruthy();
  expect(worktrees.getByText('Base branch')).toBeTruthy();
  expect(worktrees.getByText('main')).toBeTruthy();
  expect((worktrees.getByRole('button', { name: 'Edit worktrees' }) as HTMLButtonElement).disabled).toBe(false);

  const coverage = within(view.getByRole('region', { name: 'Role coverage' }));
  expect(coverage.getByText('Roles the rules use, and who fills them.')).toBeTruthy();
  expect(coverage.getByText('2 of 2 roles have a member')).toBeTruthy();
  expect(coverage.queryByText(/has no member in the running team/)).toBeNull();
});

it('shows the team initials and a singular member count', async () => {
  const overview = runningOverview([
    { id: 'solo', name: 'Solo Team', members: [member({ memberId: 'solo-dev', name: 'solo dev', role: 'Developer' })] },
  ]);
  const { view } = await renderRouting(routingSettingsFixture(), { overview: [{ ok: true, data: overview }] });
  const execution = within(view.getByRole('region', { name: 'Autonomous execution' }));
  const teamRow = execution.getByText('Solo Team').closest('li')!;
  expect(teamRow.querySelector('.routing-team-avatar')?.textContent).toBe('ST');
  expect(teamRow.querySelector('.routing-team-count')?.textContent).toBe('1 member');
  expect(teamRow.querySelectorAll('.routing-running-pill')).toHaveLength(1);
});

it('lists every running team and opens the chosen one', async () => {
  const overview = runningOverview([
    { id: 'alpha', name: 'Alpha Team' },
    { id: 'beta', name: 'Beta Team', members: [member({ memberId: 'beta-dev', name: 'beta dev', role: 'Developer' }), member({ memberId: 'beta-lead', name: 'beta lead', role: 'TeamLead' })] },
  ]);
  const onOpenTeam = vi.fn();
  const fake = fakeManagement({ boardSettings: [{ ok: true, data: routingSettingsFixture() }], overview: [{ ok: true, data: overview }] });
  const view = render(<RoutingScreen workspace={workspaceA} management={fake.api} onOpenTeam={onOpenTeam} />);
  await act(async () => {});
  const execution = within(view.getByRole('region', { name: 'Autonomous execution' }));
  expect(execution.getByText('Alpha Team')).toBeTruthy();
  expect(execution.getByText('Beta Team')).toBeTruthy();
  const opens = execution.getAllByRole('button', { name: /^Open .* Team$/ });
  expect(opens).toHaveLength(2);
  expect(opens.map(button => button.getAttribute('aria-label'))).toEqual(['Open Alpha Team', 'Open Beta Team']);
  fireEvent.click(opens[0]!);
  fireEvent.click(opens[1]!);
  expect(onOpenTeam.mock.calls).toEqual([['alpha'], ['beta']]);
});

it('says no team is running and links to Teams when none runs', async () => {
  const overview = overviewFixture([team({ id: 'stopped', name: 'Stopped Team', runtime: { state: 'stopped', teamId: 'old', status: 'stopped' } })]);
  const onOpenTeams = vi.fn();
  const fake = fakeManagement({ boardSettings: [{ ok: true, data: routingSettingsFixture() }], overview: [{ ok: true, data: overview }] });
  const view = render(<RoutingScreen workspace={workspaceA} management={fake.api} onOpenTeams={onOpenTeams} />);
  await act(async () => {});
  const execution = within(view.getByRole('region', { name: 'Autonomous execution' }));
  expect(execution.getByText('No team is running. Tickets are not worked automatically until a team starts.')).toBeTruthy();
  fireEvent.click(execution.getByRole('button', { name: 'Open Teams' }));
  expect(onOpenTeams).toHaveBeenCalledTimes(1);
  const coverage = within(view.getByRole('region', { name: 'Role coverage' }));
  expect(coverage.getByText('No team is running')).toBeTruthy();
  expect(coverage.queryByText(/has no member in the running team/)).toBeNull();
});

it('counts role coverage and names every gap with the statuses that wait', async () => {
  const s = escalationRoutingFixture();
  const overview = overviewFixture([team({
    id: 'dev-team', name: 'Dev Team', runtime: { state: 'running', teamId: 'live', status: 'running' },
    members: [member({ memberId: 'dev', name: 'dev', role: 'Developer' }), member({ memberId: 'lead', name: 'lead', role: 'TeamLead' })],
  })]);
  const fake = fakeManagement({ boardSettings: [{ ok: true, data: s }], overview: [{ ok: true, data: overview }] });
  const view = render(<RoutingScreen workspace={workspaceA} management={fake.api} />);
  await act(async () => {});
  const coverage = within(view.getByRole('region', { name: 'Role coverage' }));
  expect(coverage.getByText('2 of 5 roles have a member')).toBeTruthy();
  expect(coverage.getByText('QA has no member in the running team, so tickets in QA ready will wait.')).toBeTruthy();
  expect(coverage.getByText('Reviewer has no member in the running team, so tickets in Review ready will wait.')).toBeTruthy();
  expect(coverage.getByText('SeniorDeveloper has no member in the running team, so tickets in Escalate will wait.')).toBeTruthy();
});

it('never claims a coverage gap when no team runs or the overview is unavailable', async () => {
  const stopped = overviewFixture([team({ runtime: { state: 'stopped', teamId: 'old', status: 'stopped' }, members: [] })]);
  const first = await renderRouting(routingSettingsFixture(), { overview: [{ ok: true, data: stopped }] });
  expect(first.panel.queryByText(/has no member in the running team/)).toBeNull();
  first.view.unmount();

  const unavailable = await renderRouting(routingSettingsFixture(), { overview: [managementError('TEAMS_DOWN', 'teams unreadable')] });
  expect(unavailable.panel.getByText('Role coverage is unavailable.')).toBeTruthy();
  expect(unavailable.panel.getByText('Teams are unavailable.')).toBeTruthy();
  expect(unavailable.panel.queryByText(/has no member in the running team/)).toBeNull();
});

it('surfaces an unavailable live team state instead of claiming no team runs', async () => {
  const overview = overviewFixture([team({
    id: 'live', name: 'Live Team', runtime: { state: 'running', teamId: 'live', status: 'running' },
  })], { runtimeState: { available: false, error: { code: 'RUNTIME_DOWN', message: 'down' } } });
  const { view } = await renderRouting(routingSettingsFixture(), { overview: [{ ok: true, data: overview }] });
  const execution = within(view.getByRole('region', { name: 'Autonomous execution' }));
  expect(execution.getByText('Live team state is unavailable, so running teams cannot be shown.')).toBeTruthy();
  expect(execution.queryByText(/No team is running/)).toBeNull();
  const coverage = within(view.getByRole('region', { name: 'Role coverage' }));
  expect(coverage.getByText('Role coverage is unavailable.')).toBeTruthy();
  expect(coverage.queryByText(/has no member in the running team/)).toBeNull();
  expect(view.queryByText(/Worked by|No member in the running team/)).toBeNull();
});

it('keeps configured rule order and labels unknown statuses', async () => {
  const s = escalationRoutingFixture();
  s.rules = [s.rules[6]!, s.rules[5]!, ...s.rules.slice(0, 5), s.rules[7]!];
  s.statuses = s.statuses.filter(x => x.id !== 'blocked-x');
  const first = await renderRouting(s);
  const rows = ruleRows(first.view);
  expect(rows.map(x => x.getAttribute('data-rule-index'))).toEqual(s.rules.map(x => String(x.index)));
  expect(rows[0]!.textContent).toContain('blocked-x (unknown status)');
  first.view.unmount();
  const known = { ...s, statuses: [...s.statuses, { id: 'blocked-x', name: null, kind: null }] };
  const second = await renderRouting(known);
  expect(ruleRows(second.view)[0]!.textContent).toContain('blocked-x');
});

it('describes an agent rule with its role, workflow, member, next statuses and limits', async () => {
  const { view } = await renderRouting(routingSettingsFixture());
  const row = ruleRows(view)[0]!;
  expect(row.textContent).toContain('1');
  expect(row.textContent).toContain('backlog');
  expect(row.textContent).toContain('Developer');
  expect(row.textContent).toContain('board-develop');
  expect(row.textContent).toContain('Worked by dev');
  expect(row.textContent).toContain('merge-ready');
  expect(row.textContent).toContain('dev-ready');
  expect(row.textContent).toContain('Isolated worktree · sync base');
  expect(row.textContent).toContain('Max 3 rounds');
  expect(within(row).getByText('Developer')).toBeTruthy();
});

it('describes an action rule without a role, workflow or member', async () => {
  const { view } = await renderRouting(routingSettingsFixture());
  const row = ruleRows(view)[1]!;
  expect(row.textContent).toContain('Merge');
  expect(row.textContent).toContain('Built-in action, no agent');
  expect(row.textContent).toContain('done');
  expect(row.textContent).toContain('merge-conflict');
  expect(row.textContent).toContain('Runs on the board');
  expect(row.textContent).toContain('No limits');
  expect(row.textContent).not.toContain('board-develop');
  expect(within(row).queryByRole('button', { name: /in Roles/ })).toBeNull();
});

it('shows built-in action rows without a role or created-on-pass detail', async () => {
  const { view } = await renderRouting(escalationRoutingFixture());
  const rows = ruleRows(view);
  for (const row of [rows[1]!, rows[2]!]) {
    expect(row.textContent).toContain('Merge');
    expect(row.textContent).toContain('Built-in action, no agent');
    expect(row.textContent).not.toContain('tickets created on pass');
    expect(within(row).queryByRole('button', { name: /in Roles/ })).toBeNull();
  }
});

it('marks protected rules and explains a needs-repair route in the row', async () => {
  const s = routingSettingsFixture();
  const first = await renderRouting(s);
  expect(ruleRows(first.view)[3]!.textContent).toContain('Protected');
  first.view.unmount();

  s.protectedRoutes = s.protectedRoutes.map(route => route.status === 'merge-conflict' ? { ...route, satisfied: false } : route);
  const second = await renderRouting(s);
  const row = ruleRows(second.view)[3]!;
  expect(row.textContent).toContain('Needs repair');
  expect(row.textContent).toContain('Change the rule for merge-conflict to use role TeamLead.');
});

it('shows failure escalation and blocked statuses inline', async () => {
  const { view } = await renderRouting(escalationRoutingFixture());
  const rows = ruleRows(view);
  expect(rows[5]!.textContent).toContain('After 3 fails → Escalate');
  expect(rows[5]!.textContent).toContain('Max 4 rounds · priority 5');
  expect(rows[6]!.textContent).toContain('If blocked → blocked-x');
});

it('uses singular wording when a failure limit is one run', async () => {
  const s = escalationRoutingFixture();
  s.rules[5] = { ...s.rules[5]!, onFailureLimit: { count: 1, status: 'need-escalate' } };
  const { view } = await renderRouting(s);
  const row = ruleRows(view)[5]!;
  expect(row.textContent).toContain('After 1 fail → Escalate');
  expect(row.textContent).not.toContain('After 1 fails');
});

it('shows board and role problems in amber notes above the rules table', async () => {
  const s = routingSettingsFixture();
  s.board = { ...s.board, state: 'invalid', problems: [{ path: 'rules[0]', message: 'broken rule' }] };
  s.roles = { ...s.roles, state: 'invalid', message: 'Roles invalid' };
  const { view } = await renderRouting(s);
  const warnings = Array.from(view.container.querySelectorAll<HTMLElement>('.routing-warning-note'));
  expect(warnings.map(warning => warning.textContent)).toEqual([
    'The workspace board configuration is invalid. Routing cannot be shown until it is repaired.',
    'rules[0]: broken rule',
    'Roles invalid',
  ]);
  const scroll = view.getByRole('region', { name: 'Routing transitions (scrollable)' });
  expect(warnings[0]!.compareDocumentPosition(scroll) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('marks coverage gaps and needs-repair tags as amber findings', async () => {
  const s = routingSettingsFixture();
  s.protectedRoutes = s.protectedRoutes.map(route => route.status === 'merge-conflict' ? { ...route, satisfied: false } : route);
  const overview = overviewFixture([team({
    runtime: { state: 'running', teamId: 'live', status: 'running' },
    members: [member({ memberId: 'dev', role: 'Developer' })],
  })]);
  const { view } = await renderRouting(s, { overview: [{ ok: true, data: overview }] });
  const coverage = within(view.getByRole('region', { name: 'Role coverage' }));
  const gap = coverage.getByText('TeamLead has no member in the running team, so tickets in merge-conflict, plan-merge-conflict will wait.');
  expect(gap.classList.contains('routing-coverage-gap')).toBe(true);
  expect(ruleRows(view)[3]!.querySelector('.routing-tag-repair')).toBeTruthy();
});

it('warns when an escalation target has no rule to handle it', async () => {
  const s = escalationRoutingFixture();
  s.rules = s.rules.filter(rule => rule.status !== 'need-escalate');
  const { view } = await renderRouting(s);
  expect(ruleRows(view)[5]!.textContent).toContain('No rule starts from Escalate; escalated tickets wait there.');
});

it('keeps missing and unavailable roles in the Then column', async () => {
  const s = routingSettingsFixture();
  s.rules[0] = { ...s.rules[0]!, role: 'ghost' };
  const missing = await renderRouting(s);
  expect(ruleRows(missing.view)[0]!.textContent).toContain('ghost');
  expect(ruleRows(missing.view)[0]!.textContent).toContain('Role not in catalog');
  missing.view.unmount();

  const unavailable = await renderRouting(s, { roles: [managementError('ROLES_DOWN', 'roles unreadable')] });
  expect(unavailable.panel.getAllByText('Role catalog unavailable').length).toBeGreaterThan(0);
  expect(unavailable.panel.queryByRole('button', { name: /in Roles/ })).toBeNull();
});

it('links duplicate role names by stable id', async () => {
  const s = routingSettingsFixture();
  s.rules[0] = { ...s.rules[0]!, role: 'qa-a' };
  s.rules[3] = { ...s.rules[3]!, role: 'qa-b' };
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
  expect(ruleRows(view)[0]!.textContent).toContain('qa-a');
  expect(ruleRows(view)[3]!.textContent).toContain('qa-b');
  expect(view.getAllByText('Role not in catalog').length).toBeGreaterThan(0);
});

it('explains unavailable workflows in the row and in the Workflows card', async () => {
  const s = routingSettingsFixture();
  s.workflows = s.workflows.map(w => w.name === 'board-develop' ? { ...w, errors: ['Broken workflow'] } : w);
  const { view } = await renderRouting(s);
  expect(ruleRows(view)[0]!.textContent).toContain('board-develop — unavailable');
  const workflows = within(view.getByRole('region', { name: 'Workflows' }));
  expect(workflows.getByText('board-develop')).toBeTruthy();
  expect(workflows.getAllByText('built-in').length).toBeGreaterThan(0);
  expect(workflows.getByText('unavailable')).toBeTruthy();
  expect(workflows.getByText('Broken workflow')).toBeTruthy();
  expect(workflows.getByText('Roles: Developer')).toBeTruthy();
  expect(view.container.textContent).not.toMatch(/Develops|Leads/);
  expect(view.queryByRole('textbox')).toBeNull();
});

it('shows the Workflows card empty state', async () => {
  const s = routingSettingsFixture();
  s.workflows = [];
  const { view } = await renderRouting(s);
  expect(within(view.getByRole('region', { name: 'Workflows' })).getByText('No workflows were returned.')).toBeTruthy();
  expect(ruleRows(view)[0]!.textContent).toContain('board-develop — not found');
});

it('keeps the rules grid defined once and scrolls inside its card', async () => {
  const { view } = await renderRouting(routingSettingsFixture());
  const card = view.getByRole('region', { name: 'Rules' });
  const scroll = within(card).getByRole('region', { name: 'Routing transitions (scrollable)' });
  expect(scroll.tabIndex).toBe(0);
  expect(scroll.querySelector('.routing-rules-inner')).toBeTruthy();
  const css = readFileSync(resolve(__dirname, '../src/renderer/styles.css'), 'utf8');
  const templates = css.match(/grid-template-columns: 34px minmax\(0, 1\.5fr\) minmax\(0, 2fr\) minmax\(0, 1\.4fr\) minmax\(0, 1\.6fr\) minmax\(0, 1\.5fr\) 68px/g) ?? [];
  expect(templates).toHaveLength(1);
  expect(css).toMatch(/\.routing-summary-grid \{ display: grid; grid-template-columns: repeat\(auto-fit, minmax\(300px, 1fr\)\); gap: 22px;/);
  expect(css).toContain('.routing-read-view { display: flex; flex-direction: column; gap: 22px; min-width: 0; }');
  expect(css).toContain('.routing-rules-inner { min-width: 1040px; }');
});

it('keeps the base branch unavailable when the board has none', async () => {
  const s = routingSettingsFixture();
  s.worktree = { baseBranch: null, worktreeStatuses: [] };
  const { view } = await renderRouting(s);
  expect(within(view.getByRole('region', { name: 'Worktrees' })).getByText('unavailable')).toBeTruthy();
});

it('shows loading, missing, invalid, and retained error states without invented rules', async () => {
  const gate = deferred<{ ok: true; data: BoardSettings }>();
  const loading = await renderRouting(routingSettingsFixture(), { board: [gate.promise] });
  expect(loading.panel.getByText('Loading settings…')).toBeTruthy();
  expect(loading.panel.queryByRole('list', { name: 'Routing transitions' })).toBeNull();
  loading.view.unmount();

  const missingSettings = routingSettingsFixture();
  missingSettings.rules = [];
  missingSettings.board = { ...missingSettings.board, state: 'missing' };
  const missing = await renderRouting(missingSettings);
  expect(missing.panel.getByText('No workspace board is configured, so no routing is shown.')).toBeTruthy();
  expect(missing.panel.queryByRole('list', { name: 'Routing transitions' })).toBeNull();
  missing.view.unmount();

  const invalidSettings = routingSettingsFixture();
  invalidSettings.rules = [];
  invalidSettings.board = { ...invalidSettings.board, state: 'invalid', problems: [{ path: 'rules[0]', message: 'broken rule' }] };
  invalidSettings.roles = { ...invalidSettings.roles, state: 'invalid', message: 'Roles invalid' };
  const invalid = await renderRouting(invalidSettings);
  expect(invalid.panel.getByText('The workspace board configuration is invalid. Routing cannot be shown until it is repaired.')).toBeTruthy();
  expect(invalid.panel.getByText('rules[0]: broken rule')).toBeTruthy();
  expect(invalid.panel.getByText('Roles invalid')).toBeTruthy();
  expect(invalid.panel.queryByRole('list', { name: 'Routing transitions' })).toBeNull();
  invalid.view.unmount();

  const fake = fakeManagement({ boardSettings: [{ ok: true, data: routingSettingsFixture() }, managementError('OFFLINE', 'offline')] });
  const retained = render(<RoutingScreen workspace={workspaceA} management={fake.api} connection={{ state: 'lost', error: null, distro: null, command: null }} />);
  await act(async () => {});
  await act(async () => { fireEvent.click(retained.getByRole('button', { name: 'Refresh' })); });
  expect(retained.getByRole('alert').textContent).toContain('OFFLINE: offline');
  expect(retained.getByText('Showing the last loaded routing; it may be out of date.')).toBeTruthy();
  expect(retained.getByText('Disconnected from the backend. Routing is read-only until the connection returns.')).toBeTruthy();
  expect(retained.getByRole('list', { name: 'Routing transitions' })).toBeTruthy();
});

it('shows the empty-board message for a valid board without rules', async () => {
  const s = routingSettingsFixture();
  s.rules = [];
  const { view } = await renderRouting(s);
  expect(view.getByText('This workspace board has no routing rules.')).toBeTruthy();
  expect(view.queryByRole('list', { name: 'Routing transitions' })).toBeNull();
});

it('uses returned protected routes instead of rule flags', async () => {
  const s = routingSettingsFixture();
  s.rules[0] = { ...s.rules[0]!, protected: true };
  s.protectedRoutes = [{ status: 'dev-ready', role: 'Maintainer', satisfied: false }];
  s.rules[3] = { ...s.rules[3]!, status: 'dev-ready', protected: false };
  const { view } = await renderRouting(s);
  const rows = ruleRows(view);
  expect(rows[0]!.textContent).not.toContain('Protected');
  expect(rows[3]!.textContent).toContain('Needs repair');
  expect(rows[3]!.textContent).toContain('Change the rule for dev-ready to use role Maintainer.');
});

it('matches Worked by to running-team members and marks a role without one', async () => {
  const overview = overviewFixture([team({
    id: 'live', name: 'Live Team', runtime: { state: 'running', teamId: 'live', status: 'running' },
    members: [member({ memberId: 'lead', name: 'lead', role: 'TeamLead' })],
  })]);
  const { view } = await renderRouting(routingSettingsFixture(), { overview: [{ ok: true, data: overview }] });
  const rows = ruleRows(view);
  expect(rows[0]!.textContent).toContain('No member in the running team');
  expect(rows[0]!.textContent).not.toContain('Worked by');
  expect(rows[3]!.textContent).toContain('Worked by lead');
  const coverage = within(view.getByRole('region', { name: 'Role coverage' }));
  expect(coverage.getByText('1 of 2 roles have a member')).toBeTruthy();
  expect(coverage.getByText('Developer has no member in the running team, so tickets in backlog will wait.')).toBeTruthy();
});

it('marks coverage and Worked by unknown when a running team member list is truncated', async () => {
  const overview = overviewFixture([team({
    id: 'live', name: 'Live Team', runtime: { state: 'running', teamId: 'live', status: 'running' },
    members: [member({ memberId: 'dev', name: 'dev', role: 'Developer' })],
    membersTruncated: true,
  })]);
  const { view } = await renderRouting(routingSettingsFixture(), { overview: [{ ok: true, data: overview }] });
  const coverage = within(view.getByRole('region', { name: 'Role coverage' }));
  expect(coverage.getByText('1 of 2 roles have a member')).toBeTruthy();
  expect(coverage.queryByText(/has no member in the running team/)).toBeNull();
  expect(coverage.getByText('The running team returned only part of its members, so a role without a member may still be filled.')).toBeTruthy();
  const rows = ruleRows(view);
  expect(rows[0]!.textContent).toContain('Worked by dev');
  expect(rows[3]!.textContent).toContain('Member for this role is unknown');
  expect(rows[3]!.textContent).not.toContain('No member in the running team');
});

it('omits Worked by and member-gap claims when no team runs even if a stopped team fills the role', async () => {
  const overview = overviewFixture([team({
    id: 'stopped', name: 'Stopped Team', runtime: { state: 'stopped', teamId: 'old', status: 'stopped' },
    members: [member({ memberId: 'dev', name: 'dev', role: 'Developer' }), member({ memberId: 'lead', name: 'lead', role: 'TeamLead' })],
  })]);
  const { view } = await renderRouting(routingSettingsFixture(), { overview: [{ ok: true, data: overview }] });
  const text = ruleRows(view).map(row => row.textContent).join(' ');
  expect(text).not.toContain('Worked by');
  expect(text).not.toContain('No member in the running team');
});

it('shows loading cards without claiming coverage or members while teams are unknown', async () => {
  const gate = deferred<{ ok: true; data: TeamOverview }>();
  const { view, panel } = await renderRouting(routingSettingsFixture(), { overview: [gate.promise] });
  const execution = within(panel.getByRole('region', { name: 'Autonomous execution' }));
  expect(execution.getByText('Loading teams…')).toBeTruthy();
  expect(execution.queryByRole('button', { name: 'Open Teams' })).toBeNull();
  const coverage = within(panel.getByRole('region', { name: 'Role coverage' }));
  expect(coverage.getByText('Loading role coverage…')).toBeTruthy();
  expect(coverage.queryByText(/has no member in the running team/)).toBeNull();
  expect(panel.queryByText(/Worked by|No member in the running team/)).toBeNull();
});

it('counts members from every running team in the coverage card and the rows', async () => {
  const overview = runningOverview([
    { id: 'alpha', name: 'Alpha Team', members: [member({ memberId: 'alpha-dev', name: 'alpha dev', role: 'Developer' })] },
    { id: 'beta', name: 'Beta Team', members: [member({ memberId: 'beta-lead', name: 'beta lead', role: 'TeamLead' })] },
  ]);
  const { view } = await renderRouting(routingSettingsFixture(), { overview: [{ ok: true, data: overview }] });
  const coverage = within(view.getByRole('region', { name: 'Role coverage' }));
  expect(coverage.getByText('2 of 2 roles have a member')).toBeTruthy();
  expect(coverage.queryByText(/has no member in the running team/)).toBeNull();
  const rows = ruleRows(view);
  expect(rows[0]!.textContent).toContain('Worked by alpha dev');
  expect(rows[3]!.textContent).toContain('Worked by beta lead');
});

it('uses the role catalog name for a coverage gap and the stable id when the catalog is unavailable', async () => {
  const s = routingSettingsFixture();
  const overview = overviewFixture([team({
    runtime: { state: 'running', teamId: 'live', status: 'running' },
    members: [member({ memberId: 'dev', role: 'Developer' })],
  })]);
  const fake = fakeManagement({
    boardSettings: [{ ok: true, data: s }],
    overview: [{ ok: true, data: overview }],
    roles: [{ ok: true, data: rolesFixture({ items: [roleItem('Developer'), roleItem('TeamLead', { name: 'Tech lead' })] }) }],
  });
  const view = render(<RoutingScreen workspace={workspaceA} management={fake.api} />);
  await act(async () => {});
  expect(within(view.getByRole('region', { name: 'Role coverage' }))
    .getByText('Tech lead has no member in the running team, so tickets in merge-conflict, plan-merge-conflict will wait.')).toBeTruthy();
  view.unmount();

  const unavailable = await renderRouting(s, { overview: [{ ok: true, data: overview }], roles: [managementError('ROLES_DOWN', 'roles unreadable')] });
  expect(within(unavailable.view.getByRole('region', { name: 'Role coverage' }))
    .getByText('TeamLead has no member in the running team, so tickets in merge-conflict, plan-merge-conflict will wait.')).toBeTruthy();
});

it('labels the six rule columns with one action column and keeps every row a list item', async () => {
  const { view } = await renderRouting(routingSettingsFixture());
  const card = view.getByRole('region', { name: 'Rules' });
  const scroll = within(card).getByRole('region', { name: 'Routing transitions (scrollable)' });
  const header = scroll.querySelector<HTMLElement>('.routing-rules-header');
  expect(header).toBeTruthy();
  expect(Array.from(header!.children).map(cell => cell.textContent)).toEqual(['#', 'When a ticket is in', 'Then', 'If it passes', 'If it fails', 'Limits', '']);
  expect(header!.lastElementChild!.getAttribute('aria-hidden')).toBe('true');
  const rows = ruleRows(view);
  expect(rows).toHaveLength(5);
  expect(rows.every(row => row.tagName === 'LI')).toBe(true);
  expect(within(rows[1]!).getByRole('button', { name: 'Edit rule 2, merge-ready' })).toBeTruthy();
});

it('numbers rules from their configured order and shows a lock on the protected tag', async () => {
  const s = escalationRoutingFixture();
  s.rules = [s.rules[6]!, s.rules[5]!, ...s.rules.slice(0, 5), s.rules[7]!];
  const { view } = await renderRouting(s);
  const rows = ruleRows(view);
  expect(rows.map(row => row.querySelector('.routing-rule-index')?.textContent)).toEqual(['7', '6', '1', '2', '3', '4', '5', '8']);
  expect(rows[5]!.textContent).toContain('Protected');
  expect(rows[5]!.querySelector('.routing-tag-protected svg')).toBeTruthy();
});

it('uses the design status dot colours in the rows and chips', async () => {
  const { view } = await renderRouting(routingSettingsFixture());
  const rows = ruleRows(view);
  expect(rows[0]!.querySelector('.routing-status-dot-grey')).toBeTruthy();
  expect(rows[0]!.querySelector('.routing-status-dot-blue')).toBeTruthy();
  expect(rows[1]!.querySelector('.routing-status-dot-green')).toBeTruthy();
  expect(rows[1]!.querySelector('.routing-status-dot-red')).toBeTruthy();
});

it('shows whichever limits are set and No limits only when neither is', async () => {
  const s = routingSettingsFixture();
  s.rules[0] = { ...s.rules[0]!, maxRounds: null, priority: 7 };
  s.rules[3] = { ...s.rules[3]!, maxRounds: 2, priority: null };
  const { view } = await renderRouting(s);
  const rows = ruleRows(view);
  expect(rows[0]!.textContent).toContain('priority 7');
  expect(rows[0]!.textContent).not.toContain('No limits');
  expect(rows[3]!.textContent).toContain('Max 2 rounds');
  expect(rows[3]!.textContent).not.toContain('priority');
  expect(rows[1]!.textContent).toContain('No limits');
});

it('shows workspace workflows with no roles and structured error text in the Workflows card', async () => {
  const s = routingSettingsFixture();
  s.workflows = [{ name: 'flow-a', builtin: false, roles: [], errors: [{ message: 'bad flow' }] }];
  s.rules[0] = { ...s.rules[0]!, workflow: 'flow-a' };
  const { view } = await renderRouting(s);
  const workflows = within(view.getByRole('region', { name: 'Workflows' }));
  expect(workflows.getByText('flow-a')).toBeTruthy();
  expect(workflows.getByText('workspace')).toBeTruthy();
  expect(workflows.getByText('Roles: none')).toBeTruthy();
  expect(workflows.getByText('unavailable')).toBeTruthy();
  expect(workflows.getByText('bad flow')).toBeTruthy();
  expect(ruleRows(view)[0]!.textContent).toContain('flow-a — unavailable');
});

it('renders renamed statuses, roles and workflows from the returned configuration', async () => {
  const s = escalationRoutingFixture();
  s.statuses = s.statuses.map(x => x.id === 'need-escalate' ? { ...x, id: 'triage', name: 'Triage' } : x);
  s.rules = s.rules.map(r => ({
    ...r,
    status: r.status === 'need-escalate' ? 'triage' : r.status,
    onFail: r.onFail === 'need-escalate' ? 'triage' : r.onFail,
    role: r.role === 'SeniorDeveloper' ? 'Expert' : r.role,
    workflow: r.workflow === 'board-develop' ? 'flow-a' : r.workflow,
    onFailureLimit: r.onFailureLimit && { ...r.onFailureLimit, status: 'triage' },
  }));
  s.workflows = s.workflows.map(w => ({ ...w, name: w.name === 'board-develop' ? 'flow-a' : w.name, roles: w.roles.map(r => r === 'SeniorDeveloper' ? 'Expert' : r) }));
  const { view } = await renderRouting(s);
  expect(view.getAllByText(/3 fails → Triage/).length).toBe(2);
  expect(view.container.textContent).not.toMatch(/need-escalate|SeniorDeveloper|board-develop/);
});
