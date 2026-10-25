import { describe, expect, it } from 'vitest';
import { CHANNELS, forwardState, pickedPath, registerIpc, type ServeLike } from '../src/main/ipc';
import type { ConnectionPayload } from '../src/shared/api';
import { ServeError, type StateChange } from '../src/main/serveClient';

type Handler = (e: unknown, ...a: unknown[]) => unknown;

function setup(over: Partial<{ distro: string | null; reply: unknown; fail: unknown; picked: string | null }> = {}) {
  const handlers = new Map<string, Handler>();
  const calls: Array<[string, unknown]> = [];
  const listeners: Array<(s: StateChange) => void> = [];
  let dialogs = 0;
  const client: ServeLike = {
    state: 'ready' as StateChange['state'],
    lastError: null,
    diagnostics: { distro: 'Ubuntu', command: 'wsl.exe -d Ubuntu --exec /e serve' },
    distro: over.distro === undefined ? 'Ubuntu' : over.distro,
    async request(command, args) {
      calls.push([command, args]);
      if (over.fail) throw over.fail;
      return (over.reply ?? { protocol: 1, id: '1', ok: true, data: { x: 1 } }) as never;
    },
    on: (_e, l) => void listeners.push(l),
    off: (_e, l) => void listeners.splice(listeners.indexOf(l), 1),
  };
  registerIpc({
    ipcMain: { handle: (c, l) => void handlers.set(c, l) },
    client,
    showFolderDialog: async () => {
      dialogs++;
      return over.picked === undefined ? null : over.picked;
    },
  });
  const call = (c: string, ...a: unknown[]) => handlers.get(c)!({}, ...a);
  return { handlers, calls, listeners, call, client, dialogs: () => dialogs };
}

