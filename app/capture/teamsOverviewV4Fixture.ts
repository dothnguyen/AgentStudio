// Operator-only fixture for the Teams overview v4 capture (npm run capture:teams).
// It mirrors the sample data in design/teams-overview-v4.html and never changes the app.
import type {
  AgentCatalogList,
  AgentDef,
  BoardSettings,
  ConnectionStatus,
  DashboardActivity,
  DashboardApi,
  DashboardBoard,
  DashboardTeams,
  ManagementApi,
  ManagementResult,
  OverviewMember,
  ResolvedAgentOption,
  ResolvedMember,
  RoleCatalogItem,
  RoleCatalogList,
  TeamDefinitionDetail,
  TeamOverview,
  Workspace,
} from '../src/renderer/api';

export const TEAMS_V4_WORKSPACE: Workspace = {
  id: 'agent-studio',
  name: 'Agent Studio',
  path: '/mnt/c/Works/Projects/AgentStudio',
  exists: true,
  missing: false,
};

export const TEAMS_V4_CONNECTION: ConnectionStatus = {
  state: 'connected',
  error: null,
  distro: null,
  command: 'serve',
};

export const TEAMS_V4_TEAM_ID = 'dev-team';
export const TEAMS_V4_TEAM_NAME = 'Agent Studio Dev Team';
export const TEAMS_V4_RUNTIME_ID = 'b4597175-3c2e-4d1a-9f6b-0a7ef9548168'; // shows as b4597175…f9548168
export const TEAMS_V4_MEMBER_IDS = ['lead', 'dev-1', 'dev-2', 'dev-3', 'reviewer', 'qa'] as const;

export const CLAUDE_AGENT_ID = 'claude-opus-5-5-medium';
export const CODEX_AGENT_ID = 'codex-5-6-sol-medium';

export const CAPTURE_READ_ONLY = {
  ok: false as const,
  error: { code: 'CAPTURE_READ_ONLY', message: 'The v4 capture fixture is read-only.', retryable: false },
};

const CATALOG: AgentDef[] = [
  { id: CLAUDE_AGENT_ID, name: 'Claude Opus 5.5 medium', provider: 'claude', model: 'claude-opus-5-5', reasoning: 'medium' },
  { id: CODEX_AGENT_ID, name: 'Codex 5.6 Sol medium', provider: 'codex', model: 'gpt-5.6-sol', reasoning: 'medium' },
];

const ROLE_INFO: Record<string, { role: string; description: string }> = {
  lead: { role: 'TeamLead', description: 'Plans and refines stories.' },
  'dev-1': { role: 'Developer', description: 'Implements scoped tickets.' },
  'dev-2': { role: 'Developer', description: 'Implements scoped tickets.' },
  'dev-3': { role: 'Developer', description: 'Implements scoped tickets.' },
  reviewer: { role: 'Reviewer', description: 'Reviews changes.' },
  qa: { role: 'QA', description: 'Validates changes.' },
};

function catalogAgents(): AgentDef[] {
  return CATALOG.map((agent) => ({ ...agent }));
}

function resolvedOptions(): ResolvedAgentOption[] {
  return CATALOG.map((agent) => ({
    id: agent.id,
    name: agent.name,
    provider: agent.provider ?? null,
    model: agent.model ?? null,
    reasoning: agent.reasoning ?? null,
    description: null,
    state: 'ok' as const,
  }));
}

function option(id: string): ResolvedAgentOption {
  const found = resolvedOptions().find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`unknown capture agent ${id}`);
  return found;
}

function member(id: string): OverviewMember {
  const info = ROLE_INFO[id]!;
  const runtime: NonNullable<OverviewMember['runtime']> = id === 'lead'
    ? {
        agentId: 'agent-lead',
        configuredAgents: [CLAUDE_AGENT_ID, CODEX_AGENT_ID],
        activeAgent: CODEX_AGENT_ID,
        quotaHolds: {},
        pendingAgent: null,
        lastSwitch: {
          state: 'completed',
          requestedAgent: CODEX_AGENT_ID,
          assignmentId: null,
          code: null,
          message: null,
          at: '2026-10-31T09:00:00Z',
        },
        assignment: null,
        availability: 'idle',
        paneState: null,
        provider: 'codex',
        model: 'gpt-5.6-sol',
        reasoning: 'medium',
        stale: false,
      }
    : {
        agentId: `agent-${id}`,
        configuredAgents: [CLAUDE_AGENT_ID],
        activeAgent: CLAUDE_AGENT_ID,
        quotaHolds: {},
        pendingAgent: null,
        lastSwitch: null,
        assignment: null,
        availability: 'idle',
        paneState: null,
        provider: 'claude',
        model: 'claude-opus-5-5',
        reasoning: 'medium',
        stale: false,
      };
  return {
    memberId: id,
    name: id,
    role: info.role,
    roleDescription: info.description,
    roleState: 'defined',
    source: 'catalog',
    agentMode: id === 'lead' ? 'ordered_catalog' : 'single_catalog',
    agentOptions: id === 'lead' ? [option(CLAUDE_AGENT_ID), option(CODEX_AGENT_ID)] : [option(CLAUDE_AGENT_ID)],
    defaultAgent: CLAUDE_AGENT_ID,
    agentDefId: CLAUDE_AGENT_ID,
    agentDefState: 'ok',
    provider: 'claude',
    model: 'claude-opus-5-5',
    reasoning: 'medium',
    presence: 'idle',
    work: { state: 'none' },
    runtime,
  };
}

