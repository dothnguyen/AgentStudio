import { catalogFixture } from './teamsFixtures';
import { roleCatalogFixture } from './roleFixtures';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { registerIpc, type ServeLike } from '../src/main/ipc';
import { MANAGEMENT_CHANNELS as C } from '../src/main/managementSpecs';
import { ServeError } from '../src/main/serveClient';

type Handler = (e: unknown, ...a: unknown[]) => unknown;
type Opts = { timeoutMs?: number; idempotencyKey?: string } | undefined;

const WS = { id: 'workspace-a', name: 'A', path: '/work/a', missing: false, exists: true };
const ok = (data: unknown) => ({ protocol: 1, id: '1', ok: true, data });
const UUID = '123e4567-e89b-42d3-a456-426614174000';
const SHA = 'a'.repeat(64);

function setup(
  over: {
    workspaces?: unknown[];
    replies?: Record<string, unknown>;
    failures?: Record<string, unknown>;
    newIdempotencyKey?: () => string;
  } = {},
) {
  const handlers = new Map<string, Handler>();
  const calls: Array<[string, unknown]> = [];
  const optsSeen: Opts[] = [];
  const client: ServeLike = {
    state: 'ready' as never,
    lastError: null,
    diagnostics: { distro: 'Ubuntu', command: null },
    distro: 'Ubuntu',
    async request(command, args, opts) {
      calls.push([command, args]);
      optsSeen.push(opts);
      if (over.failures?.[command]) throw over.failures[command];
      if (command === 'workspace.list') return ok({ workspaces: over.workspaces ?? [WS] }) as never;
      return (over.replies?.[command] ?? ok({ payload: command })) as never;
    },
    on: () => undefined,
    off: () => undefined,
  };
  registerIpc({
    ipcMain: { handle: (c, l) => void handlers.set(c, l) },
    client,
    showFolderDialog: async () => null,
    ...(over.newIdempotencyKey ? { newIdempotencyKey: over.newIdempotencyKey } : {}),
  });
  const call = (c: string, ...a: unknown[]) => handlers.get(c)!({}, ...a) as Promise<any>;
  return { handlers, calls, optsSeen, call };
}

const LABELS: Record<string, string> = {
  [C.managementOverview]: 'overview',
  [C.managementAgents]: 'agents',
  [C.managementTeam]: 'team',
  [C.managementValidateTeam]: 'validateTeam',
  [C.managementBoardSettings]: 'boardSettings',
  [C.managementCreateAgent]: 'createAgent',
  [C.managementUpdateAgent]: 'updateAgent',
  [C.managementDeleteAgent]: 'deleteAgent',
  [C.managementCreateTeam]: 'createTeam',
  [C.managementRenameTeam]: 'renameTeam',
  [C.managementDeleteTeam]: 'deleteTeam',
  [C.managementAddMember]: 'addMember',
  [C.managementUpdateMember]: 'updateMember',
  [C.managementRemoveMember]: 'removeMember',
  [C.managementUpdateBoardSettings]: 'updateBoardSettings',
  [C.managementRoles]: 'roles',
  [C.managementCreateRole]: 'createRole',
  [C.managementUpdateRole]: 'updateRole',
  [C.managementUpdateRoleInstructions]: 'updateRoleInstructions',
  [C.managementDeleteRole]: 'deleteRole',
  [C.managementRunBoard]: 'runBoard',
  [C.managementStopBoard]: 'stopBoard',
  [C.managementSwitchMemberAgent]: 'switchMemberAgent',
  [C.managementResumeMemberAgent]: 'resumeMemberAgent',
};

