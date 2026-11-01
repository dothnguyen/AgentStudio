// Operator-only fixture for the Routing v1 capture page (npm run capture:routing).
// It mirrors the sample data in design/routing-v1/*.html and never changes the app.
import type {
  BoardSettings,
  DashboardApi,
  ManagementApi,
  ManagementResult,
  OverviewMember,
  OverviewTeam,
  RoleCatalogItem,
  RoleCatalogList,
  TeamOverview,
} from '../src/renderer/api';
import { createTeamsOverviewV4Apis, TEAMS_V4_WORKSPACE } from './teamsOverviewV4Fixture';

export const ROUTING_V1_WORKSPACE = TEAMS_V4_WORKSPACE;
export const ROUTING_V1_TEAM_NAME = 'Agent Studio Dev Team';
export const ROUTING_V1_TEAM_ID = 'dev-team';

const WORKSPACE_PATH = ROUTING_V1_WORKSPACE.path;
const SHA = 'a'.repeat(64);

const STATUSES = [
  { id: 'backlog', name: 'Backlog', kind: null },
  { id: 'dev-ready', name: 'Dev ready', kind: null },
  // The design has no rule from backlog; validation needs a path to done from
  // the initial status, so the sample starts at Merge ready (whose merge action
  // reaches Done). Backlog stays the first free status for Add rule.
  { id: 'merge-ready', name: 'Merge ready', kind: 'initial' },
  { id: 'merge-conflict', name: 'Merge conflict', kind: null },
  { id: 'plan-merge-ready', name: 'Plan merge ready', kind: null },
  { id: 'plan-merge-conflict', name: 'Plan merge conflict', kind: null },
  { id: 'review-ready', name: 'Review ready', kind: null },
  { id: 'qa-ready', name: 'QA ready', kind: null },
  { id: 'need-escalate', name: 'Needs escalation', kind: null },
  { id: 'refine-ready', name: 'Refine ready', kind: null },
  { id: 'unpack-ready', name: 'Unpack ready', kind: null },
  { id: 'done', name: 'Done', kind: 'done' },
] as const;

// Developer first so the Add rule defaults match the design sample; the team
// roster below still lists the TeamLead first.
const ROLE_NAMES = ['Developer', 'TeamLead', 'Reviewer', 'QA', 'SeniorDeveloper', 'ProductOwner'] as const;
const WORKFLOWS = [
  { name: 'board-develop', builtin: true, roles: ['Developer'], errors: [] },
  { name: 'board-review', builtin: true, roles: ['Reviewer'], errors: [] },
  { name: 'board-qa', builtin: true, roles: ['QA'], errors: [] },
  { name: 'board-resolve-merge', builtin: true, roles: ['TeamLead'], errors: [] },
  { name: 'board-senior-develop', builtin: true, roles: ['SeniorDeveloper'], errors: [] },
  { name: 'board-refine', builtin: true, roles: ['TeamLead'], errors: [] },
  { name: 'board-unpack', builtin: true, roles: ['ProductOwner'], errors: [] },
];

interface RuleSpec {
  status: string;
  action?: 'merge';
  role?: string;
  workflow?: string;
  onPass: string;
  onFail: string;
  syncBase?: boolean;
  maxRounds?: number;
  priority?: number;
  onFailureLimit?: { count: number; status: string };
  protected?: boolean;
}

const RULE_SPECS: RuleSpec[] = [
  { status: 'merge-ready', action: 'merge', onPass: 'done', onFail: 'merge-conflict' },
  { status: 'plan-merge-ready', action: 'merge', onPass: 'done', onFail: 'plan-merge-conflict' },
  { status: 'merge-conflict', role: 'TeamLead', workflow: 'board-resolve-merge', onPass: 'merge-ready', onFail: 'merge-conflict', syncBase: true, maxRounds: 3, priority: 0, protected: true },
  { status: 'plan-merge-conflict', role: 'TeamLead', workflow: 'board-resolve-merge', onPass: 'plan-merge-ready', onFail: 'plan-merge-conflict', syncBase: true, maxRounds: 3, priority: 0, protected: true },
  { status: 'review-ready', role: 'Reviewer', workflow: 'board-review', onPass: 'merge-ready', onFail: 'dev-ready', onFailureLimit: { count: 3, status: 'need-escalate' } },
  { status: 'qa-ready', role: 'QA', workflow: 'board-qa', onPass: 'review-ready', onFail: 'dev-ready', onFailureLimit: { count: 3, status: 'need-escalate' } },
  { status: 'need-escalate', role: 'SeniorDeveloper', workflow: 'board-senior-develop', onPass: 'qa-ready', onFail: 'need-escalate', syncBase: true, maxRounds: 3, priority: 0 },
  { status: 'dev-ready', role: 'Developer', workflow: 'board-develop', onPass: 'qa-ready', onFail: 'dev-ready', syncBase: true, maxRounds: 6 },
  { status: 'refine-ready', role: 'TeamLead', workflow: 'board-refine', onPass: 'dev-ready', onFail: 'backlog', syncBase: true, maxRounds: 2 },
  { status: 'unpack-ready', role: 'ProductOwner', workflow: 'board-unpack', onPass: 'plan-merge-ready', onFail: 'backlog', maxRounds: 2 },
];

