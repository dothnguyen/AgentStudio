import type { StateChange } from '../main/serveClient';
import type { ManagementApi } from './management';

export interface ConnectionPayload extends StateChange {
  distro: string | null;
  command: string | null;
}
export interface ApiError {
  code: string;
  message: string;
  retryable: boolean;
  remediation?: string;
  data?: unknown;
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
export type DashboardTeamStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'error';
export type DashboardAgentAvailability =
  | 'starting'
  | 'idle'
  | 'busy'
  | 'waiting_input'
  | 'limit_reached'
  | 'offline'
  | 'error';
export interface DashboardTeamRuntime {
  teamId: string;
  status: DashboardTeamStatus;
  memberCount: number;
  availability: Record<DashboardAgentAvailability, number>;
  activeAssignments: number;
}
export interface DashboardTeams {
  workspace: string;
  teams: Array<{
    id: string;
    name: string | null;
    members: number;
    problems?: Array<{ path: string; message: string }>;
    runtime: DashboardTeamRuntime | null;
  }>;
  truncated: boolean;
}
export interface DashboardBoard {
  workspace: string;
  currentPhase: { slug: string; name: string; status: 'open' | 'closed' };
  columns: Array<{
    status: string;
    kind: 'initial' | 'done' | 'closed' | null;
    title: string;
    count: number;
  }>;
  totals: { active: number; blocked: number; done: number };
  tickets: Array<{
    key: string;
    title: string;
    status: string;
    priority: number;
    phase: string;
    activity: {
      state: 'working' | 'not started' | 'finished' | 'blocked';
      agent?: string;
      role?: string;
    };
  }>;
}
export interface DashboardActivity {
  workspace: string;
  dbId: string;
  head: number;
  entries: Array<{
    id: string;
    at: string;
    kind: 'team' | 'assignment' | 'workflow' | 'ticket';
    name: string;
    summary: string;
    subject?: { type: string; id: string; label?: string };
  }>;
}
export interface AgentStudioApi {
  workspaces: {
    list(): Promise<Result<WorkspaceList>>;
    create(args: CreateArgs): Promise<Result<InitResult>>;
    pickFolder(): Promise<Result<string | null>>;
  };
  dashboard: {
    teams(workspaceId: string): Promise<Result<DashboardTeams>>;
    board(workspaceId: string): Promise<Result<DashboardBoard>>;
    activity(workspaceId: string): Promise<Result<DashboardActivity>>;
  };
  management: ManagementApi;
  connection: { onChange(cb: (s: ConnectionPayload) => void): () => void };
}
