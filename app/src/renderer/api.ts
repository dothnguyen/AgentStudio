export type ConnectionState = 'connecting' | 'connected' | 'lost';
export interface ConnectionStatus {
  state: ConnectionState;
  error: string | null;
  distro: string | null;
  command: string | null;
}
export interface ConnectionApi {
  onChange(cb: (s: ConnectionStatus) => void): () => void;
}

export const INITIAL_STATUS: ConnectionStatus = { state: 'connecting', error: null, distro: null, command: null };

declare global {
  interface Window {
    agentStudio?: {
      connection: {
        onChange(cb: (s: Partial<ConnectionStatus> & { state: ConnectionState }) => void): () => void;
      };
      workspaces?: {
        list(): Promise<Result<WorkspaceList>>;
        create(args: CreateArgs): Promise<Result<InitResult>>;
        pickFolder(): Promise<Result<string | null>>;
      };
    };
  }
}

export interface ApiError {
  code: string;
  message: string;
  retryable: boolean;
  remediation?: string;
}
export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiError };
export interface Workspace {
  id: string;
  name: string;
  path: string;
  missing: boolean;
  exists: boolean;
}
export interface WorkspaceList {
  workspaces: Workspace[];
}
export interface CreateArgs {
  path: string;
  name?: string;
}
export interface InitResult {
  id: string;
  name: string;
  path: string;
  existed: boolean;
}
export interface WorkspacesApi {
  list(): Promise<Result<WorkspaceList>>;
  create(args: CreateArgs): Promise<Result<InitResult>>;
  pickFolder(): Promise<Result<string | null>>;
}

export function getWorkspacesApi(): WorkspacesApi {
  const real = window.agentStudio?.workspaces;
  if (!real) throw new Error('Agent Studio preload API is missing (window.agentStudio.workspaces).');
  return {
    list: () => real.list(),
    create: (args) => real.create(args),
    pickFolder: () => real.pickFolder(),
  };
}

export function getConnectionApi(): ConnectionApi {
  const real = window.agentStudio?.connection;
  if (!real) throw new Error('Agent Studio preload API is missing (window.agentStudio).');
  return {
    onChange: (cb) =>
      real.onChange((s) =>
        cb({ state: s.state, error: s.error ?? null, distro: s.distro ?? null, command: s.command ?? null }),
      ),
  };
}
