// Operator-only fixture for the Boards v1 capture page (npm run capture:boards).
// It mirrors the sample data in design/boards-v1/*.html and never changes the app.
import type {
  BoardPhase,
  BoardPhases,
  BoardRuleView,
  BoardSettings,
  BoardTicketDetail,
  BoardTicketEvent,
  BoardTicketList,
  BoardTicketSummary,
  ManagementApi,
  ManagementResult,
  TeamOverview,
} from '../src/renderer/api';
import { createTeamsOverviewV4Apis, TEAMS_V4_WORKSPACE } from './teamsOverviewV4Fixture';

export const BOARDS_V1_WORKSPACE = TEAMS_V4_WORKSPACE;
export const BOARDS_V1_PHASE = {
  id: 'phase-06-id',
  slug: 'phase-06',
  name: 'Phase 06 - Roles, Routing and Skills redesign',
  description: 'Redesign the Roles screen, move Routing to its own screen, and add a Skills screen, in the style of the Teams screen.',
  position: 6,
  status: 'open' as const,
};

const STATUS_IDS = [
  'backlog', 'unpack-ready', 'refine-ready', 'dev-ready', 'qa-ready', 'need-escalate',
  'review-ready', 'plan-merge-ready', 'plan-merge-conflict', 'merge-ready', 'merge-conflict', 'done', 'close',
];

const STATUS_NAMES: Record<string, string> = {
  backlog: 'Backlog',
  'unpack-ready': 'Unpack ready',
  'refine-ready': 'Refine ready',
  'dev-ready': 'Dev ready',
  'qa-ready': 'QA ready',
  'need-escalate': 'Needs escalation',
  'review-ready': 'Review ready',
  'plan-merge-ready': 'Plan merge ready',
  'plan-merge-conflict': 'Plan merge conflict',
  'merge-ready': 'Merge ready',
  'merge-conflict': 'Merge conflict',
  done: 'Done',
  close: 'Closed',
};

const READ_ONLY = {
  ok: false as const,
  error: { code: 'CAPTURE_READ_ONLY', message: 'The boards capture fixture is read-only.', retryable: false },
};

function rule(status: string, role: string, index: number, overrides: Partial<BoardRuleView> = {}): BoardRuleView {
  return {
    index, status, type: 'agent', role, workflow: 'board-develop', action: null,
    onPass: 'done', onFail: 'dev-ready', onBlocked: null, workspace: 'worktree',
    syncBase: false, maxRounds: null, priority: null, onFailureLimit: null, protected: false,
    ...overrides,
  };
}

export function boardsV1Settings(): BoardSettings {
  const statuses = STATUS_IDS.map((id) => ({
    id,
    name: STATUS_NAMES[id] ?? null,
    kind: id === 'backlog' ? 'initial' as const : id === 'done' ? 'done' as const : id === 'close' ? 'closed' as const : null,
  }));
  const rules: BoardRuleView[] = [
    rule('unpack-ready', 'ProductOwner', 0),
    rule('refine-ready', 'TeamLead', 1, { maxRounds: 2 }),
    rule('dev-ready', 'Developer', 2, { maxRounds: 6 }),
    rule('qa-ready', 'QA', 3, { maxRounds: 2 }),
    rule('need-escalate', 'SeniorDeveloper', 4, { maxRounds: 3, workflow: 'board-senior-develop' }),
    rule('review-ready', 'Reviewer', 5, { maxRounds: 2, workflow: 'board-review' }),
    rule('plan-merge-ready', '', 6, { type: 'action', role: null, workflow: null, action: 'merge' }),
    rule('plan-merge-conflict', 'TeamLead', 7, { workflow: 'board-resolve-merge' }),
    rule('merge-ready', '', 8, { type: 'action', role: null, workflow: null, action: 'merge' }),
    rule('merge-conflict', 'TeamLead', 9, { workflow: 'board-resolve-merge' }),
  ];
  return {
    workspace: BOARDS_V1_WORKSPACE.path,
    board: { state: 'ok', sha256: 'a'.repeat(64), message: null, problems: [], config: {} },
    statuses,
    rules,
    actionRules: rules.filter((entry) => entry.type === 'action').map((entry) => ({
      status: entry.status, action: entry.action!, onPass: entry.onPass, onFail: entry.onFail, onPassCreatedTickets: null,
    })),
    worktree: { baseBranch: 'main', worktreeStatuses: [] },
    protectedRoutes: [],
    roles: { state: 'ok', sha256: null, message: null, items: [] },
    workflows: [],
    runner: {
      status: 'running', runStatus: 'running', teamId: 'b4597175-3c2e-4d1a-9f6b-0a7ef9548168',
      teamStatus: 'running', teamDefId: 'dev-team', coordinatorRunning: true, error: null,
    },
  } as unknown as BoardSettings;
}