const ROWS: Array<[string, Record<string, unknown>, string, Record<string, unknown>]> = [
  [C.managementOverview, {}, 'team.overview', {}],
  [C.managementAgents, {}, 'agentdef.list', {}],
  [C.managementTeam, { teamDefId: 'core' }, 'teamdef.show', { teamDefId: 'core' }],
  [C.managementValidateTeam, { teamDefId: 'core' }, 'teamdef.validate', { teamDefId: 'core' }],
  [C.managementBoardSettings, {}, 'board.settings', {}],
  [C.managementCreateAgent, { agent: { id: 'ada', name: 'Ada', provider: 'claude' } }, 'agentdef.create', { agent: { id: 'ada', name: 'Ada', provider: 'claude' } }],
  [C.managementUpdateAgent, { agentDefId: 'ada', changes: { model: null } }, 'agentdef.update', { agentDefId: 'ada', changes: { model: null } }],
  [C.managementDeleteAgent, { agentDefId: 'ada' }, 'agentdef.delete', { agentDefId: 'ada' }],
  [C.managementCreateTeam, { name: 'Core', teamDefId: 'core' }, 'teamdef.create', { name: 'Core', teamDefId: 'core' }],
  [C.managementRenameTeam, { teamDefId: 'core', name: 'New' }, 'teamdef.rename', { teamDefId: 'core', name: 'New' }],
  [C.managementDeleteTeam, { teamDefId: 'core' }, 'teamdef.delete', { teamDefId: 'core' }],
  [C.managementAddMember, { teamDefId: 'core', member: { role: 'Developer', agent: 'ada' } }, 'teamdef.member.add', { teamDefId: 'core', role: 'Developer', agent: 'ada' }],
  [C.managementUpdateMember, { teamDefId: 'core', memberId: 'm1', changes: { role: 'QA' } }, 'teamdef.member.update', { teamDefId: 'core', memberId: 'm1', role: 'QA' }],
  [C.managementRemoveMember, { teamDefId: 'core', memberId: 'm1' }, 'teamdef.member.remove', { teamDefId: 'core', memberId: 'm1' }],
  [C.managementUpdateBoardSettings, { changes: { baseBranch: 'main' }, expectedSha256: SHA }, 'board.settings.update', { changes: { baseBranch: 'main' }, expectedSha256: SHA }],
  [C.managementRoles, {}, 'role.list', {}],
  [C.managementCreateRole, { input: { name: 'QA' }, expectedRolesSha256: null }, 'role.create', { name: 'QA', expectedSha256: null }],
  [C.managementUpdateRole, { roleId: 'TeamLead', changes: { description: null }, expectedRolesSha256: SHA }, 'role.update', { role: 'TeamLead', description: null, expectedSha256: SHA }],
  [C.managementUpdateRoleInstructions, { roleId: 'TeamLead', text: '', expectedRolesSha256: SHA, expectedInstructionsSha256: null }, 'role.instructions.update', { role: 'TeamLead', text: '', expectedRolesSha256: SHA, expectedInstructionsSha256: null }],
  [C.managementDeleteRole, { roleId: 'TeamLead', confirmation: { expectedRolesSha256: SHA, expectedInstructionsSha256: null } }, 'role.delete', { role: 'TeamLead', expectedRolesSha256: SHA, expectedInstructionsSha256: null }],
  [C.managementRunBoard, { teamId: UUID }, 'board.run', { teamId: UUID }],
  [C.managementStopBoard, {}, 'board.stop', {}],
  [C.managementSwitchMemberAgent, { teamDefId: 'core', memberId: 'm1', agent: 'ada' }, 'team.member.switch', { teamDefId: 'core', memberId: 'm1', agent: 'ada' }],
  [C.managementResumeMemberAgent, { teamDefId: 'core', memberId: 'm1', agent: 'ada' }, 'team.member.resume', { teamDefId: 'core', memberId: 'm1', agent: 'ada' }],
];

const SLUG_MSG = (f: string) => `${f} must be a slug (lowercase letters, digits, '-'; at most 64 characters).`;

