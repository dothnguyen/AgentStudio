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
export interface DelegationWork {
  commands: string[];
  state: 'running' | 'awaiting_approval' | 'queued';
}
export type MemberWork =
  | {
      state: 'working';
      assignment: { id: string; status: string; taskId: string; goal: string; workflowRunId: string | null } | null;
      ticket: { key: string; title: string; status: string; workflowRunId: string | null } | null;
      /** P06: the member's run is parked while the coordinator runs delegated commands for it. */
      delegation?: DelegationWork;
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
export interface AttentionRun {
  workflowRunId: string;
  status: 'queued' | 'running' | 'paused';
  stage: string | null;
  memberId: string | null;
  ticketKey: string | null;
  assignmentId: string | null;
  assignmentStatus: string | null;
  diagnosticCode: string | null;
  delegating: boolean;
}
export interface AttentionCommandRequest {
  id: string;
  command: string;
  status: 'requested' | 'approved' | 'running';
  reason: string | null;
  workflowRunId: string;
  memberId: string | null;
}
export interface BlockedTicket {
  key: string;
  title: string;
  reason: string | null;
  returnStatus: string | null;
  memberId: string | null;
  updatedAt: string;
}
export interface TeamAttention {
  runs: AttentionRun[];
  commandRequests: AttentionCommandRequest[];
  truncated: { runs: boolean; commandRequests: boolean };
}
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
  attention: TeamAttention;
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
  blockedTickets: BlockedTicket[];
  blockedTicketsTruncated: boolean;
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
export interface FailureLimitPolicy {
  count: number;
  status: string;
}

export interface BoardRuleView {
  index: number;
  status: string;
  type: 'action' | 'agent';
  role: string | null;
  workflow: string | null;
  during: string | null;
  action: string | null;
  onPass: string;
  onFail: string;
  onBlocked: string | null;
  workspace: string | null;
  syncBase: boolean;
  maxRounds: number | null;
  priority: number | null;
  onFailureLimit: FailureLimitPolicy | null;
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
  workflowStatuses: Array<{ id: string; name: string | null; kind: string | null }>;
  todoEntry: string[];
  todoDefault: string | null;
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
  | 'workflowStatuses'
  | 'todoEntry'
  | 'todoDefault'
  | 'ticketFields'
  | 'rules'
  | 'leaseSeconds'
  | 'baseBranch'
  | 'agentTicketStatus';

// Workflow catalog reads
export interface WorkflowProblem { path: string; message: string; workflow?: string }
export interface BoardWorkflowSummary {
  name: string; title: string; startsAt: string; whileRunning: string; role: string | null;
  steps: Array<{ id: string; kind: string }>;
  end: Record<string, unknown>; limits: Record<string, unknown>;
  priority?: number; workspace?: string; syncBase?: boolean; waitForDependencies?: boolean; createdTickets?: string;
}
export interface BoardWorkflows { workflows: BoardWorkflowSummary[]; problems: WorkflowProblem[] }
export interface BoardWorkflowDetail {
  name: string; definition: Record<string, unknown> | null; text: string; sha256: string;
  problems: WorkflowProblem[]; start: { allowed: boolean; default: boolean };
}
export interface PromptDetail { name: string; text: string; words: number; sha256: string; users: Array<{ workflow: string; step: string }> }
export interface PromptList { prompts: PromptDetail[] }
export interface CheckSetList {
  checkSets: Array<{ id: string; run: Array<{ command: string; when: string[] }>; otherwise: string | null; reuseIfTested: boolean }>;
  commands: Array<{ id: string; description: string }>; problems: Array<{ path: string; message: string }>;
}
export interface BoardStatuses {
  statuses: Array<{ id: string; name: string; hasName?: boolean; kind: 'initial' | 'done' | 'closed' | null;
    type: 'start' | 'done' | 'closed' | 'startsWorkflow' | 'whileRunning' | 'unused';
    usedBy: Array<{ workflow: string; title: string; how: string }>; ticketCount: number }>;
  sha256: string;
}

// board reads (phase.list, board.show, ticket.list summary mode, ticket.show)
export type BoardColumn = 'backlog' | 'todo' | 'in-progress' | 'done' | 'closed';
export type BoardColumnCounts = Record<BoardColumn, number>;
export interface BoardShowPhase extends BoardPhaseRef {
  current: boolean;
  ticketCount: number;
  columns: BoardColumnCounts;
  workflow: Record<string, number>;
  columnWorkflow: Record<BoardColumn, Record<string, number>>;
  waitingApproval: number; needsInput: number; blocked: number; paused: number;
}
export interface BoardShow {
  workspace: string;
  currentPhase: BoardPhaseRef;
  phases: BoardShowPhase[];
}
export interface BoardPhaseRef {
  id: string | null;
  slug: string;
  name: string;
  description: string | null;
  position: number;
  status: 'open' | 'closed';
}
export interface BoardPhase extends BoardPhaseRef {
  current: boolean;
  ticketCount: number;
  counts: Record<string, number>;
}
export interface BoardPhases {
  unassignedTicketCount?: number;
  workspace: string;
  currentPhase: BoardPhaseRef;
  phases: BoardPhase[];
}
export type BoardTicketActivityState = 'working' | 'not started' | 'finished' | 'blocked';
export interface BoardTicketActivity {
  state: BoardTicketActivityState;
  agent?: string | null;
  role?: string | null;
  run?: string | null;
  leaseUntil?: string | null;
  workflow?: string | null;
  waitingFor?: string;
  note?: string | null;
}
export interface BoardTicket {
  id: string;
  workspace: string;
  key: string;
  title: string;
  body: string | null;
  phase: string | null;
  phaseName: string | null;
  status: BoardColumn;
  workflowStatus: string;
  priority: number;
  assignee: string | null;
  leaseUntil: string | null;
  createdByMember: string | null;
  createdByAssignment: string | null;
  createdAt: string;
  updatedAt: string;
  runId: string | null;
  activeRunId: string | null;
  branch: string | null;
  worktreePath: string | null;
  preferredAgentId: string | null;
  rounds: Record<string, number> | null;
  returnStatus: string | null;
  blockedReason: string | null;
  waitingApproval: { workflowRunId: string; stage: string; ask: string; since: string } | null;
  needsInput: { question: string; since: string } | null;
  paused: { reason: string | null; at: string } | null;
  activity: BoardTicketActivity;
}
export interface BoardTicketSummary extends Omit<BoardTicket, 'body'> {
  dependsOn: string[];
  openDependsOn: string[];
}
export interface BoardTicketList {
  workspace: string;
  statuses: string[];
  status: BoardColumn | null;
  workflowStatus: string | null;
  phase: string | null;
  tickets: BoardTicketSummary[];
}
export interface BoardTicketLink {
  key: string;
  title: string | null;
  status: string | null;
  phase: string | null;
}
export interface BoardTicketLinks {
  dependsOn: BoardTicketLink[];
  dependents: BoardTicketLink[];
}
export interface BoardTicketEvent {
  id: number;
  at: string;
  actor: string;
  name: string;
  from: string | null;
  to: string | null;
  payload: unknown;
}
export interface BoardTicketDetail {
  attentionContext?: { workflow: string; stage: string; assignmentId: string | null; member: string | null; agent: string | null; routes: Record<string, string>; end: Record<string, unknown> } | null;
  workspace: string;
  ticket: BoardTicket;
  dependsOn: string[];
  dependents: string[];
  links: BoardTicketLinks;
  events: BoardTicketEvent[];
  eventsTruncated: boolean;
  statuses: string[];
}
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
export type SkillState = 'ok' | 'missing' | 'unreadable' | 'truncated';
export interface SkillRoleRef {
  id: string;
  name: string | null;
  contextBytes: number;
}
export interface SkillItem {
  id: string;
  path: string;
  state: SkillState;
  title: string | null;
  bytes: number | null;
  sha256: string | null;
  roles: SkillRoleRef[];
}
export interface SkillCatalogList {
  workspace: string;
  rolesSha256: string | null;
  limits: { skillBytes: number; roleContextBytes: number };
  skills: SkillItem[];
  problems: Problem[];
}
export interface SkillDetail {
  workspace: string;
  skill: SkillItem;
  text: string | null;
}
export interface SkillDeleteResult {
  workspace: string;
  deleted: { id: string; folder: 'removed' | 'kept' };
  rolesSha256: string | null;
}
export interface SkillRolesResult {
  workspace: string;
  skill: string;
  roles: string[];
  added: string[];
  removed: string[];
  rolesSha256: string;
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
export interface UsageResetMember {
  memberId: string | null;
  cleared: string[];
  activeAgent: string | null;
  switched: boolean;
  error?: string;
}
export interface UsageResetResult { teamId: string; provider: string; members: UsageResetMember[] }
export interface RunRetryResult {
  workflowRunId: string;
  assignmentId: string;
  action: 'retry';
  status: 'retried';
  newAssignmentId?: string;
  stage?: string;
}
export type RunCancelResult = Extract<CancellationResult, { workflowRunId: string }>;
export interface TicketActionResult { ticket: { key: string; status: string } }
export interface CommandActionResult { requestId: string; status: string }
export interface AttachInfo {
  sessionName: string;
  wsl: string;
  windowsTerminal: string;
  powershell: string;
  keys: Record<string, string>;
}
export interface TeamStartAgent {
  agentId: string;
  memberId?: string | null;
  providerId: string;
  role: string;
  displayName: string;
  paneId: string;
  model?: string | null;
  reasoning?: string | null;
  activeCatalogAgent?: string | null;
  roleConfigured?: boolean;
  roleSources?: string[];
  roleWarnings?: string[];
  [key: string]: unknown;
}
export interface TeamStartResult {
  teamId: string;
  name: string;
  workspace: string;
  agents: TeamStartAgent[];
  attach: AttachInfo;
}
export interface TeamStopResult {
  teamId: string;
  stopped: true;
  alreadyStopped?: boolean;
  sessionWasPresent?: boolean;
  tmuxInventory?: { before: string[]; after: string[] };
}

type R<T> = Promise<ManagementResult<T>>;
export interface ManagementApi {
  overview(workspaceId: string): R<TeamOverview>;
  agents(workspaceId: string): R<AgentCatalogList>;
  team(workspaceId: string, teamDefId: string): R<TeamDefinitionDetail>;
  validateTeam(workspaceId: string, teamDefId: string): R<TeamValidation>;
  boardSettings(workspaceId: string): R<BoardSettings>;
  saveBoardWorkflow(workspaceId: string, input: { name: string; definition: Record<string, unknown>; expectedSha256: string | null; start?: { allowed: boolean; default: boolean }; expectedBoardSha256?: string }): R<BoardWorkflowDetail>;
  deleteBoardWorkflow(workspaceId: string, input: { name: string; expectedSha256: string }): R<{ name: string }>;
  savePrompt(workspaceId: string, input: { name: string; text: string; expectedSha256: string | null }): R<PromptDetail>;
  deletePrompt(workspaceId: string, input: { name: string; expectedSha256: string }): R<{ name: string }>;
  addStatus(workspaceId: string, input: { id: string; name: string; kind: 'none' | 'done'; expectedSha256: string }): R<ConfigWriteResult>;
  renameStatus(workspaceId: string, input: { id: string; name: string; expectedSha256: string }): R<ConfigWriteResult>;
  removeStatus(workspaceId: string, input: { id: string; expectedSha256: string }): R<ConfigWriteResult>;
  reorderStatuses(workspaceId: string, input: { ids: string[]; expectedSha256: string }): R<ConfigWriteResult>;
  approveWorkflow(workspaceId: string, input: { workflowRunId: string; stage: string; approve: boolean; note?: string }): R<{ workflowRunId: string; stage: string; outcome: string }>;
  answerAssignment(workspaceId: string, input: { assignmentId: string; answer: string }): R<{ assignmentId: string; action: 'retry'; previousStatus: string; status: 'answered'; newAssignmentId: string; stage: string; resumedSession: boolean }>;
  boardWorkflows(workspaceId: string): R<BoardWorkflows>;
  boardWorkflow(workspaceId: string, name: string): R<BoardWorkflowDetail>;
  prompts(workspaceId: string): R<PromptList>;
  prompt(workspaceId: string, name: string): R<PromptDetail>;
  checkSets(workspaceId: string): R<CheckSetList>;
  boardStatuses(workspaceId: string): R<BoardStatuses>;
  boardPhases(workspaceId: string): R<BoardPhases>;
  boardTickets(workspaceId: string, input: { phase?: string; unassigned?: boolean }): R<BoardTicketList>;
  boardTicket(workspaceId: string, input: { key: string }): R<BoardTicketDetail>;
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
  skills(workspaceId: string): R<SkillCatalogList>;
  skill(workspaceId: string, skillId: string): R<SkillDetail>;
  createSkill(workspaceId: string, input: { id: string; text: string }): R<SkillDetail>;
  updateSkill(workspaceId: string, skillId: string, text: string, expectedSha256: string): R<SkillDetail>;
  deleteSkill(workspaceId: string, skillId: string, expectedRolesSha256: string | null, expectedSha256: string | null): R<SkillDeleteResult>;
  updateSkillRoles(workspaceId: string, skillId: string, roles: string[], expectedRolesSha256: string | null): R<SkillRolesResult>;
  runBoard(workspaceId: string, teamId: string): R<BoardRunResult>;
  switchMemberAgent(workspaceId: string, teamDefId: string, memberId: string, agent: string, confirmation?: { cancelActive: true; assignmentId: string }): R<MemberSwitchResult>;
  resumeMemberAgent(workspaceId: string, teamDefId: string, memberId: string, agent: string): R<MemberResumeResult>;
  stopBoard(workspaceId: string): R<BoardRunResult>;
  resetUsage(workspaceId: string, teamDefId: string, provider: string): R<UsageResetResult>;
  retryRun(workspaceId: string, workflowRunId: string): R<RunRetryResult>;
  cancelRun(workspaceId: string, workflowRunId: string): R<RunCancelResult>;
  ticketMove(workspaceId: string, input: { key: string; to: BoardColumn; workflowStatus?: string; reason?: string; force?: boolean }): R<TicketActionResult>;
  ticketPhase(workspaceId: string, input: { key: string; phase: string }): R<TicketActionResult>;
  ticketWorkflow(workspaceId: string, input: { key: string; to: string; reason?: string }): R<TicketActionResult>;
  retryTicket(workspaceId: string, key: string): R<TicketActionResult>;
  unblockTicket(workspaceId: string, key: string, to?: string): R<TicketActionResult>;
  approveCommand(workspaceId: string, requestId: string): R<CommandActionResult>;
  rejectCommand(workspaceId: string, requestId: string, reason?: string): R<CommandActionResult>;
  cancelCommand(workspaceId: string, requestId: string, reason?: string): R<CommandActionResult>;
  attachInfo(workspaceId: string, teamId: string): R<AttachInfo>;
  startTeam(workspaceId: string, teamDefId: string): R<TeamStartResult>;
  stopTeam(workspaceId: string, teamId: string): R<TeamStopResult>;
}