function summary(
  key: string,
  title: string,
  status: string,
  overrides: Partial<BoardTicketSummary> = {},
): BoardTicketSummary {
  const day = '2026-11-01';
  return {
    id: `${key.toLowerCase()}-id`,
    workspace: BOARDS_V1_WORKSPACE.path,
    key,
    title,
    phase: BOARDS_V1_PHASE.slug,
    phaseName: BOARDS_V1_PHASE.name,
    status,
    priority: 100,
    assignee: null,
    leaseUntil: null,
    createdByMember: null,
    createdByAssignment: null,
    createdAt: `${day}T13:57:00Z`,
    updatedAt: `${day}T21:12:00Z`,
    runId: null,
    activeRunId: null,
    branch: null,
    worktreePath: null,
    preferredAgentId: null,
    rounds: null,
    returnStatus: null,
    blockedReason: null,
    activity: { state: 'not started' },
    dependsOn: [],
    openDependsOn: [],
    ...overrides,
  };
}

function working(agent: string, role: string, workflow: string, run: string, round?: { status: string; value: number }) {
  return {
    state: 'working' as const,
    agent,
    role,
    run,
    leaseUntil: '2026-11-01T12:00:00Z',
    workflow,
    ...(round ? { rounds: { [round.status]: round.value } } : {}),
  };
}

export const BOARDS_V1_TICKETS: BoardTicketSummary[] = [
  summary('T-134', 'Boards Phase A: Current Phase board and ticket page', 'backlog'),
  summary('T-135', 'Boards Phase B: Backlog list and Phases view', 'backlog'),
  summary('T-133', 'Document the bridge allowlist in scripts/README', 'refine-ready', {
    branch: 'ticket/t-133',
    rounds: { 'refine-ready': 1 },
    activity: working('lead', 'TeamLead', 'board-refine', 'run-t-133'),
  }),
  summary('T-114', 'Roles v2 (3/4): edit dialogs for overview, skills and instructions, and the New role dialog', 'dev-ready', {
    branch: 'ticket/t-114', rounds: { 'dev-ready': 2 }, dependsOn: ['T-113'],
    activity: working('dev', 'Developer', 'board-develop', 'run-t-114'),
  }),
  summary('T-115', 'Roles v2 (4/4): remove the old roles layout and finish (a11y, responsive, design check)', 'dev-ready', {
    dependsOn: ['T-112', 'T-113', 'T-114'], openDependsOn: ['T-114', 'T-113'],
  }),
  summary('T-116', 'Routing v1 (1/4): Routing becomes its own screen with a sidebar item and leaves the team page', 'dev-ready', {
    activity: { state: 'not started', waitingFor: 'Developer' },
  }),
  summary('T-117', 'Routing v1 (2/4): summary cards and the redesigned rules table', 'dev-ready', {
    dependsOn: ['T-116'], openDependsOn: ['T-116'],
    activity: { state: 'not started', waitingFor: 'Developer' },
  }),
  summary('T-118', 'Routing v1 (3/4): edit, add and remove rules and edit worktrees in dialogs', 'dev-ready', {
    priority: 50, dependsOn: ['T-117'], openDependsOn: ['T-117'],
    activity: { state: 'not started', waitingFor: 'Developer' },
  }),
  summary('T-119', 'Routing v1 (4/4): remove the old routing panel code and finish', 'dev-ready', {
    dependsOn: ['T-116', 'T-117', 'T-118'], openDependsOn: ['T-118', 'T-116', 'T-117'],
    activity: { state: 'not started', waitingFor: 'Developer' },
  }),
  summary('T-136', 'Fix flaky teamsA11y focus test after the dialog change', 'blocked', {
    returnStatus: 'qa-ready', branch: 'ticket/t-136', rounds: { 'qa-ready': 1 },
    blockedReason: 'The run was stopped when the team stopped. Unblock it to continue.',
    activity: { state: 'blocked', note: 'The run was stopped when the team stopped. Unblock it to continue.' },
  }),
  summary('T-137', 'Escalated: backend test_p04_s10 scheduler failures on main', 'need-escalate', {
    rounds: { 'need-escalate': 3 },
    activity: working('senior', 'SeniorDeveloper', 'board-senior-develop', 'run-t-137'),
  }),
  summary('T-113', 'Roles v2 (2/4): role page with section cards (overview, instructions, skills, used by) and delete', 'review-ready', {
    branch: 'ticket/t-113', rounds: { 'review-ready': 1 },
    activity: working('reviewer', 'Reviewer', 'board-review', 'run-t-113'),
  }),
  summary('T-138', 'Merge conflict in design/README after the Skills export', 'merge-conflict', {
    branch: 'ticket/t-138', rounds: { 'merge-conflict': 1 },
    activity: working('lead', 'TeamLead', 'board-resolve-merge', 'run-t-138'),
  }),
  summary('T-112', 'Roles v2 (1/4): roles table and list / role-page navigation instead of the master-detail layout', 'done', {
    branch: 'ticket/t-112', activity: { state: 'finished' }, updatedAt: '2026-11-01T21:02:00Z',
  }),
  summary('T-124', 'Approval demo: app-dependency-add', 'dev-ready', {
    activity: { state: 'not started', waitingFor: 'Developer' },
  }),
  summary('T-139', 'Boards Phase A: finish', 'dev-ready', {
    activity: { state: 'not started', waitingFor: 'Developer' },
  }),
];

