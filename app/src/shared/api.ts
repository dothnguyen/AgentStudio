import type { StateChange } from '../main/serveClient';

export interface ConnectionPayload extends StateChange {
  distro: string | null;
  command: string | null;
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
export interface InitResult {
  id: string;
  name: string;
  path: string;
  existed: boolean;
}
export interface CreateArgs {
  path: string;
  name?: string;
}
export interface AgentStudioApi {
  workspaces: {
    list(): Promise<Result<WorkspaceList>>;
    create(args: CreateArgs): Promise<Result<InitResult>>;
    pickFolder(): Promise<Result<string | null>>;
  };
  connection: { onChange(cb: (s: ConnectionPayload) => void): () => void };
}
