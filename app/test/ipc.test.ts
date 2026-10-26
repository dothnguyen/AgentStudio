import { describe, expect, it } from 'vitest';
import { CHANNELS, forwardState, pickedPath, registerIpc, type ServeLike } from '../src/main/ipc';
import type { ConnectionPayload, DashboardActivity } from '../src/shared/api';
import { ServeError, type StateChange } from '../src/main/serveClient';

type Handler = (e: unknown, ...a: unknown[]) => unknown;

function setup(over: Partial<{ distro: string | null; reply: unknown; fail: unknown; picked: string | null; replies: Record<string, unknown>; failures: Record<string, unknown> }> = {}) {
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
      if (over.fail || over.failures?.[command]) throw (over.fail ?? over.failures?.[command]);
      return (over.replies?.[command] ?? over.reply ?? { protocol: 1, id: '1', ok: true, data: { x: 1 } }) as never;
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
  it('registers exactly the seven invoke channels', () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual(
      [CHANNELS.list, CHANNELS.create, CHANNELS.pickFolder, CHANNELS.connectionGet, CHANNELS.dashboardTeams, CHANNELS.dashboardBoard, CHANNELS.dashboardActivity].sort(),
    );
  });

  const ok = (data: unknown) => ({ protocol: 1, id: '1', ok: true, data });
  const ws = (overrides: Record<string, unknown> = {}) => ({ id: 'workspace-a', name: 'A', path: '/work/a', missing: false, exists: true, ...overrides });
  const dashboardCalls = [
    [CHANNELS.dashboardTeams, 'dashboard.teams', {}],
    [CHANNELS.dashboardBoard, 'dashboard.board', {}],
    [CHANNELS.dashboardActivity, 'dashboard.activity', {}],
  ] as const;
  const targetCommandFor = (channel: string) => channel === CHANNELS.dashboardBoard ? 'board.summary' : channel === CHANNELS.dashboardActivity ? 'activity.recent' : 'team.list';
  const activityPayload: DashboardActivity = {
    workspace: '/work/a',
    dbId: 'db-a',
    head: 4,
    entries: [{
      id: 'event:4',
      at: '2026-10-26T00:00:00Z',
      kind: 'ticket',
      name: 'ticket.updated',
      summary: 'Updated T-019',
    }],
  };

  it.each(dashboardCalls.flatMap(([channel, label]) => [
    [channel, label, []], [channel, label, ['a', 'b']], [channel, label, [1]], [channel, label, [null]],
    [channel, label, [false]], [channel, label, [{}]], [channel, label, ['']], [channel, label, ['  ']],
  ]))('dashboard %s rejects invalid arguments %j without serve calls', async (channel, label, args) => {
    const s = setup();
    expect(await s.call(channel, ...(args as unknown[]))).toEqual({ ok: false, error: { code: 'BAD_ARGS', message: `${label} expects one non-empty workspace id string.`, retryable: false } });
    expect(s.calls).toEqual([]);
  });

  it.each([
    [CHANNELS.dashboardTeams, 'team.list', {}],
    [CHANNELS.dashboardBoard, 'board.summary', { limit: 5 }],
    [CHANNELS.dashboardActivity, 'activity.recent', { limit: 15 }],
  ])('dashboard resolves workspace and sends %s', async (channel, target, extra) => {
    const payload = target === 'activity.recent'
      ? activityPayload
      : { value: 'unchanged' };
    const s = setup({ replies: { 'workspace.list': ok({ workspaces: [ws()] }), [target]: ok(payload) } });
    expect(await s.call(channel, 'workspace-a')).toEqual({ ok: true, data: payload });
    expect(s.calls).toEqual([['workspace.list', {}], [target, { workspace: '/work/a', ...extra }]]);
  });

  it('dashboard lookup preserves a valid workspace id without trimming it', async () => {
    const s = setup({ replies: { 'workspace.list': ok({ workspaces: [ws({ id: ' workspace-a ' })] }), 'team.list': ok({ teams: [] }) } });
    expect(await s.call(CHANNELS.dashboardTeams, ' workspace-a ')).toEqual({ ok: true, data: { teams: [] } });
    expect(s.calls).toEqual([['workspace.list', {}], ['team.list', { workspace: '/work/a' }]]);
  });

  it('dashboard lookup rejects unknown and missing workspaces locally', async () => {
    const unknown = setup({ replies: { 'workspace.list': ok({ workspaces: [] }) } });
    expect(await unknown.call(CHANNELS.dashboardTeams, 'other')).toEqual({ ok: false, error: { code: 'WORKSPACE_NOT_FOUND', message: "Workspace id 'other' is not registered.", retryable: false } });
    expect(unknown.calls).toEqual([['workspace.list', {}]]);
    for (const flags of [{ exists: false }, { missing: true }]) {
      const missing = setup({ replies: { 'workspace.list': ok({ workspaces: [ws(flags)] }) } });
      expect(await missing.call(CHANNELS.dashboardTeams, 'workspace-a')).toEqual({ ok: false, error: { code: 'WORKSPACE_MISSING', message: "Workspace 'A' is registered but its folder is missing.", retryable: false } });
      expect(missing.calls).toEqual([['workspace.list', {}]]);
    }
  });

  it.each([null, {}, { workspaces: {} }, ...[undefined, null, 1, '', '  '].map((path) => ({ workspaces: [ws({ path })] }))])('dashboard lookup rejects malformed workspace.list data %j', async (data) => {
    const s = setup({ replies: { 'workspace.list': ok(data) } });
    const r = await s.call(CHANNELS.dashboardBoard, 'workspace-a') as { error: unknown };
    expect(r).toEqual({ ok: false, error: { code: 'BAD_RESPONSE', message: data && typeof data === 'object' && Array.isArray((data as { workspaces?: unknown }).workspaces) ? 'workspace.list returned an invalid workspace entry.' : 'workspace.list returned no workspaces array.', retryable: false } });
    expect(s.calls).toEqual([['workspace.list', {}]]);
  });

  it.each([
    ...dashboardCalls.map(([channel, ,]) => [channel, 'workspace.list'] as const),
    ...dashboardCalls.map(([channel]) => [channel, targetCommandFor(channel)] as const),
  ])('dashboard preserves backend errors on %s at %s stage', async (channel, command) => {
    const error = { code: 'BAD_REQUEST', message: 'backend failure', retryable: false, remediation: 'fix' };
    const target = dashboardCalls.find(([c]) => c === channel)![2];
    const targetCommand = targetCommandFor(channel);
    const s = setup({ replies: { 'workspace.list': command === 'workspace.list' ? { protocol: 1, id: '1', ok: false, error } : ok({ workspaces: [ws()] }), [targetCommand]: command === targetCommand ? { protocol: 1, id: '1', ok: false, error } : ok({}) } });
    const r = await s.call(channel, 'workspace-a') as { error: unknown };
    expect(r.error).toBe(error);
    expect(s.calls.map(([c]) => c)).toEqual(command === 'workspace.list' ? ['workspace.list'] : ['workspace.list', targetCommand]);
  });

  it.each([
    ...dashboardCalls.map(([channel]) => [channel, 'workspace.list'] as const),
    ...dashboardCalls.map(([channel]) => [channel, targetCommandFor(channel)] as const),
  ])('dashboard transport errors are retryable on %s at %s stage', async (channel, command) => {
    const s = setup({
      failures: { [command]: new ServeError('NOT_CONNECTED', 'nope') },
      replies: { 'workspace.list': ok({ workspaces: [ws()] }) },
    });
    expect(await s.call(channel, 'workspace-a')).toEqual({ ok: false, error: { code: 'NOT_CONNECTED', message: 'nope', retryable: true } });
    expect(s.calls.map(([c]) => c)).toEqual(command === 'workspace.list' ? ['workspace.list'] : ['workspace.list', targetCommandFor(channel)]);
  });

  it.each([
    ...dashboardCalls.map(([channel]) => [channel, 'workspace.list'] as const),
    ...dashboardCalls.map(([channel]) => [channel, targetCommandFor(channel)] as const),
  ])('dashboard maps ordinary exceptions to non-retryable INTERNAL on %s at %s stage', async (channel, command) => {
    const s = setup({
      failures: { [command]: new Error('unexpected failure') },
      replies: { 'workspace.list': ok({ workspaces: [ws()] }) },
    });
    expect(await s.call(channel, 'workspace-a')).toEqual({ ok: false, error: { code: 'INTERNAL', message: 'unexpected failure', retryable: false } });
    expect(s.calls.map(([c]) => c)).toEqual(command === 'workspace.list' ? ['workspace.list'] : ['workspace.list', targetCommandFor(channel)]);
  });

  it('dashboard handlers use only the read command allowlist', async () => {
    const s = setup({ reply: ok({ workspaces: [ws()] }) });
    for (const channel of [CHANNELS.dashboardTeams, CHANNELS.dashboardBoard, CHANNELS.dashboardActivity]) await s.call(channel, 'workspace-a');
    expect([...new Set(s.calls.map(([command]) => command))].sort()).toEqual(['activity.recent', 'board.summary', 'team.list', 'workspace.list']);
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
