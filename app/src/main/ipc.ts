import type { ConnectionPayload, CreateArgs, Result } from '../shared/api';
import { ServeError, type ConnectionState, type ServeResponse, type StateChange } from './serveClient';
import { WslPathError, toWslPath } from './wslPath';

export const CHANNELS = {
  list: 'workspaces:list',
  create: 'workspaces:create',
  pickFolder: 'workspaces:pickFolder',
  connectionGet: 'connection:get',
  connectionState: 'connection:state',
} as const;

export interface ServeLike {
  readonly state: ConnectionState;
  readonly lastError: string | null;
  readonly distro: string | null;
  readonly diagnostics: { distro: string | null; command: string | null };
  request(command: string, args?: Record<string, unknown>): Promise<ServeResponse>;
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
  return {
    ok: false,
    error: resp.error ?? { code: 'BAD_RESPONSE', message: 'serve returned ok:false without an error.', retryable: false },
  };
}

function isCreateArgs(v: unknown): v is CreateArgs {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (!Object.keys(o).every((k) => k === 'path' || k === 'name')) return false;
  return typeof o.path === 'string' && (o.name === undefined || typeof o.name === 'string');
}

export function registerIpc(deps: IpcDeps): void {
  const { ipcMain, client, showFolderDialog } = deps;

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
