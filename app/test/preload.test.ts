import { catalogFixture } from './teamsFixtures';
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

const METHODS = [
  'overview', 'agents', 'team', 'validateTeam', 'boardSettings', 'createAgent', 'updateAgent', 'deleteAgent',
  'createTeam', 'renameTeam', 'deleteTeam', 'addMember', 'updateMember', 'removeMember', 'updateBoardSettings',
  'roles', 'createRole', 'updateRole', 'updateRoleInstructions', 'deleteRole', 'runBoard', 'stopBoard', 'switchMemberAgent', 'resumeMemberAgent',
];

describe('preload', () => {
  it('exposes exactly the fixed calls on window.agentStudio', () => {
    expect(Object.keys(exposed)).toEqual(['agentStudio']);
    const api = exposed.agentStudio as Record<string, Record<string, unknown>>;
    expect(Object.keys(api).sort()).toEqual(['connection', 'dashboard', 'management', 'workspaces']);
    expect(Object.keys(api.workspaces).sort()).toEqual(['create', 'list', 'pickFolder']);
    expect(Object.keys(api.dashboard).sort()).toEqual(['activity', 'board', 'teams']);
    expect(Object.keys(api.management).sort()).toEqual([...METHODS].sort());
    expect(Object.keys(api.connection)).toEqual(['onChange']);
    for (const k of ['invoke', 'send', 'on', 'ipcRenderer']) expect(k in api).toBe(false);
  });

  it('dashboard calls forward one workspace id on their fixed channels', () => {
    const f = fakeIpc();
    const dashboard = buildApi(f.ipc).dashboard as Record<string, (...a: unknown[]) => unknown>;
    dashboard.teams('ws-1', 'extra');
    dashboard.board('ws-2', 'extra');
    dashboard.activity('ws-3', 'extra');
    expect(f.invoke.mock.calls).toEqual([
      [CHANNELS.dashboardTeams, 'ws-1'],
      [CHANNELS.dashboardBoard, 'ws-2'],
      [CHANNELS.dashboardActivity, 'ws-3'],
    ]);
  });

  it('management calls forward the workspace id and a fixed request on their channel', () => {
    const f = fakeIpc();
    const m = buildApi(f.ipc).management as unknown as Record<string, (...a: unknown[]) => unknown>;
    const sha = 'a'.repeat(64);
    const uuid = '123e4567-e89b-42d3-a456-426614174000';
    const x = 'extra';
    m.overview('ws', x);
    m.agents('ws', x);
    m.team('ws', 'core', x);
    m.validateTeam('ws', 'core', x);
    m.boardSettings('ws', x);
    m.createAgent('ws', { name: 'Ada', provider: 'claude' }, x);
    m.updateAgent('ws', 'ada', { model: null }, x);
    m.deleteAgent('ws', 'ada', x);
    m.createTeam('ws', { name: 'Core' }, x);
    m.createTeam('ws', { name: 'Core', teamDefId: 'core' }, x);
    m.renameTeam('ws', 'core', 'New', x);
    m.deleteTeam('ws', 'core', x);
    m.addMember('ws', 'core', { role: 'Developer' }, x);
    m.updateMember('ws', 'core', 'm1', { role: 'QA' }, x);
    m.removeMember('ws', 'core', 'm1', x);
    m.updateBoardSettings('ws', { baseBranch: 'main' }, undefined, x);
    m.updateBoardSettings('ws', { baseBranch: 'main' }, sha);
    m.roles('ws', x);
    m.createRole('ws', { name: 'QA' }, null, x);
    m.createRole('ws', { id: 'qa', name: 'QA', description: 'd', skills: [] }, sha, x);
    m.updateRole('ws', 'TeamLead', { description: null }, sha, x);
    m.updateRoleInstructions('ws', 'TeamLead', '', sha, null, x);
    m.updateRoleInstructions('ws', 'TeamLead', 'text', sha, sha, x);
    m.deleteRole('ws', 'TeamLead', { expectedRolesSha256: sha, expectedInstructionsSha256: null }, x);
    m.runBoard('ws', uuid, x);
    m.stopBoard('ws', x);
    m.switchMemberAgent('ws', 'core', 'm1', 'ada');
    m.switchMemberAgent('ws', 'core', 'm1', 'ada', { cancelActive: true, assignmentId: uuid }, x);
    m.resumeMemberAgent('ws', 'core', 'm1', 'ada', x);
    const P = PRELOAD_CHANNELS;
    expect(f.invoke.mock.calls).toEqual([
      [P.managementOverview, 'ws', {}],
      [P.managementAgents, 'ws', {}],
      [P.managementTeam, 'ws', { teamDefId: 'core' }],
      [P.managementValidateTeam, 'ws', { teamDefId: 'core' }],
      [P.managementBoardSettings, 'ws', {}],
      [P.managementCreateAgent, 'ws', { agent: { name: 'Ada', provider: 'claude' } }],
      [P.managementUpdateAgent, 'ws', { agentDefId: 'ada', changes: { model: null } }],
      [P.managementDeleteAgent, 'ws', { agentDefId: 'ada' }],
      [P.managementCreateTeam, 'ws', { name: 'Core' }],
      [P.managementCreateTeam, 'ws', { name: 'Core', teamDefId: 'core' }],
      [P.managementRenameTeam, 'ws', { teamDefId: 'core', name: 'New' }],
      [P.managementDeleteTeam, 'ws', { teamDefId: 'core' }],
      [P.managementAddMember, 'ws', { teamDefId: 'core', member: { role: 'Developer' } }],
      [P.managementUpdateMember, 'ws', { teamDefId: 'core', memberId: 'm1', changes: { role: 'QA' } }],
      [P.managementRemoveMember, 'ws', { teamDefId: 'core', memberId: 'm1' }],
      [P.managementUpdateBoardSettings, 'ws', { changes: { baseBranch: 'main' } }],
      [P.managementUpdateBoardSettings, 'ws', { changes: { baseBranch: 'main' }, expectedSha256: sha }],
      [P.managementRoles, 'ws', {}],
      [P.managementCreateRole, 'ws', { input: { name: 'QA' }, expectedRolesSha256: null }],
      [P.managementCreateRole, 'ws', { input: { id: 'qa', name: 'QA', description: 'd', skills: [] }, expectedRolesSha256: sha }],
      [P.managementUpdateRole, 'ws', { roleId: 'TeamLead', changes: { description: null }, expectedRolesSha256: sha }],
      [P.managementUpdateRoleInstructions, 'ws', { roleId: 'TeamLead', text: '', expectedRolesSha256: sha, expectedInstructionsSha256: null }],
      [P.managementUpdateRoleInstructions, 'ws', { roleId: 'TeamLead', text: 'text', expectedRolesSha256: sha, expectedInstructionsSha256: sha }],
      [P.managementDeleteRole, 'ws', { roleId: 'TeamLead', confirmation: { expectedRolesSha256: sha, expectedInstructionsSha256: null } }],
      [P.managementRunBoard, 'ws', { teamId: uuid }],
      [P.managementStopBoard, 'ws', {}],
      [P.managementSwitchMemberAgent, 'ws', { teamDefId: 'core', memberId: 'm1', agent: 'ada' }],
      [P.managementSwitchMemberAgent, 'ws', { teamDefId: 'core', memberId: 'm1', agent: 'ada', confirmation: { cancelActive: true, assignmentId: uuid } }],
      [P.managementResumeMemberAgent, 'ws', { teamDefId: 'core', memberId: 'm1', agent: 'ada' }],
    ]);
  });

  it('management agents returns the fixed invoke result unchanged', async () => {
    const result = { ok: true, data: catalogFixture() };
    const f = fakeIpc(result);
    expect(await buildApi(f.ipc).management.agents('ws')).toEqual(result);
    expect(f.invoke.mock.calls).toEqual([[PRELOAD_CHANNELS.managementAgents, 'ws', {}]]);
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
