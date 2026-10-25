import { describe, expect, it, vi } from 'vitest';

const exposed = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (k: string, v: unknown) => void (exposed[k] = v) },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
}));

import { CHANNELS } from '../src/main/ipc';
import { PRELOAD_CHANNELS, buildApi } from '../src/preload/preload';

function fakeIpc(getResult: unknown = { state: 'connecting', error: null }) {
  const listeners = new Map<string, (e: unknown, s: unknown) => void>();
  const invoke = vi.fn(async (_c: string, ..._a: unknown[]) => getResult);
  const on = vi.fn((c: string, l: (e: unknown, s: unknown) => void) => void listeners.set(c, l));
  const removeListener = vi.fn((c: string) => void listeners.delete(c));
  return { ipc: { invoke, on, removeListener } as never, invoke, on, removeListener, listeners };
}

describe('preload', () => {
  it('exposes exactly the four calls on window.agentStudio', () => {
    expect(Object.keys(exposed)).toEqual(['agentStudio']);
    const api = exposed.agentStudio as Record<string, Record<string, unknown>>;
    expect(Object.keys(api).sort()).toEqual(['connection', 'workspaces']);
    expect(Object.keys(api.workspaces).sort()).toEqual(['create', 'list', 'pickFolder']);
    expect(Object.keys(api.connection)).toEqual(['onChange']);
    for (const k of ['invoke', 'send', 'on', 'ipcRenderer']) expect(k in api).toBe(false);
  });

  it('channel strings equal the main process constants', () => {
    expect(PRELOAD_CHANNELS).toEqual(CHANNELS);
  });

  it('list and pickFolder forward no arguments; create forwards exactly one', () => {
    const f = fakeIpc();
    const api = buildApi(f.ipc);
    (api.workspaces.list as (...a: unknown[]) => unknown)(1, 2);
    (api.workspaces.pickFolder as (...a: unknown[]) => unknown)(1);
    (api.workspaces.create as (...a: unknown[]) => unknown)({ path: 'a' }, 'extra');
    expect(f.invoke.mock.calls).toEqual([
      [CHANNELS.list],
      [CHANNELS.pickFolder],
      [CHANNELS.create, { path: 'a' }],
    ]);
  });

  it('onChange delivers the initial state and pushes without the event, and unsubscribes', async () => {
    const f = fakeIpc();
    const cb = vi.fn();
    const off = buildApi(f.ipc).connection.onChange(cb);
    await Promise.resolve();
    await Promise.resolve();
    expect(cb).toHaveBeenCalledWith({ state: 'connecting', error: null });
    f.listeners.get(CHANNELS.connectionState)!({ sender: 1 }, { state: 'ready', error: null });
    expect(cb).toHaveBeenLastCalledWith({ state: 'ready', error: null });
    off();
    off();
    expect(f.removeListener).toHaveBeenCalledWith(CHANNELS.connectionState, expect.any(Function));
  });

  it('a push before the get result wins; a late get result after unsubscribe is dropped', async () => {
    const f = fakeIpc();
    const cb = vi.fn();
    buildApi(f.ipc).connection.onChange(cb);
    f.listeners.get(CHANNELS.connectionState)!({}, { state: 'ready', error: null });
    await Promise.resolve();
    await Promise.resolve();
    expect(cb).toHaveBeenCalledTimes(1);

    const g = fakeIpc();
    const cb2 = vi.fn();
    buildApi(g.ipc).connection.onChange(cb2)();
    await Promise.resolve();
    await Promise.resolve();
    expect(cb2).not.toHaveBeenCalled();
  });

  it('does not deliver a push after unsubscribe', () => {
    const f = fakeIpc();
    const cb = vi.fn();
    const off = buildApi(f.ipc).connection.onChange(cb);
    const listener = f.listeners.get(CHANNELS.connectionState)!;
    off();
    listener({}, { state: 'ready', error: null });
    expect(cb).not.toHaveBeenCalled();
  });
});
