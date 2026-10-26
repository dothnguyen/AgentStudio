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
      dashboard?: DashboardApi;
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
export interface DashboardApi {
  teams(workspaceId: string): Promise<Result<DashboardTeams>>;
  board(workspaceId: string): Promise<Result<DashboardBoard>>;
  activity(workspaceId: string): Promise<Result<DashboardActivity>>;
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

export function getDashboardApi(): DashboardApi {
  const real = window.agentStudio?.dashboard;
  if (!real) throw new Error('Agent Studio preload API is missing (window.agentStudio.dashboard).');
  return {
    teams: (workspaceId) => real.teams(workspaceId),
    board: (workspaceId) => real.board(workspaceId),
    activity: (workspaceId) => real.activity(workspaceId),
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
