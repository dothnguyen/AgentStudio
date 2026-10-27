import type {
  ConnectionPayload,
  CreateArgs,
  DashboardActivity,
  DashboardBoard,
  DashboardTeams,
  Result,
  WorkspaceList,
} from '../shared/api';
import { randomUUID } from 'node:crypto';
import { MANAGEMENT_CHANNELS, MANAGEMENT_SPECS, isPlainObject } from './managementSpecs';
import { ServeError, type ConnectionState, type ServeResponse, type StateChange } from './serveClient';
import { WslPathError, toWslPath } from './wslPath';

export const CHANNELS = {
  list: 'workspaces:list',
  create: 'workspaces:create',
  pickFolder: 'workspaces:pickFolder',
  connectionGet: 'connection:get',
  connectionState: 'connection:state',
  dashboardTeams: 'dashboard:teams',
  dashboardBoard: 'dashboard:board',
  dashboardActivity: 'dashboard:activity',
  ...MANAGEMENT_CHANNELS,
} as const;

export interface ServeLike {
  readonly state: ConnectionState;
  readonly lastError: string | null;
  readonly distro: string | null;
  readonly diagnostics: { distro: string | null; command: string | null };
  request(command: string, args?: Record<string, unknown>, opts?: { timeoutMs?: number; idempotencyKey?: string }): Promise<ServeResponse>;
  on(event: 'state', listener: (s: StateChange) => void): unknown;
  off(event: 'state', listener: (s: StateChange) => void): unknown;
}
export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}
export interface IpcDeps {
  ipcMain: IpcMainLike;
  client: ServeLike;
  showFolderDialog: () => Promise<string | null>;
  newIdempotencyKey?: () => string;
}

function badArgs(message: string): Result<never> {
  return { ok: false, error: { code: 'BAD_ARGS', message, retryable: false } };
}

function fromError(e: unknown): Result<never> {
  if (e instanceof WslPathError) {
    return { ok: false, error: { code: 'PATH_' + e.code, message: e.message, retryable: false } };
  }
  if (e instanceof ServeError) {
    return { ok: false, error: { code: e.code, message: e.message, retryable: true } };
  }
  return { ok: false, error: { code: 'INTERNAL', message: String((e as Error)?.message ?? e), retryable: false } };
}

function fromResponse<T>(resp: ServeResponse): Result<T> {
  if (resp.ok) return { ok: true, data: resp.data as T };
  if (resp.error) {
    return { ok: false, error: resp.data === undefined ? resp.error : { ...resp.error, data: resp.data } };
  }
  return {
    ok: false,
    error: { code: 'BAD_RESPONSE', message: 'serve returned ok:false without an error.', retryable: false },
  };
}