export function boardsV1TicketList(): BoardTicketList {
  return {
    workspace: BOARDS_V1_WORKSPACE.path,
    statuses: STATUS_IDS,
    status: null,
    phase: BOARDS_V1_PHASE.slug,
    tickets: BOARDS_V1_TICKETS.map((ticket) => ({ ...ticket, dependsOn: [...ticket.dependsOn], openDependsOn: [...ticket.openDependsOn] })),
  };
}

export function boardsV1Phases(): BoardPhases {
  const counts = Object.fromEntries(STATUS_IDS.map((status) => [status, 0])) as Record<string, number>;
  for (const ticket of BOARDS_V1_TICKETS) counts[ticket.status] = (counts[ticket.status] ?? 0) + 1;
  const phase: BoardPhase = {
    ...BOARDS_V1_PHASE,
    current: true,
    ticketCount: BOARDS_V1_TICKETS.length,
    counts,
  };
  return {
    workspace: BOARDS_V1_WORKSPACE.path,
    currentPhase: BOARDS_V1_PHASE,
    phases: [phase],
  };
}

function linkOf(key: string) {
  const ticket = BOARDS_V1_TICKETS.find((entry) => entry.key === key);
  return ticket === undefined
    ? { key, title: null, status: null, phase: null }
    : { key, title: ticket.title, status: ticket.status, phase: ticket.phase };
}

function event(id: number, time: string, name: string, from: string | null, to: string | null, payload: Record<string, unknown> = {}): BoardTicketEvent {
  return { id, at: `2026-11-01T${time}:00Z`, actor: 'coordinator', name, from, to, payload };
}

const BODIES: Record<string, string> = {
  'T-114': '# Roles v2 (3/4): edit dialogs and New role\n\n## Goal\nReplace the old full-form role editor (`RoleForm.tsx`, `RoleSkillEditor.tsx`, `useRoleEditing` in `RolesScreen.tsx`) with one dialog per section of the role page, and restyle New role, as in `design/roles-catalog-v2/edit-overview.png`, `edit-skills.png`, `edit-instructions.png` and `new-role.png`.\n\n## Do not duplicate\nThe save sequence lives in `app/src/renderer/roles/roleSave.ts`; every role write goes through it.\n\n## Dialogs\n1. Edit overview (width 560)\n2. Edit skills (width 560)\n3. Edit instructions (width 780)\n4. New role (width 560)\n\n## Done when\n- [ ] Every section of the role page edits through its own dialog matching the design.\n- [ ] All role writes go through the shared save module.\n- [ ] Tests above exist and pass; `test-ui` passes.',
  'T-118': '# Routing v1 (3/4): edit, add and remove rules and edit worktrees in dialogs\n\n## Goal\nImplement as described in the design folder referenced below. Match the design as closely as possible.\n\n## Done when\n- [ ] The behaviour above exists and is covered by tests.\n- [ ] `test-ui` passes.\n\n## Constraints\nNo backend change; no new dependency.',
  'T-136': '# Fix flaky teamsA11y focus test after the dialog change\n\n## Goal\nImplement as described in the design folder referenced below. Match the design as closely as possible.\n\n## Done when\n- [ ] The behaviour above exists and is covered by tests.\n- [ ] `test-ui` passes.\n\n## Constraints\nNo backend change; no new dependency.',
  'T-112': '# Roles v2 (1/4): roles table and list / role-page navigation instead of the master-detail layout\n\n## Goal\nImplement as described in the design folder referenced below. Match the design as closely as possible.\n\n## Done when\n- [ ] The behaviour above exists and is covered by tests.\n- [ ] `test-ui` passes.\n\n## Constraints\nNo backend change; no new dependency.',
};

