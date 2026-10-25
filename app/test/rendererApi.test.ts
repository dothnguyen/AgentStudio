// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { getConnectionApi, getWorkspacesApi, type ConnectionStatus, type CreateArgs } from '../src/renderer/api';

describe('getConnectionApi', () => {
  it('getConnectionApi throws when the preload API is missing', () => {
    delete window.agentStudio;
    expect(() => getConnectionApi()).toThrow('Agent Studio preload API is missing (window.agentStudio).');
  });

  it('getConnectionApi normalises payloads and returns the real unsubscribe', () => {
    const off = vi.fn();
    window.agentStudio = {
      connection: {
        onChange: (cb) => {
          cb({ state: 'lost', error: 'x' });
          return off;
        },
      },
    };
    const got: ConnectionStatus[] = [];
    const unsub = getConnectionApi().onChange((s) => got.push(s));
    expect(got).toEqual([{ state: 'lost', error: 'x', distro: null, command: null }]);
    expect(unsub).toBe(off);
  });
});

describe('getWorkspacesApi', () => {
  it('getWorkspacesApi throws when the preload workspaces API is missing', () => {
    window.agentStudio = { connection: { onChange: () => () => {} } };
    expect(() => getWorkspacesApi()).toThrow('Agent Studio preload API is missing (window.agentStudio.workspaces).');
  });

  it('getWorkspacesApi forwards list, create, and pickFolder', async () => {
    const listResult = { ok: true as const, data: { workspaces: [] } };
    const createResult = {
      ok: true as const,
      data: { id: 'a', name: 'Alpha', path: '/home/me/a', existed: false },
    };
    const pickResult = { ok: true as const, data: '/mnt/c/Works/project' };
    const list = vi.fn(async () => listResult);
    const create = vi.fn(async (_args: CreateArgs) => createResult);
    const pickFolder = vi.fn(async () => pickResult);
    window.agentStudio = {
      connection: { onChange: () => () => {} },
      workspaces: { list, create, pickFolder },
    };
    const api = getWorkspacesApi();
    const args = { path: '/home/me/a', name: 'Alpha' };
    expect(await api.list()).toEqual(listResult);
    expect(await api.create(args)).toEqual(createResult);
    expect(await api.pickFolder()).toEqual(pickResult);
    expect(list).toHaveBeenCalledWith();
    expect(create).toHaveBeenCalledWith(args);
    expect(pickFolder).toHaveBeenCalledWith();
  });

  it('getWorkspacesApi returns its own narrow forwarding object', () => {
    const workspaces = {
      list: vi.fn(async () => ({ ok: true as const, data: { workspaces: [] } })),
      create: vi.fn(async (_args: CreateArgs) => ({
        ok: true as const,
        data: { id: 'a', name: 'Alpha', path: '/a', existed: false },
      })),
      pickFolder: vi.fn(async () => ({ ok: true as const, data: null })),
      extraPreloadMethod: vi.fn(),
    };
    window.agentStudio = {
      connection: { onChange: () => () => {} },
      workspaces,
    };

    const api = getWorkspacesApi();
    expect(api).not.toBe(workspaces);
    expect(Object.keys(api).sort()).toEqual(['create', 'list', 'pickFolder']);
  });
});
