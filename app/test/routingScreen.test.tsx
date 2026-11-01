// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RoutingScreen } from '../src/renderer/routing/RoutingScreen';
import { workspaceA, workspaceB } from './dashboardFixtures';
import { connectionFixture, deferred, fakeManagement, managementError, routingSettingsFixture } from './teamsFixtures';
import { rolesFixture } from './rolesFixtures';

afterEach(cleanup);

const okR = <T,>(data: T) => ({ ok: true as const, data });

it('renders the design header and notice above the existing routing panel with one h1', async () => {
  const fake = fakeManagement({ boardSettings: [okR(routingSettingsFixture())] });
  const view = render(<RoutingScreen workspace={workspaceA} management={fake.api} />);
  await act(async () => {});
  expect(view.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  expect(view.getByRole('heading', { level: 1 }).textContent).toBe('Routing');
  expect(view.getByText('How tickets move on its own. When a ticket reaches a status, the role named here works it in the running team, and the result decides the next status.')).toBeTruthy();
  expect(view.getByText('Routing belongs to the workspace board, not to one team. Changes apply to every team that uses this board. Without routing, teams still work when you give them a task, and you can move tickets by hand.')).toBeTruthy();
  const header = view.container.querySelector<HTMLElement>('.routing-header')!;
  const notice = view.container.querySelector<HTMLElement>('.routing-notice')!;
  const panel = view.getByRole('region', { name: 'Workspace board routing' });
  expect(header.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(notice.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(view.getByRole('heading', { level: 2, name: 'Workspace board routing' })).toBeTruthy();
  expect(fake.boardSettings).toHaveBeenCalledTimes(1);
  expect(fake.roles).toHaveBeenCalledTimes(1);
  expect(fake.overview).toHaveBeenCalledTimes(1);
});

it('keeps the page header to the heading and subtitle from the design', async () => {
  const fake = fakeManagement({ boardSettings: [okR(routingSettingsFixture())] });
  const view = render(<RoutingScreen workspace={workspaceA} management={fake.api} />);
  await act(async () => {});
  const header = view.container.querySelector<HTMLElement>('.routing-header')!;
  expect(within(header).getByRole('heading', { level: 1 }).textContent).toBe('Routing');
  expect(within(header).queryByRole('button')).toBeNull();
  expect(header.querySelectorAll('h1')).toHaveLength(1);
  expect(view.container.querySelector('.routing-notice svg path')?.getAttribute('d')).toBe('M12 8v4M12 16h.01');
});

it('announces loading once and retries a failed board read with focus on the panel heading', async () => {
  const gate = deferred<ReturnType<typeof okR<ReturnType<typeof routingSettingsFixture>>>>();
  const loading = render(<RoutingScreen workspace={workspaceA} management={fakeManagement({ boardSettings: [gate.promise] }).api} />);
  await act(async () => {});
  expect(loading.getByText('Loading settings…')).toBeTruthy();
  expect(loading.getAllByRole('status')).toHaveLength(1);
  loading.unmount();

  const fake = fakeManagement({ boardSettings: [managementError('BOARD_DOWN', 'board unreadable'), okR(routingSettingsFixture())] });
  const view = render(<RoutingScreen workspace={workspaceA} management={fake.api} />);
  await act(async () => {});
  const panel = within(view.getByRole('region', { name: 'Workspace board routing' }));
  expect(panel.getByRole('alert').textContent).toContain('BOARD_DOWN: board unreadable');
  const retry = panel.getByRole('button', { name: 'Retry' });
  fireEvent.click(retry);
  await act(async () => {});
  expect(fake.boardSettings).toHaveBeenCalledTimes(2);
  expect(fake.roles).toHaveBeenCalledTimes(1);
  expect(within(panel.getByRole('region', { name: 'Worktrees' })).getByText('main')).toBeTruthy();
  expect(document.activeElement).toBe(panel.getByRole('heading', { level: 2, name: 'Workspace board routing' }));
});

it('refreshes board settings and roles and announces the result once', async () => {
  const fake = fakeManagement({ boardSettings: [okR(routingSettingsFixture()), okR(routingSettingsFixture())], roles: [okR(rolesFixture()), okR(rolesFixture())] });
  const view = render(<RoutingScreen workspace={workspaceA} management={fake.api} />);
  await act(async () => {});
  fireEvent.click(view.getByRole('button', { name: 'Refresh' }));
  await act(async () => {});
  expect(fake.boardSettings).toHaveBeenCalledTimes(2);
  expect(fake.roles).toHaveBeenCalledTimes(2);
  expect(view.getByRole('status').textContent).toContain('Routing data refreshed.');
});

it('returns focus to the panel refresh button after a successful refresh', async () => {
  const fake = fakeManagement({ boardSettings: [okR(routingSettingsFixture()), okR(routingSettingsFixture())], roles: [okR(rolesFixture()), okR(rolesFixture())] });
  const view = render(<RoutingScreen workspace={workspaceA} management={fake.api} />);
  await act(async () => {});
  const panel = within(view.getByRole('region', { name: 'Workspace board routing' }));
  const refresh = panel.getByRole('button', { name: 'Refresh' });
  expect(refresh.closest('.routing-panel-header')).not.toBeNull();
  fireEvent.click(refresh);
  await act(async () => {});
  expect(fake.boardSettings).toHaveBeenCalledTimes(2);
  expect(fake.roles).toHaveBeenCalledTimes(2);
  expect(document.activeElement).toBe(refresh);
});

it('a failed refresh shows the panel error instead of announcing a refresh', async () => {
  const fake = fakeManagement({
    boardSettings: [okR(routingSettingsFixture()), managementError('OFFLINE', 'offline')],
    roles: [okR(rolesFixture())],
  });
  const view = render(<RoutingScreen workspace={workspaceA} management={fake.api} />);
  await act(async () => {});
  const panel = within(view.getByRole('region', { name: 'Workspace board routing' }));
  fireEvent.click(panel.getByRole('button', { name: 'Refresh' }));
  await act(async () => {});
  expect(fake.boardSettings).toHaveBeenCalledTimes(2);
  expect(view.queryByText('Routing data refreshed.')).toBeNull();
  expect(panel.getByRole('alert').textContent).toContain('OFFLINE: offline');
  expect(panel.getByText('Showing the last loaded routing; it may be out of date.')).toBeTruthy();
});

it('refreshes board settings and the role catalog once after reconnecting', async () => {
  const fake = fakeManagement({ boardSettings: [okR(routingSettingsFixture()), okR(routingSettingsFixture())], roles: [okR(rolesFixture()), okR(rolesFixture())] });
  const view = render(<RoutingScreen workspace={workspaceA} management={fake.api} connection={connectionFixture('lost')} />);
  await act(async () => {});
  expect(fake.boardSettings).toHaveBeenCalledTimes(1);
  expect(fake.roles).toHaveBeenCalledTimes(1);
  expect(view.getByText('Connection lost. Showing previously loaded routing data.')).toBeTruthy();
  view.rerender(<RoutingScreen workspace={workspaceA} management={fake.api} connection={connectionFixture('connected')} />);
  await act(async () => {});
  expect(fake.boardSettings).toHaveBeenCalledTimes(2);
  expect(fake.roles).toHaveBeenCalledTimes(2);
  expect(view.queryByText('Connection lost. Showing previously loaded routing data.')).toBeNull();
  expect(view.getByRole('heading', { level: 1, name: 'Routing' })).toBeTruthy();
  expect(view.getByRole('region', { name: 'Workspace board routing' })).toBeTruthy();
});

it('switching workspace reloads routing for the new workspace and resets local state', async () => {
  const fake = fakeManagement({ boardSettings: [okR(routingSettingsFixture()), okR(routingSettingsFixture())] });
  const view = render(<RoutingScreen workspace={workspaceA} management={fake.api} />);
  await act(async () => {});
  fireEvent.click(view.getByRole('button', { name: 'Edit worktrees' }));
  fireEvent.change(view.getByLabelText('Base branch'), { target: { value: 'uncommitted-draft' } });
  expect((view.getByLabelText('Base branch') as HTMLInputElement).value).toBe('uncommitted-draft');
  view.rerender(<RoutingScreen workspace={workspaceB} management={fake.api} />);
  await act(async () => {});
  expect(fake.boardSettings).toHaveBeenLastCalledWith(workspaceB.id);
  expect(view.getByRole('heading', { level: 1, name: 'Routing' })).toBeTruthy();
  expect(view.getByRole('region', { name: 'Workspace board routing' })).toBeTruthy();
  expect(view.queryByLabelText('Base branch')).toBeNull();
  expect(within(view.getByRole('region', { name: 'Worktrees' })).getByText('main')).toBeTruthy();
});

it('opens the Roles section for a role link through onViewRole', async () => {
  const onViewRole = vi.fn();
  const fake = fakeManagement({ boardSettings: [okR(routingSettingsFixture())] });
  const view = render(<RoutingScreen workspace={workspaceA} management={fake.api} onViewRole={onViewRole} />);
  await act(async () => {});
  fireEvent.click(view.getByRole('button', { name: 'View Developer in Roles (rule 1)' }));
  expect(onViewRole).toHaveBeenCalledWith('Developer');
});

it('announces a pending role catalog once and retries it without reloading board settings', async () => {
  const gate = deferred<ReturnType<typeof okR<ReturnType<typeof rolesFixture>>>>();
  const pending = render(<RoutingScreen workspace={workspaceA} management={fakeManagement({ roles: [gate.promise] }).api} />);
  await act(async () => {});
  expect(pending.getByText('Loading the role catalog…')).toBeTruthy();
  expect(pending.getAllByRole('status')).toHaveLength(1);
  pending.unmount();

  const fake = fakeManagement({
    boardSettings: [okR(routingSettingsFixture())],
    roles: [managementError('ROLES_DOWN', 'roles unreadable'), okR(rolesFixture())],
  });
  const view = render(<RoutingScreen workspace={workspaceA} management={fake.api} onViewRole={vi.fn()} />);
  await act(async () => {});
  const error = view.getByRole('alert');
  expect(error.textContent).toContain('Role catalog: ROLES_DOWN: roles unreadable');
  fireEvent.click(view.getByRole('button', { name: 'Retry loading roles' }));
  await act(async () => {});
  expect(fake.roles).toHaveBeenCalledTimes(2);
  expect(fake.boardSettings).toHaveBeenCalledTimes(1);
  expect(view.getByRole('button', { name: 'View Developer in Roles (rule 1)' })).toBeTruthy();
  expect(document.activeElement).toBe(view.getByRole('heading', { level: 1, name: 'Routing' }));
});

it('explains an invalid role catalog and offers no role links until it is fixed', async () => {
  const fake = fakeManagement({
    boardSettings: [okR(routingSettingsFixture())],
    roles: [okR(rolesFixture({ state: 'invalid', message: 'roles.json is invalid', items: [] }))],
  });
  const view = render(<RoutingScreen workspace={workspaceA} management={fake.api} onViewRole={vi.fn()} />);
  await act(async () => {});
  expect(view.getByText('The role catalog is invalid. Fix it in Roles before choosing a role.')).toBeTruthy();
  expect(view.queryByRole('button', { name: /in Roles/ })).toBeNull();
  expect(view.queryByRole('alert')).toBeNull();
});

it('does not show a previous workspace routing response after switching workspace', async () => {
  const gateA = deferred<ReturnType<typeof okR<ReturnType<typeof routingSettingsFixture>>>>();
  const boardSettings = vi.fn((id: string) => id === workspaceB.id
    ? Promise.resolve(okR(routingSettingsFixture({ worktree: { baseBranch: 'workspace-b', worktreeStatuses: [] } })))
    : gateA.promise);
  const fake = fakeManagement({ calls: { boardSettings } });
  const view = render(<RoutingScreen workspace={workspaceA} management={fake.api} />);
  await act(async () => {});
  view.rerender(<RoutingScreen workspace={workspaceB} management={fake.api} />);
  await act(async () => {});
  expect(within(view.getByRole('region', { name: 'Worktrees' })).getByText('workspace-b')).toBeTruthy();
  await act(async () => { gateA.resolve(okR(routingSettingsFixture())); });
  expect(within(view.getByRole('region', { name: 'Worktrees' })).getByText('workspace-b')).toBeTruthy();
  expect(within(view.getByRole('region', { name: 'Worktrees' })).queryByText('main')).toBeNull();
  expect(view.getByRole('heading', { level: 1, name: 'Routing' })).toBeTruthy();
});

it('keeps board routing visible when only the role catalog refresh fails and does not announce success', async () => {
  const fake = fakeManagement({
    boardSettings: [okR(routingSettingsFixture()), okR(routingSettingsFixture())],
    roles: [okR(rolesFixture()), managementError('ROLES_DOWN', 'roles unreadable')],
  });
  const view = render(<RoutingScreen workspace={workspaceA} management={fake.api} />);
  await act(async () => {});
  fireEvent.click(view.getByRole('button', { name: 'Refresh' }));
  await act(async () => {});
  expect(fake.boardSettings).toHaveBeenCalledTimes(2);
  expect(fake.roles).toHaveBeenCalledTimes(2);
  expect(view.queryByText('Routing data refreshed.')).toBeNull();
  expect(view.getAllByRole('alert')).toHaveLength(1);
  expect(view.getByRole('alert').textContent).toContain('Role catalog: ROLES_DOWN: roles unreadable');
  expect(within(view.getByRole('region', { name: 'Worktrees' })).getByText('main')).toBeTruthy();
  expect(view.getByRole('list', { name: 'Routing transitions' })).toBeTruthy();
});

it('shows role names without Roles links when onViewRole is not provided', async () => {
  const fake = fakeManagement({ boardSettings: [okR(routingSettingsFixture())] });
  const view = render(<RoutingScreen workspace={workspaceA} management={fake.api} />);
  await act(async () => {});
  expect(view.queryByRole('button', { name: /in Roles/ })).toBeNull();
  const table = within(view.getByRole('list', { name: 'Routing transitions' }));
  expect(table.getAllByText('Developer').length).toBeGreaterThan(0);
  expect(table.getAllByText('TeamLead').length).toBeGreaterThan(0);
});
