// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  getConnectionApi,
  getDashboardApi,
  getWorkspacesApi,
  type ConnectionStatus,
  type CreateArgs,
  type DashboardActivity,
} from '../src/renderer/api';

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

describe('getDashboardApi', () => {
  it('throws when the preload dashboard API is missing', () => {
    window.agentStudio = { connection: { onChange: () => () => {} } };
    expect(() => getDashboardApi()).toThrow('Agent Studio preload API is missing (window.agentStudio.dashboard).');
  });

  it('forwards teams board and activity and preserves Results', async () => {
    const teamsResult = { ok: true as const, data: { workspace: '/a', teams: [], truncated: false } };
    const boardResult = { ok: true as const, data: { workspace: '/a', columns: [], tickets: [], totals: { active: 0, blocked: 0, done: 0 }, currentPhase: { slug: 'p', name: 'P', status: 'open' as const } } };
    const activityData: DashboardActivity = {
      workspace: '/a',
      dbId: 'db-a',
      head: 4,
      entries: [{
        id: 'ticket-event:4',
        at: '2026-10-26T00:00:00Z',
        kind: 'ticket',
        name: 'ticket.moved',
        summary: 'Ticket T-019 moved to done',
        subject: { type: 'ticket', id: 'ticket-id', label: 'T-019' },
      }],
    };
    const activityResult = { ok: true as const, data: activityData };
    const teams = vi.fn(async () => teamsResult);
    const board = vi.fn(async () => boardResult);
    const activity = vi.fn(async () => activityResult);
    window.agentStudio = { connection: { onChange: () => () => {} }, dashboard: { teams, board, activity } };
    const api = getDashboardApi();
    expect(await api.teams('ws-a')).toEqual(teamsResult);
    expect(await api.board('ws-b')).toEqual(boardResult);
    expect(await api.activity('ws-c')).toEqual(activityResult);
    expect(teams).toHaveBeenCalledWith('ws-a');
    expect(board).toHaveBeenCalledWith('ws-b');
    expect(activity).toHaveBeenCalledWith('ws-c');
  });

  it('returns its own narrow forwarding object', () => {
    const dashboard = { teams: vi.fn(), board: vi.fn(), activity: vi.fn(), extraPreloadMethod: vi.fn() };
    window.agentStudio = { connection: { onChange: () => () => {} }, dashboard };
    const api = getDashboardApi();
    expect(api).not.toBe(dashboard);
    expect(Object.keys(api).sort()).toEqual(['activity', 'board', 'teams']);
  });
});
