// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import type { ConnectionStatus, DashboardApi, Workspace } from '../src/renderer/api';
import { SectionPlaceholder } from '../src/renderer/sections/SectionPlaceholder';
import { WorkspaceShell as WorkspaceShellComponent, type WorkspaceShellProps } from '../src/renderer/shell/WorkspaceShell';
import { NAV_ITEMS, type NavItem } from '../src/renderer/shell/navModel';
import { fakeManagement, member, overviewFixture, team, teamDefinition, twoTeams, connectionFixture, deferred } from './teamsFixtures';
import { roleItem, rolesFixture } from './rolesFixtures';

afterEach(cleanup);

const workspace: Workspace = {
  id: 'a',
  name: 'A very long workspace name',
  path: '/home/me/a/very/long/path',
  exists: true,
  missing: false,
};

const descriptions = {
  Home: 'Not available yet. The workspace dashboard will appear here.',
  Teams: 'Not available yet. Teams and their members will appear here.',
  Boards: 'Not available yet. Board phases and tickets will appear here.',
  Configuration: 'Not available yet. Workspace settings will appear here.',
};

const dashboard: DashboardApi = {
  teams: vi.fn(async () => ({ ok: true, data: { workspace: workspace.path, teams: [], truncated: false } })),
  board: vi.fn(async () => ({
    ok: true,
    data: {
      workspace: workspace.path, currentPhase: { slug: 'default', name: 'Default', status: 'open' },
      columns: [], totals: { active: 0, blocked: 0, done: 0 }, tickets: [],
    },
  })),
  activity: vi.fn(async () => ({
    ok: true,
    data: { workspace: workspace.path, dbId: 'activity-db', head: 0, entries: [] },
  })),
};
const management = fakeManagement().api;
const connection: ConnectionStatus = { state: 'connected', error: null, distro: null, command: 'serve' };

function WorkspaceShell(props: Omit<WorkspaceShellProps, 'dashboard' | 'connection' | 'management'>) {
  return (
    <WorkspaceShellComponent
      {...props}
      dashboard={dashboard}
      management={management}
      connection={connection}
      renderSection={props.renderSection ?? ((sectionId) => sectionId === 'home' ? (
        <SectionPlaceholder sectionId="home" title="Home" description={descriptions.Home} />
      ) : undefined)}
    />
  );
}

function currentButtons(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('button[aria-current="page"]')];
}