const EVENTS: Record<string, BoardTicketEvent[]> = {
  'T-114': [
    event(1, '13:57', 'ticket.created', null, 'dev-ready'),
    event(2, '13:57', 'ticket.depends', null, null, { on: ['T-113'] }),
    { ...event(3, '14:04', 'ticket.moved', 'dev-ready', 'dev-ready'), actor: 'operator' },
    event(4, '21:03', 'ticket.claimed', 'dev-ready', 'dev-ready', { agent: 'dev', round: 1 }),
    event(5, '21:31', 'ticket.command_requested', null, null, { command: 'test-ui' }),
    event(6, '21:46', 'ticket.command_finished', null, null, { command: 'test-ui', durationMs: 840000 }),
    event(7, '21:47', 'ticket.committed', null, null, { message: 'Roles v2 (3/4): edit dialogs' }),
    event(8, '21:48', 'ticket.outcome_applied', null, 'dev-ready', { outcome: 'fail', findings: 2 }),
    event(9, '21:52', 'ticket.claimed', 'dev-ready', 'dev-ready', { agent: 'dev', round: 2 }),
  ],
  'T-118': [
    event(1, '13:57', 'ticket.created', null, 'dev-ready'),
    event(2, '13:57', 'ticket.depends', null, null, { on: ['T-117'] }),
    { ...event(3, '21:12', 'ticket.moved', 'dev-ready', 'dev-ready'), actor: 'operator' },
  ],
  'T-136': [
    event(1, '19:10', 'ticket.created', null, 'dev-ready'),
    { ...event(2, '19:12', 'ticket.moved', 'dev-ready', 'dev-ready'), actor: 'operator' },
    event(3, '19:30', 'ticket.claimed', 'dev-ready', 'dev-ready', { agent: 'dev', round: 1 }),
    event(4, '20:02', 'ticket.outcome_applied', null, 'qa-ready', { outcome: 'pass', detail: 'Dev passed, tests verified' }),
    event(5, '20:10', 'ticket.claimed', 'qa-ready', 'qa-ready', { agent: 'qa', round: 1 }),
    event(6, '20:41', 'run.cancelled', null, null, { note: 'The team was stopped' }),
    event(7, '20:41', 'ticket.blocked', null, 'blocked', { returnStatus: 'qa-ready' }),
  ],
  'T-112': [
    event(1, '13:57', 'ticket.created', null, 'dev-ready'),
    { ...event(2, '21:02', 'ticket.moved', 'review-ready', 'done'), actor: 'operator' },
  ],
};

export function boardsV1TicketDetail(key: string): BoardTicketDetail {
  const ticket = BOARDS_V1_TICKETS.find((entry) => entry.key === key) ?? BOARDS_V1_TICKETS[0]!;
  const dependents = BOARDS_V1_TICKETS.filter((entry) => entry.dependsOn.includes(key));
  return {
    workspace: BOARDS_V1_WORKSPACE.path,
    ticket: { ...ticket, body: BODIES[key] ?? `# ${ticket.title}\n\n## Goal\nImplement as described in the design.` },
    dependsOn: ticket.dependsOn,
    dependents: dependents.map((entry) => entry.key),
    links: {
      dependsOn: ticket.dependsOn.map(linkOf),
      dependents: dependents.map((entry) => linkOf(entry.key)),
    },
    events: EVENTS[key] ?? [event(1, '13:57', 'ticket.created', null, ticket.status)],
    eventsTruncated: false,
    statuses: STATUS_IDS,
  };
}

