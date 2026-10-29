// Types for the Teams management IPC. Type-only and import-free so the renderer can `import type` it.
export interface ManagementError {
  code: string;
  message: string;
  retryable: boolean;
  remediation?: string;
  data?: unknown;
}
export type ManagementResult<T> = { ok: true; data: T } | { ok: false; error: ManagementError };
export interface Problem {
  path: string;
  message: string;
}

// catalog
export interface AgentDef {
  id: string;
  name: string;
  provider: string;
  description?: string;
  model?: string;
  reasoning?: string;
  [key: string]: unknown;
}
export interface AgentDefInput {
  id?: string;
  name: string;
  provider: string;
  description?: string;
  model?: string;
  reasoning?: string;
}
export interface AgentDefChanges {
  name?: string;
  provider?: string;
  description?: string | null;
  model?: string | null;
  reasoning?: string | null;
}
export interface AgentEditorProviderOption {
  id: string;
  modelSelectable: boolean;
  reasoningLevels: string[];
  configuredModels: string[];
}
export interface AgentCatalogList {
  workspace: string;
  version: unknown;
  agents: AgentDef[];
  problems: Problem[];
  editorOptions: { providers: AgentEditorProviderOption[] };
}
export interface AgentDefResult {
  workspace: string;
  agent: AgentDef;
}
export interface AgentDefDeleted {
  workspace: string;
  deleted: AgentDef;
}

// team definitions
export interface TeamMemberConfig {
  id: string;
  name: string;
  role: string;
  agent?: string;
  agents?: string[];
  provider?: string;
  model?: string;
  reasoning?: string;
  canAddTickets?: boolean;
  [key: string]: unknown;
}
export interface TeamDefinition {
  id: string;
  name: string;
  members: TeamMemberConfig[];
  [key: string]: unknown;
}
export interface ResolvedMember {
  id: string | null;
  name: string | null;
  role: string | null;
  source: 'catalog' | 'inline';
  agent: string | null;
  agents?: string[];
  provider: string | null;
  model: string | null;
  reasoning: string | null;
  canAddTickets: boolean | null;
}
export interface TeamDefinitionDetail {
  team: TeamDefinition;
  members: ResolvedMember[];
  problems: Problem[];
  active: { teamId: string; status: string } | null;
}
export interface TeamValidation {
  teamDefId: string;
  ready: boolean;
  problems: Problem[];
  roster: ResolvedMember[];
}
export interface TeamCreateInput {
  name: string;
  teamDefId?: string;
}
export interface TeamEditResult {
  team: TeamDefinition;
  problems: Problem[];
  appliesOnNextStart?: boolean;
}
export interface TeamDeleted {
  deleted: string;
}
export interface MemberInput {
  memberId?: string;
  name?: string;
  role: string;
  agent?: string;
  agents?: string[];
  provider?: string;
  model?: string;
  reasoning?: string;
  canAddTickets?: boolean;
}
export interface MemberChanges {
  name?: string;
  role?: string;
  agent?: string;
  agents?: string[];
  provider?: string;
  model?: string | null;
  reasoning?: string | null;
  canAddTickets?: boolean | null;
}
export interface MemberEditResult {
  team: TeamDefinition;
  member: TeamMemberConfig;
  problems: Problem[];
  appliesOnNextStart: boolean;
}
export interface MemberRemoved {
  team: TeamDefinition;
  removed: TeamMemberConfig;
  problems: Problem[];
}

// team.overview
export type OverviewRuntimeState =
  | 'not_started'
  | 'starting'
  | 'running'
  | 'stopped'
  | 'error'
  | 'disconnected'
  | 'unavailable';
export type MemberWork =
  | {
      state: 'working';
      assignment: { id: string; status: string; taskId: string; goal: string; workflowRunId: string | null } | null;
      ticket: { key: string; title: string; status: string; workflowRunId: string | null } | null;
    }
  | { state: 'none' }
  | { state: 'unavailable'; reason: string };
