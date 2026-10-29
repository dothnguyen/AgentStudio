// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  getConnectionApi,
  getDashboardApi,
  getManagementApi,
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

describe('getManagementApi', () => {
  const METHODS = [
    'overview', 'agents', 'team', 'validateTeam', 'boardSettings', 'createAgent', 'updateAgent', 'deleteAgent',
    'createTeam', 'renameTeam', 'deleteTeam', 'addMember', 'updateMember', 'removeMember', 'updateBoardSettings',
    'roles', 'createRole', 'updateRole', 'updateRoleInstructions', 'deleteRole', 'runBoard', 'stopBoard', 'switchMemberAgent', 'resumeMemberAgent',
  ];
  const fakes = () => {
    const fns: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const m of METHODS) fns[m] = vi.fn(async () => ({ ok: true as const, data: { m } }));
    return fns;
  };

  it('getManagementApi throws when the preload management API is missing', () => {
    window.agentStudio = { connection: { onChange: () => () => {} } };
    expect(() => getManagementApi()).toThrow('Agent Studio preload API is missing (window.agentStudio.management).');
  });

  it('getManagementApi forwards every method and preserves Results', async () => {
    const fns = fakes();
    window.agentStudio = { connection: { onChange: () => () => {} }, management: fns as never };
    const api = getManagementApi() as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    for (const m of METHODS) {
      const args = m === 'switchMemberAgent' || m === 'resumeMemberAgent' ? ['ws', 'core', 'm1', 'ada'] : ['ws', 'a', { b: 1 }];
      expect(await api[m](...args)).toEqual({ ok: true, data: { m } });
      expect(fns[m]).toHaveBeenCalledWith(...args);
    }
  });

  it('forwards role methods with their arguments and returns success and error results unchanged', async () => {
    const error = { ok: false as const, error: { code: 'CONFIG_CHANGED', message: 'm', retryable: false, data: { sha256: 'x' } } };
    const fns = fakes();
    for (const m of ['roles', 'createRole', 'updateRole', 'updateRoleInstructions', 'deleteRole']) fns[m] = vi.fn(async () => error);
    window.agentStudio = { connection: { onChange: () => () => {} }, management: { ...fns, extra: vi.fn() } as never };
    const api = getManagementApi();
    const sha = 'a'.repeat(64);
    const conf = { expectedRolesSha256: sha, expectedInstructionsSha256: null };
    expect(await api.roles('ws')).toBe(error);
    expect(await api.createRole('ws', { name: 'QA' }, null)).toBe(error);
    expect(await api.updateRole('ws', 'QA', { skills: [] }, sha)).toBe(error);
    expect(await api.updateRoleInstructions('ws', 'QA', '', sha, null)).toBe(error);
    expect(await api.deleteRole('ws', 'QA', conf)).toBe(error);
    expect(fns.roles).toHaveBeenCalledWith('ws');
    expect(fns.createRole).toHaveBeenCalledWith('ws', { name: 'QA' }, null);
    expect(fns.updateRole).toHaveBeenCalledWith('ws', 'QA', { skills: [] }, sha);
    expect(fns.updateRoleInstructions).toHaveBeenCalledWith('ws', 'QA', '', sha, null);
    expect(fns.deleteRole).toHaveBeenCalledWith('ws', 'QA', conf);
    expect('extra' in api).toBe(false);
  });

  it('forwards switch confirmation', async () => {
    const fns = fakes();
    window.agentStudio = { connection: { onChange: () => () => {} }, management: fns as never };
    const api = getManagementApi();
    const confirmation = { cancelActive: true as const, assignmentId: '123e4567-e89b-42d3-a456-426614174000' };
    await api.switchMemberAgent('ws', 'core', 'm1', 'ada', confirmation);
    expect(fns.switchMemberAgent).toHaveBeenCalledWith('ws', 'core', 'm1', 'ada', confirmation);
  });

  it('getManagementApi returns its own narrow forwarding object', () => {
    const fns = { ...fakes(), extra: vi.fn() };
    window.agentStudio = { connection: { onChange: () => () => {} }, management: fns as never };
    const api = getManagementApi();
    expect(api).not.toBe(fns);
    expect(Object.keys(api).sort()).toEqual([...METHODS].sort());
  });
});