describe('management IPC', () => {
  it.each(ROWS)('every management channel resolves the workspace and sends its fixed command: %s', async (channel, request, command, expected) => {
    const { call, calls } = setup();
    const r = await call(channel, 'workspace-a', request);
    expect(calls).toEqual([['workspace.list', {}], [command, { workspace: '/work/a', ...expected }]]);
    expect(r).toEqual({ ok: true, data: { payload: command } });
  });

  it('forwards agent editor options unchanged', async () => {
    const catalog = catalogFixture({ workspace: '/work/a' });
    const { call, calls } = setup({ replies: { 'agentdef.list': ok(catalog) } });
    expect(await call(C.managementAgents, 'workspace-a', {})).toEqual({ ok: true, data: catalog });
    expect(calls).toEqual([['workspace.list', {}], ['agentdef.list', { workspace: '/work/a' }]]);
  });

  it('optional keys are omitted when absent', async () => {
    const { call, calls } = setup();
    await call(C.managementCreateTeam, 'workspace-a', { name: 'Core' });
    await call(C.managementUpdateBoardSettings, 'workspace-a', { changes: { baseBranch: 'main' }, expectedSha256: undefined });
    const targets = calls.filter(([c]) => c !== 'workspace.list');
    expect(targets[0][1]).toEqual({ workspace: '/work/a', name: 'Core' });
    expect('expectedSha256' in (targets[1][1] as object)).toBe(false);
  });

  it('member fields are flattened', async () => {
    const { call, calls } = setup();
    await call(C.managementAddMember, 'workspace-a', { teamDefId: 'core', member: { agent: 'ada', role: 'Developer' } });
    await call(C.managementUpdateMember, 'workspace-a', { teamDefId: 'core', memberId: 'm1', changes: { model: null } });
    const targets = calls.filter(([c]) => c !== 'workspace.list');
    expect(targets[0]).toEqual(['teamdef.member.add', { workspace: '/work/a', teamDefId: 'core', agent: 'ada', role: 'Developer' }]);
    expect(targets[1]).toEqual(['teamdef.member.update', { workspace: '/work/a', teamDefId: 'core', memberId: 'm1', model: null }]);
  });

  it('rejects malformed envelopes without serve calls', async () => {
    for (const channel of Object.values(C)) {
      const msg = `management.${LABELS[channel]} expects (workspaceId: string, request: object).`;
      for (const args of [[], ['ws'], ['ws', {}, 1], ['', {}], ['  ', {}], [1, {}], ['ws', null], ['ws', []], ['ws', 'x']]) {
        const { call, calls } = setup();
        expect(await call(channel, ...args)).toEqual({ ok: false, error: { code: 'BAD_ARGS', message: msg, retryable: false } });
        expect(calls).toEqual([]);
      }
    }
  });

  const bad = async (channel: string, request: unknown, message: string) => {
    const { call, calls } = setup();
    expect(await call(channel, 'workspace-a', request)).toEqual({ ok: false, error: { code: 'BAD_ARGS', message, retryable: false } });
    expect(calls).toEqual([]);
  };

  it('rejects renderer-chosen workspace, path or command keys', async () => {
    await bad(C.managementOverview, { workspace: '/etc' }, 'management.overview: unknown field(s): workspace.');
    await bad(C.managementOverview, { path: '/', command: 'x' }, 'management.overview: unknown field(s): command, path.');
  });

  it('rejects invalid identifiers', async () => {
    await bad(C.managementTeam, { teamDefId: '../etc' }, `management.team: ${SLUG_MSG('teamDefId')}`);
    await bad(C.managementDeleteAgent, { agentDefId: 'Ada' }, `management.deleteAgent: ${SLUG_MSG('agentDefId')}`);
    await bad(C.managementRemoveMember, { teamDefId: 'core', memberId: '' }, `management.removeMember: ${SLUG_MSG('memberId')}`);
    await bad(C.managementAddMember, { teamDefId: 'core', member: { agent: 'Bad Id' } }, `management.addMember: ${SLUG_MSG('member.agent')}`);
    await bad(C.managementRunBoard, { teamId: 'abc' }, 'management.runBoard: teamId must be a lowercase UUID v4.');
  });

  it('rejects wrong types and empty changes', async () => {
    await bad(C.managementRenameTeam, { teamDefId: 'core', name: '  ' }, 'management.renameTeam: name must be a non-empty string.');
    await bad(C.managementUpdateAgent, { agentDefId: 'ada', changes: {} }, 'management.updateAgent: changes must have at least one field.');
    await bad(C.managementUpdateAgent, { agentDefId: 'ada', changes: { id: 'x' } }, 'management.updateAgent: unknown field(s): changes.id.');
    await bad(C.managementUpdateMember, { teamDefId: 'core', memberId: 'm1', changes: { canAddTickets: 'yes' } }, 'management.updateMember: changes.canAddTickets must be a boolean or null.');
    await bad(C.managementUpdateBoardSettings, { changes: { foo: 1 } }, 'management.updateBoardSettings: unknown field(s): changes.foo.');
    await bad(C.managementUpdateBoardSettings, { changes: { baseBranch: 'x' }, expectedSha256: 'ABC' }, 'management.updateBoardSettings: expectedSha256 must be a lowercase hex sha256.');
    await bad(C.managementUpdateRole, { roleId: 'TeamLead', expectedRolesSha256: SHA }, 'management.updateRole: changes is required.');
    await bad(C.managementCreateAgent, { agent: [] }, 'management.createAgent: agent must be an object.');
  });

  const SHA2 = 'b'.repeat(64);
  const roleRequests: Array<[string, Record<string, unknown>]> = [
    [C.managementRoles, {}],
    [C.managementCreateRole, { input: { name: 'QA' }, expectedRolesSha256: null }],
    [C.managementUpdateRole, { roleId: 'QA', changes: { skills: [] }, expectedRolesSha256: SHA }],
    [C.managementUpdateRoleInstructions, { roleId: 'QA', text: 'x', expectedRolesSha256: SHA, expectedInstructionsSha256: SHA2 }],
    [C.managementDeleteRole, { roleId: 'QA', confirmation: { expectedRolesSha256: SHA, expectedInstructionsSha256: null } }],
  ];

  it('forwards role list after resolving workspace id', async () => {
    const catalog = roleCatalogFixture();
    const { call, calls } = setup({ replies: { 'role.list': ok(catalog) } });
    expect(await call(C.managementRoles, 'workspace-a', {})).toEqual({ ok: true, data: catalog });
    expect(calls).toEqual([['workspace.list', {}], ['role.list', { workspace: '/work/a' }]]);
  });

  it('flattens create and update without forwarding renderer field names', async () => {
    const { call, calls } = setup();
    await call(C.managementCreateRole, 'workspace-a', { input: { id: 'qa', name: 'QA', description: '', skills: ['b', 'a'] }, expectedRolesSha256: null });
    await call(C.managementUpdateRole, 'workspace-a', { roleId: 'Legacy', changes: { name: 'L', description: null, skills: [] }, expectedRolesSha256: SHA });
    const targets = calls.filter(([c]) => c !== 'workspace.list');
    expect(targets[0]).toEqual(['role.create', { workspace: '/work/a', id: 'qa', name: 'QA', description: '', skills: ['b', 'a'], expectedSha256: null }]);
    expect(targets[1]).toEqual(['role.update', { workspace: '/work/a', role: 'Legacy', name: 'L', description: null, skills: [], expectedSha256: SHA }]);
    for (const [, args] of targets) for (const k of ['input', 'changes', 'roleId', 'expectedRolesSha256']) expect(k in (args as object)).toBe(false);
  });

  it('forwards instruction text and both concurrency tokens byte-exact', async () => {
    const { call, calls } = setup();
    const text = '  line\r\n\ttab 😀  \n';
    await call(C.managementUpdateRoleInstructions, 'workspace-a', { roleId: 'QA', text, expectedRolesSha256: SHA, expectedInstructionsSha256: SHA2 });
    await call(C.managementUpdateRoleInstructions, 'workspace-a', { roleId: 'QA', text: '', expectedRolesSha256: SHA, expectedInstructionsSha256: null });
    const targets = calls.filter(([c]) => c !== 'workspace.list');
    expect(targets[0]).toEqual(['role.instructions.update', { workspace: '/work/a', role: 'QA', text, expectedRolesSha256: SHA, expectedInstructionsSha256: SHA2 }]);
    expect(targets[1][1]).toEqual({ workspace: '/work/a', role: 'QA', text: '', expectedRolesSha256: SHA, expectedInstructionsSha256: null });
  });

  it('flattens exact delete confirmation without usage claims', async () => {
    const { call, calls } = setup();
    await call(C.managementDeleteRole, 'workspace-a', { roleId: 'QA', confirmation: { expectedRolesSha256: SHA, expectedInstructionsSha256: SHA2 } });
    expect(calls[1]).toEqual(['role.delete', { workspace: '/work/a', role: 'QA', expectedRolesSha256: SHA, expectedInstructionsSha256: SHA2 }]);
    await bad(C.managementDeleteRole, { roleId: 'QA', confirmation: { expectedRolesSha256: SHA, expectedInstructionsSha256: null, usage: { count: 0 } } }, 'management.deleteRole: unknown field(s): confirmation.usage.');
    await bad(C.managementDeleteRole, { roleId: 'QA', confirmation: { expectedRolesSha256: SHA, expectedInstructionsSha256: null }, workspace: '/etc' }, 'management.deleteRole: unknown field(s): workspace.');
  });

  it('rejects malformed role requests before workspace lookup', async () => {
    await bad(C.managementCreateRole, { input: { name: 'QA' } }, 'management.createRole: expectedRolesSha256 is required.');
    await bad(C.managementCreateRole, { input: { name: 'QA', path: '/x' }, expectedRolesSha256: null }, 'management.createRole: unknown field(s): input.path.');
    await bad(C.managementUpdateRole, { roleId: 'QA', changes: {}, expectedRolesSha256: SHA }, 'management.updateRole: changes must have at least one field.');
    await bad(C.managementUpdateRoleInstructions, { roleId: 'QA', text: 'x', expectedRolesSha256: SHA }, 'management.updateRoleInstructions: expectedInstructionsSha256 is required.');
    await bad(C.managementRoles, { workspace: '/etc' }, 'management.roles: unknown field(s): workspace.');
  });

  it('returns stale or missing workspace errors without invoking a role command', async () => {
    for (const [channel, request] of roleRequests) {
      const a = setup();
      expect((await a.call(channel, 'nope', request)).error.code).toBe('WORKSPACE_NOT_FOUND');
      expect(a.calls).toEqual([['workspace.list', {}]]);
      const b = setup({ workspaces: [{ ...WS, exists: false }] });
      expect((await b.call(channel, 'workspace-a', request)).error.code).toBe('WORKSPACE_MISSING');
      expect(b.calls).toEqual([['workspace.list', {}]]);
    }
  });

  it('preserves CONFIG_CHANGED ROLE_IN_USE ROLE_USAGE_UNAVAILABLE ROLES_CONFIG_INVALID and field problem data', async () => {
    const cases: Array<[string, string, Record<string, unknown>, Record<string, unknown>, Record<string, unknown>]> = [
      ['role.update', C.managementUpdateRole, roleRequests[2][1], { code: 'CONFIG_CHANGED', message: 'm', retryable: false, remediation: 'reload' }, { currentRolesSha256: SHA2, currentInstructionsSha256: null }],
      ['role.delete', C.managementDeleteRole, roleRequests[4][1], { code: 'ROLE_IN_USE', message: 'm', retryable: false }, { usage: { members: [{ memberId: 'dev-1' }], count: 1, blocking: true } }],
      ['role.delete', C.managementDeleteRole, roleRequests[4][1], { code: 'ROLE_USAGE_UNAVAILABLE', message: 'm', retryable: true }, { problems: [{ path: 'board.json', message: 'unreadable' }] }],
      ['role.list', C.managementRoles, roleRequests[0][1], { code: 'ROLES_CONFIG_INVALID', message: 'm', retryable: false }, { problems: [{ path: 'roles', message: 'bad json' }] }],
      ['role.create', C.managementCreateRole, roleRequests[1][1], { code: 'BAD_ARGS', message: 'm', retryable: false }, { problems: [{ path: 'skills[0]', message: 'unknown skill' }] }],
    ];
    for (const [command, channel, request, error, data] of cases) {
      const { call } = setup({ replies: { [command]: { ok: false, error, data } } });
      expect(await call(channel, 'workspace-a', request)).toEqual({ ok: false, error: { ...error, data } });
    }
  });

  it('role config commands receive no generated idempotency key', async () => {
    const { call, calls, optsSeen } = setup({ newIdempotencyKey: () => 'k-00000001' });
    for (const [channel, request] of roleRequests) await call(channel, 'workspace-a', request);
    const opts = calls.map(([c], i) => [c, optsSeen[i]] as const).filter(([c]) => c !== 'workspace.list').map(([, o]) => o);
    expect(opts).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });

  it('stale or missing workspace ids stop before the target command', async () => {
    const a = setup();
    expect((await a.call(C.managementOverview, 'nope', {})).error.code).toBe('WORKSPACE_NOT_FOUND');
    expect(a.calls).toEqual([['workspace.list', {}]]);
    const b = setup({ workspaces: [{ ...WS, exists: false }] });
    expect((await b.call(C.managementOverview, 'workspace-a', {})).error.code).toBe('WORKSPACE_MISSING');
    expect(b.calls).toEqual([['workspace.list', {}]]);
  });

  it('resolves the workspace on every call', async () => {
    const { call, calls } = setup();
    await call(C.managementOverview, 'workspace-a', {});
    await call(C.managementOverview, 'workspace-a', {});
    expect(calls.filter(([c]) => c === 'workspace.list')).toHaveLength(2);
  });

  it('propagates structured backend errors with data', async () => {
    const problems = [{ path: 'rules[0]', message: 'x' }];
    const a = setup({ replies: { 'board.settings.update': { ok: false, error: { code: 'BOARD_CONFIG_INVALID', message: 'm', retryable: false }, data: { problems } } } });
    expect(await a.call(C.managementUpdateBoardSettings, 'workspace-a', { changes: { baseBranch: 'x' } })).toEqual({
      ok: false,
      error: { code: 'BOARD_CONFIG_INVALID', message: 'm', retryable: false, data: { problems } },
    });
    const b = setup({ replies: { 'agentdef.delete': { ok: false, error: { code: 'AGENT_IN_USE', message: 'm', retryable: false, remediation: 'remove it' }, data: { teams: ['core'] } } } });
    expect((await b.call(C.managementDeleteAgent, 'workspace-a', { agentDefId: 'ada' })).error).toEqual({
      code: 'AGENT_IN_USE', message: 'm', retryable: false, remediation: 'remove it', data: { teams: ['core'] },
    });
  });

  it('backend error without data is returned unchanged', async () => {
    const error = { code: 'AGENT_NOT_FOUND', message: 'm', retryable: false };
    const { call } = setup({ replies: { 'agentdef.delete': { ok: false, error } } });
    const r = await call(C.managementDeleteAgent, 'workspace-a', { agentDefId: 'ada' });
    expect(r.error).toBe(error);
  });

  it('transport and unexpected errors', async () => {
    const a = setup({ failures: { 'board.run': new ServeError('TIMEOUT', 't') } });
    expect(await a.call(C.managementRunBoard, 'workspace-a', { teamId: UUID })).toEqual({ ok: false, error: { code: 'TIMEOUT', message: 't', retryable: true } });
    const b = setup({ failures: { 'board.run': new Error('boom') } });
    expect(await b.call(C.managementRunBoard, 'workspace-a', { teamId: UUID })).toEqual({ ok: false, error: { code: 'INTERNAL', message: 'boom', retryable: false } });
  });

  it('board run and stop send a fresh idempotency key; others none', async () => {
    let n = 0;
    const { call, calls, optsSeen } = setup({ newIdempotencyKey: () => `k-0000000${++n}` });
    await call(C.managementRunBoard, 'workspace-a', { teamId: UUID });
    await call(C.managementRunBoard, 'workspace-a', { teamId: UUID });
    await call(C.managementStopBoard, 'workspace-a', {});
    await call(C.managementSwitchMemberAgent, 'workspace-a', { teamDefId: 'core', memberId: 'm1', agent: 'ada' });
    await call(C.managementSwitchMemberAgent, 'workspace-a', { teamDefId: 'core', memberId: 'm1', agent: 'ada', confirmation: { cancelActive: true, assignmentId: UUID } });
    await call(C.managementResumeMemberAgent, 'workspace-a', { teamDefId: 'core', memberId: 'm1', agent: 'ada' });
    await call(C.managementOverview, 'workspace-a', {});
    await call(C.managementCreateAgent, 'workspace-a', { agent: { name: 'A', provider: 'claude' } });
    const targetOpts = calls.map(([c], i) => [c, optsSeen[i]] as const).filter(([c]) => c !== 'workspace.list').map(([, o]) => o);
    expect(targetOpts).toEqual([
      { idempotencyKey: 'k-00000001' },
      { idempotencyKey: 'k-00000002' },
      { idempotencyKey: 'k-00000003' },
      { idempotencyKey: 'k-00000004' },
      { idempotencyKey: 'k-00000005' },
      { idempotencyKey: 'k-00000006' },
      undefined,
      undefined,
    ]);
  });

  it('board control outcomes and errors pass through unchanged', async () => {
    const board = { workspace: '/work/a', status: 'running', teamId: UUID };
    const a = setup({
      replies: {
        'board.run': ok({ board, rules: 3 }),
        'board.stop': { ok: false, error: { code: 'PENDING', message: 'p', retryable: true }, data: { idempotencyKey: 'k-00000001' } },
      },
    });
    expect(await a.call(C.managementRunBoard, 'workspace-a', { teamId: UUID })).toEqual({ ok: true, data: { board, rules: 3 } });
    expect(await a.call(C.managementStopBoard, 'workspace-a', {})).toEqual({
      ok: false,
      error: { code: 'PENDING', message: 'p', retryable: true, data: { idempotencyKey: 'k-00000001' } },
    });
    const b = setup({
      replies: {
        'board.run': { ok: false, error: { code: 'BOARD_ALREADY_RUNNING', message: 'm', retryable: false }, data: { teamId: 'x' } },
      },
    });
    expect(await b.call(C.managementRunBoard, 'workspace-a', { teamId: UUID })).toEqual({
      ok: false,
      error: { code: 'BOARD_ALREADY_RUNNING', message: 'm', retryable: false, data: { teamId: 'x' } },
    });
  });

  it('default idempotency key matches the backend rule', async () => {
    const { call, calls, optsSeen } = setup();
    await call(C.managementStopBoard, 'workspace-a', {});
    const i = calls.findIndex(([c]) => c === 'board.stop');
    expect(optsSeen[i]?.idempotencyKey).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
  });

  it('management handlers only use allowlisted commands', async () => {
    const { call, calls } = setup();
    for (const [channel, request] of ROWS) await call(channel, 'workspace-a', request);
    expect([...new Set(calls.map(([c]) => c))].sort()).toEqual([
      'agentdef.create', 'agentdef.delete', 'agentdef.list', 'agentdef.update', 'board.run', 'board.settings',
      'board.settings.update', 'board.stop', 'role.create', 'role.delete', 'role.instructions.update', 'role.list', 'role.update', 'team.member.resume', 'team.member.switch', 'team.overview', 'teamdef.create', 'teamdef.delete',
      'teamdef.member.add', 'teamdef.member.remove', 'teamdef.member.update', 'teamdef.rename', 'teamdef.show',
      'teamdef.validate', 'workspace.list',
    ]);
  });

  it('shared management types module has no imports', () => {
    const src = readFileSync(new URL('../src/shared/management.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/^\s*import\s/m);
  });
  it('forwards_ordered_agents', async () => {
    const { call, calls } = setup();
    await call(C.managementAddMember, 'workspace-a', { teamDefId: 'core', member: { agents: ['z', 'a'] } });
    await call(C.managementUpdateMember, 'workspace-a', { teamDefId: 'core', memberId: 'm1', changes: { agents: ['a', 'z'] } });
    expect(calls.filter(([c]) => c !== 'workspace.list')).toEqual([
      ['teamdef.member.add', { workspace: '/work/a', teamDefId: 'core', agents: ['z', 'a'] }],
      ['teamdef.member.update', { workspace: '/work/a', teamDefId: 'core', memberId: 'm1', agents: ['a', 'z'] }],
    ]);
  });
  it('rejects_empty_duplicate_or_invalid_agent_arrays', async () => {
    for (const [channel, method, field] of [[C.managementAddMember, 'addMember', 'member'], [C.managementUpdateMember, 'updateMember', 'changes']]) {
      for (const [value, suffix] of [
        ['a', 'must be a non-empty array of slugs.'], [[], 'must be a non-empty array of slugs.'],
        [['a', 'a'], 'must not contain duplicates.'], [['a', 'Bad'], "[1] must be a slug (lowercase letters, digits, '-'; at most 64 characters)."],
        [['a', 1], "[1] must be a slug (lowercase letters, digits, '-'; at most 64 characters)."],
      ] as const) {
        const request = { teamDefId: 'core', ...(method === 'updateMember' ? { memberId: 'm1' } : {}), [field]: { agents: value } };
        await bad(channel as string, request, `management.${method}: ${field}.agents${suffix.startsWith('[') ? '' : ' '}${suffix}`);
      }
    }
  });
  it('forwards_switch_without_confirmation', async () => {
    const { call, calls, optsSeen } = setup();
    await call(C.managementSwitchMemberAgent, 'workspace-a', { teamDefId: 'core', memberId: 'm1', agent: 'ada' });
    expect(calls[1]).toEqual(['team.member.switch', { workspace: '/work/a', teamDefId: 'core', memberId: 'm1', agent: 'ada' }]);
    expect(optsSeen[1]?.idempotencyKey).toBeTruthy();
  });
  it('forwards_exact_assignment_confirmation', async () => {
    const { call, calls } = setup();
    await call(C.managementSwitchMemberAgent, 'workspace-a', { teamDefId: 'core', memberId: 'm1', agent: 'ada', confirmation: { cancelActive: true, assignmentId: UUID } });
    expect(calls[1]).toEqual(['team.member.switch', { workspace: '/work/a', teamDefId: 'core', memberId: 'm1', agent: 'ada', cancelActive: true, assignmentId: UUID }]);
  });
  it('rejects_partial_or_extra_confirmation', async () => {
    const base = { teamDefId: 'core', memberId: 'm1', agent: 'ada' };
    for (const [confirmation, message] of [
      [{ assignmentId: UUID }, 'confirmation.cancelActive is required.'],
      [{ cancelActive: true }, 'confirmation.assignmentId is required.'],
      [{ cancelActive: false, assignmentId: UUID }, 'confirmation.cancelActive must be true.'],
      [{ cancelActive: 'true', assignmentId: UUID }, 'confirmation.cancelActive must be true.'],
      [{ cancelActive: true, assignmentId: UUID.toUpperCase() }, 'confirmation.assignmentId must be a lowercase UUID v4.'],
      [{ cancelActive: true, assignmentId: 'bad' }, 'confirmation.assignmentId must be a lowercase UUID v4.'],
      [{ extra: 1 }, 'unknown field(s): confirmation.extra.'],
    ] as const) await bad(C.managementSwitchMemberAgent, { ...base, confirmation }, `management.switchMemberAgent: ${message}`);
  });
  it('forwards_resume', async () => {
    const { call, calls, optsSeen } = setup();
    await call(C.managementResumeMemberAgent, 'workspace-a', { teamDefId: 'core', memberId: 'm1', agent: 'ada' });
    expect(calls[1]).toEqual(['team.member.resume', { workspace: '/work/a', teamDefId: 'core', memberId: 'm1', agent: 'ada' }]);
    expect(optsSeen[1]?.idempotencyKey).toBeTruthy();
  });
  it('preserves switch backend errors and structured data', async () => {
    const base = { teamDefId: 'core', memberId: 'm1', agent: 'ada' };
    const active = { code: 'BAD_REQUEST', message: 'Member has an active assignment; confirm cancellation of this assignment to switch.', retryable: false };
    const provider = { code: 'PROVIDER_UNAVAILABLE', message: "Provider 'claude' is not ready: unavailable", retryable: false, remediation: 'Install the provider.' };
    const a = setup({ replies: { 'team.member.switch': { ok: false, error: active, data: { assignmentId: UUID } } } });
    expect(await a.call(C.managementSwitchMemberAgent, 'workspace-a', base)).toEqual({ ok: false, error: { ...active, data: { assignmentId: UUID } } });
    const b = setup({ replies: { 'team.member.switch': { ok: false, error: provider } } });
    expect(await b.call(C.managementSwitchMemberAgent, 'workspace-a', base)).toEqual({ ok: false, error: provider });
  });

  it('preserves each specified switch error and both cancellation result shapes', async () => {
    const base = { teamDefId: 'core', memberId: 'm1', agent: 'ada' };
    const messages = [
      'A switch is already pending for this member.',
      "Agent 'ada' is on quota hold.",
      'That agent is already active; use board resume when its quota resets.',
      "The member's pane is not alive.",
      'Member must be idle or quota-limited before switching.',
      "Agent 'ada' is not configured for member 'm1'.",
      "Agent 'ada' is missing from the catalog.",
    ];
    for (const message of messages) {
      const error = { code: 'BAD_REQUEST', message, retryable: false };
      const { call } = setup({ replies: { 'team.member.switch': { ok: false, error } } });
      expect(await call(C.managementSwitchMemberAgent, 'workspace-a', base)).toEqual({ ok: false, error });
    }
    for (const identifier of [{ assignmentId: UUID }, { workflowRunId: UUID }]) {
      const data = { teamId: UUID, memberId: 'm1', agentId: 'worker', pendingAgent: 'ada', assignmentId: UUID,
        cancellation: { ...identifier, previousStatus: 'running', outcome: 'cancel_requested', status: 'running' } };
      const { call } = setup({ replies: { 'team.member.switch': ok(data) } });
      expect(await call(C.managementSwitchMemberAgent, 'workspace-a', base)).toEqual({ ok: true, data });
    }
  });

});
