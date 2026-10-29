// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import type { ConnectionStatus, DashboardApi, Workspace } from '../src/renderer/api';
import { SectionPlaceholder } from '../src/renderer/sections/SectionPlaceholder';
import { WorkspaceShell as WorkspaceShellComponent, type WorkspaceShellProps } from '../src/renderer/shell/WorkspaceShell';
import { NAV_ITEMS, type NavItem } from '../src/renderer/shell/navModel';
import { fakeManagement, member, overviewFixture, team } from './teamsFixtures';
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
    expect(within(nav).getAllByRole('button').map((button) => button.textContent)).toEqual([
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
    const buttons = result.container.querySelectorAll('nav button');
    expect(buttons).toHaveLength(7);
    buttons.forEach((button, index) => {
      expect(button.querySelector('svg.shell-icon')?.getAttribute('aria-hidden')).toBe('true');
      expect(button.textContent).toBe(items[index].label);
    });
  });

  it('sidebar controls are native buttons in visual order with no tabindex', () => {
    const result = render(<WorkspaceShell workspace={workspace} onSwitchWorkspace={vi.fn()} />);
    const buttons = [...result.container.querySelectorAll('aside button')] as HTMLButtonElement[];
    expect(buttons).toHaveLength(8);
    expect(buttons[0].className).toContain('workspace-selector');
    expect(buttons.slice(1, 7).map((button) => button.textContent)).toEqual(['Home', 'Teams', 'Agents', 'Roles', 'Boards', 'Configuration']);
    expect(buttons[7].className).toContain('switch-workspace');
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

  it('direct_roles_navigation_clears_requested_role', async () => {
    const { view } = deepLinkShell();
    fireEvent.click(view.getByRole('button', { name: 'Teams' }));
    fireEvent.click(await view.findByRole('button', { name: 'View QA in Roles' }));
    await waitFor(() => expect(view.container.querySelector('[data-section="roles"]')).toBeTruthy());
    await waitFor(() => expect(view.container.querySelector('[aria-current="true"]')?.lastElementChild?.textContent).toBe('qa-b'));
    fireEvent.click(view.getByRole('button', { name: 'Teams' }));
    fireEvent.click(view.getByRole('button', { name: 'Roles' }));
    await waitFor(() => expect(view.container.querySelector('[aria-current="true"]')?.lastElementChild?.textContent).toBe('qa-a'));
    expect(view.queryByText(/is unavailable in this workspace/)).toBeNull();
  });

  it('workspace_change_clears_section_and_role_request', async () => {
    const { view, ui } = deepLinkShell();
    fireEvent.click(view.getByRole('button', { name: 'Teams' }));
    fireEvent.click(await view.findByRole('button', { name: 'View QA in Roles' }));
    await waitFor(() => expect(view.container.querySelector('[data-section="roles"]')).toBeTruthy());
    view.rerender(ui({ ...workspace, id: 'b', name: 'Workspace B' }));
    await waitFor(() => expect(view.container.querySelector('[data-section="roles"]')).toBeNull());
    expect(view.getByRole('button', { name: 'Home' }).getAttribute('aria-current')).toBe('page');
    fireEvent.click(view.getByRole('button', { name: 'Roles' }));
    await waitFor(() => expect(view.container.querySelector('[aria-current="true"]')?.lastElementChild?.textContent).toBe('qa-a'));
  });
});
