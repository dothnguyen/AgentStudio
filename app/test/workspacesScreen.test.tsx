// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, type RenderResult } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionStatus, DashboardApi, InitResult, Result, Workspace, WorkspaceList, WorkspacesApi } from '../src/renderer/api';
import { StartupScreen } from '../src/renderer/StartupScreen';
import {
  BAD_RESPONSE_MESSAGE,
  EMPTY_TEXT,
  EMPTY_TITLE,
  ERROR_TITLE,
  LIST_TITLE,
  LOADING_TEXT,
  MISSING_BADGE,
  PRODUCT_SUBTITLE,
  WorkspacesScreen,
  toLoadResult,
} from '../src/renderer/WorkspacesScreen';
import { fakeConnection } from './fakeConnection';
import { fakeManagement } from './teamsFixtures';

afterEach(cleanup);

const connectionStatus: ConnectionStatus = { state: 'connected', error: null, distro: null, command: 'serve' };
const dashboard: DashboardApi = {
  teams: vi.fn(async () => ({ ok: true, data: { workspace: '/workspace', teams: [], truncated: false } })),
  board: vi.fn(async () => ({
    ok: true,
    data: {
      workspace: '/workspace', currentPhase: { slug: 'default', name: 'Default', status: 'open' },
      columns: [], totals: { active: 0, blocked: 0, done: 0 }, tickets: [],
    },
  })),
  activity: vi.fn(async () => ({
    ok: true,
    data: { workspace: '/workspace', dbId: 'activity-db', head: 0, entries: [] },
  })),
};
const screenContext = { dashboard, connection: connectionStatus, management: fakeManagement().api };

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function ws(id: string, name: string, path: string, exists = true): Workspace {
  return { id, name, path, exists, missing: !exists };
}

function ok(...workspaces: Workspace[]): Result<WorkspaceList> {
  return { ok: true, data: { workspaces } };
}

