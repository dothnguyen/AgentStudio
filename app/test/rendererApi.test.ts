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
import { boardPhasesFixture, boardTicketDetailFixture, boardTicketSummary, fakeBoardManagement } from './boardFixtures';
import type { BoardShow, BoardSettings } from '../src/renderer/api';
import { boardSettingsFixture } from './teamsFixtures';

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
    'overview', 'agents', 'team', 'validateTeam', 'boardSettings', 'boardPhases', 'boardTickets', 'boardTicket',
    'saveBoardWorkflow', 'deleteBoardWorkflow', 'savePrompt', 'deletePrompt', 'addStatus', 'renameStatus', 'removeStatus', 'reorderStatuses', 'approveWorkflow', 'answerAssignment',
    'boardWorkflows', 'boardWorkflow', 'prompts', 'prompt', 'checkSets', 'boardStatuses',
    'createAgent', 'updateAgent', 'deleteAgent',
    'createTeam', 'renameTeam', 'deleteTeam', 'addMember', 'updateMember', 'removeMember', 'updateBoardSettings',
    'roles', 'createRole', 'updateRole', 'updateRoleInstructions', 'deleteRole',
    'skills', 'skill', 'createSkill', 'updateSkill', 'deleteSkill', 'updateSkillRoles',
    'runBoard', 'stopBoard', 'switchMemberAgent', 'resumeMemberAgent',
    'resetUsage', 'retryRun', 'cancelRun', 'ticketMove', 'ticketWorkflow', 'retryTicket', 'unblockTicket', 'approveCommand', 'rejectCommand', 'cancelCommand', 'attachInfo',
    'startTeam', 'stopTeam',
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

  it('renderer can read phases, tickets and one ticket from the fake board', async () => {
    const board = fakeBoardManagement();
    window.agentStudio = { connection: { onChange: () => () => {} }, management: { ...fakes(), ...board.api } as never };
    const api = getManagementApi();
    expect(await api.boardPhases('ws')).toEqual({ ok: true, data: boardPhasesFixture() });
    const list = await api.boardTickets('ws', { phase: 'phase-06' });
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.data.tickets).toHaveLength(12);
      expect(list.data.tickets.filter((ticket) => ticket.status === 'blocked')).toHaveLength(1);
      expect(list.data.tickets.some((ticket) => ticket.activity.state === 'not started' && ticket.activity.waitingFor)).toBe(true);
      expect(list.data.tickets.every((ticket) => !('body' in ticket))).toBe(true);
    }
    const detail = await api.boardTicket('ws', { key: 'T-114' });
    expect(detail.ok).toBe(true);
    if (detail.ok) expect(detail.data.ticket.body).toContain('#');
    expect(detail.ok ? detail.data : null).toEqual(boardTicketDetailFixture('T-114'));
    expect(board.phases).toHaveBeenCalledWith('ws');
    expect(board.tickets).toHaveBeenCalledWith('ws', { phase: 'phase-06' });
    expect(board.ticket).toHaveBeenCalledWith('ws', { key: 'T-114' });
  });

  it('models Kanban columns separately from workflow statuses and exposes workflow board settings', () => {
    const ticket = boardTicketSummary({ status: 'todo', workflowStatus: 'dev-ready' });
    expect(ticket.status).toBe('todo');
    expect(ticket.workflowStatus).toBe('dev-ready');

    const settings: BoardSettings = {
      ...boardSettingsFixture(),
      workflowStatuses: [{ id: 'dev-ready', name: 'Development ready', kind: null }],
      todoEntry: ['dev-ready'],
      todoDefault: 'dev-ready',
      rules: [{
        index: 0, status: 'dev-ready', type: 'agent', role: 'Developer', workflow: 'board-develop', during: 'developing',
        action: null, onPass: 'qa-ready', onFail: 'dev-ready', onBlocked: null, workspace: 'worktree', syncBase: false,
        maxRounds: null, priority: null, onFailureLimit: null, protected: false,
      }],
    };
    expect(settings.workflowStatuses[0]?.id).toBe('dev-ready');
    expect(settings.todoEntry).toEqual(['dev-ready']);
    expect(settings.todoDefault).toBe('dev-ready');
    expect(settings.rules[0]?.during).toBe('developing');

    const board: BoardShow = {
      workspace: '/work/alpha',
      currentPhase: { id: 'phase-06-id', slug: 'phase-06', name: 'Phase 06', description: null, position: 1, status: 'open' },
      phases: [{
        id: 'phase-06-id', slug: 'phase-06', name: 'Phase 06', description: null, position: 1, status: 'open', current: true,
        ticketCount: 1,
        columns: { backlog: 0, todo: 1, 'in-progress': 0, done: 0, closed: 0 },
        workflow: { 'dev-ready': 1 },
        columnWorkflow: { backlog: {}, todo: { 'dev-ready': 1 }, 'in-progress': {}, done: {}, closed: {} },
        waitingApproval: 0, needsInput: 0, blocked: 0, paused: 0,
      }],
    };
    expect(board.phases[0]?.columns.todo).toBe(1);
    expect(board.phases[0]?.columnWorkflow.todo['dev-ready']).toBe(1);
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

  it('forwards skill methods with their arguments and returns success and error results unchanged', async () => {
    const error = { ok: false as const, error: { code: 'CONFIG_CHANGED', message: 'm', retryable: false, data: { skillSha256: 'x' } } };
    const fns = fakes();
    for (const m of ['skills', 'skill', 'createSkill', 'updateSkill', 'deleteSkill', 'updateSkillRoles']) fns[m] = vi.fn(async () => error);
    window.agentStudio = { connection: { onChange: () => () => {} }, management: { ...fns, extra: vi.fn() } as never };
    const api = getManagementApi();
    const sha = 'a'.repeat(64);
    expect(await api.skills('ws')).toBe(error);
    expect(await api.skill('ws', 'code-search')).toBe(error);
    expect(await api.createSkill('ws', { id: 'new-skill', text: '' })).toBe(error);
    expect(await api.updateSkill('ws', 'code-search', 'text', sha)).toBe(error);
    expect(await api.deleteSkill('ws', 'ts-testing', null, sha)).toBe(error);
    expect(await api.updateSkillRoles('ws', 'code-search', ['Developer'], sha)).toBe(error);
    expect(fns.skills).toHaveBeenCalledWith('ws');
    expect(fns.skill).toHaveBeenCalledWith('ws', 'code-search');
    expect(fns.createSkill).toHaveBeenCalledWith('ws', { id: 'new-skill', text: '' });
    expect(fns.updateSkill).toHaveBeenCalledWith('ws', 'code-search', 'text', sha);
    expect(fns.deleteSkill).toHaveBeenCalledWith('ws', 'ts-testing', null, sha);
    expect(fns.updateSkillRoles).toHaveBeenCalledWith('ws', 'code-search', ['Developer'], sha);
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
