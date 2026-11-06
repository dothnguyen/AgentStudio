import type { ManagementApi } from '../shared/management';

export type {
  AgentCatalogList,
  AgentDef,
  AgentDefChanges,
  AgentDefDeleted,
  AgentDefInput,
  AgentDefResult,
  BoardWorkflowSummary, BoardWorkflows, BoardWorkflowDetail, WorkflowProblem, PromptDetail, PromptList, CheckSetList, BoardStatuses,
  BoardColumn,
  BoardColumnCounts,
  BoardShow,
  BoardShowPhase,
  BoardRuleView,
  BoardRunResult,
  BoardRunner,
  BoardRunnerStatus,
  BoardPhase,
  BoardPhaseCreateInput,
  BoardPhaseCreateResult,
  BoardPhaseRef,
  BoardPhases,
  BoardTicket,
  BoardTicketActivity,
  BoardTicketActivityState,
  BoardTicketCreateInput,
  BoardTicketCreateResult,
  BoardTicketDetail,
  BoardTicketEvent,
  BoardTicketLink,
  BoardTicketLinks,
  BoardTicketList,
  BoardTicketSummary,
  BoardSettings,
  BoardSettingsChanges,
  BoardSettingsKey,
  ConfigState,
  ConfigWriteResult,
  FailureLimitPolicy,
  ManagementApi,
  ManagementError,
  ManagementResult,
  CancellationResult,
  MemberSwitchResult,
  MemberResumeResult,
  AttentionRun,
  AttentionCommandRequest,
  BlockedTicket,
  TeamAttention,
  UsageResetMember,
  UsageResetResult,
  RunRetryResult,
  RunCancelResult,
  TicketActionResult,
  CommandActionResult,
  AttachInfo,
  TeamStartAgent,
  TeamStartResult,
  TeamStopResult,
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
  SkillCatalogList,
  SkillDeleteResult,
  SkillDetail,
  SkillItem,
  SkillRoleRef,
  SkillRolesResult,
  SkillState,
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
        remove(path: string): Promise<Result<{ removed: boolean; path: string }>>;
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
  remove(path: string): Promise<Result<{ removed: boolean; path: string }>>;
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
    remove: (path) => real.remove(path),
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
    saveBoardWorkflow: (...args) => real.saveBoardWorkflow(...args),
    deleteBoardWorkflow: (...args) => real.deleteBoardWorkflow(...args),
    savePrompt: (...args) => real.savePrompt(...args),
    deletePrompt: (...args) => real.deletePrompt(...args),
    addStatus: (...args) => real.addStatus(...args),
    renameStatus: (...args) => real.renameStatus(...args),
    removeStatus: (...args) => real.removeStatus(...args),
    reorderStatuses: (...args) => real.reorderStatuses(...args),
    approveWorkflow: (...args) => real.approveWorkflow(...args),
    answerAssignment: (...args) => real.answerAssignment(...args),
    boardWorkflows: (...args) => real.boardWorkflows(...args),
    boardWorkflow: (...args) => real.boardWorkflow(...args),
    prompts: (...args) => real.prompts(...args),
    prompt: (...args) => real.prompt(...args),
    checkSets: (...args) => real.checkSets(...args),
    boardStatuses: (...args) => real.boardStatuses(...args),
    boardPhases: (...args) => real.boardPhases(...args),
    createPhase: (...args) => real.createPhase(...args),
    boardTickets: (...args) => real.boardTickets(...args),
    boardTicket: (...args) => real.boardTicket(...args),
    createTicket: (...args) => real.createTicket(...args),
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
    skills: (...args) => real.skills(...args),
    skill: (...args) => real.skill(...args),
    createSkill: (...args) => real.createSkill(...args),
    updateSkill: (...args) => real.updateSkill(...args),
    deleteSkill: (...args) => real.deleteSkill(...args),
    updateSkillRoles: (...args) => real.updateSkillRoles(...args),
    runBoard: (...args) => real.runBoard(...args),
    switchMemberAgent: (workspaceId, teamDefId, memberId, agent, confirmation) =>
      confirmation === undefined ? real.switchMemberAgent(workspaceId, teamDefId, memberId, agent) : real.switchMemberAgent(workspaceId, teamDefId, memberId, agent, confirmation),
    resumeMemberAgent: (workspaceId, teamDefId, memberId, agent) => real.resumeMemberAgent(workspaceId, teamDefId, memberId, agent),
    resetUsage: (...args) => real.resetUsage(...args),
    retryRun: (...args) => real.retryRun(...args),
    cancelRun: (...args) => real.cancelRun(...args),
    ticketMove: (...args) => real.ticketMove(...args),
    ticketPhase: (...args) => real.ticketPhase(...args),
    ticketWorkflow: (...args) => real.ticketWorkflow(...args),
    retryTicket: (...args) => real.retryTicket(...args),
    unblockTicket: (...args) => real.unblockTicket(...args),
    approveCommand: (...args) => real.approveCommand(...args),
    rejectCommand: (...args) => real.rejectCommand(...args),
    cancelCommand: (...args) => real.cancelCommand(...args),
    attachInfo: (...args) => real.attachInfo(...args),
    stopBoard: (...args) => real.stopBoard(...args),
    startTeam: (...args) => real.startTeam(...args),
    stopTeam: (...args) => real.stopTeam(...args),
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