describe('WorkspaceShell', () => {
  it('renders workspace identity and defaults to Home', () => {
    const result = render(<WorkspaceShell workspace={workspace} onSwitchWorkspace={vi.fn()} />);
    const name = result.getByText(workspace.name);
    const path = result.getByText(workspace.path);
    const nav = result.getByRole('navigation', { name: 'Workspace' });

    expect(name.getAttribute('title')).toBe(workspace.name);
    expect(path.getAttribute('title')).toBe(workspace.path);
    expect(Array.from(nav.querySelectorAll<HTMLButtonElement>('.nav-item')).map((button) => button.textContent)).toEqual([
      'Home', 'Teams', 'Agents', 'Roles', 'Boards', 'Configuration',
    ]);
    expect(currentButtons(result.container)).toEqual([within(nav).getByRole('button', { name: 'Home' })]);
    const agents = within(nav).getAllByRole('button', { name: 'Agents' });
    expect(agents).toHaveLength(1);
    expect((agents[0] as HTMLButtonElement).disabled).toBe(false);
    expect(agents[0].querySelector('svg')?.getAttribute('data-icon')).toBe('agents');
    const roles = within(nav).getAllByRole('button', { name: 'Roles' });
    expect(roles).toHaveLength(1);
    expect((roles[0] as HTMLButtonElement).disabled).toBe(false);
    expect(roles[0].querySelector('svg')?.getAttribute('data-icon')).toBe('roles');
    expect(roles[0].querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(result.getByRole('heading', { level: 1 }).textContent).toBe('Home');
    expect(result.getByText(descriptions.Home)).toBeTruthy();
  });

  it('changes only main content and retains the workspace header', () => {
    const result = render(<WorkspaceShell workspace={workspace} onSwitchWorkspace={vi.fn()} />);
    const main = result.getByRole('main');
    const name = result.getByText(workspace.name);
    const path = result.getByText(workspace.path);

    for (const label of ['Teams', 'Agents', 'Roles', 'Boards', 'Configuration'] as const) {
      const button = result.getByRole('button', { name: label });
      button.focus();
      fireEvent.click(button);
      expect(result.getByRole('main')).toBe(main);
      expect(result.getByText(workspace.name)).toBe(name);
      expect(result.getByText(workspace.path)).toBe(path);
      expect(result.getByRole('heading', { level: 1 }).textContent).toBe(label);
      if (label === 'Teams' || label === 'Agents' || label === 'Roles') expect(main.querySelector(`[data-section="${label.toLowerCase()}"]`)).toBeTruthy();
      else expect(result.getByText(descriptions[label])).toBeTruthy();
      expect(currentButtons(result.container)).toEqual([button]);
      expect(document.activeElement).toBe(button);
    }
  });

  it('keeps built-in placeholders free of mutation controls', () => {
    const result = render(<WorkspaceShell workspace={workspace} onSwitchWorkspace={vi.fn()} />);
    const main = result.getByRole('main');

    for (const label of ['Home', 'Boards', 'Configuration']) {
      fireEvent.click(result.getByRole('button', { name: label }));
      expect(main.querySelectorAll('button, a, input, select, textarea, form')).toHaveLength(0);
      expect(main.querySelector('[data-section]')?.getAttribute('data-section')).toBe(label.toLowerCase());
    }
  });

  it('activates enabled navigation with Enter and Space', () => {
    const result = render(<WorkspaceShell workspace={workspace} onSwitchWorkspace={vi.fn()} />);
    const teams = result.getByRole('button', { name: 'Teams' });
    teams.focus();
    expect(fireEvent.keyDown(teams, { key: 'Enter' })).toBe(false);
    expect(result.getByRole('heading', { level: 1 }).textContent).toBe('Teams');
    expect(currentButtons(result.container)).toEqual([teams]);
    expect(document.activeElement).toBe(teams);

    const boards = result.getByRole('button', { name: 'Boards' });
    boards.focus();
    expect(fireEvent.keyDown(boards, { key: ' ' })).toBe(false);
    expect(result.getByRole('heading', { level: 1 }).textContent).toBe('Boards');
    expect(currentButtons(result.container)).toEqual([boards]);
    expect(document.activeElement).toBe(boards);
  });

  it('does not activate a disabled item', () => {
    const items: readonly NavItem[] = NAV_ITEMS.map((item) =>
      item.id === 'teams' ? { ...item, disabled: true } : item,
    );
    const result = render(<WorkspaceShell workspace={workspace} items={items} onSwitchWorkspace={vi.fn()} />);
    const teams = result.getByRole('button', { name: 'Teams' }) as HTMLButtonElement;

    fireEvent.click(teams);
    fireEvent.keyDown(teams, { key: 'Enter' });
    fireEvent.keyDown(teams, { key: ' ' });

    expect(teams.disabled).toBe(true);
    expect(result.getByRole('heading', { level: 1 }).textContent).toBe('Home');
    expect(currentButtons(result.container)).toEqual([result.getByRole('button', { name: 'Home' })]);
  });

  it('keeps markup-like workspace identity as literal text', () => {
    const unusual = { ...workspace, name: '<img src=x onerror=alert(1)>', path: '<script>bad()</script>' };
    const result = render(<WorkspaceShell workspace={unusual} onSwitchWorkspace={vi.fn()} />);

    expect(result.getByText(unusual.name).getAttribute('title')).toBe(unusual.name);
    expect(result.getByText(unusual.path).getAttribute('title')).toBe(unusual.path);
    expect(result.container.querySelector('img, script')).toBeNull();
  });

  it('uses a generic placeholder for injected items and preserves null overrides', () => {
    const items = [...NAV_ITEMS, { id: 'reports', label: 'Reports' }];
    const result = render(
      <WorkspaceShell workspace={workspace} items={items} onSwitchWorkspace={vi.fn()} />,
    );
    fireEvent.click(result.getByRole('button', { name: 'Reports' }));
    expect(result.getByRole('heading', { level: 1 }).textContent).toBe('Reports');
    expect(result.getByText('Not available yet.')).toBeTruthy();

    result.rerender(
      <WorkspaceShell
        workspace={workspace}
        items={items}
        onSwitchWorkspace={vi.fn()}
        renderSection={() => null}
      />,
    );
    expect(result.queryByRole('heading', { level: 1 })).toBeNull();
    expect(result.queryByText('Not available yet.')).toBeNull();
  });

  it('ignores guarded navigation to a disabled item', () => {
    const items: readonly NavItem[] = NAV_ITEMS.map((item) =>
      item.id === 'teams' ? { ...item, disabled: true } : item,
    );
    const result = render(
      <WorkspaceShell
        workspace={workspace}
        items={items}
        onSwitchWorkspace={vi.fn()}
        renderSection={(sectionId, navigate) => sectionId === 'home' ? (
          <>
            <SectionPlaceholder
              sectionId="home"
              title="Home"
              description={descriptions.Home}
            />
            <button type="button" onClick={() => navigate('teams')}>Try disabled Teams</button>
          </>
        ) : undefined}
      />,
    );

    fireEvent.click(result.getByRole('button', { name: 'Try disabled Teams' }));
    expect(result.getByRole('heading', { level: 1 }).textContent).toBe('Home');
    expect(result.getByText(descriptions.Home)).toBeTruthy();
    expect(result.container.querySelector('[data-section="home"]')).toBeTruthy();
    expect((result.getByRole('button', { name: 'Teams' }) as HTMLButtonElement).disabled).toBe(true);
    expect(currentButtons(result.container)).toEqual([result.getByRole('button', { name: 'Home' })]);
  });

  it('renders an injected navigation item without layout changes', () => {
    const items = [...NAV_ITEMS, { id: 'reports', label: 'Reports' }];
    const result = render(
      <WorkspaceShell
        workspace={workspace}
        items={items}
        onSwitchWorkspace={vi.fn()}
        renderSection={(sectionId) => sectionId === 'reports' ? <h1>Reports</h1> : undefined}
      />,
    );
    const nav = result.getByRole('navigation', { name: 'Workspace' });
    const main = result.getByRole('main');
    const reports = within(nav).getByRole('button', { name: 'Reports' });
    fireEvent.click(reports);

    expect(result.getByRole('navigation', { name: 'Workspace' })).toBe(nav);
    expect(result.getByRole('main')).toBe(main);
    expect(result.getByRole('heading', { level: 1 }).textContent).toBe('Reports');
    expect(currentButtons(result.container)).toEqual([reports]);
  });

  it('uses renderSection and guarded navigate', () => {
    const result = render(
      <WorkspaceShell
        workspace={workspace}
        onSwitchWorkspace={vi.fn()}
        renderSection={(sectionId, navigate) => sectionId === 'home' || sectionId === 'teams' ? (
          <section>
            <h1>{sectionId === 'home' ? 'Custom Home' : 'Teams'}</h1>
            <button type="button" onClick={() => navigate('teams')}>Go to Teams</button>
            <button type="button" onClick={() => navigate('missing')}>Go missing</button>
          </section>
        ) : undefined}
      />,
    );

    fireEvent.click(result.getByRole('button', { name: 'Go to Teams' }));
    expect(result.getByRole('heading', { level: 1 }).textContent).toBe('Teams');
    const teams = result.getByRole('button', { name: 'Teams' });
    expect(currentButtons(result.container)).toEqual([teams]);

    fireEvent.click(result.getByRole('button', { name: 'Go missing' }));
    expect(result.getByRole('heading', { level: 1 }).textContent).toBe('Teams');
    expect(currentButtons(result.container)).toEqual([teams]);
  });

  it('resets to Home only when workspace id changes', async () => {
    const result = render(<WorkspaceShell workspace={workspace} onSwitchWorkspace={vi.fn()} />);
    result.getByRole('button', { name: 'Agents' }).focus();
    await userEvent.keyboard('{Enter}');
    expect(currentButtons(result.container)).toEqual([result.getByRole('button', { name: 'Agents' })]);
    expect(result.getAllByRole('main')).toHaveLength(1);
    expect(result.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    result.rerender(
      <WorkspaceShell workspace={{ ...workspace, name: 'Changed name' }} onSwitchWorkspace={vi.fn()} />,
    );
    expect(result.getByRole('heading', { level: 1 }).textContent).toBe('Agents');

    result.rerender(
      <WorkspaceShell workspace={{ ...workspace, id: 'b', name: 'Workspace B' }} onSwitchWorkspace={vi.fn()} />,
    );
    await waitFor(() => expect(result.getByRole('heading', { level: 1 }).textContent).toBe('Home'));
    expect(currentButtons(result.container)).toEqual([result.getByRole('button', { name: 'Home' })]);
  });

  it('opens_roles_by_mouse_and_keyboard_marks_it_current_and_resets_home_on_workspace_change', async () => {
    const result = render(<WorkspaceShell workspace={workspace} onSwitchWorkspace={vi.fn()} />);
    fireEvent.click(result.getByRole('button', { name: 'Roles' }));
    expect(currentButtons(result.container)).toEqual([result.getByRole('button', { name: 'Roles' })]);
    fireEvent.click(result.getByRole('button', { name: 'Home' }));
    result.getByRole('button', { name: 'Roles' }).focus();
    await userEvent.keyboard('{Enter}');
    expect(currentButtons(result.container)).toEqual([result.getByRole('button', { name: 'Roles' })]);
    await waitFor(() => expect(result.container.querySelector('[data-section="roles"]')).toBeTruthy());
    expect(result.getAllByRole('main')).toHaveLength(1);
    expect(result.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(result.getByRole('heading', { level: 1 }).textContent).toBe('Roles');
    expect(result.getByRole('main').querySelector('main')).toBeNull();
    result.rerender(<WorkspaceShell workspace={{ ...workspace, id: 'b', name: 'Workspace B' }} onSwitchWorkspace={vi.fn()} />);
    await waitFor(() => expect(result.getByRole('heading', { level: 1 }).textContent).toBe('Home'));
    expect(currentButtons(result.container)).toEqual([result.getByRole('button', { name: 'Home' })]);
  });

  it('Switch workspace calls only its callback', () => {
    const onSwitchWorkspace = vi.fn();
    const result = render(<WorkspaceShell workspace={workspace} onSwitchWorkspace={onSwitchWorkspace} />);
    fireEvent.click(result.getByRole('button', { name: 'Switch workspace' }));
    expect(onSwitchWorkspace).toHaveBeenCalledTimes(1);
    expect(result.getByRole('heading', { level: 1 }).textContent).toBe('Home');
    expect(currentButtons(result.container)).toEqual([result.getByRole('button', { name: 'Home' })]);
  });

  it('renders brand, workspace label and selector with full accessible text', () => {
    const result = render(<WorkspaceShell workspace={workspace} onSwitchWorkspace={vi.fn()} />);
    const sidebar = result.getByRole('complementary', { name: 'Workspace sidebar' });
    expect(within(sidebar).getByText('Agent Studio')).toBeTruthy();
    expect(within(sidebar).getByText('Workspace')).toBeTruthy();
    expect(result.getByRole('button', {
      name: 'Current workspace: A very long workspace name (/home/me/a/very/long/path). Choose another workspace',
    })).toBeTruthy();
    expect(result.container.querySelector('.workspace-name')?.getAttribute('title')).toBe(workspace.name);
    expect(result.container.querySelector('.workspace-path')?.getAttribute('title')).toBe(workspace.path);
  });

  it('workspace selector calls only onSwitchWorkspace', () => {
    const onSwitchWorkspace = vi.fn();
    const result = render(<WorkspaceShell workspace={workspace} onSwitchWorkspace={onSwitchWorkspace} />);
    fireEvent.click(result.container.querySelector('.workspace-selector')!);
    expect(onSwitchWorkspace).toHaveBeenCalledTimes(1);
    expect(result.getByRole('heading', { level: 1 }).textContent).toBe('Home');
    expect(currentButtons(result.container)).toEqual([result.getByRole('button', { name: 'Home' })]);
  });

  it('nav buttons show an aria-hidden icon and their label', () => {
    const items: NavItem[] = [...NAV_ITEMS, { id: 'reports', label: 'Reports' }];
    const result = render(<WorkspaceShell workspace={workspace} onSwitchWorkspace={vi.fn()} items={items} />);
    const buttons = result.container.querySelectorAll('nav button.nav-item');
    expect(buttons).toHaveLength(7);
    buttons.forEach((button, index) => {
      expect(button.querySelector('svg.shell-icon')?.getAttribute('aria-hidden')).toBe('true');
      expect(button.textContent).toBe(items[index].label);
    });
  });

  it('sidebar controls are native buttons in visual order with no tabindex', () => {
    const result = render(<WorkspaceShell workspace={workspace} onSwitchWorkspace={vi.fn()} />);
    const buttons = [...result.container.querySelectorAll('aside button')] as HTMLButtonElement[];
    expect(buttons).toHaveLength(9);
    expect(buttons[0].className).toContain('workspace-selector');
    expect(buttons.slice(1, 8).map((button) => button.textContent)).toEqual(['Home', 'Teams', 'New team', 'Agents', 'Roles', 'Boards', 'Configuration']);
    expect(buttons[8].className).toContain('switch-workspace');
    for (const button of buttons) {
      expect(button.tagName).toBe('BUTTON');
      expect(button.type).toBe('button');
      expect(button.getAttribute('tabindex')).toBeNull();
    }
  });

  it('Switch workspace is the last sidebar control', () => {
    const result = render(<WorkspaceShell workspace={workspace} onSwitchWorkspace={vi.fn()} />);
    const buttons = result.container.querySelectorAll('aside button');
    const last = buttons[buttons.length - 1];
    expect(result.getByRole('button', { name: 'Switch workspace' })).toBe(last);
    expect(last.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
  });

  it('keeps one main, the Workspace nav and the sidebar landmark', () => {
    const result = render(<WorkspaceShell workspace={workspace} onSwitchWorkspace={vi.fn()} />);
    expect(result.getAllByRole('main')).toHaveLength(1);
    expect(result.getByRole('navigation', { name: 'Workspace' })).toBeTruthy();
    expect(result.getByRole('complementary', { name: 'Workspace sidebar' })).toBeTruthy();
  });

  function deepLinkShell(ws: Workspace = workspace) {
    const fake = fakeManagement({
      overview: [{ ok: true, data: overviewFixture([team({ members: [member({ role: 'qa-b' })] })]) }],
      roles: [{ ok: true, data: rolesFixture({ items: [roleItem('qa-a', { name: 'QA' }), roleItem('qa-b', { name: 'QA' })] }) }],
    });
    const ui = (w: Workspace) => <WorkspaceShellComponent workspace={w} dashboard={dashboard} management={fake.api} connection={connection} onSwitchWorkspace={vi.fn()} />;
    return { ui, view: render(ui(ws)) };
  }

  it.skip('direct_roles_navigation_clears_requested_role', async () => {
    const { view } = deepLinkShell();
    fireEvent.click(view.getByRole('button', { name: 'Teams' }));
    fireEvent.click(await view.findByRole('tab', { name: 'Members' }));
    fireEvent.click(view.container.querySelector<HTMLButtonElement>('.teams-member-row')!);
    fireEvent.click(await view.findByRole('button', { name: 'View QA in Roles' }));
    await waitFor(() => expect(view.container.querySelector('[data-section="roles"]')).toBeTruthy());
    await waitFor(() => expect(view.container.querySelector('[aria-current="true"]')?.lastElementChild?.textContent).toBe('qa-b'));
    fireEvent.click(view.getByRole('button', { name: 'Teams' }));
    fireEvent.click(view.getByRole('button', { name: 'Roles' }));
    await waitFor(() => expect(view.container.querySelector('[aria-current="true"]')?.lastElementChild?.textContent).toBe('qa-a'));
    expect(view.queryByText(/is unavailable in this workspace/)).toBeNull();
  });

  it.skip('workspace_change_clears_section_and_role_request', async () => {
    const { view, ui } = deepLinkShell();
    fireEvent.click(view.getByRole('button', { name: 'Teams' }));
    fireEvent.click(await view.findByRole('tab', { name: 'Members' }));
    fireEvent.click(view.container.querySelector<HTMLButtonElement>('.teams-member-row')!);
    fireEvent.click(await view.findByRole('button', { name: 'View QA in Roles' }));
    await waitFor(() => expect(view.container.querySelector('[data-section="roles"]')).toBeTruthy());
    view.rerender(ui({ ...workspace, id: 'b', name: 'Workspace B' }));
    await waitFor(() => expect(view.container.querySelector('[data-section="roles"]')).toBeNull());
    expect(view.getByRole('button', { name: 'Home' }).getAttribute('aria-current')).toBe('page');
    fireEvent.click(view.getByRole('button', { name: 'Roles' }));
    await waitFor(() => expect(view.container.querySelector('[aria-current="true"]')?.lastElementChild?.textContent).toBe('qa-a'));
  });
  it.skip('teams_view_state_resets_when_section_or_workspace_changes', async () => {
    const fake = fakeManagement({ overview: [{ ok: true, data: twoTeams() }] });
    const ui = (w: Workspace) => <WorkspaceShellComponent workspace={w} dashboard={dashboard} management={fake.api} connection={connection} onSwitchWorkspace={vi.fn()} />;
    const view = render(ui(workspace));
    const pressed = (name: RegExp) => (view.getByRole('button', { name }).getAttribute('aria-current') === 'page' ? 'true' : 'false');
    const selected = () => view.getAllByRole('tab').filter(t => t.getAttribute('aria-selected') === 'true').map(t => t.textContent);
    fireEvent.click(view.getByRole('button', { name: 'Teams' }));
    fireEvent.click(await view.findByRole('button', { name: /^Open Release Team,/ }));
    fireEvent.click(view.getByRole('tab', { name: 'Members' }));
    expect(pressed(/^Open Release Team,/)).toBe('true');
    fireEvent.click(view.getByRole('button', { name: 'Agents' }));
    fireEvent.click(view.getByRole('button', { name: 'Teams' }));
    await waitFor(() => expect(view.getByRole('heading', { level: 2, name: 'Release Team' })).toBeTruthy());
    expect(pressed(/^Open Release Team,/)).toBe('false');
    expect(selected()).toEqual(['Overview']);
    fireEvent.click(view.getByRole('tab', { name: 'Members' }));
    view.rerender(ui({ ...workspace, id: 'b', name: 'Workspace B' }));
    await waitFor(() => expect(view.getByRole('button', { name: 'Home' }).getAttribute('aria-current')).toBe('page'));
    fireEvent.click(view.getByRole('button', { name: 'Teams' }));
    await waitFor(() => expect(view.getByRole('heading', { level: 2, name: 'Dev Team' })).toBeTruthy());
    expect(selected()).toEqual(['Overview']);
    expect(fake.overview).toHaveBeenLastCalledWith('b');
  });

  describe('T-082 teams shell behavior', () => {
    const shell = (fake: ReturnType<typeof fakeManagement>, ws: Workspace, conn: ConnectionStatus = connection) =>
      <WorkspaceShellComponent workspace={ws} dashboard={dashboard} management={fake.api} connection={conn} onSwitchWorkspace={vi.fn()} />;
    const structure = (view: ReturnType<typeof render>) => {
      expect(view.getAllByRole('main')).toHaveLength(1);
      expect(view.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    };

    it.skip('teams_focus_and_selection_reset_on_workspace_switch', async () => {
      const other = overviewFixture([team({ id: 'b-team', name: 'Only B', members: [member({ memberId: 'bee', name: 'bee' })] })]);
      const overview = vi.fn(async (id: string) => ({ ok: true as const, data: id === 'b' ? other : twoTeams() }));
      const fake = fakeManagement({ calls: { overview } });
      const view = render(shell(fake, workspace));
      fireEvent.click(view.getByRole('button', { name: 'Teams' }));
      fireEvent.click(await view.findByRole('tab', { name: 'Members' }));
      fireEvent.click(view.container.querySelector<HTMLButtonElement>('.teams-member-row')!);
      await waitFor(() => expect(document.activeElement?.id).toBe('teams-member-detail-title'));
      expect(overview).toHaveBeenLastCalledWith('a');
      view.rerender(shell(fake, { ...workspace, id: 'b', name: 'Workspace B' }));
      await waitFor(() => expect(view.getByRole('button', { name: 'Home' }).getAttribute('aria-current')).toBe('page'));
      expect(view.queryByText('Dev Team')).toBeNull();
      fireEvent.click(view.getByRole('button', { name: 'Teams' }));
      await view.findByRole('button', { name: /^Open Only B,/ });
      expect(overview).toHaveBeenLastCalledWith('b');
      structure(view);
      expect(view.getByRole('heading', { level: 1 }).textContent).toBe('Teams');
      expect(view.queryByText(/Dev Team|Release Team/)).toBeNull();
      expect(view.getAllByRole('tab').filter(t => t.getAttribute('aria-selected') === 'true').map(t => t.textContent)).toEqual(['Overview']);
      expect(view.queryByRole('region', { name: 'dev' })).toBeNull();
      const h2 = view.getAllByRole('heading', { level: 2 }).map(h => h.textContent);
      expect(h2).toContain('Only B');
      expect(view.queryByRole('region', { name: 'Workspace teams' })).toBeNull();
      expect(view.queryByRole('list', { name: 'Choose a team' })).toBeNull();
    });

    it('home_agents_roles_and_teams_navigation_remain_keyboard_reachable', async () => {
      const fake = fakeManagement({ overview: [{ ok: true, data: twoTeams() }] });
      const view = render(shell(fake, workspace));
      for (const name of ['Agents', 'Roles', 'Teams', 'Home']) {
        const nav = view.getByRole('button', { name });
        expect(nav.tagName).toBe('BUTTON'); expect(nav.hasAttribute('tabindex')).toBe(false);
        nav.focus();
        await userEvent.keyboard('{Enter}');
        if (name === 'Teams') await waitFor(() => expect(currentButtons(view.container)).toHaveLength(1));
        else await waitFor(() => expect(view.getByRole('button', { name }).getAttribute('aria-current')).toBe('page'));
        expect(currentButtons(view.container)).toHaveLength(1);
        structure(view);
        expect(document.activeElement).toBe(view.getByRole('button', { name }));
      }
      view.getByRole('button', { name: 'Teams' }).focus();
      await userEvent.keyboard(' ');
      await view.findByRole('tab', { name: 'Overview' });
      structure(view);
      expect(view.getByRole('heading', { level: 1 }).textContent).toBe('Teams');
    });

    it.skip('teams_connection_recovery_does_not_duplicate_management_reads', async () => {
      const fake = fakeManagement({ overview: [{ ok: true, data: twoTeams() }] });
      const reads = () => [fake.overview, fake.agents, fake.boardSettings, fake.roles].map(f => f.mock.calls.length);
      const view = render(shell(fake, workspace));
      fireEvent.click(view.getByRole('button', { name: 'Teams' }));
      await view.findByRole('tab', { name: 'Members' });
      fireEvent.click(view.getByRole('tab', { name: 'Members' }));
      const before = reads();
      expect(before).toEqual([1, 1, 1, 1]);
      view.rerender(shell(fake, workspace, connectionFixture('lost')));
      await waitFor(() => expect(view.getByText('Connection lost. Showing previously loaded data.')).toBeTruthy());
      expect(reads()).toEqual(before);
      view.rerender(shell(fake, workspace, connectionFixture('connected')));
      await waitFor(() => expect(reads()).toEqual([2, 2, 2, 2]));
      view.rerender(shell(fake, workspace, connectionFixture('connected')));
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(reads()).toEqual([2, 2, 2, 2]);
      expect(fake.overview.mock.calls.every(c => c[0] === 'a')).toBe(true);
      expect(view.getByRole('tab', { name: 'Members' }).getAttribute('aria-selected')).toBe('true');
      structure(view);
    });
  });
});

describe('T-084 sidebar team navigation', () => {
  const ui = (fake: ReturnType<typeof fakeManagement>, ws: Workspace = workspace, conn: ConnectionStatus = connection) => (
    <WorkspaceShellComponent workspace={ws} dashboard={dashboard} management={fake.api} connection={conn} onSwitchWorkspace={vi.fn()} />
  );
  const settle = () => act(async () => {});
  const ok = <T,>(data: T) => ({ ok: true as const, data });
  const fail = (message: string) => ({ ok: false as const, error: { code: 'READ_FAILED', message, retryable: true } });
  const rows = (view: ReturnType<typeof render>) => view.queryAllByRole('listitem').flatMap((li) => Array.from(li.querySelectorAll<HTMLButtonElement>('.team-nav-item')));
  const row = (view: ReturnType<typeof render>, name: string) => view.getByRole('button', { name: new RegExp(`^Open ${name},`) });
  const teamsButton = (view: ReturnType<typeof render>) => view.getByRole('button', { name: 'Teams' });
  const tabs = (view: ReturnType<typeof render>) => view.getAllByRole('tab').filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.textContent);
  const running = (t: ReturnType<typeof team>) => ({ ...t, runtime: { state: 'running' as const, teamId: 'live', status: 'running' } });

  it('sidebar_teams_are_loaded_once_and_selecting_child_opens_overview', async () => {
    const fake = fakeManagement();
    const view = render(ui(fake));
    await settle();
    expect(fake.overview).toHaveBeenCalledTimes(1);
    expect(rows(view).map((r) => r.querySelector('.team-nav-label')!.textContent)).toEqual(['Dev Team', 'Release Team']);
    expect(view.getByRole('list', { name: 'Workspace teams' })).toBeTruthy();
    expect(rows(view).every((r) => r.getAttribute('aria-current') === null)).toBe(true);
    fireEvent.click(row(view, 'Release Team'));
    await settle();
    expect(view.getByRole('heading', { level: 1 }).textContent).toBe('Teams');
    expect(view.getByRole('heading', { level: 2, name: 'Release Team' })).toBeTruthy();
    expect(rows(view).filter((r) => r.getAttribute('aria-current') === 'page').map((r) => r.getAttribute('aria-label'))).toEqual(['Open Release Team, Stopped']);
    expect(teamsButton(view).getAttribute('aria-current')).toBeNull();
    expect(currentButtons(view.container)).toHaveLength(1);
    expect(view.queryByRole('list', { name: 'Choose a team' })).toBeNull();
    expect(view.container.querySelector('.teams-card, .teams-layout')).toBeNull();
    expect(fake.overview).toHaveBeenCalledTimes(1);
  });

  it('sidebar_children_are_reachable_by_tab_and_activate_with_enter_and_space', async () => {
    const fake = fakeManagement();
    const view = render(ui(fake));
    await settle();
    teamsButton(view).focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(view.getByRole('button', { name: 'New team' }));
    await userEvent.tab();
    expect(document.activeElement).toBe(row(view, 'Dev Team'));
    await userEvent.tab();
    expect(document.activeElement).toBe(row(view, 'Release Team'));
    await userEvent.keyboard('{Enter}');
    expect(view.getByRole('heading', { level: 2, name: 'Release Team' })).toBeTruthy();
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(row(view, 'Dev Team'));
    await userEvent.keyboard(' ');
    expect(view.getByRole('heading', { level: 2, name: 'Dev Team' })).toBeTruthy();
    expect(fake.overview).toHaveBeenCalledTimes(1);
  });

  it('teams_parent_is_current_until_a_sidebar_child_is_opened', async () => {
    const view = render(ui(fakeManagement()));
    await settle();
    fireEvent.click(teamsButton(view));
    await settle();
    expect(view.getByRole('heading', { level: 2, name: 'Dev Team' })).toBeTruthy();
    expect(teamsButton(view).getAttribute('aria-current')).toBe('page');
    expect(rows(view).every((button) => button.getAttribute('aria-current') === null)).toBe(true);
    fireEvent.click(row(view, 'Release Team'));
    expect(teamsButton(view).getAttribute('aria-current')).toBeNull();
    expect(row(view, 'Release Team').getAttribute('aria-current')).toBe('page');
  });

  it('teams_parent_becomes_current_when_the_selected_child_is_removed_and_list_is_empty', async () => {
    const fake = fakeManagement({ overview: [ok(twoTeams()), ok(overviewFixture([])), ok(twoTeams())] });
    const view = render(ui(fake));
    await settle();
    fireEvent.click(row(view, 'Release Team'));
    fireEvent.click(view.getByRole('button', { name: 'Refresh' }));
    await settle();
    expect(rows(view)).toHaveLength(0);
    expect(teamsButton(view).getAttribute('aria-current')).toBe('page');
    fireEvent.click(view.getByRole('button', { name: 'Refresh' }));
    await settle();
    expect(teamsButton(view).getAttribute('aria-current')).toBe('page');
    expect(rows(view).every((button) => button.getAttribute('aria-current') === null)).toBe(true);
  });

  it('initial_sidebar_error_retry_loads_only_overview_and_selects_real_data', async () => {
    const fake = fakeManagement({ overview: [fail('offline'), ok(twoTeams())] });
    const view = render(ui(fake));
    await settle();
    expect(rows(view)).toHaveLength(0);
    expect(view.getByRole('alert').textContent).toContain('Teams unavailable. offline');
    const before = [fake.agents, fake.roles, fake.boardSettings].map((f) => f.mock.calls.length);
    fireEvent.click(within(view.getByRole('complementary')).getByRole('button', { name: 'Retry teams' }));
    await settle();
    expect(fake.overview).toHaveBeenCalledTimes(2);
    expect([fake.agents, fake.roles, fake.boardSettings].map((f) => f.mock.calls.length)).toEqual(before);
    expect(rows(view)).toHaveLength(2);
    fireEvent.click(row(view, 'Dev Team'));
    await settle();
    expect(row(view, 'Dev Team').getAttribute('aria-current')).toBe('page');
  });

  it.skip('teams_parent_preserves_valid_selection_and_same_child_reopens_overview', async () => {
    const fake = fakeManagement();
    const view = render(ui(fake));
    await settle();
    fireEvent.click(row(view, 'Release Team'));
    await settle();
    fireEvent.click(view.getByRole('tab', { name: 'Routing' }));
    await settle();
    fireEvent.click(view.getByRole('button', { name: 'Home' }));
    await settle();
    fireEvent.click(teamsButton(view));
    await settle();
    expect(view.getByRole('heading', { level: 2, name: 'Release Team' })).toBeTruthy();
    expect(teamsButton(view).getAttribute('aria-current')).toBe('page');
    fireEvent.click(view.getByRole('tab', { name: 'Members' }));
    await settle();
    fireEvent.click(view.container.querySelector<HTMLButtonElement>('.teams-member-row')!);
    await settle();
    expect(view.container.querySelector('#teams-member-detail-title')).toBeTruthy();
    fireEvent.click(row(view, 'Release Team'));
    await settle();
    expect(tabs(view)).toEqual(['Overview']);
    expect(view.container.querySelector('#teams-member-detail-title')).toBeNull();
    expect(document.activeElement).toBe(document.getElementById('teams-detail-title'));
    expect(fake.overview).toHaveBeenCalledTimes(1);
  });

  it.skip('sidebar_selection_survives_reorder_and_falls_back_after_removal', async () => {
    const [releaseTeam, devTeam] = [twoTeams().teams[0]!, twoTeams().teams[1]!];
    const fake = fakeManagement({ overview: [
      ok(twoTeams()),
      ok(overviewFixture([running(releaseTeam), { ...devTeam, runtime: { state: 'stopped', teamId: null, status: null } }])),
      ok(overviewFixture([devTeam])),
    ] });
    const view = render(ui(fake));
    await settle();
    fireEvent.click(row(view, 'Release Team'));
    fireEvent.click(view.getByRole('tab', { name: 'Members' }));
    fireEvent.click(view.getByRole('button', { name: 'Refresh' }));
    await settle();
    expect(rows(view).map((r) => r.querySelector('.team-nav-label')!.textContent)).toEqual(['Release Team', 'Dev Team']);
    expect(row(view, 'Release Team').getAttribute('aria-current')).toBe('page');
    expect(tabs(view)).toEqual(['Members']);
    fireEvent.click(view.getByRole('button', { name: 'Refresh' }));
    await settle();
    expect(rows(view).map((r) => r.querySelector('.team-nav-label')!.textContent)).toEqual(['Dev Team']);
    expect(row(view, 'Dev Team').getAttribute('aria-current')).toBe('page');
    expect(view.getByRole('heading', { level: 2, name: 'Dev Team' })).toBeTruthy();
    expect(tabs(view)).toEqual(['Overview']);
  });

  it('runtime_only_sidebar_selection_survives_reorder_by_runtime_id', async () => {
    const live = team({ id: null as unknown as string, name: 'Live only', definition: { state: 'missing', problems: [] }, runtime: { state: 'running', teamId: 'runtime-1', status: 'running' } });
    const saved = team({ id: 'saved', name: 'Saved team' });
    const reorderedLive = { ...live, runtime: { state: 'stopped' as const, teamId: 'runtime-1', status: 'stopped' } };
    const reorderedSaved = running(saved);
    const fake = fakeManagement({ overview: [ok(overviewFixture([live, saved])), ok(overviewFixture([reorderedLive, reorderedSaved]))] });
    const view = render(ui(fake));
    await settle();
    fireEvent.click(row(view, 'Live only'));
    fireEvent.click(view.getByRole('tab', { name: 'Routing' }));
    fireEvent.click(view.getByRole('button', { name: 'Refresh' }));
    await settle();
    expect(rows(view).map((r) => r.querySelector('.team-nav-label')!.textContent)).toEqual(['Saved team', 'Live only']);
    expect(row(view, 'Live only').getAttribute('aria-current')).toBe('page');
    expect(view.getByRole('heading', { level: 2, name: 'Live only' })).toBeTruthy();
    expect(tabs(view)).toEqual(['Routing']);
  });

  it('partial_truncated_sidebar_rows_with_markup_names_remain_selectable_as_text', async () => {
    const name = '<img src=x onerror=alert(1)>';
    const data = overviewFixture([team({ id: 'untrusted', name })], { partial: true, truncated: true });
    const view = render(ui(fakeManagement({ overview: [ok(data)] })));
    await settle();
    const button = view.getByRole('button', { name: `Open ${name}, Not started` });
    expect(button.querySelector('img')).toBeNull();
    expect(button.textContent).toContain(name);
    expect(view.getByText('Showing the first 1 team. More teams exist in this workspace.')).toBeTruthy();
    expect(view.getByText('Some team navigation data is unavailable.')).toBeTruthy();
    fireEvent.click(button);
    await settle();
    expect(view.getByRole('heading', { level: 2, name })).toBeTruthy();
    expect(button.getAttribute('aria-current')).toBe('page');
  });

  it('sidebar_workspace_switch_clears_old_data_and_selection', async () => {
    const onlyB = overviewFixture([team({ id: 'b-team', name: 'Only B' })]);
    const gateB = deferred<ReturnType<typeof ok<typeof onlyB>>>();
    const overview = vi.fn((id: string) => id === 'b' ? gateB.promise : Promise.resolve(ok(twoTeams())));
    const fake = fakeManagement({ calls: { overview } });
    const view = render(ui(fake));
    await settle();
    fireEvent.click(row(view, 'Release Team'));
    await settle();
    view.rerender(ui(fake, { ...workspace, id: 'b', name: 'Workspace B' }));
    await settle();
    expect(rows(view)).toHaveLength(0);
    expect(view.queryByText(/Dev Team|Release Team/)).toBeNull();
    expect(view.getByText('Loading teams…').getAttribute('role')).toBe('status');
    await act(async () => { gateB.resolve(ok(onlyB)); });
    expect(rows(view).map((r) => r.querySelector('.team-nav-label')!.textContent)).toEqual(['Only B']);
    fireEvent.click(row(view, 'Only B'));
    await settle();
    expect(row(view, 'Only B').getAttribute('aria-current')).toBe('page');
    expect(view.queryByText(/Dev Team|Release Team/)).toBeNull();
  });

  it('sidebar_ignores_a_superseded_workspace_response', async () => {
    const gateA = deferred<ReturnType<typeof ok<ReturnType<typeof twoTeams>>>>();
    const onlyB = overviewFixture([team({ id: 'b-team', name: 'Only B' })]);
    const overview = vi.fn((id: string) => id === 'a' ? gateA.promise : Promise.resolve(ok(onlyB)));
    const fake = fakeManagement({ calls: { overview } });
    const view = render(ui(fake));
    await settle();
    view.rerender(ui(fake, { ...workspace, id: 'b', name: 'Workspace B' }));
    await settle();
    await act(async () => { gateA.resolve(ok(twoTeams())); });
    expect(rows(view).map((r) => r.querySelector('.team-nav-label')!.textContent)).toEqual(['Only B']);
    expect(view.queryByText(/Dev Team|Release Team/)).toBeNull();
  });

  it('sidebar_ignores_a_superseded_workspace_error', async () => {
    const gateA = deferred<ReturnType<typeof fail>>();
    const onlyB = overviewFixture([team({ id: 'b-team', name: 'Only B' })]);
    const overview = vi.fn((id: string) => id === 'a' ? gateA.promise : Promise.resolve(ok(onlyB)));
    const fake = fakeManagement({ calls: { overview } });
    const view = render(ui(fake));
    await settle();
    view.rerender(ui(fake, { ...workspace, id: 'b' }));
    await settle();
    fireEvent.click(row(view, 'Only B'));
    await settle();
    await act(async () => { gateA.resolve(fail('Old workspace error')); });
    expect(view.queryByText(/Old workspace error/)).toBeNull();
    expect(rows(view).map((r) => r.querySelector('.team-nav-label')!.textContent)).toEqual(['Only B']);
    expect(row(view, 'Only B').getAttribute('aria-current')).toBe('page');
  });

  it('sidebar_retains_stale_rows_and_disables_teams_writes_on_error_or_disconnect', async () => {
    const fake = fakeManagement({ overview: [ok(twoTeams()), fail('overview unreadable'), ok(twoTeams())] });
    const view = render(ui(fake));
    await settle();
    fireEvent.click(teamsButton(view));
    await settle();
    fireEvent.click(view.getByRole('button', { name: 'Refresh' }));
    await settle();
    expect(view.getByText('Team list unavailable. Showing previously loaded teams. overview unreadable')).toBeTruthy();
    expect(rows(view)).toHaveLength(2);
    expect((view.getByRole('button', { name: 'New team' }) as HTMLButtonElement).getAttribute('aria-disabled')).toBe('true');
    expect((view.getByRole('button', { name: 'Rename team' }) as HTMLButtonElement).disabled).toBe(true);
    const before = [fake.agents, fake.roles, fake.boardSettings].map((f) => f.mock.calls.length);
    fireEvent.click(within(view.getByRole('complementary')).getByRole('button', { name: 'Retry teams' }));
    await settle();
    expect(fake.overview).toHaveBeenCalledTimes(3);
    expect([fake.agents, fake.roles, fake.boardSettings].map((f) => f.mock.calls.length)).toEqual(before);
    expect(view.queryByText(/Team list unavailable/)).toBeNull();
    view.rerender(ui(fake, workspace, connectionFixture('lost')));
    await settle();
    expect(view.getByText('Connection lost. Showing previously loaded teams.')).toBeTruthy();
    expect(rows(view)).toHaveLength(2);
    expect((view.getByRole('button', { name: 'New team' }) as HTMLButtonElement).disabled).toBe(true);
    expect((view.getByRole('button', { name: 'Rename team' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('sidebar_loading_empty_partial_truncated_and_long_names_are_truthful', async () => {
    const gate = deferred<ReturnType<typeof ok<ReturnType<typeof twoTeams>>>>();
    const loading = render(ui(fakeManagement({ calls: { overview: () => gate.promise } })));
    await settle();
    expect(loading.getByText('Loading teams…').getAttribute('role')).toBe('status');
    expect(rows(loading)).toHaveLength(0);
    loading.unmount();

    const failed = render(ui(fakeManagement({ overview: [fail('down')] })));
    await settle();
    expect(failed.getByText('Teams unavailable. down').getAttribute('role')).toBe('alert');
    expect(within(failed.getByRole('complementary')).getByRole('button', { name: 'Retry teams' })).toBeTruthy();
    failed.unmount();

    const empty = render(ui(fakeManagement({ overview: [ok(overviewFixture([]))] })));
    await settle();
    expect(empty.getByText('No teams defined.')).toBeTruthy();
    expect(empty.queryByRole('list', { name: 'Workspace teams' })).toBeNull();
    fireEvent.click(teamsButton(empty));
    await settle();
    expect(teamsButton(empty).getAttribute('aria-current')).toBe('page');
    empty.unmount();

    const longName = `Long ${'x'.repeat(200)}`;
    const incomplete = render(ui(fakeManagement({ overview: [ok(overviewFixture([
      team({ id: 'long', name: longName, definition: { state: 'unreadable', problems: [] } as never, runtime: { state: 'unavailable', teamId: null, status: null } }),
    ], { partial: true, truncated: true }))] })));
    await settle();
    const longRow = rows(incomplete)[0]!;
    expect(longRow.getAttribute('aria-label')).toBe(`Open ${longName}, Runtime unavailable, Definition unreadable`);
    expect(longRow.querySelector('.team-nav-label')!.textContent).toBe(longName);
    expect(longRow.getAttribute('title')).toBe(longName);
    expect(incomplete.getByText('Showing the first 1 team. More teams exist in this workspace.')).toBeTruthy();
    expect(incomplete.getByText('Some team navigation data is unavailable.')).toBeTruthy();
  });

  it.each([
    { roles: { state: 'missing' as const, message: 'Roles unavailable' } },
    { catalog: { state: 'missing' as const, message: 'Catalog unavailable' } },
    { runtimeState: { available: false, error: { code: 'DOWN', message: 'Runtime unavailable', retryable: true } } },
  ])('partial_sidebar_notice_remains_visible_with_other_overview_errors', async (overrides) => {
    const data = overviewFixture([team()], { ...overrides, partial: true });
    const view = render(ui(fakeManagement({ overview: [ok(data)] })));
    await settle();
    expect(row(view, 'Dev Team')).toBeTruthy();
    expect(view.getByText('Some team navigation data is unavailable.')).toBeTruthy();
  });

  it('refreshing_with_retained_rows_says_so_without_hiding_them', async () => {
    const gate = deferred<ReturnType<typeof ok<ReturnType<typeof twoTeams>>>>();
    const overview = vi.fn().mockResolvedValueOnce(ok(twoTeams())).mockReturnValueOnce(gate.promise);
    const view = render(ui(fakeManagement({ calls: { overview } })));
    await settle();
    fireEvent.click(teamsButton(view));
    fireEvent.click(view.getByRole('button', { name: 'Refresh' }));
    await settle();
    expect(view.getByText('Refreshing teams… Showing previously loaded teams.')).toBeTruthy();
    expect(rows(view)).toHaveLength(2);
    await act(async () => { gate.resolve(ok(twoTeams())); });
    expect(view.queryByText(/^Refreshing teams… Showing previously loaded teams/)).toBeNull();
  });

  it('removed_focused_team_moves_focus_to_fallback_or_parent', async () => {
    const [releaseTeam, devTeam] = [twoTeams().teams[0]!, twoTeams().teams[1]!];
    const fake = fakeManagement({ overview: [
      ok(twoTeams()),
      ok(overviewFixture([running(releaseTeam), { ...devTeam, runtime: { state: 'stopped', teamId: null, status: null } }])),
      ok(overviewFixture([devTeam])),
      ok(overviewFixture([])),
    ] });
    const view = render(ui(fake, workspace, connectionFixture('connecting')));
    await settle();
    const reconnect = async () => {
      view.rerender(ui(fake, workspace, connectionFixture('lost')));
      view.rerender(ui(fake, workspace, connectionFixture('connected')));
      await settle();
    };
    row(view, 'Release Team').focus();
    await reconnect();
    expect(rows(view).map((r) => r.querySelector('.team-nav-label')!.textContent)).toEqual(['Release Team', 'Dev Team']);
    expect(document.activeElement).toBe(row(view, 'Release Team'));
    await reconnect();
    expect(rows(view).map((r) => r.querySelector('.team-nav-label')!.textContent)).toEqual(['Dev Team']);
    expect(document.activeElement).toBe(row(view, 'Dev Team'));
    await reconnect();
    expect(rows(view)).toHaveLength(0);
    expect(document.activeElement).toBe(teamsButton(view));
  });

  it('removing_an_unfocused_team_does_not_move_focus', async () => {
    const fake = fakeManagement({ overview: [ok(twoTeams()), ok(overviewFixture([twoTeams().teams[1]!]))] });
    const view = render(ui(fake, workspace, connectionFixture('connecting')));
    await settle();
    view.getByRole('button', { name: 'Agents' }).focus();
    view.rerender(ui(fake, workspace, connectionFixture('connected')));
    await settle();
    expect(rows(view)).toHaveLength(1);
    expect(document.activeElement).toBe(view.getByRole('button', { name: 'Agents' }));
  });

  it('reconnect_refreshes_overview_once_when_teams_is_closed_and_once_when_open', async () => {
    const reads = (fake: ReturnType<typeof fakeManagement>) => [fake.overview, fake.agents, fake.boardSettings, fake.roles].map((f) => f.mock.calls.length);
    const closed = fakeManagement();
    const first = render(ui(closed));
    await settle();
    expect(reads(closed)).toEqual([1, 0, 0, 0]);
    first.rerender(ui(closed, workspace, connectionFixture('lost')));
    await settle();
    expect(reads(closed)).toEqual([1, 0, 0, 0]);
    first.rerender(ui(closed, workspace, connectionFixture('connected')));
    await settle();
    expect(reads(closed)).toEqual([2, 0, 0, 0]);
    first.unmount();

    const open = fakeManagement();
    const second = render(ui(open));
    fireEvent.click(teamsButton(second));
    await settle();
    expect(reads(open)).toEqual([1, 1, 1, 1]);
    second.rerender(ui(open, workspace, connectionFixture('lost')));
    await settle();
    second.rerender(ui(open, workspace, connectionFixture('connected')));
    await settle();
    expect(reads(open)).toEqual([2, 2, 2, 2]);
  });

  it('nested_teams_are_not_rendered_when_the_teams_item_is_disabled_or_absent', async () => {
    const fake = fakeManagement();
    const disabled = render(
      <WorkspaceShellComponent workspace={workspace} dashboard={dashboard} management={fake.api} connection={connection} onSwitchWorkspace={vi.fn()}
        items={NAV_ITEMS.map((item) => item.id === 'teams' ? { ...item, disabled: true } : item)} />,
    );
    await settle();
    expect(disabled.container.querySelector('.team-nav')).toBeNull();
    disabled.unmount();
    const absent = render(
      <WorkspaceShellComponent workspace={workspace} dashboard={dashboard} management={fake.api} connection={connection} onSwitchWorkspace={vi.fn()}
        items={NAV_ITEMS.filter((item) => item.id !== 'teams')} />,
    );
    await settle();
    expect(absent.container.querySelector('.team-nav')).toBeNull();
  });
});

describe('T-085 sidebar team creation', () => {
  const other: Workspace = { id: 'ws-other', name: 'Other', path: '/work/other', missing: false, exists: true };
  const ui = (fake: ReturnType<typeof fakeManagement>, ws: Workspace = workspace, conn: ConnectionStatus = connection) => (
    <WorkspaceShellComponent workspace={ws} dashboard={dashboard} management={fake.api} connection={conn} onSwitchWorkspace={vi.fn()} />
  );
  const settle = () => act(async () => {});
  const ok = <T,>(data: T) => ({ ok: true as const, data });
  const created = (id = 'qa-team', name = 'QA Team') => ok({ team: teamDefinition({ id, name }), problems: [] });
  const withQa = (id = 'qa-team') => overviewFixture([...twoTeams().teams, team({ id, name: 'QA Team', members: [] })]);
  const newTeam = (view: ReturnType<typeof render>) => view.getByRole('button', { name: 'New team' }) as HTMLButtonElement;
  const row = (view: ReturnType<typeof render>, name: string) => view.getByRole('button', { name: new RegExp(`^Open ${name},`) });
  const dialog = (view: ReturnType<typeof render>) => view.queryByRole('dialog', { name: 'New team' });
  const create = async (view: ReturnType<typeof render>, name = 'QA Team') => {
    fireEvent.click(newTeam(view));
    await settle();
    fireEvent.change(view.getByLabelText('Team name'), { target: { value: name } });
    fireEvent.click(view.getByRole('button', { name: 'Create team' }));
    await settle();
  };

  it('sidebar_exposes_exactly_one_new_team_action_for_empty_and_populated_data', async () => {
    for (const data of [twoTeams(), overviewFixture([])]) {
      const view = render(ui(fakeManagement({ overview: [ok(data)] })));
      await settle();
      expect(view.getAllByRole('button', { name: 'New team' })).toHaveLength(1);
      expect(newTeam(view).closest('.team-nav')).not.toBeNull();
      expect(newTeam(view).disabled).toBe(false);
      fireEvent.click(view.getByRole('button', { name: 'Teams' }));
      await settle();
      expect(view.getAllByRole('button', { name: 'New team' })).toHaveLength(1);
      expect(view.container.querySelector('main button.teams-new-button, main .dashboard-actions')?.textContent ?? '').not.toContain('New team');
      view.unmount();
    }
  });

  it('sidebar_new_team_is_disabled_for_loading_stale_disconnected_and_pending_states', async () => {
    const gate = deferred<ReturnType<typeof ok<ReturnType<typeof twoTeams>>>>();
    const loading = render(ui(fakeManagement({ calls: { overview: () => gate.promise } })));
    await settle();
    expect(newTeam(loading).getAttribute('aria-disabled')).toBe('true');
    gate.resolve(ok(twoTeams()));
    await settle();
    expect(newTeam(loading).disabled).toBe(false);
    loading.unmount();

    const stale = render(ui(fakeManagement({ overview: [ok(twoTeams()), { ok: false, error: { code: 'INTERNAL', message: 'offline', retryable: true } }] })));
    await settle();
    fireEvent.click(stale.getByRole('button', { name: 'Teams' }));
    await settle();
    fireEvent.click(stale.getByRole('button', { name: 'Refresh' }));
    await settle();
    expect(row(stale, 'Dev Team')).toBeTruthy();
    expect(newTeam(stale).getAttribute('aria-disabled')).toBe('true');
    stale.unmount();

    for (const state of ['connecting', 'lost'] as const) {
      const view = render(ui(fakeManagement(), workspace, connectionFixture(state)));
      await settle();
      expect(newTeam(view).disabled).toBe(true);
      view.unmount();
    }

    const writeGate = deferred<ReturnType<typeof created>>();
    const pending = render(ui(fakeManagement({ calls: { createTeam: () => writeGate.promise } })));
    await settle();
    fireEvent.click(newTeam(pending));
    await settle();
    expect(newTeam(pending).disabled).toBe(true);
    fireEvent.change(pending.getByLabelText('Team name'), { target: { value: 'QA Team' } });
    fireEvent.click(pending.getByRole('button', { name: 'Create team' }));
    await settle();
    expect(newTeam(pending).disabled).toBe(true);
    writeGate.resolve(created());
    await settle();
    expect(newTeam(pending).disabled).toBe(false);
  });

  it('sidebar_new_team_cancel_and_escape_restore_trigger_focus', async () => {
    const createTeam = vi.fn();
    const view = render(ui(fakeManagement({ calls: { createTeam } })));
    await settle();
    fireEvent.click(newTeam(view));
    await settle();
    expect(dialog(view)).not.toBeNull();
    expect(document.activeElement).toBe(view.getByLabelText('Team name'));
    fireEvent.click(view.getByRole('button', { name: 'Cancel' }));
    await settle();
    expect(dialog(view)).toBeNull();
    expect(document.activeElement).toBe(newTeam(view));

    newTeam(view).focus();
    await userEvent.keyboard('{Enter}');
    expect(dialog(view)).not.toBeNull();
    await userEvent.keyboard('{Escape}');
    expect(dialog(view)).toBeNull();
    expect(document.activeElement).toBe(newTeam(view));
    expect(createTeam).not.toHaveBeenCalled();
  });

  it('open_create_dialog_blocks_submission_during_disconnect_and_recovers_after_refresh', async () => {
    const createTeam = vi.fn(async () => created());
    const fake = fakeManagement({ overview: [ok(twoTeams()), ok(twoTeams()), ok(withQa())], calls: { createTeam } });
    const view = render(ui(fake));
    await settle();
    fireEvent.click(newTeam(view));
    await settle();
    fireEvent.change(view.getByLabelText('Team name'), { target: { value: 'QA Team' } });
    view.rerender(ui(fake, workspace, connectionFixture('lost')));
    await settle();
    expect(dialog(view)).not.toBeNull();
    expect((view.getByRole('button', { name: 'Create team' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(view.getByRole('form', { name: 'New team' }));
    await settle();
    expect(createTeam).not.toHaveBeenCalled();
    expect((view.getByLabelText('Team name') as HTMLInputElement).value).toBe('QA Team');
    view.rerender(ui(fake, workspace, connectionFixture('connected')));
    await settle();
    expect((view.getByRole('button', { name: 'Create team' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(view.getByRole('button', { name: 'Create team' }));
    await settle();
    expect(createTeam).toHaveBeenCalledOnce();
    expect(row(view, 'QA Team').getAttribute('aria-current')).toBe('page');
  });

  it('create_dialog_escape_from_error_dismiss_button_closes_and_restores_focus', async () => {
    const createTeam = vi.fn(async () => ({ ok: false as const, error: { code: 'TEAM_EXISTS', message: 'dup', retryable: false } }));
    const view = render(ui(fakeManagement({ calls: { createTeam } })));
    await settle();
    fireEvent.click(newTeam(view));
    await settle();
    fireEvent.change(view.getByLabelText('Team name'), { target: { value: 'QA Team' } });
    fireEvent.click(view.getByRole('button', { name: 'Create team' }));
    await settle();
    const dismiss = view.getByRole('button', { name: 'Dismiss' });
    dismiss.focus();
    await userEvent.keyboard('{Escape}');
    await settle();
    expect(dialog(view)).toBeNull();
    expect(document.activeElement).toBe(newTeam(view));
    expect(createTeam).toHaveBeenCalledTimes(1);
  });

  it('create_dialog_cancel_after_backend_error_restores_trigger_without_refresh', async () => {
    const createTeam = vi.fn(async () => ({ ok: false as const, error: { code: 'TEAM_EXISTS', message: 'dup', retryable: false } }));
    const fake = fakeManagement({ calls: { createTeam } });
    const view = render(ui(fake));
    await settle();
    fireEvent.click(row(view, 'Dev Team'));
    await settle();
    await create(view);
    expect(view.getByRole('alert').textContent).toContain('TEAM_EXISTS: dup');
    fireEvent.click(view.getByRole('button', { name: 'Cancel' }));
    await settle();
    expect(dialog(view)).toBeNull();
    expect(document.activeElement).toBe(newTeam(view));
    expect(createTeam).toHaveBeenCalledTimes(1);
    expect(fake.overview).toHaveBeenCalledTimes(1);
    expect(row(view, 'Dev Team').getAttribute('aria-current')).toBe('page');
  });

  it('create_dialog_traps_tab_within_its_controls', async () => {
    const view = render(ui(fakeManagement()));
    await settle();
    fireEvent.click(newTeam(view));
    await settle();
    expect(document.activeElement).toBe(view.getByLabelText('Team name'));
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(view.getByRole('button', { name: 'Cancel' }));
    await userEvent.tab();
    expect(document.activeElement).toBe(view.getByLabelText('Team name'));
  });

  it('create_dialog_traps_tab_after_backend_error_adds_dismiss_control', async () => {
    const createTeam = vi.fn(async () => ({ ok: false as const, error: { code: 'TEAM_EXISTS', message: 'dup', retryable: false } }));
    const view = render(ui(fakeManagement({ calls: { createTeam } })));
    await settle();
    await create(view);
    expect(document.activeElement).toBe(view.getByLabelText('Team name'));
    const dismiss = view.getByRole('button', { name: 'Dismiss' });
    dismiss.focus();
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(view.getByRole('button', { name: 'Cancel' }));
    await userEvent.tab();
    expect(document.activeElement).toBe(dismiss);
  });

  it('sidebar_creation_focuses_confirmed_refreshed_team_row', async () => {
    const gate = deferred<ReturnType<typeof ok<ReturnType<typeof withQa>>>>();
    const createTeam = vi.fn(async () => created());
    const fake = fakeManagement({ overview: [ok(twoTeams())], calls: { createTeam } });
    let reads = 0;
    fake.api.overview = vi.fn(async () => (reads++ === 0 ? ok(twoTeams()) : gate.promise));
    const view = render(ui(fake));
    await settle();
    await create(view);
    expect(createTeam).toHaveBeenCalledTimes(1);
    expect(createTeam).toHaveBeenCalledWith(workspace.id, { name: 'QA Team' });
    expect(dialog(view)).not.toBeNull();
    expect(view.queryByRole('button', { name: /^Open QA Team,/ })).toBeNull();
    gate.resolve(ok(withQa()));
    await settle();
    expect(dialog(view)).toBeNull();
    expect(document.activeElement).toBe(row(view, 'QA Team'));
    expect(row(view, 'QA Team').getAttribute('aria-current')).toBe('page');
    expect(view.getByRole('heading', { level: 2, name: 'QA Team' })).toBeTruthy();
    expect(view.getByRole('status').textContent).toContain('Created team "QA Team".');
  });

  it('sidebar_creation_refresh_failure_preserves_success_and_selection', async () => {
    const fake = fakeManagement({
      overview: [ok(twoTeams()), { ok: false, error: { code: 'INTERNAL', message: 'offline', retryable: true } }, ok(withQa())],
      calls: { createTeam: async () => created() },
    });
    const view = render(ui(fake));
    await settle();
    fireEvent.click(row(view, 'Release Team'));
    await settle();
    await create(view);
    expect(dialog(view)).toBeNull();
    expect(view.getByText('Created team "QA Team". Team list refresh failed (INTERNAL: offline). Refresh Teams to select it.')).toBeTruthy();
    expect(view.getByRole('heading', { level: 2, name: 'Release Team' })).toBeTruthy();
    expect(row(view, 'Release Team').getAttribute('aria-current')).toBe('page');
    expect(document.activeElement).toBe(newTeam(view));
    const refresh = view.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement;
    expect(refresh.disabled).toBe(false);
    fireEvent.click(refresh);
    await settle();
    expect(row(view, 'QA Team')).toBeTruthy();
    expect(newTeam(view).disabled).toBe(false);
  });

  it('sidebar_creation_missing_from_refresh_does_not_select_by_name_or_index', async () => {
    const fake = fakeManagement({
      overview: [ok(twoTeams()), ok(withQa('different-id'))],
      calls: { createTeam: async () => created() },
    });
    const view = render(ui(fake));
    await settle();
    await create(view);
    expect(dialog(view)).toBeNull();
    expect(view.getByText('Created team "QA Team". The refreshed team list did not include team "qa-team"; refresh Teams to select it.')).toBeTruthy();
    expect(view.getByRole('heading', { level: 2, name: 'Dev Team' })).toBeTruthy();
    expect(row(view, 'QA Team').getAttribute('aria-current')).toBeNull();
    expect(document.activeElement).toBe(newTeam(view));
  });

  it('sidebar_creation_does_not_select_runtime_only_row_matching_created_id_key', async () => {
    const runtimeOnly = team({ id: null, name: 'Runtime Foo', members: [], runtime: { state: 'running', teamId: 'foo', status: 'running' } });
    const fake = fakeManagement({
      overview: [ok(twoTeams()), ok(overviewFixture([...twoTeams().teams, runtimeOnly]))],
      calls: { createTeam: async () => created('runtime:foo', 'Foo') },
    });
    const view = render(ui(fake));
    await settle();
    await create(view);
    expect(view.getByText(/did not include team "runtime:foo"/)).toBeTruthy();
    expect(view.getByRole('heading', { level: 2, name: 'Dev Team' })).toBeTruthy();
    expect(document.activeElement).toBe(newTeam(view));
  });

  it('missing_created_and_previous_team_does_not_select_an_unrelated_row', async () => {
    const unrelated = team({ id: 'different-id', name: 'QA Team', members: [] });
    const fake = fakeManagement({
      overview: [ok(twoTeams()), ok(overviewFixture([unrelated]))],
      calls: { createTeam: async () => created() },
    });
    const view = render(ui(fake));
    await settle();
    fireEvent.click(row(view, 'Release Team'));
    await settle();
    await create(view);
    expect(view.getByText(/did not include team "qa-team"/)).toBeTruthy();
    expect(row(view, 'QA Team').getAttribute('aria-current')).toBeNull();
    expect(view.queryByRole('heading', { level: 2, name: 'QA Team' })).toBeNull();
    expect(document.activeElement).toBe(newTeam(view));
  });

  it('navigation_away_during_create_keeps_request_until_refresh_finishes', async () => {
    const gate = deferred<ReturnType<typeof created>>();
    const fake = fakeManagement({ overview: [ok(twoTeams()), ok(withQa())], calls: { createTeam: () => gate.promise } });
    const view = render(ui(fake));
    await settle();
    await create(view);
    fireEvent.click(view.getByRole('button', { name: 'Home' }));
    expect(dialog(view)).not.toBeNull();
    gate.resolve(created());
    await settle();
    expect(dialog(view)).toBeNull();
    expect(fake.overview).toHaveBeenCalledTimes(2);
    expect(view.getByText('Created team "QA Team".')).toBeTruthy();
    expect(row(view, 'QA Team').getAttribute('aria-current')).toBe('page');
  });

  it('workspace_switch_closes_create_dialog_without_restoring_old_focus', async () => {
    const fake = fakeManagement();
    const view = render(ui(fake));
    await settle();
    fireEvent.click(newTeam(view));
    await settle();
    const oldTrigger = newTeam(view);
    expect(dialog(view)).not.toBeNull();
    view.rerender(ui(fake, other));
    await settle();
    expect(view.getByRole('heading', { level: 1 }).textContent).toBe('Workspace overview');
    expect(dialog(view)).toBeNull();
    expect(document.activeElement).not.toBe(oldTrigger);
    expect(document.contains(document.activeElement)).toBe(true);
  });

  it('sidebar_create_result_after_workspace_switch_is_ignored', async () => {
    const gate = deferred<ReturnType<typeof created>>();
    const fake = fakeManagement({ calls: { createTeam: () => gate.promise } });
    const view = render(ui(fake));
    await settle();
    fireEvent.click(newTeam(view));
    await settle();
    fireEvent.change(view.getByLabelText('Team name'), { target: { value: 'QA Team' } });
    fireEvent.click(view.getByRole('button', { name: 'Create team' }));
    await settle();
    view.rerender(ui(fake, other));
    await settle();
    const reads = fake.overview.mock.calls.length;
    const before = document.activeElement;
    gate.resolve(created());
    await settle();
    expect(fake.overview.mock.calls.length).toBe(reads);
    expect(view.getByRole('heading', { level: 1 }).textContent).toBe('Workspace overview');
    expect(dialog(view)).toBeNull();
    expect(document.activeElement).toBe(before);
    expect(newTeam(view).disabled).toBe(false);
  });

  it('sidebar_create_refresh_result_after_workspace_switch_is_ignored', async () => {
    const gate = deferred<ReturnType<typeof ok<ReturnType<typeof withQa>>>>();
    const fake = fakeManagement({ calls: { createTeam: async () => created() } });
    fake.api.overview = vi.fn(async (workspaceId: string) => {
      if (workspaceId === workspace.id && fake.api.overview.mock.calls.length > 1) return gate.promise;
      return ok(twoTeams());
    });
    const view = render(ui(fake));
    await settle();
    await create(view);
    expect(dialog(view)).not.toBeNull();
    view.rerender(ui(fake, other));
    await settle();
    const focusBefore = document.activeElement;
    gate.resolve(ok(withQa()));
    await settle();
    expect(view.getByRole('heading', { level: 1 }).textContent).toBe('Workspace overview');
    expect(dialog(view)).toBeNull();
    expect(view.queryByText('Created team "QA Team".')).toBeNull();
    expect(document.activeElement).toBe(focusBefore);
  });

  it('sidebar_creation_keeps_definition_problems_before_refresh_warning', async () => {
    const fake = fakeManagement({
      overview: [ok(twoTeams()), { ok: false, error: { code: 'INTERNAL', message: 'offline', retryable: true } }],
      calls: { createTeam: async () => ok({ team: teamDefinition({ id: 'qa-team', name: 'QA Team' }), problems: [{ code: 'MEMBER_UNKNOWN_AGENT', message: 'unknown agent' }] }) },
    });
    const view = render(ui(fake));
    await settle();
    fireEvent.click(row(view, 'Dev Team'));
    await settle();
    await create(view);
    expect(view.getByText('Created team "QA Team". The team still has 1 problem; see the team details. Team list refresh failed (INTERNAL: offline). Refresh Teams to select it.')).toBeTruthy();
    expect(row(view, 'Dev Team').getAttribute('aria-current')).toBe('page');
  });
});