function fail(code: string, message: string, remediation?: string): Result<WorkspaceList> {
  return {
    ok: false,
    error: { code, message, retryable: false, ...(remediation ? { remediation } : {}) },
  };
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fakeWorkspaces(...items: Array<unknown | Error | Deferred<unknown>>) {
  let next = 0;
  const list = vi.fn(() => {
    const item = items[next++];
    if (item instanceof Error) return Promise.reject(item);
    if (typeof item === 'object' && item !== null && 'promise' in item) {
      return (item as Deferred<unknown>).promise;
    }
    return Promise.resolve(item);
  });
  const create = vi.fn();
  const pickFolder = vi.fn(async () => ({ ok: true as const, data: null }));
  return { api: { list, create, pickFolder } as WorkspacesApi, list, create, pickFolder };
}

const settle = () => act(async () => {});

async function mount(api: WorkspacesApi): Promise<RenderResult> {
  const result = render(<WorkspacesScreen {...screenContext} api={api} />);
  await settle();
  return result;
}

function view(result: RenderResult): string | null | undefined {
  return result.container.querySelector('section')?.getAttribute('data-view');
}

describe('WorkspacesScreen', () => {
  it('shows the loading state until the list resolves', async () => {
    const pending = deferred<unknown>();
    const fake = fakeWorkspaces(pending);
    const result = render(<WorkspacesScreen {...screenContext} api={fake.api} />);

    expect(result.getByRole('status').textContent).toBe(LOADING_TEXT);
    expect(view(result)).toBe('loading');

    await act(async () => pending.resolve(ok()));
    expect(view(result)).toBe('empty');
  });

  it('empty list shows only the empty state with a primary Create workspace button', async () => {
    const result = await mount(fakeWorkspaces(ok()).api);

    expect(view(result)).toBe('empty');
    expect(result.getByRole('heading', { level: 1 }).textContent).toBe(EMPTY_TITLE);
    expect(result.container.textContent).toContain(EMPTY_TEXT);
    const buttons = result.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toBe('Create workspace');
    expect(buttons[0].classList.contains('primary')).toBe(true);
    expect(result.container.querySelector('[data-action="refresh"]')).toBeNull();
    expect(result.container.querySelector('ul')).toBeNull();
  });

  it('uses the shared product identity and illustrated workspace states', async () => {
    const loading = deferred<unknown>();
    const pending = render(<WorkspacesScreen {...screenContext} api={fakeWorkspaces(loading).api} />);
    expect(pending.getByText('Agent Studio').classList.contains('product-name')).toBe(true);
    expect(pending.getByText(PRODUCT_SUBTITLE)).toBeTruthy();
    expect(pending.container.querySelector('[data-view="loading"] .spinner')?.getAttribute('aria-hidden')).toBe('true');
    pending.unmount();

    const empty = await mount(fakeWorkspaces(ok()).api);
    expect(empty.container.querySelector('[data-view="empty"] .empty-folder svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('both empty and list Create buttons open the dialog', async () => {
    const empty = await mount(fakeWorkspaces(ok()).api);
    fireEvent.click(empty.getByRole('button', { name: 'Create workspace' }));
    expect(empty.getByRole('dialog')).toBeTruthy();
    empty.unmount();

    const list = await mount(fakeWorkspaces(ok(ws('a', 'Alpha', '/home/me/a'))).api);
    fireEvent.click(list.getByRole('button', { name: 'Create workspace' }));
    expect(list.getByRole('dialog')).toBeTruthy();
  });

  it('cancel keeps the ready view and restores focus to the Create button that opened the dialog', async () => {
    const result = await mount(fakeWorkspaces(ok(ws('a', 'Alpha', '/a'))).api);
    const opener = result.getByRole('button', { name: 'Create workspace' });
    opener.focus();
    fireEvent.click(opener);

    expect(result.getByRole('dialog')).toBeTruthy();
    expect(result.getByText('Alpha')).toBeTruthy();
    fireEvent.click(result.getByRole('button', { name: 'Cancel' }));

    expect(result.queryByRole('dialog')).toBeNull();
    expect(view(result)).toBe('list');
    expect(result.getByText('Alpha')).toBeTruthy();
    expect(document.activeElement).toBe(opener);
  });

  it('successful create refreshes and opens its shell', async () => {
    const added = ws('b', 'Beta', '/home/me/b');
    const fake = fakeWorkspaces(ok(ws('a', 'Alpha', '/a')), ok(ws('a', 'Alpha', '/a'), added));
    fake.create.mockResolvedValue({
      ok: true,
      data: { id: added.id, name: added.name, path: added.path, existed: false } satisfies InitResult,
    });
    const result = await mount(fake.api);
    fireEvent.click(result.getByRole('button', { name: 'Create workspace' }));
    fireEvent.change(result.getByLabelText('Folder'), { target: { value: '/home/me/b' } });
    await act(async () => fireEvent.submit(result.container.querySelector('form')!));
    await settle();

    expect(result.queryByRole('dialog')).toBeNull();
    expect(fake.list).toHaveBeenCalledTimes(2);
    expect(result.container.querySelector('.workspace-shell')).toBeTruthy();
    expect(result.getByRole('heading', { level: 1 }).textContent).toBe('Workspace overview');
    expect(result.container.querySelector('.dashboard-workspace-name')?.textContent).toBe('Beta');
    expect(result.container.querySelector('.workspace-name')?.textContent).toBe('Beta');
    expect(result.container.querySelector('.workspace-path')?.textContent).toBe('/home/me/b');
    expect(result.queryByRole('button', { name: 'Back' })).toBeNull();
  });

  it('retains the ready view while the post-create refresh is pending', async () => {
    const refresh = deferred<unknown>();
    const added = ws('b', 'Beta', '/b');
    const fake = fakeWorkspaces(ok(ws('a', 'Alpha', '/a')), refresh);
    fake.create.mockResolvedValue({
      ok: true,
      data: { id: added.id, name: added.name, path: added.path, existed: false },
    });
    const result = await mount(fake.api);
    fireEvent.click(result.getByRole('button', { name: 'Create workspace' }));
    fireEvent.change(result.getByLabelText('Folder'), { target: { value: '/b' } });
    await act(async () => fireEvent.submit(result.container.querySelector('form')!));

    expect(result.queryByRole('dialog')).toBeNull();
    expect(view(result)).toBe('list');
    expect(result.getByText('Alpha')).toBeTruthy();
    expect(result.queryByText('Beta')).toBeNull();

    await act(async () => refresh.resolve(ok(ws('a', 'Alpha', '/a'), added)));
    expect(result.container.querySelector('.workspace-shell')).toBeTruthy();
    expect(result.container.querySelector('.workspace-name')?.textContent).toBe('Beta');
    expect(result.getByRole('heading', { level: 1 }).textContent).toBe('Workspace overview');
    expect(result.container.querySelector('.dashboard-workspace-name')?.textContent).toBe('Beta');
  });

  it('ignores a post-create refresh result after unmount', async () => {
    const refresh = deferred<unknown>();
    const added = ws('b', 'Beta', '/b');
    const fake = fakeWorkspaces(ok(ws('a', 'Alpha', '/a')), refresh);
    fake.create.mockResolvedValue({
      ok: true,
      data: { id: added.id, name: added.name, path: added.path, existed: false },
    });
    const result = await mount(fake.api);
    fireEvent.click(result.getByRole('button', { name: 'Create workspace' }));
    fireEvent.change(result.getByLabelText('Folder'), { target: { value: '/b' } });
    await act(async () => fireEvent.submit(result.container.querySelector('form')!));

    expect(result.queryByRole('dialog')).toBeNull();
    expect(view(result)).toBe('list');
    result.unmount();

    await act(async () => refresh.resolve(ok(ws('a', 'Alpha', '/a'), added)));
    expect(result.container.innerHTML).toBe('');
  });

  it('selects the created workspace by exact path when its id is absent from the refreshed list', async () => {
    const refreshed = ws('registry-id', 'Renamed in registry', '/home/me/b');
    const fake = fakeWorkspaces(ok(ws('a', 'Alpha', '/a')), ok(refreshed));
    fake.create.mockResolvedValue({
      ok: true,
      data: { id: 'created-id', name: 'Beta', path: refreshed.path, existed: false },
    });
    const result = await mount(fake.api);
    fireEvent.click(result.getByRole('button', { name: 'Create workspace' }));
    fireEvent.change(result.getByLabelText('Folder'), { target: { value: refreshed.path } });
    await act(async () => fireEvent.submit(result.container.querySelector('form')!));
    await settle();

    expect(result.container.querySelector('.workspace-shell')).toBeTruthy();
    expect(result.container.querySelector('.workspace-name')?.textContent).toBe('Renamed in registry');
    expect(result.container.querySelector('.workspace-path')?.textContent).toBe(refreshed.path);
  });

  it('prefers the created id when the refreshed list also contains a path match', async () => {
    const idMatch = ws('created-id', 'ID match', '/registry/id-match');
    const pathMatch = ws('other-id', 'Path match', '/requested/path');
    const fake = fakeWorkspaces(ok(ws('a', 'Alpha', '/a')), ok(idMatch, pathMatch));
    fake.create.mockResolvedValue({
      ok: true,
      data: { id: idMatch.id, name: 'Requested name', path: pathMatch.path, existed: false },
    });
    const result = await mount(fake.api);
    fireEvent.click(result.getByRole('button', { name: 'Create workspace' }));
    fireEvent.change(result.getByLabelText('Folder'), { target: { value: pathMatch.path } });
    await act(async () => fireEvent.submit(result.container.querySelector('form')!));
    await settle();

    expect(result.container.querySelector('.workspace-shell')).toBeTruthy();
    expect(result.container.querySelector('.workspace-name')?.textContent).toBe('ID match');
    expect(result.container.querySelector('.workspace-path')?.textContent).toBe('/registry/id-match');
  });

  it('existing path refreshes without a duplicate and selects it', async () => {
    const existing = ws('a', 'Alpha', '/home/me/a');
    const fake = fakeWorkspaces(ok(existing), ok(existing));
    fake.create.mockResolvedValue({
      ok: true,
      data: { id: existing.id, name: existing.name, path: existing.path, existed: true },
    });
    const result = await mount(fake.api);
    fireEvent.click(result.getByRole('button', { name: 'Create workspace' }));
    fireEvent.change(result.getByLabelText('Folder'), { target: { value: existing.path } });
    await act(async () => fireEvent.submit(result.container.querySelector('form')!));
    await settle();
    expect(result.container.querySelector('.workspace-shell')).toBeTruthy();
    fireEvent.click(result.getByRole('button', { name: 'Switch workspace' }));
    expect(result.container.querySelectorAll('[data-id="a"]')).toHaveLength(1);
    expect(result.getAllByText('/home/me/a')).toHaveLength(1);
  });

  it('failed create leaves the list unchanged and does not refresh', async () => {
    const fake = fakeWorkspaces(ok(ws('a', 'Alpha', '/a')));
    fake.create.mockResolvedValue({
      ok: false,
      error: {
        code: 'WORKSPACE_PATH_NOT_FOUND',
        message: 'Folder does not exist.',
        retryable: false,
        remediation: 'Choose an existing folder.',
      },
    });
    const result = await mount(fake.api);
    fireEvent.click(result.getByRole('button', { name: 'Create workspace' }));
    fireEvent.change(result.getByLabelText('Folder'), { target: { value: '/missing' } });
    await act(async () => fireEvent.submit(result.container.querySelector('form')!));
    expect(result.getByRole('alert').textContent).toBe('WORKSPACE_PATH_NOT_FOUND: Folder does not exist.');
    expect(result.getByText('Choose an existing folder.')).toBeTruthy();
    expect(result.getByRole('dialog')).toBeTruthy();
    expect(fake.list).toHaveBeenCalledTimes(1);
    fireEvent.click(result.getByRole('button', { name: 'Cancel' }));
    expect(result.queryByRole('dialog')).toBeNull();
    expect(result.getByText('Alpha')).toBeTruthy();
  });

  it('post-create refresh must contain the created workspace', async () => {
    const fake = fakeWorkspaces(ok(ws('a', 'Alpha', '/a')), ok(ws('a', 'Alpha', '/a')));
    fake.create.mockResolvedValue({
      ok: true,
      data: { id: 'missing', name: 'Missing', path: '/missing', existed: false },
    });
    const result = await mount(fake.api);
    fireEvent.click(result.getByRole('button', { name: 'Create workspace' }));
    fireEvent.change(result.getByLabelText('Folder'), { target: { value: '/missing' } });
    await act(async () => fireEvent.submit(result.container.querySelector('form')!));
    await settle();
    expect(result.container.querySelector('[data-role="error-message"]')?.textContent).toBe(
      'BAD_RESPONSE: workspace.list did not return the created workspace.',
    );
    expect(result.container.textContent).not.toContain('Missing');
  });

  it('post-create list errors use the existing list-error view and do not invent a workspace', async () => {
    const fake = fakeWorkspaces(
      ok(ws('a', 'Alpha', '/a')),
      fail('REGISTRY_UNAVAILABLE', 'Registry could not be read.', 'Try again later.'),
    );
    fake.create.mockResolvedValue({
      ok: true,
      data: { id: 'b', name: 'Beta', path: '/b', existed: false },
    });
    const result = await mount(fake.api);
    fireEvent.click(result.getByRole('button', { name: 'Create workspace' }));
    fireEvent.change(result.getByLabelText('Folder'), { target: { value: '/b' } });
    await act(async () => fireEvent.submit(result.container.querySelector('form')!));
    await settle();

    expect(view(result)).toBe('error');
    expect(result.getByRole('alert').textContent).toBe('REGISTRY_UNAVAILABLE: Registry could not be read.');
    expect(result.container.querySelector('[data-role="error-remediation"]')?.textContent).toBe('Try again later.');
    expect(result.container.textContent).not.toContain('Beta');
    expect(fake.list).toHaveBeenCalledTimes(2);
  });

  it('post-create list rejection uses the existing internal list-error view', async () => {
    const fake = fakeWorkspaces(ok(ws('a', 'Alpha', '/a')), new Error('registry read failed'));
    fake.create.mockResolvedValue({
      ok: true,
      data: { id: 'b', name: 'Beta', path: '/b', existed: false },
    });
    const result = await mount(fake.api);
    fireEvent.click(result.getByRole('button', { name: 'Create workspace' }));
    fireEvent.change(result.getByLabelText('Folder'), { target: { value: '/b' } });
    await act(async () => fireEvent.submit(result.container.querySelector('form')!));
    await settle();

    expect(view(result)).toBe('error');
    expect(result.getByRole('alert').textContent).toBe('INTERNAL: registry read failed');
    expect(result.container.textContent).not.toContain('Beta');
    expect(fake.list).toHaveBeenCalledTimes(2);
  });

  it('lists workspaces in order with name, path and a badge only for missing folders', async () => {
    const result = await mount(
      fakeWorkspaces(ok(ws('a', 'Alpha', '/home/me/a'), ws('b', 'Beta', '/mnt/c/b', false))).api,
    );

    expect(view(result)).toBe('list');
    expect(result.getByRole('heading', { level: 1 }).textContent).toBe(LIST_TITLE);
    const rows = [...result.container.querySelectorAll<HTMLElement>('.ws-row')];
    expect(rows.map((row) => row.dataset.id)).toEqual(['a', 'b']);
    expect(rows.map((row) => row.querySelector('.ws-name')?.textContent)).toEqual(['Alpha', 'Beta']);
    expect(rows.map((row) => row.querySelector('.ws-path')?.textContent)).toEqual(['/home/me/a', '/mnt/c/b']);
    expect(rows.map((row) => row.querySelector('.ws-path')?.getAttribute('title'))).toEqual(['/home/me/a', '/mnt/c/b']);
    expect(rows.every((row) => row.querySelector('.folder-icon')?.getAttribute('aria-hidden') === 'true')).toBe(true);
    expect(rows.every((row) => row.querySelector('.row-chevron')?.getAttribute('aria-hidden') === 'true')).toBe(true);
    expect(rows[0].querySelector('[data-role="missing-badge"]')).toBeNull();
    expect(rows[1].querySelector('[data-role="missing-badge"]')?.textContent).toBe(MISSING_BADGE);
    expect(result.getByRole('button', { name: 'Create workspace' }).classList.contains('primary')).toBe(true);
    expect(result.getByRole('button', { name: 'Refresh' }).classList.contains('secondary')).toBe(true);
  });

  it('refresh reloads the list and disables Refresh while loading', async () => {
    const pending = deferred<unknown>();
    const fake = fakeWorkspaces(ok(ws('a', 'Alpha', '/home/me/a')), pending);
    const result = await mount(fake.api);

    const refresh = result.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement;
    fireEvent.click(refresh);
    expect(refresh.disabled).toBe(true);
    expect(result.getByText('Alpha')).toBeTruthy();

    await act(async () => pending.resolve(ok(ws('a', 'Alpha', '/home/me/a'), ws('g', 'Gamma', '/g'))));
    expect(result.container.querySelectorAll('.ws-row')).toHaveLength(2);
    expect((result.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(false);
    expect(fake.list).toHaveBeenCalledTimes(2);
  });

  it('keeps an open Create dialog and the ready list when an earlier refresh fails', async () => {
    const refresh = deferred<unknown>();
    const fake = fakeWorkspaces(ok(ws('a', 'Alpha', '/home/me/a')), refresh);
    const result = await mount(fake.api);

    fireEvent.click(result.getByRole('button', { name: 'Refresh' }));
    fireEvent.click(result.getByRole('button', { name: 'Create workspace' }));
    expect(result.getByRole('dialog')).toBeTruthy();

    await act(async () => refresh.resolve(fail('REGISTRY_UNAVAILABLE', 'Registry could not be read.')));

    expect(result.getByRole('dialog')).toBeTruthy();
    expect(result.getByLabelText('Folder')).toBeTruthy();
    expect(view(result)).toBe('list');
    expect(result.getByText('Alpha')).toBeTruthy();
    expect(result.queryByText('Could not load workspaces')).toBeNull();
  });

  it('keeps an open Create dialog and the ready list when an earlier refresh rejects', async () => {
    const refresh = deferred<unknown>();
    const fake = fakeWorkspaces(ok(ws('a', 'Alpha', '/home/me/a')), refresh);
    const result = await mount(fake.api);

    fireEvent.click(result.getByRole('button', { name: 'Refresh' }));
    fireEvent.click(result.getByRole('button', { name: 'Create workspace' }));
    expect(result.getByRole('dialog')).toBeTruthy();

    await act(async () => refresh.reject(new Error('refresh failed')));

    expect(result.getByRole('dialog')).toBeTruthy();
    expect(result.getByLabelText('Folder')).toBeTruthy();
    expect(view(result)).toBe('list');
    expect(result.getByText('Alpha')).toBeTruthy();
    expect(result.queryByText('Could not load workspaces')).toBeNull();
  });

  it('refresh to an empty list shows the empty state', async () => {
    const result = await mount(fakeWorkspaces(ok(ws('a', 'Alpha', '/a')), ok()).api);
    fireEvent.click(result.getByRole('button', { name: 'Refresh' }));
    await settle();
    expect(view(result)).toBe('empty');
  });

  it('clicking an existing workspace opens its shell', async () => {
    const result = await mount(fakeWorkspaces(ok(ws('a', 'Alpha', '/home/me/a'))).api);
    fireEvent.click(result.container.querySelector('.ws-row')!);

    expect(result.container.querySelector('.workspace-shell')).toBeTruthy();
    expect(result.container.querySelector('.workspace-name')?.textContent).toBe('Alpha');
    expect(result.container.querySelector('.workspace-path')?.textContent).toBe('/home/me/a');
    expect(result.getByRole('heading', { level: 1 }).textContent).toBe('Workspace overview');
    expect(result.container.querySelector('.dashboard-workspace-name')?.textContent).toBe('Alpha');
    expect(result.getByRole('button', { name: 'Home' }).getAttribute('aria-current')).toBe('page');
  });

  it('Enter and Space on a row open the shell', async () => {
    const result = await mount(fakeWorkspaces(ok(ws('a', 'Alpha', '/home/me/a'))).api);
    let row = result.container.querySelector('.ws-row')!;
    expect(fireEvent.keyDown(row, { key: 'Enter' })).toBe(false);
    expect(result.container.querySelector('.workspace-shell')).toBeTruthy();

    fireEvent.click(result.getByRole('button', { name: 'Switch workspace' }));
    row = result.container.querySelector('.ws-row')!;
    expect(fireEvent.keyDown(row, { key: ' ' })).toBe(false);
    expect(result.container.querySelector('.workspace-shell')).toBeTruthy();
  });

  it('Switch workspace returns to the cached list and focuses the row', async () => {
    const fake = fakeWorkspaces(ok(ws('a', 'Alpha', '/a'), ws('b', 'Beta', '/b')));
    const result = await mount(fake.api);
    fireEvent.click(result.container.querySelector('[data-id="b"]')!);
    fireEvent.click(result.getByRole('button', { name: 'Switch workspace' }));

    expect(view(result)).toBe('list');
    expect(fake.list).toHaveBeenCalledTimes(1);
    expect(fake.create).toHaveBeenCalledTimes(0);
    expect(document.activeElement?.getAttribute('data-id')).toBe('b');
    expect(result.container.querySelector('[data-role="notice"]')).toBeNull();
  });

  it('section navigation performs no workspace API calls', async () => {
    const fake = fakeWorkspaces(ok(ws('a', 'Alpha', '/a')));
    const result = await mount(fake.api);
    fireEvent.click(result.container.querySelector('[data-id="a"]')!);

    expect(fake.list).toHaveBeenCalledTimes(1);
    expect(fake.create).toHaveBeenCalledTimes(0);
    for (const label of ['Home', 'Teams', 'Boards', 'Configuration']) {
      fireEvent.click(result.getByRole('button', { name: label }));
    }
    expect(fake.list).toHaveBeenCalledTimes(1);
    expect(fake.create).toHaveBeenCalledTimes(0);
  });

  it('a missing-folder workspace shows a message instead of opening', async () => {
    const result = await mount(fakeWorkspaces(ok(ws('b', 'Beta', '/mnt/c/b', false))).api);
    const row = result.container.querySelector('.ws-row')!;
    fireEvent.click(row);

    const message = 'The folder for "Beta" no longer exists (/mnt/c/b). It cannot be opened.';
    expect(view(result)).toBe('list');
    expect(result.container.querySelector('.workspace-shell')).toBeNull();
    expect(result.container.querySelector('[data-role="notice"]')?.textContent).toBe(message);
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(view(result)).toBe('list');
    expect(result.container.querySelector('[data-role="notice"]')?.textContent).toBe(message);
  });

  it('shows a list error with code, message and remediation, and Try again reloads', async () => {
    const result = await mount(
      fakeWorkspaces(
        fail('WORKSPACE_REGISTRY_CORRUPT', 'Registry unreadable.', 'Fix the registry file.'),
        ok(ws('a', 'Alpha', '/a')),
      ).api,
    );

    expect(view(result)).toBe('error');
    expect(result.getByRole('heading', { level: 1 }).textContent).toBe(ERROR_TITLE);
    expect(result.container.querySelector('[data-role="error-message"]')?.textContent).toBe(
      'WORKSPACE_REGISTRY_CORRUPT: Registry unreadable.',
    );
    expect(result.container.querySelector('[data-role="error-remediation"]')?.textContent).toBe(
      'Fix the registry file.',
    );
    fireEvent.click(result.getByRole('button', { name: 'Try again' }));
    await settle();
    expect(view(result)).toBe('list');
    expect(result.getByText('Alpha')).toBeTruthy();
  });

  it('omits the remediation line when there is none', async () => {
    const result = await mount(fakeWorkspaces(fail('TIMEOUT', 'Request timed out.')).api);
    expect(result.container.querySelector('[data-role="error-remediation"]')).toBeNull();
  });

  it('a rejected list call is shown, not thrown', async () => {
    const result = await mount(fakeWorkspaces(new Error('ipc broke')).api);
    expect(view(result)).toBe('error');
    expect(result.container.querySelector('[data-role="error-message"]')?.textContent).toBe('INTERNAL: ipc broke');
  });

  it('a malformed list result is shown as BAD_RESPONSE', async () => {
    const malformed = await mount(fakeWorkspaces({ ok: true, data: {} }).api);
    expect(malformed.container.querySelector('[data-role="error-message"]')?.textContent).toBe(
      `BAD_RESPONSE: ${BAD_RESPONSE_MESSAGE}`,
    );
    malformed.unmount();

    const missing = await mount(fakeWorkspaces(undefined).api);
    expect(missing.container.querySelector('[data-role="error-message"]')?.textContent).toBe(
      `BAD_RESPONSE: ${BAD_RESPONSE_MESSAGE}`,
    );

    missing.unmount();
    const nullData = await mount(fakeWorkspaces({ ok: true, data: null }).api);
    expect(nullData.container.querySelector('[data-role="error-message"]')?.textContent).toBe(
      `BAD_RESPONSE: ${BAD_RESPONSE_MESSAGE}`,
    );
  });

  it('a refresh error replaces the list with the error view', async () => {
    const result = await mount(
      fakeWorkspaces(ok(ws('a', 'Alpha', '/a')), fail('CONNECTION_LOST', 'serve exited')).api,
    );
    fireEvent.click(result.getByRole('button', { name: 'Refresh' }));
    await settle();
    expect(view(result)).toBe('error');
    expect(result.container.querySelector('[data-role="error-message"]')?.textContent).toBe(
      'CONNECTION_LOST: serve exited',
    );
  });

  it('renders names and paths as text, never HTML', async () => {
    const name = '<img src=x onerror=alert(1)>';
    const result = await mount(fakeWorkspaces(ok(ws('x', name, '/tmp/<b>'))).api);
    expect(result.container.querySelector('img')).toBeNull();
    expect(result.container.querySelector('b')).toBeNull();
    expect(result.container.querySelector('.ws-name')?.textContent).toBe(name);
  });

  it('ignores stale and post-unmount results', async () => {
    const stale = deferred<unknown>();
    const latestApi = fakeWorkspaces(ok(ws('new', 'Latest', '/latest'))).api;
    const firstApi = fakeWorkspaces(stale).api;
    const rerendered = render(<WorkspacesScreen {...screenContext} api={firstApi} />);
    rerendered.rerender(<WorkspacesScreen {...screenContext} api={latestApi} />);
    await settle();
    expect(rerendered.container.querySelector('.ws-name')?.textContent).toBe('Latest');
    await act(async () => stale.resolve(ok(ws('old', 'Stale', '/stale'))));
    expect(rerendered.container.querySelector('.ws-name')?.textContent).toBe('Latest');
    expect(rerendered.container.textContent).not.toContain('Stale');
    rerendered.unmount();

    const pending = deferred<unknown>();
    const result = render(<WorkspacesScreen {...screenContext} api={fakeWorkspaces(pending).api} />);
    result.unmount();
    await expect(act(async () => pending.resolve(ok(ws('a', 'Alpha', '/a'))))).resolves.toBeUndefined();
    expect(result.container.innerHTML).toBe('');

    const error = fail('X', 'y');
    expect(toLoadResult(error)).toBe(error);
    expect(toLoadResult(null)).toEqual({
      ok: false,
      error: { code: 'BAD_RESPONSE', message: BAD_RESPONSE_MESSAGE, retryable: false },
    });
  });

  it('connected state mounts the workspaces screen; lost removes it; reconnect reloads', async () => {
    const connection = fakeConnection();
    const fake = fakeWorkspaces(ok(), ok());
    const result = render(
      <StartupScreen
        connection={connection.api}
        onRetry={vi.fn()}
        connectedView={(status) => <WorkspacesScreen api={fake.api} dashboard={dashboard} management={fakeManagement().api} connection={status} />}
      />,
    );

    await act(async () =>
      connection.emit({ state: 'connected', error: null, distro: null, command: 'x' }),
    );
    await settle();
    expect(result.container.querySelector('[data-view="empty"]')).toBeTruthy();

    act(() => connection.emit({ state: 'lost', error: 'serve exited', distro: null, command: 'x' }));
    expect(result.container.querySelector('[data-view]')).toBeNull();
    expect(result.getByRole('heading', { level: 1 }).textContent).toBe('Connection lost');

    await act(async () =>
      connection.emit({ state: 'connected', error: null, distro: null, command: 'x' }),
    );
    await settle();
    expect(fake.list).toHaveBeenCalledTimes(2);
  });
});