describe('registerIpc', () => {
  it('registers exactly the four invoke channels', () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual(
      [CHANNELS.list, CHANNELS.create, CHANNELS.pickFolder, CHANNELS.connectionGet].sort(),
    );
  });

  it('list returns the data as is and sends workspace.list', async () => {
    const s = setup();
    expect(await s.call(CHANNELS.list)).toEqual({ ok: true, data: { x: 1 } });
    expect(s.calls).toEqual([['workspace.list', {}]]);
  });

  it('list rejects arguments', async () => {
    const s = setup();
    expect(await s.call(CHANNELS.list, 1)).toEqual({
      ok: false,
      error: { code: 'BAD_ARGS', message: 'workspaces.list takes no arguments.', retryable: false },
    });
    expect(s.calls).toEqual([]);
  });

  it('transport errors are retryable', async () => {
    const s = setup({ fail: new ServeError('NOT_CONNECTED', 'nope') });
    expect(await s.call(CHANNELS.list)).toEqual({
      ok: false,
      error: { code: 'NOT_CONNECTED', message: 'nope', retryable: true },
    });
  });

  it('other thrown errors become INTERNAL', async () => {
    const s = setup({ fail: new Error('boom') });
    expect(await s.call(CHANNELS.list)).toEqual({
      ok: false,
      error: { code: 'INTERNAL', message: 'boom', retryable: false },
    });
  });

  it('create converts a Windows path and omits name', async () => {
    const s = setup();
    expect(await s.call(CHANNELS.create, { path: 'C:\\Works\\x' })).toEqual({ ok: true, data: { x: 1 } });
    expect(s.calls).toEqual([['workspace.init', { path: '/mnt/c/Works/x' }]]);
  });

  it('create forwards name, including the empty string', async () => {
    const s = setup();
    await s.call(CHANNELS.create, { path: '/home/me/p', name: 'P' });
    await s.call(CHANNELS.create, { path: '/home/me/p', name: '' });
    expect(s.calls).toEqual([
      ['workspace.init', { path: '/home/me/p', name: 'P' }],
      ['workspace.init', { path: '/home/me/p', name: '' }],
    ]);
  });

  it('create returns the backend error object unchanged', async () => {
    const error = { code: 'BAD_REQUEST', message: 'bad', retryable: false, remediation: 'fix it' };
    const s = setup({ reply: { protocol: 1, id: '1', ok: false, error } });
    const r = (await s.call(CHANNELS.create, { path: '/a' })) as { error: unknown };
    expect(r.error).toBe(error);
  });

  it('create reports BAD_RESPONSE when ok:false has no error', async () => {
    const s = setup({ reply: { protocol: 1, id: '1', ok: false } });
    expect(await s.call(CHANNELS.create, { path: '/a' })).toEqual({
      ok: false,
      error: { code: 'BAD_RESPONSE', message: 'serve returned ok:false without an error.', retryable: false },
    });
  });

  it('create returns path conversion errors', async () => {
    const s = setup();
    const r = (await s.call(CHANNELS.create, { path: 'rel/x' })) as { ok: boolean; error: { code: string } };
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('PATH_RELATIVE');
    expect(s.calls).toEqual([]);
  });

  it('create without a known distro fails UNC paths with PATH_DISTRO_UNKNOWN', async () => {
    const s = setup({ distro: null });
    const r = (await s.call(CHANNELS.create, { path: '\\\\wsl$\\Ubuntu\\home\\me' })) as { error: { code: string } };
    expect(r.error.code).toBe('PATH_DISTRO_UNKNOWN');
  });

  it.each([[[]], [['a']], [[{ path: 1 }]], [[{ path: 'a', extra: 1 }]], [[{ path: 'a', name: 2 }]], [[null]], [[[]]], [[{ path: 'a' }, 2]]])(
    'create rejects bad args %j',
    async (args) => {
      const s = setup();
      const r = (await s.call(CHANNELS.create, ...(args as unknown[]))) as { error: { code: string; message: string } };
      expect(r.error.code).toBe('BAD_ARGS');
      expect(r.error.message).toBe('workspaces.create expects one argument { path: string, name?: string }.');
      expect(s.calls).toEqual([]);
    },
  );

  it('pickFolder returns null on cancel and a WSL path otherwise', async () => {
    expect(await setup({ picked: null }).call(CHANNELS.pickFolder)).toEqual({ ok: true, data: null });
    const s = setup({ picked: 'D:\\code\\p' });
    expect(await s.call(CHANNELS.pickFolder)).toEqual({ ok: true, data: '/mnt/d/code/p' });
    expect(s.calls).toEqual([]);
  });

  it('pickFolder returns conversion errors and rejects args without opening the dialog', async () => {
    const s = setup({ picked: '\\\\server\\share\\x' });
    expect(await s.call(CHANNELS.pickFolder)).toEqual({
      ok: false,
      error: {
        code: 'PATH_UNC_SHARE',
        message: "Network shares are not supported: '\\\\server\\share\\x'. Pick a folder on a local drive or in WSL.",
        retryable: false,
      },
    });
    const s2 = setup();
    expect(((await s2.call(CHANNELS.pickFolder, 1)) as { error: { code: string } }).error.code).toBe('BAD_ARGS');
    expect(s2.dialogs()).toBe(0);
  });

  it('connection:get returns the state and throws with arguments', () => {
    const s = setup();
    expect(s.call(CHANNELS.connectionGet)).toEqual({ state: 'ready', error: null, distro: 'Ubuntu', command: 'wsl.exe -d Ubuntu --exec /e serve' });
    expect(() => s.call(CHANNELS.connectionGet, 1)).toThrow('connection.get takes no arguments.');
  });
});

describe('forwardState and pickedPath', () => {
  it('forwards state changes and stops after the returned off', () => {
    const s = setup();
    const sent: Array<[string, ConnectionPayload]> = [];
    const stop = forwardState(s.client, (c, p) => sent.push([c, p]));
    s.listeners[0]({ state: 'ready' as StateChange['state'], error: null });
    expect(sent).toEqual([[CHANNELS.connectionState, { state: 'ready', error: null, distro: 'Ubuntu', command: 'wsl.exe -d Ubuntu --exec /e serve' }]]);
    stop();
    expect(s.listeners).toHaveLength(0);
  });

  it('pickedPath handles cancel, empty and a pick', () => {
    expect(pickedPath({ canceled: true, filePaths: ['x'] })).toBeNull();
    expect(pickedPath({ canceled: false, filePaths: [] })).toBeNull();
    expect(pickedPath({ canceled: false, filePaths: ['C:\\a'] })).toBe('C:\\a');
  });
});