function overviewMembers(): OverviewMember[] {
  return TEAMS_V4_MEMBER_IDS.map((id) => member(id));
}

function roleItems(): RoleCatalogItem[] {
  const roles = ['TeamLead', 'Developer', 'Reviewer', 'QA'];
  return roles.map((id) => {
    const description = id === 'TeamLead' ? 'Plans and refines stories.'
      : id === 'Developer' ? 'Implements scoped tickets.'
      : id === 'Reviewer' ? 'Reviews changes.'
      : 'Validates changes.';
    const prompt = id === 'TeamLead'
      ? 'You are the team lead.\n\nTake a feature request and break it into phases, epics and stories.\nFor each story write a technical plan a developer can follow without asking questions: files to touch, tests to add, edge cases, and what done looks like.\n\nWhen a story is refined, fix the plan in place on the ticket.\nDo not review code. Do not merge. Do not implement stories yourself.\n\nIf a request is ambiguous, write down the assumption you made at the top of the story.'
      : null;
    return {
      id,
      name: id,
      description,
      instructions: prompt === null
        ? { state: 'none', path: null, text: null, sha256: null, bytes: null }
        : { state: 'ok', path: `.agent-studio/roles/${id === 'TeamLead' ? 'team-lead' : id.toLowerCase()}.md`, text: prompt, sha256: 'd'.repeat(64), bytes: prompt.length },
      skills: [],
      warnings: [],
      problems: [],
      usage: { members: [], boardRules: [], workflows: [], liveRuntime: [], count: 0, blocking: false, partial: false },
    };
  });
}

export function teamsOverviewV4Catalog(): AgentCatalogList {
  return {
    workspace: TEAMS_V4_WORKSPACE.path,
    version: 1,
    agents: catalogAgents(),
    problems: [],
    editorOptions: {
      providers: [
        {
          id: 'claude',
          modelSelectable: true,
          reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
          configuredModels: ['claude-opus-5-5'],
        },
        {
          id: 'codex',
          modelSelectable: true,
          reasoningLevels: ['minimal', 'low', 'medium', 'high', 'xhigh'],
          configuredModels: ['gpt-5.6-sol'],
        },
      ],
    },
  };
}

export function teamsOverviewV4Overview(): TeamOverview {
  return {
    workspace: TEAMS_V4_WORKSPACE.path,
    coordinator: { running: true },
    runtimeState: { available: true, error: null },
    roles: { state: 'ok', message: null },
    catalog: { state: 'ok', message: null },
    teams: [
      {
        id: TEAMS_V4_TEAM_ID,
        name: TEAMS_V4_TEAM_NAME,
        definition: { state: 'valid', problems: [] },
        runtime: { state: 'running', teamId: TEAMS_V4_RUNTIME_ID, status: 'running' },
        members: overviewMembers(),
        membersTruncated: false,
        attention: { runs: [], commandRequests: [], truncated: { runs: false, commandRequests: false } },
      },
    ],
    blockedTickets: [],
    blockedTicketsTruncated: false,
    truncated: false,
    partial: false,
  };
}

export function teamsOverviewV4BoardSettings(): BoardSettings {
  return {
    workspace: TEAMS_V4_WORKSPACE.path,
    board: { state: 'ok', sha256: 'a'.repeat(64), message: null, problems: [], config: {} },
    statuses: [],
    rules: [],
    actionRules: [],
    worktree: { baseBranch: 'main', worktreeStatuses: [] },
    protectedRoutes: [],
    roles: {
      state: 'ok',
      sha256: 'b'.repeat(64),
      message: null,
      items: roleItems().map((role) => ({ id: role.id, description: role.description })),
    },
    workflows: [],
    runner: {
      status: 'running',
      runStatus: 'running',
      teamId: TEAMS_V4_RUNTIME_ID,
      teamStatus: 'running',
      teamDefId: TEAMS_V4_TEAM_ID,
      coordinatorRunning: true,
      error: null,
    },
  };
}

export function teamsOverviewV4Roles(): RoleCatalogList {
  return {
    workspace: TEAMS_V4_WORKSPACE.path,
    state: 'ok',
    sha256: 'c'.repeat(64),
    items: roleItems(),
    problems: [],
    availableSkills: [],
  };
}

