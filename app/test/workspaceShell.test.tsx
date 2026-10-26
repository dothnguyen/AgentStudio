// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../src/renderer/api';
import { SectionPlaceholder } from '../src/renderer/sections/SectionPlaceholder';
import { WorkspaceShell } from '../src/renderer/shell/WorkspaceShell';
import { NAV_ITEMS, type NavItem } from '../src/renderer/shell/navModel';

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
      'Home', 'Teams', 'Boards', 'Configuration',
    ]);
    expect(currentButtons(result.container)).toEqual([within(nav).getByRole('button', { name: 'Home' })]);
    expect(result.getByRole('heading', { level: 1 }).textContent).toBe('Home');
    expect(result.getByText(descriptions.Home)).toBeTruthy();
  });

  it('changes only main content and retains the workspace header', () => {
    const result = render(<WorkspaceShell workspace={workspace} onSwitchWorkspace={vi.fn()} />);
    const main = result.getByRole('main');
    const name = result.getByText(workspace.name);
    const path = result.getByText(workspace.path);

    for (const label of ['Teams', 'Boards', 'Configuration'] as const) {
      const button = result.getByRole('button', { name: label });
      button.focus();
      fireEvent.click(button);
      expect(result.getByRole('main')).toBe(main);
      expect(result.getByText(workspace.name)).toBe(name);
      expect(result.getByText(workspace.path)).toBe(path);
      expect(result.getByRole('heading', { level: 1 }).textContent).toBe(label);
      expect(result.getByText(descriptions[label])).toBeTruthy();
      expect(currentButtons(result.container)).toEqual([button]);
      expect(document.activeElement).toBe(button);
    }
  });

  it('keeps built-in placeholders free of mutation controls', () => {
    const result = render(<WorkspaceShell workspace={workspace} onSwitchWorkspace={vi.fn()} />);
    const main = result.getByRole('main');

    for (const label of ['Home', 'Teams', 'Boards', 'Configuration']) {
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
    fireEvent.click(result.getByRole('button', { name: 'Boards' }));
    result.rerender(
      <WorkspaceShell workspace={{ ...workspace, name: 'Changed name' }} onSwitchWorkspace={vi.fn()} />,
    );
    expect(result.getByRole('heading', { level: 1 }).textContent).toBe('Boards');

    result.rerender(
      <WorkspaceShell workspace={{ ...workspace, id: 'b', name: 'Workspace B' }} onSwitchWorkspace={vi.fn()} />,
    );
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
});