function isCreateArgs(v: unknown): v is CreateArgs {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (!Object.keys(o).every((k) => k === 'path' || k === 'name')) return false;
  return typeof o.path === 'string' && (o.name === undefined || typeof o.name === 'string');
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

async function resolveWorkspacePath(client: ServeLike, workspaceId: string): Promise<Result<string>> {
  try {
    const result = fromResponse<WorkspaceList>(await client.request('workspace.list', {}));
    if (!result.ok) return result;
    const data = result.data as unknown;
    if (typeof data !== 'object' || data === null || !Array.isArray((data as { workspaces?: unknown }).workspaces)) {
      return {
        ok: false,
        error: {
          code: 'BAD_RESPONSE',
          message: 'workspace.list returned no workspaces array.',
          retryable: false,
        },
      };
    }
    const workspaces = (data as { workspaces: unknown[] }).workspaces;
    const entry = workspaces.find(
      (candidate) => typeof candidate === 'object' && candidate !== null && (candidate as { id?: unknown }).id === workspaceId,
    ) as Record<string, unknown> | undefined;
    if (!entry) {
      return {
        ok: false,
        error: {
          code: 'WORKSPACE_NOT_FOUND',
          message: `Workspace id '${workspaceId}' is not registered.`,
          retryable: false,
        },
      };
    }
    if (entry.exists === false || entry.missing === true) {
      return {
        ok: false,
        error: {
          code: 'WORKSPACE_MISSING',
          message: `Workspace '${String(entry.name)}' is registered but its folder is missing.`,
          retryable: false,
        },
      };
    }
    if (!isNonEmptyString(entry.path)) {
      return {
        ok: false,
        error: {
          code: 'BAD_RESPONSE',
          message: 'workspace.list returned an invalid workspace entry.',
          retryable: false,
        },
      };
    }
    return { ok: true, data: entry.path };
  } catch (e) {
    return fromError(e);
  }
}

export function registerIpc(deps: IpcDeps): void {
  const { ipcMain, client, showFolderDialog } = deps;
  const newIdempotencyKey = deps.newIdempotencyKey ?? (() => `ipc-${randomUUID()}`);

  ipcMain.handle(CHANNELS.list, async (_e, ...args) => {
    if (args.length !== 0) return badArgs('workspaces.list takes no arguments.');
    try {
      return fromResponse(await client.request('workspace.list', {}));
    } catch (e) {
      return fromError(e);
    }
  });

  ipcMain.handle(CHANNELS.create, async (_e, ...args) => {
    if (args.length !== 1 || !isCreateArgs(args[0])) {
      return badArgs('workspaces.create expects one argument { path: string, name?: string }.');
    }
    const a = args[0];
    try {
      const path = toWslPath(a.path, client.distro);
      const req = a.name === undefined ? { path } : { path, name: a.name };
      return fromResponse(await client.request('workspace.init', req));
    } catch (e) {
      return fromError(e);
    }
  });

  ipcMain.handle(CHANNELS.pickFolder, async (_e, ...args) => {
    if (args.length !== 0) return badArgs('workspaces.pickFolder takes no arguments.');
    try {
      const picked = await showFolderDialog();
      if (picked === null) return { ok: true, data: null };
      return { ok: true, data: toWslPath(picked, client.distro) };
    } catch (e) {
      return fromError(e);
    }
  });

  const registerDashboardHandler = <T>(
    channel: string,
    label: string,
    command: string,
    extraArgs: Record<string, unknown>,
  ) => {
    ipcMain.handle(channel, async (_e, ...args) => {
      if (args.length !== 1 || !isNonEmptyString(args[0])) {
        return badArgs(`${label} expects one non-empty workspace id string.`);
      }
      const workspace = await resolveWorkspacePath(client, args[0]);
      if (!workspace.ok) return workspace;
      try {
        return fromResponse<T>(await client.request(command, { workspace: workspace.data, ...extraArgs }));
      } catch (e) {
        return fromError(e);
      }
    });
  };

  registerDashboardHandler<DashboardTeams>(CHANNELS.dashboardTeams, 'dashboard.teams', 'team.list', {});
  registerDashboardHandler<DashboardBoard>(CHANNELS.dashboardBoard, 'dashboard.board', 'board.summary', { limit: 5 });
  registerDashboardHandler<DashboardActivity>(CHANNELS.dashboardActivity, 'dashboard.activity', 'activity.recent', { limit: 15, kinds: ['ticket'] });

  for (const spec of MANAGEMENT_SPECS) {
    ipcMain.handle(spec.channel, async (_e, ...args) => {
      if (args.length !== 2 || !isNonEmptyString(args[0]) || !isPlainObject(args[1])) {
        return badArgs(`${spec.label} expects (workspaceId: string, request: object).`);
      }
      const parsed = spec.parse(args[1]);
      if (typeof parsed === 'string') return badArgs(parsed);
      const workspace = await resolveWorkspacePath(client, args[0]);
      if (!workspace.ok) return workspace;
      try {
        const backendArgs = { workspace: workspace.data, ...parsed };
        const resp = spec.mutating
          ? await client.request(spec.command, backendArgs, { idempotencyKey: newIdempotencyKey() })
          : await client.request(spec.command, backendArgs);
        return fromResponse(resp);
      } catch (e) {
        return fromError(e);
      }
    });
  }

  ipcMain.handle(CHANNELS.connectionGet, (_e, ...args) => {
    if (args.length !== 0) throw new Error('connection.get takes no arguments.');
    return { state: client.state, error: client.lastError, ...client.diagnostics };
  });
}

export function forwardState(client: ServeLike, send: (channel: string, payload: ConnectionPayload) => void): () => void {
  const l = (s: StateChange) => send(CHANNELS.connectionState, { state: s.state, error: s.error, ...client.diagnostics });
  client.on('state', l);
  return () => {
    client.off('state', l);
  };
}

export function pickedPath(r: { canceled: boolean; filePaths: string[] }): string | null {
  return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
}