function resolvedMember(id: string): ResolvedMember {
  const info = ROLE_INFO[id]!;
  const base: ResolvedMember = {
    id,
    name: id,
    role: info.role,
    source: 'catalog',
    agent: CLAUDE_AGENT_ID,
    provider: 'claude',
    model: 'claude-opus-5-5',
    reasoning: 'medium',
    canAddTickets: id === 'lead',
  };
  return id === 'lead' ? { ...base, agents: [CLAUDE_AGENT_ID, CODEX_AGENT_ID] } : base;
}

export function teamsOverviewV4TeamDetail(): TeamDefinitionDetail {
  return {
    team: {
      id: TEAMS_V4_TEAM_ID,
      name: TEAMS_V4_TEAM_NAME,
      members: [
        { id: 'lead', name: 'lead', role: 'TeamLead', agents: [CLAUDE_AGENT_ID, CODEX_AGENT_ID] },
        ...(['dev-1', 'dev-2', 'dev-3', 'reviewer', 'qa'] as const).map((id) => ({
          id,
          name: id,
          role: ROLE_INFO[id]!.role,
          agent: CLAUDE_AGENT_ID,
        })),
      ],
    },
    members: TEAMS_V4_MEMBER_IDS.map((id) => resolvedMember(id)),
    problems: [],
    active: { teamId: TEAMS_V4_RUNTIME_ID, status: 'running' },
  };
}

export function createTeamsOverviewV4Apis(): { management: ManagementApi; dashboard: DashboardApi } {
  const ok = <T,>(data: T): Promise<ManagementResult<T>> => Promise.resolve({ ok: true, data });
  const readOnly = <T,>(): Promise<ManagementResult<T>> => Promise.resolve(CAPTURE_READ_ONLY);

  const management: ManagementApi = {
    overview: () => ok(teamsOverviewV4Overview()),
    agents: () => ok(teamsOverviewV4Catalog()),
    team: () => ok(teamsOverviewV4TeamDetail()),
    validateTeam: () => ok({
      teamDefId: TEAMS_V4_TEAM_ID,
      ready: true,
      problems: [],
      roster: teamsOverviewV4TeamDetail().members,
    }),
    boardSettings: () => ok(teamsOverviewV4BoardSettings()),
    roles: () => ok(teamsOverviewV4Roles()),
    createAgent: () => readOnly(),
    updateAgent: () => readOnly(),
    deleteAgent: () => readOnly(),
    createTeam: () => readOnly(),
    renameTeam: () => readOnly(),
    deleteTeam: () => readOnly(),
    addMember: () => readOnly(),
    updateMember: () => readOnly(),
    removeMember: () => readOnly(),
    updateBoardSettings: () => readOnly(),
    createRole: () => readOnly(),
    updateRole: () => readOnly(),
    updateRoleInstructions: () => readOnly(),
    deleteRole: () => readOnly(),
    skills: () => ok({
      workspace: TEAMS_V4_WORKSPACE.path,
      rolesSha256: null,
      limits: { skillBytes: 32768, roleContextBytes: 98304 },
      skills: [],
      problems: [],
    }),
    skill: () => readOnly(),
    createSkill: () => readOnly(),
    updateSkill: () => readOnly(),
    deleteSkill: () => readOnly(),
    updateSkillRoles: () => readOnly(),
    runBoard: () => readOnly(),
    switchMemberAgent: () => readOnly(),
    resumeMemberAgent: () => readOnly(),
    stopBoard: () => readOnly(),
    resetUsage: () => readOnly(),
    retryRun: () => readOnly(),
    cancelRun: () => readOnly(),
    retryTicket: () => readOnly(),
    unblockTicket: () => readOnly(),
    approveCommand: () => readOnly(),
    rejectCommand: () => readOnly(),
    cancelCommand: () => readOnly(),
    attachInfo: () => readOnly(),
    startTeam: () => readOnly(),
    stopTeam: () => readOnly(),
  };

  const dashboard: DashboardApi = {
    teams: () => ok<DashboardTeams>({
      workspace: TEAMS_V4_WORKSPACE.path,
      teams: [
        {
          id: TEAMS_V4_TEAM_ID,
          name: TEAMS_V4_TEAM_NAME,
          members: 6,
          runtime: {
            teamId: TEAMS_V4_RUNTIME_ID,
            status: 'running',
            memberCount: 6,
            availability: { starting: 0, idle: 6, busy: 0, waiting_input: 0, limit_reached: 0, offline: 0, error: 0 },
            activeAssignments: 0,
          },
        },
      ],
      truncated: false,
    }),
    board: () => ok<DashboardBoard>({
      workspace: TEAMS_V4_WORKSPACE.path,
      currentPhase: { slug: 'phase-05', name: 'Phase 05', status: 'open' },
      columns: [],
      totals: { active: 0, blocked: 0, done: 0 },
      tickets: [],
    }),
    activity: () => ok<DashboardActivity>({ workspace: TEAMS_V4_WORKSPACE.path, dbId: 'capture', head: 0, entries: [] }),
  };

  return { management, dashboard };
}
