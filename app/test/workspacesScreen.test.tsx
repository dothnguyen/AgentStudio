// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, type RenderResult } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Result, Workspace, WorkspaceList, WorkspacesApi } from '../src/renderer/api';
import { StartupScreen } from '../src/renderer/StartupScreen';
import {
  BAD_RESPONSE_MESSAGE,
  EMPTY_TEXT,
  EMPTY_TITLE,
  ERROR_TITLE,
  LIST_TITLE,
  LOADING_TEXT,
  MISSING_BADGE,
  WorkspacesScreen,
  toLoadResult,
} from '../src/renderer/WorkspacesScreen';
import { fakeConnection } from './fakeConnection';

afterEach(cleanup);

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
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
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
  return { api: { list } as WorkspacesApi, list };
}

const settle = () => act(async () => {});

async function mount(api: WorkspacesApi, onCreate?: () => void): Promise<RenderResult> {
  const result = render(<WorkspacesScreen api={api} onCreate={onCreate} />);
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
    const result = render(<WorkspacesScreen api={fake.api} />);

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

  it('create buttons call onCreate and are inert without it', async () => {
    const emptyCreate = vi.fn();
    const empty = await mount(fakeWorkspaces(ok()).api, emptyCreate);
    fireEvent.click(empty.getByRole('button', { name: 'Create workspace' }));
    expect(emptyCreate).toHaveBeenCalledTimes(1);
    empty.unmount();

    const listCreate = vi.fn();
    const list = await mount(fakeWorkspaces(ok(ws('a', 'Alpha', '/home/me/a'))).api, listCreate);
    fireEvent.click(list.getByRole('button', { name: 'Create workspace' }));
    expect(listCreate).toHaveBeenCalledTimes(1);
    list.unmount();

    const inert = await mount(fakeWorkspaces(ok()).api);
    expect(() => fireEvent.click(inert.getByRole('button', { name: 'Create workspace' }))).not.toThrow();
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
    expect(rows[0].querySelector('[data-role="missing-badge"]')).toBeNull();
    expect(rows[1].querySelector('[data-role="missing-badge"]')?.textContent).toBe(MISSING_BADGE);
    expect(result.getByRole('button', { name: 'Create workspace' }).classList.contains('secondary')).toBe(true);
    expect(result.getByRole('button', { name: 'Refresh' })).toBeTruthy();
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

  it('refresh to an empty list shows the empty state', async () => {
    const result = await mount(fakeWorkspaces(ok(ws('a', 'Alpha', '/a')), ok()).api);
    fireEvent.click(result.getByRole('button', { name: 'Refresh' }));
    await settle();
    expect(view(result)).toBe('empty');
  });

  it('clicking an existing workspace opens the placeholder with Back', async () => {
    const result = await mount(fakeWorkspaces(ok(ws('a', 'Alpha', '/home/me/a'))).api);
    fireEvent.click(result.container.querySelector('.ws-row')!);

    expect(view(result)).toBe('selected');
    expect(result.getByRole('heading', { level: 1 }).textContent).toBe('Alpha');
    expect(result.container.querySelector('.ws-path')?.textContent).toBe('/home/me/a');
    expect(document.activeElement).toBe(result.getByRole('button', { name: 'Back' }));
  });

  it('Enter and Space on a row open the placeholder', async () => {
    const result = await mount(fakeWorkspaces(ok(ws('a', 'Alpha', '/home/me/a'))).api);
    let row = result.container.querySelector('.ws-row')!;
    expect(fireEvent.keyDown(row, { key: 'Enter' })).toBe(false);
    expect(view(result)).toBe('selected');

    fireEvent.click(result.getByRole('button', { name: 'Back' }));
    row = result.container.querySelector('.ws-row')!;
    expect(fireEvent.keyDown(row, { key: ' ' })).toBe(false);
    expect(view(result)).toBe('selected');
  });

  it('Back returns to the list without reloading and focuses the row', async () => {
    const fake = fakeWorkspaces(ok(ws('a', 'Alpha', '/a'), ws('b', 'Beta', '/b')));
    const result = await mount(fake.api);
    fireEvent.click(result.container.querySelector('[data-id="b"]')!);
    fireEvent.click(result.getByRole('button', { name: 'Back' }));

    expect(view(result)).toBe('list');
    expect(fake.list).toHaveBeenCalledTimes(1);
    expect(document.activeElement?.getAttribute('data-id')).toBe('b');
    expect(result.container.querySelector('[data-role="notice"]')).toBeNull();
  });

  it('a missing-folder workspace shows a message instead of opening', async () => {
    const result = await mount(fakeWorkspaces(ok(ws('b', 'Beta', '/mnt/c/b', false))).api);
    const row = result.container.querySelector('.ws-row')!;
    fireEvent.click(row);

    const message = 'The folder for "Beta" no longer exists (/mnt/c/b). It cannot be opened.';
    expect(view(result)).toBe('list');
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
    const rerendered = render(<WorkspacesScreen api={firstApi} />);
    rerendered.rerender(<WorkspacesScreen api={latestApi} />);
    await settle();
    expect(rerendered.container.querySelector('.ws-name')?.textContent).toBe('Latest');
    await act(async () => stale.resolve(ok(ws('old', 'Stale', '/stale'))));
    expect(rerendered.container.querySelector('.ws-name')?.textContent).toBe('Latest');
    expect(rerendered.container.textContent).not.toContain('Stale');
    rerendered.unmount();

    const pending = deferred<unknown>();
    const result = render(<WorkspacesScreen api={fakeWorkspaces(pending).api} />);
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
        connectedView={<WorkspacesScreen api={fake.api} />}
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