export interface ResolvedAgentOption {
  id: string;
  name: string | null;
  provider: string | null;
  model: string | null;
  reasoning: string | null;
  description: string | null;
  state: 'ok' | 'missing';
}
export interface RuntimeSwitchState {
  state: 'pending' | 'completed' | 'failed';
  requestedAgent: string;
  assignmentId: string | null;
  code: string | null;
  message: string | null;
  at: string;
}
export type QuotaHoldMap = Record<string, string | null>;
export type RuntimeAssignment = { id: string; status: string; taskId: string } | null;
export interface OverviewMember {
  memberId: string | null;
  name: string | null;
  role: string | null;
  roleDescription: string | null;
  roleState: 'defined' | 'undefined' | 'unavailable';
  source: 'catalog' | 'inline' | 'runtime';
  agentMode: 'ordered_catalog' | 'single_catalog' | 'inline';
  agentOptions: ResolvedAgentOption[];
  defaultAgent: string | null;
  agentDefId: string | null;
  agentDefState: 'ok' | 'missing' | 'unavailable' | null;
  provider: string | null;
  model: string | null;
  reasoning: string | null;
  runtime: {
    agentId: string;
    configuredAgents: string[] | null;
    activeAgent: string | null;
    quotaHolds: QuotaHoldMap;
    pendingAgent: string | null;
    lastSwitch: RuntimeSwitchState | null;
    assignment: RuntimeAssignment;
    availability: string;
    paneState: string | null;
    provider: string | null;
    model: string | null;
    reasoning: string | null;
    stale: boolean;
  } | null;
  presence: string;
  work: MemberWork;
}
export interface OverviewTeam {
  id: string | null;
  name: string | null;
  definition: { state: 'valid' | 'problems' | 'unreadable' | 'missing'; problems: Problem[] };
  runtime: { state: OverviewRuntimeState; teamId: string | null; status: string | null };
  members: OverviewMember[];
  membersTruncated: boolean;
}
export interface ConfigState {
  state: 'ok' | 'missing' | 'invalid';
  message: string | null;
}
export interface TeamOverview {
  workspace: string;
  coordinator: { running: boolean };
  runtimeState: { available: boolean; error: { code: string; message: string } | null };
  roles: ConfigState;
  catalog: ConfigState;
  teams: OverviewTeam[];
  truncated: boolean;
  partial: boolean;
}

// board.settings
export type BoardRunnerStatus = 'unavailable' | 'not_bound' | 'stopped' | 'team_not_running' | 'disconnected' | 'running';
export interface BoardRunner {
  status: BoardRunnerStatus;
  runStatus: string | null;
  teamId: string | null;
  teamStatus: string | null;
  teamDefId: string | null;
  coordinatorRunning: boolean;
  error: { code: string; message: string } | null;
}
export interface BoardRuleView {
  index: number;
  status: string;
  type: 'action' | 'agent';
  role: string | null;
  workflow: string | null;
  action: string | null;
  onPass: string;
  onFail: string;
  onBlocked: string | null;
  workspace: string | null;
  syncBase: boolean;
  maxRounds: number | null;
  priority: number | null;
  protected: boolean;
}
export interface BoardSettings {
  workspace: string;
  board: {
    state: 'ok' | 'invalid' | 'missing';
    sha256: string | null;
    message: string | null;
    problems: Problem[];
    config: Record<string, unknown> | null;
  };
  statuses: Array<{ id: string; name: string | null; kind: string | null }>;
  rules: BoardRuleView[];
  actionRules: Array<{ status: string; action: string; onPass: string; onFail: string; onPassCreatedTickets: string | null }>;
  worktree: { baseBranch: string | null; worktreeStatuses: string[] };
  protectedRoutes: Array<{ status: string; role: string; satisfied: boolean }>;
  roles: {
    state: 'ok' | 'invalid' | 'missing';
    sha256: string | null;
    message: string | null;
    items: Array<{ id: string; description: string | null }>;
  };
  workflows: Array<{ name: string; builtin: boolean; roles: string[]; errors: unknown[] }>;
  runner: BoardRunner;
}
export type BoardSettingsKey =
  | 'statuses'
  | 'ticketFields'
  | 'rules'
  | 'leaseSeconds'
  | 'baseBranch'
  | 'agentTicketStatus';
