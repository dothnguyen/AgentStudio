import type { ManagementApi } from '../shared/management';

export type {
  AgentCatalogList,
  AgentDef,
  AgentDefChanges,
  AgentDefDeleted,
  AgentDefInput,
  AgentDefResult,
  BoardRuleView,
  BoardRunResult,
  BoardRunner,
  BoardRunnerStatus,
  BoardSettings,
  BoardSettingsChanges,
  BoardSettingsKey,
  ConfigState,
  ConfigWriteResult,
  ManagementApi,
  ManagementError,
  ManagementResult,
  CancellationResult,
  MemberSwitchResult,
  MemberResumeResult,
  ResolvedAgentOption,
  RuntimeSwitchState,
  QuotaHoldMap,
  RuntimeAssignment,
  MemberChanges,
  MemberEditResult,
  MemberInput,
  MemberRemoved,
  MemberWork,
  OverviewMember,
  OverviewRuntimeState,
  OverviewTeam,
  Problem,
  ResolvedMember,
  RoleCatalogItem,
  RoleCatalogList,
  RoleChanges,
  RoleCreateInput,
  RoleDeleteConfirmation,
  RoleDeleteResult,
  RoleInstructionsMutationResult,
  RoleMutationResult,
  TeamCreateInput,
  TeamDefinition,
  TeamDefinitionDetail,
  TeamDeleted,
  TeamEditResult,
  TeamMemberConfig,
  TeamOverview,
  TeamValidation,
} from '../shared/management';

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
      management?: ManagementApi;
    };
  }
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

export function getManagementApi(): ManagementApi {
  const real = window.agentStudio?.management;
  if (!real) throw new Error('Agent Studio preload API is missing (window.agentStudio.management).');
  return {
    overview: (...args) => real.overview(...args),
    agents: (...args) => real.agents(...args),
    team: (...args) => real.team(...args),
    validateTeam: (...args) => real.validateTeam(...args),
    boardSettings: (...args) => real.boardSettings(...args),
    createAgent: (...args) => real.createAgent(...args),
    updateAgent: (...args) => real.updateAgent(...args),
    deleteAgent: (...args) => real.deleteAgent(...args),
    createTeam: (...args) => real.createTeam(...args),
    renameTeam: (...args) => real.renameTeam(...args),
    deleteTeam: (...args) => real.deleteTeam(...args),
    addMember: (...args) => real.addMember(...args),
    updateMember: (...args) => real.updateMember(...args),
    removeMember: (...args) => real.removeMember(...args),
    updateBoardSettings: (...args) => real.updateBoardSettings(...args),
    roles: (...args) => real.roles(...args),
    createRole: (...args) => real.createRole(...args),
    updateRole: (...args) => real.updateRole(...args),
    updateRoleInstructions: (...args) => real.updateRoleInstructions(...args),
    deleteRole: (...args) => real.deleteRole(...args),
    runBoard: (...args) => real.runBoard(...args),
    switchMemberAgent: (workspaceId, teamDefId, memberId, agent, confirmation) =>
      confirmation === undefined ? real.switchMemberAgent(workspaceId, teamDefId, memberId, agent) : real.switchMemberAgent(workspaceId, teamDefId, memberId, agent, confirmation),
    resumeMemberAgent: (workspaceId, teamDefId, memberId, agent) => real.resumeMemberAgent(workspaceId, teamDefId, memberId, agent),
    stopBoard: (...args) => real.stopBoard(...args),
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