export function boardsV1Overview(): TeamOverview {
  return {
    workspace: BOARDS_V1_WORKSPACE.path,
    coordinator: { running: true },
    runtimeState: { available: true, error: null },
    roles: { state: 'ok', message: null },
    catalog: { state: 'ok', message: null },
    teams: [{
      id: 'dev-team',
      name: 'Agent Studio Dev Team',
      definition: { state: 'valid', problems: [] },
      runtime: { state: 'running', teamId: 'b4597175-3c2e-4d1a-9f6b-0a7ef9548168', status: 'running' },
      members: [{
        memberId: 'dev', name: 'dev', role: null, roleDescription: null,
        roleState: 'undefined', source: 'catalog', agentMode: 'ordered_catalog', agentOptions: [],
        defaultAgent: null, agentDefId: null, agentDefState: null, provider: null, model: null,
        reasoning: null, runtime: null, presence: 'busy',
        work: { state: 'working', assignment: null, ticket: { key: 'T-124', title: 'Approval demo: app-dependency-add', status: 'dev-ready', workflowRunId: 'run-t-124' } },
      }],
      membersTruncated: false,
      attention: {
        runs: [{
          workflowRunId: 'run-t-124', status: 'running', stage: 'dev', memberId: 'dev', ticketKey: 'T-124',
          assignmentId: null, assignmentStatus: null, diagnosticCode: null, delegating: true,
        }],
        commandRequests: [{
          id: 'request-1', command: 'app-dependency-add', status: 'requested', reason: null,
          workflowRunId: 'run-t-124', memberId: 'dev',
        }],
        truncated: { runs: false, commandRequests: false },
      },
    }],
    blockedTickets: [{
      key: 'T-136', title: 'Fix flaky teamsA11y focus test after the dialog change',
      reason: 'The run was stopped when the team stopped. Unblock it to continue.',
      returnStatus: 'qa-ready', memberId: 'qa', updatedAt: '2026-11-01T20:41:00Z',
    }],
    blockedTicketsTruncated: false,
    truncated: false,
    partial: false,
  };
}

export function createBoardsV1Apis(includeEmptyPhase = false): { dashboard: ReturnType<typeof createTeamsOverviewV4Apis>['dashboard']; management: ManagementApi } {
  const writeNames = [
    'createAgent', 'updateAgent', 'deleteAgent', 'createTeam', 'renameTeam', 'deleteTeam',
    'addMember', 'updateMember', 'removeMember', 'updateBoardSettings', 'createRole', 'updateRole',
    'updateRoleInstructions', 'deleteRole', 'createSkill', 'updateSkill', 'deleteSkill', 'updateSkillRoles',
    'runBoard', 'switchMemberAgent', 'resumeMemberAgent', 'stopBoard', 'resetUsage', 'retryRun', 'cancelRun',
    'retryTicket', 'unblockTicket', 'approveCommand', 'rejectCommand', 'cancelCommand', 'startTeam', 'stopTeam',
  ];
  const writes = Object.fromEntries(writeNames.map((name) => [name, async () => READ_ONLY]));
  const management = {
    ...writes,
    boardPhases: async (): Promise<ManagementResult<BoardPhases>> => ({ ok: true, data: includeEmptyPhase ? { ...boardsV1Phases(), phases: [...boardsV1Phases().phases, { ...boardsV1Phases().phases[0]!, id: 'phase-07-id', slug: 'phase-07', name: 'Phase 07 - Upcoming', current: false, ticketCount: 0, counts: {} }] } : boardsV1Phases() }),
    boardSettings: async (): Promise<ManagementResult<BoardSettings>> => ({ ok: true, data: boardsV1Settings() }),
    boardTickets: async (): Promise<ManagementResult<BoardTicketList>> => ({ ok: true, data: boardsV1TicketList() }),
    boardTicket: async (_id: string, input: { key: string }): Promise<ManagementResult<BoardTicketDetail>> => ({ ok: true, data: boardsV1TicketDetail(input.key) }),
    overview: async (): Promise<ManagementResult<TeamOverview>> => ({ ok: true, data: boardsV1Overview() }),
  } as unknown as ManagementApi;
  return { dashboard: createTeamsOverviewV4Apis().dashboard, management };
}