export type BoardSettingsChanges = Partial<Record<BoardSettingsKey, unknown>>;
export interface ConfigWriteResult {
  workspace: string;
  file: 'board.json';
  sha256: string;
  changed: string[];
}
export type RoleCatalogState = 'ok' | 'missing' | 'invalid';
export type RoleInstructionState = 'ok' | 'none' | 'missing' | 'invalid' | 'truncated';
export type RoleSkillState = 'ok' | 'missing';
export interface RoleInstructions {
  state: RoleInstructionState;
  path: string | null;
  text: string | null;
  sha256: string | null;
  bytes: number | null;
}
export interface RoleSkill { id: string; state: RoleSkillState }
export interface RoleUsageAssignment { id: string; status: string }
export interface RoleUsageMember {
  teamDefId: string | null;
  teamName: string | null;
  memberId: string;
  memberName: string | null;
  saved: boolean;
  live: boolean;
  availability: string | null;
  assignment: RoleUsageAssignment | null;
}
export interface RoleUsageReference {
  sourceId: string;
  label: string | null;
  path: string | null;
}
export interface RoleUsage {
  members: RoleUsageMember[];
  boardRules: RoleUsageReference[];
  workflows: RoleUsageReference[];
  legacyRoster: RoleUsageReference[];
  liveRuntime: RoleUsageReference[];
  count: number;
  blocking: boolean;
  partial: boolean;
}
export interface RoleCatalogItem {
  id: string;
  name: string;
  description: string | null;
  instructions: RoleInstructions;
  skills: RoleSkill[];
  warnings: string[];
  problems: Problem[];
  usage: RoleUsage;
}
export interface RoleCatalogList {
  workspace: string;
  state: RoleCatalogState;
  sha256: string | null;
  items: RoleCatalogItem[];
  problems: Problem[];
  availableSkills: string[];
}
export interface RoleCreateInput {
  id?: string;
  name: string;
  description?: string;
  skills?: string[];
}
export interface RoleChanges {
  name?: string;
  description?: string | null;
  skills?: string[];
}
export interface RoleMutationResult {
  workspace: string;
  sha256: string;
  role: RoleCatalogItem;
  warnings: string[];
  appliesToNewAssignments: true;
}
export interface RoleInstructionsMutationResult extends RoleMutationResult {
  instructions: RoleInstructions;
}
export interface RoleDeleteResult {
  workspace: string;
  sha256: string | null;
  deleted: { id: string; instructions: 'deleted' | 'preserved' | 'missing' };
}
export interface RoleDeleteConfirmation {
  expectedRolesSha256: string;
  expectedInstructionsSha256: string | null;
}
export interface BoardRunResult {
  board: { workspace: string; status: 'running' | 'stopped'; teamId: string | null };
  rules?: number;
}

export type CancellationResult = ({ assignmentId: string } | { workflowRunId: string }) & {
  previousStatus: string;
  outcome: 'already_finished' | 'finishing' | 'cancelled' | 'cancel_requested';
  status: string;
};
export type MemberSwitchResult =
  | { teamId: string; memberId: string; agentId: string; activeAgent: string; provider: string }
  | { teamId: string; memberId: string; agentId: string; pendingAgent: string; assignmentId: string; cancellation: CancellationResult };
export type MemberResumeResult = { teamId: string; memberId: string; agentId: string; option: string; cleared: boolean; activeAgent: string | null };

type R<T> = Promise<ManagementResult<T>>;
export interface ManagementApi {
  overview(workspaceId: string): R<TeamOverview>;
  agents(workspaceId: string): R<AgentCatalogList>;
  team(workspaceId: string, teamDefId: string): R<TeamDefinitionDetail>;
  validateTeam(workspaceId: string, teamDefId: string): R<TeamValidation>;
  boardSettings(workspaceId: string): R<BoardSettings>;
  createAgent(workspaceId: string, agent: AgentDefInput): R<AgentDefResult>;
  updateAgent(workspaceId: string, agentDefId: string, changes: AgentDefChanges): R<AgentDefResult>;
  deleteAgent(workspaceId: string, agentDefId: string): R<AgentDefDeleted>;
  createTeam(workspaceId: string, input: TeamCreateInput): R<TeamEditResult>;
  renameTeam(workspaceId: string, teamDefId: string, name: string): R<TeamEditResult>;
  deleteTeam(workspaceId: string, teamDefId: string): R<TeamDeleted>;
  addMember(workspaceId: string, teamDefId: string, member: MemberInput): R<MemberEditResult>;
  updateMember(workspaceId: string, teamDefId: string, memberId: string, changes: MemberChanges): R<MemberEditResult>;
  removeMember(workspaceId: string, teamDefId: string, memberId: string): R<MemberRemoved>;
  updateBoardSettings(workspaceId: string, changes: BoardSettingsChanges, expectedSha256?: string): R<ConfigWriteResult>;
  roles(workspaceId: string): R<RoleCatalogList>;
  createRole(workspaceId: string, input: RoleCreateInput, expectedRolesSha256: string | null): R<RoleMutationResult>;
  updateRole(workspaceId: string, roleId: string, changes: RoleChanges, expectedRolesSha256: string): R<RoleMutationResult>;
  updateRoleInstructions(workspaceId: string, roleId: string, text: string, expectedRolesSha256: string, expectedInstructionsSha256: string | null): R<RoleInstructionsMutationResult>;
  deleteRole(workspaceId: string, roleId: string, confirmation: RoleDeleteConfirmation): R<RoleDeleteResult>;
  runBoard(workspaceId: string, teamId: string): R<BoardRunResult>;
  switchMemberAgent(workspaceId: string, teamDefId: string, memberId: string, agent: string, confirmation?: { cancelActive: true; assignmentId: string }): R<MemberSwitchResult>;
  resumeMemberAgent(workspaceId: string, teamDefId: string, memberId: string, agent: string): R<MemberResumeResult>;
  stopBoard(workspaceId: string): R<BoardRunResult>;
}