function rawRule(spec: RuleSpec): Record<string, unknown> {
  if (spec.action !== undefined) {
    return { when: { status: spec.status }, action: spec.action, onPass: spec.onPass, onFail: spec.onFail };
  }
  return {
    when: { status: spec.status },
    role: spec.role,
    workflow: spec.workflow,
    workspace: 'worktree',
    ...(spec.syncBase === true ? { syncBase: true } : {}),
    ...(spec.maxRounds !== undefined ? { maxRounds: spec.maxRounds } : {}),
    ...(spec.priority !== undefined ? { priority: spec.priority } : {}),
    ...(spec.onFailureLimit !== undefined ? { onFailureLimit: { ...spec.onFailureLimit } } : {}),
    onPass: spec.onPass,
    onFail: spec.onFail,
  };
}

export function routingV1Settings(): BoardSettings {
  const raw = RULE_SPECS.map(rawRule);
  return {
    workspace: WORKSPACE_PATH,
    board: { state: 'ok', sha256: SHA, message: null, problems: [], config: { rules: raw } },
    statuses: STATUSES.map(status => ({ ...status })),
    rules: RULE_SPECS.map((spec, index) => ({
      index,
      status: spec.status,
      type: spec.action === undefined ? 'agent' as const : 'action' as const,
      role: spec.role ?? null,
      workflow: spec.workflow ?? null,
      action: spec.action ?? null,
      onPass: spec.onPass,
      onFail: spec.onFail,
      onBlocked: null,
      workspace: spec.action === undefined ? 'worktree' : null,
      syncBase: spec.syncBase === true,
      maxRounds: spec.maxRounds ?? null,
      priority: spec.priority ?? null,
      onFailureLimit: spec.onFailureLimit !== undefined ? { ...spec.onFailureLimit } : null,
      protected: spec.protected === true,
    })),
    actionRules: RULE_SPECS.filter((spec): spec is RuleSpec & { action: 'merge' } => spec.action !== undefined)
      .map(spec => ({ status: spec.status, action: spec.action, onPass: spec.onPass, onFail: spec.onFail, onPassCreatedTickets: null })),
    worktree: { baseBranch: 'main', worktreeStatuses: [] },
    protectedRoutes: [
      { status: 'merge-conflict', role: 'TeamLead', satisfied: true },
      { status: 'plan-merge-conflict', role: 'TeamLead', satisfied: true },
    ],
    roles: { state: 'ok', sha256: SHA, message: null, items: ROLE_NAMES.map(id => ({ id, description: null })) },
    workflows: WORKFLOWS.map(workflow => ({ ...workflow, roles: [...workflow.roles], errors: [] })),
    runner: {
      status: 'running', runStatus: 'running', teamId: 'capture-runtime', teamStatus: 'running',
      teamDefId: ROUTING_V1_TEAM_ID, coordinatorRunning: true, error: null,
    },
  };
}

function roleItem(id: string): RoleCatalogItem {
  return {
    id,
    name: id,
    description: null,
    instructions: { state: 'none', path: null, text: null, sha256: null, bytes: null },
    skills: [],
    warnings: [],
    problems: [],
    usage: { members: [], boardRules: [], workflows: [], liveRuntime: { state: 'connected', error: null }, problems: [], count: 0, blocking: false, partial: false },
  } as unknown as RoleCatalogItem;
}

export function routingV1Roles(): RoleCatalogList {
  return {
    workspace: WORKSPACE_PATH,
    state: 'ok',
    sha256: SHA,
    items: ROLE_NAMES.map(roleItem),
    problems: [],
    availableSkills: [],
  };
}

function overviewMember(memberId: string, name: string, role: string): OverviewMember {
  return {
    memberId,
    name,
    role,
    roleDescription: null,
    roleState: 'defined',
    source: 'catalog',
    agentMode: 'single_catalog',
    agentOptions: [],
    defaultAgent: null,
    agentDefId: null,
    agentDefState: 'ok',
    provider: null,
    model: null,
    reasoning: null,
    runtime: null,
    presence: 'running',
    work: { state: 'unavailable', reason: 'idle' },
  } as unknown as OverviewMember;
}

export function routingV1Overview(): TeamOverview {
  const team = {
    id: ROUTING_V1_TEAM_ID,
    name: ROUTING_V1_TEAM_NAME,
    definition: { state: 'valid', problems: [] },
    runtime: { state: 'running', teamId: 'capture-runtime', status: 'running' },
    members: [
      overviewMember('lead', 'lead', 'TeamLead'),
      overviewMember('dev', 'dev', 'Developer'),
      overviewMember('dev-2', 'dev-2', 'Developer'),
      overviewMember('reviewer', 'reviewer', 'Reviewer'),
      overviewMember('qa', 'qa', 'QA'),
      overviewMember('senior', 'senior', 'SeniorDeveloper'),
    ],
    membersTruncated: false,
    attention: { runs: [], commandRequests: [], truncated: { runs: false, commandRequests: false } },
  } as unknown as OverviewTeam;
  return {
    workspace: WORKSPACE_PATH,
    coordinator: { running: true },
    runtimeState: { available: true, error: null },
    roles: { state: 'ok', message: null },
    catalog: { state: 'ok', message: null },
    teams: [team],
    blockedTickets: [],
    blockedTicketsTruncated: false,
    truncated: false,
    partial: false,
  };
}

/** Routing reads plus the unchanged dashboard reads the shell also asks for. */
export function createRoutingV1Apis(): { management: ManagementApi; dashboard: DashboardApi } {
  const base = createTeamsOverviewV4Apis();
  const ok = <T,>(data: T): Promise<ManagementResult<T>> => Promise.resolve({ ok: true, data });
  const management: ManagementApi = {
    ...base.management,
    overview: () => ok(routingV1Overview()),
    boardSettings: () => ok(routingV1Settings()),
    roles: () => ok(routingV1Roles()),
  };
  return { management, dashboard: base.dashboard };
}
