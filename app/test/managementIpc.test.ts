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
  [C.managementUpdateRole]: 'updateRole',
  [C.managementRunBoard]: 'runBoard',
  [C.managementStopBoard]: 'stopBoard',
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
  [C.managementUpdateRole, { role: 'TeamLead', description: null }, 'role.update', { role: 'TeamLead', description: null }],
  [C.managementRunBoard, { teamId: UUID }, 'board.run', { teamId: UUID }],
  [C.managementStopBoard, {}, 'board.stop', {}],
];

const SLUG_MSG = (f: string) => `${f} must be a slug (lowercase letters, digits, '-'; at most 64 characters).`;

describe('management IPC', () => {
  it.each(ROWS)('every management channel resolves the workspace and sends its fixed command: %s', async (channel, request, command, expected) => {
    const { call, calls } = setup();
    const r = await call(channel, 'workspace-a', request);
    expect(calls).toEqual([['workspace.list', {}], [command, { workspace: '/work/a', ...expected }]]);
    expect(r).toEqual({ ok: true, data: { payload: command } });
  });

  it('optional keys are omitted when absent', async () => {
    const { call, calls } = setup();
    await call(C.managementCreateTeam, 'workspace-a', { name: 'Core' });
    await call(C.managementUpdateBoardSettings, 'workspace-a', { changes: { baseBranch: 'main' }, expectedSha256: undefined });
    await call(C.managementUpdateRole, 'workspace-a', { role: 'TeamLead', description: 'd', expectedSha256: SHA });
    const targets = calls.filter(([c]) => c !== 'workspace.list');
    expect(targets[0][1]).toEqual({ workspace: '/work/a', name: 'Core' });
    expect('expectedSha256' in (targets[1][1] as object)).toBe(false);
    expect(targets[2][1]).toEqual({ workspace: '/work/a', role: 'TeamLead', description: 'd', expectedSha256: SHA });
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
    await bad(C.managementUpdateRole, { role: 'TeamLead' }, 'management.updateRole: description is required.');
    await bad(C.managementCreateAgent, { agent: [] }, 'management.createAgent: agent must be an object.');
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
    await call(C.managementOverview, 'workspace-a', {});
    await call(C.managementCreateAgent, 'workspace-a', { agent: { name: 'A', provider: 'claude' } });
    const targetOpts = calls.map(([c], i) => [c, optsSeen[i]] as const).filter(([c]) => c !== 'workspace.list').map(([, o]) => o);
    expect(targetOpts).toEqual([
      { idempotencyKey: 'k-00000001' },
      { idempotencyKey: 'k-00000002' },
      { idempotencyKey: 'k-00000003' },
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
      'board.settings.update', 'board.stop', 'role.update', 'team.overview', 'teamdef.create', 'teamdef.delete',
      'teamdef.member.add', 'teamdef.member.remove', 'teamdef.member.update', 'teamdef.rename', 'teamdef.show',
      'teamdef.validate', 'workspace.list',
    ]);
  });

  it('shared management types module has no imports', () => {
    const src = readFileSync(new URL('../src/shared/management.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/^\s*import\s/m);
  });
});
