import { vi } from 'vitest';
import type {
  BoardPhase,
  BoardPhases,
  BoardTicketDetail,
  BoardTicketLink,
  BoardTicketList,
  BoardTicketSummary,
  ManagementApi,
  Result,
} from '../src/renderer/api';

export const BOARD_WORKSPACE = '/work/alpha';
export const BOARD_STATUSES = [
  'backlog', 'refine-ready', 'dev-ready', 'qa-ready', 'review-ready', 'need-escalate',
  'merge-conflict', 'done', 'close',
];

const PHASE_05 = { id: 'phase-05-id', slug: 'phase-05', name: 'Phase 05', description: 'Helm and app work.', position: 0, status: 'open' as const };
const PHASE_06 = { id: 'phase-06-id', slug: 'phase-06', name: 'Phase 06', description: 'Boards and ticket pages.', position: 1, status: 'open' as const };

export function boardTicketSummary(overrides: Omit<Partial<BoardTicketSummary>, 'status'> & { status?: string } = {}): BoardTicketSummary {
  const key = overrides.key ?? 'T-114';
  const phase = overrides.phase !== undefined ? overrides.phase : PHASE_05.slug;
  const phaseRef = phase === PHASE_06.slug ? PHASE_06 : PHASE_05;
  return {
    id: `${key.toLowerCase()}-id`,
    workspace: BOARD_WORKSPACE,
    key,
    title: 'Boards v1: Current Phase board and ticket page',
    phase,
    phaseName: phaseRef.name,
    status: 'dev-ready',
    priority: 100,
    assignee: null,
    leaseUntil: null,
    createdByMember: null,
    createdByAssignment: null,
    createdAt: '2026-11-01T03:57:00Z',
    updatedAt: '2026-11-01T11:12:00Z',
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
    workflowStatus: overrides.workflowStatus ?? overrides.status ?? 'dev-ready',
  } as BoardTicketSummary;
}

function working(agent: string, role: string, workflow: string, run: string) {
  return {
    state: 'working' as const,
    agent,
    role,
    run,
    leaseUntil: '2026-11-01T12:00:00Z',
    workflow,
  };
}

export const BOARD_TICKETS: BoardTicketSummary[] = [
  boardTicketSummary({
    key: 'T-112', title: 'Roles v2: roles table and role-page navigation', phase: PHASE_05.slug,
    status: 'done', branch: 'ticket/t-112', activity: { state: 'finished' },
    updatedAt: '2026-11-01T09:02:00Z',
  }),
  boardTicketSummary({
    key: 'T-113', title: 'Roles v2: role page with section cards', phase: PHASE_05.slug,
    status: 'review-ready', branch: 'ticket/t-113', activity: working('reviewer', 'Reviewer', 'board-review', 'run-t-113'),
    dependsOn: ['T-112'],
  }),
  boardTicketSummary({
    key: 'T-114', title: 'Roles v2: edit dialogs and the New role dialog', phase: PHASE_05.slug,
    status: 'dev-ready', priority: 20, branch: 'ticket/t-114', rounds: { 'dev-ready': 2 },
    activity: working('dev', 'Developer', 'board-develop', 'run-t-114'),
    dependsOn: ['T-113'], openDependsOn: ['T-113'],
  }),
  boardTicketSummary({
    key: 'T-115', title: 'Roles v2: remove the old layout and finish', phase: PHASE_05.slug,
    status: 'dev-ready', activity: { state: 'not started', waitingFor: 'Developer' },
    dependsOn: ['T-112', 'T-113', 'T-114'], openDependsOn: ['T-113', 'T-114'],
  }),
  boardTicketSummary({
    key: 'T-116', title: 'Routing v1: Routing becomes its own screen', phase: PHASE_05.slug,
    status: 'dev-ready', activity: { state: 'not started', waitingFor: 'Developer' },
  }),
  boardTicketSummary({
    key: 'T-117', title: 'Routing v1: summary cards and the redesigned rules table', phase: PHASE_05.slug,
    status: 'dev-ready', activity: { state: 'not started', waitingFor: 'Developer' },
    dependsOn: ['T-116'], openDependsOn: ['T-116'],
  }),
  boardTicketSummary({
    key: 'T-118', title: 'Routing v1: edit, add and remove rules in dialogs', phase: PHASE_05.slug,
    status: 'dev-ready', priority: 50, activity: { state: 'not started', waitingFor: 'Developer' },
    dependsOn: ['T-117'], openDependsOn: ['T-117'],
  }),
  boardTicketSummary({
    key: 'T-119', title: 'Routing v1: remove the old routing panel and finish', phase: PHASE_05.slug,
    status: 'dev-ready', activity: { state: 'not started', waitingFor: 'Developer' },
    dependsOn: ['T-116', 'T-117', 'T-118'], openDependsOn: ['T-116', 'T-117', 'T-118'],
  }),
  boardTicketSummary({
    key: 'T-120', title: 'Skills 1/12: read the skill catalog', phase: PHASE_06.slug,
    status: 'dev-ready', activity: { state: 'not started', waitingFor: 'Developer' },
  }),
  boardTicketSummary({
    key: 'T-133', title: 'Document the bridge allowlist in scripts/README', phase: PHASE_06.slug,
    status: 'refine-ready', activity: working('lead', 'TeamLead', 'board-refine', 'run-t-133'),
  }),
  boardTicketSummary({
    key: 'T-136', title: 'Fix flaky teamsA11y focus test after the dialog change', phase: PHASE_05.slug,
    status: 'blocked', returnStatus: 'qa-ready',
    blockedReason: 'The run was stopped when the team stopped. Unblock it to continue.',
    branch: 'ticket/t-136', rounds: { 'qa-ready': 1 },
    activity: { state: 'blocked', note: 'The run was stopped when the team stopped. Unblock it to continue.' },
    updatedAt: '2026-11-01T10:41:00Z',
  }),
  boardTicketSummary({
    key: 'T-137', title: 'Escalated: scheduler failures on main', phase: PHASE_06.slug,
    status: 'need-escalate', rounds: { 'need-escalate': 3 },
    activity: working('senior', 'SeniorDeveloper', 'board-senior', 'run-t-137'),
  }),
];

export function boardTicketListFixture(overrides: Partial<BoardTicketList> = {}): BoardTicketList {
  return {
    workspace: BOARD_WORKSPACE,
    statuses: BOARD_STATUSES,
    status: null,
    workflowStatus: null,
    phase: null,
    tickets: BOARD_TICKETS,
    ...overrides,
  };
}

export function boardPhase(overrides: Partial<BoardPhase> = {}): BoardPhase {
  return {
    ...PHASE_05,
    current: true,
    ticketCount: 0,
    counts: Object.fromEntries(BOARD_STATUSES.map((status) => [status, 0])),
    ...overrides,
  };
}

export function boardPhasesFixture(overrides: Partial<BoardPhases> = {}): BoardPhases {
  const tickets = boardTicketListFixture().tickets;
  const phase = (ref: typeof PHASE_05, current: boolean): BoardPhase => {
    const counts = Object.fromEntries(BOARD_STATUSES.map((status) => [status, 0])) as Record<string, number>;
    for (const ticket of tickets) if (ticket.phase === ref.slug) counts[ticket.status] = (counts[ticket.status] ?? 0) + 1;
    return { ...ref, current, ticketCount: Object.values(counts).reduce((total, count) => total + count, 0), counts };
  };
  return {
    workspace: BOARD_WORKSPACE,
    currentPhase: PHASE_05,
    phases: [phase(PHASE_05, true), phase(PHASE_06, false)],
    ...overrides,
  };
}

function link(ticket: BoardTicketSummary): BoardTicketLink {
  return { key: ticket.key, title: ticket.title, status: ticket.status, phase: ticket.phase };
}

export function boardTicketDetailFixture(key = 'T-114', overrides: Partial<BoardTicketDetail> = {}): BoardTicketDetail {
  const list = boardTicketListFixture().tickets;
  const summary = list.find((ticket) => ticket.key === key) ?? list[0]!;
  const { dependsOn, openDependsOn: _openDependsOn, ...ticket } = summary;
  const byKey = new Map(list.map((entry) => [entry.key, entry]));
  const dependents = list.filter((entry) => entry.dependsOn.includes(key));
  return {
    workspace: BOARD_WORKSPACE,
    ticket: {
      ...ticket,
      body: `# ${summary.title}\n\n## Goal\nImplement the board and its read-only ticket page as described in the design folder.\n\n## Done when\n- [ ] The behaviour exists and is covered by tests.`,
    },
    dependsOn,
    dependents: dependents.map((entry) => entry.key),
    links: {
      dependsOn: dependsOn.map((dep) => (byKey.has(dep) ? link(byKey.get(dep)!) : { key: dep, title: null, status: null, phase: null })),
      dependents: dependents.map(link),
    },
    events: [
      { id: 1, at: summary.createdAt, actor: 'operator', name: 'ticket.created', from: null, to: 'dev-ready', payload: { key: summary.key } },
      { id: 2, at: summary.updatedAt, actor: 'coordinator', name: 'ticket.claimed', from: 'dev-ready', to: 'dev-ready', payload: { agent: 'dev' } },
    ],
    eventsTruncated: false,
    statuses: BOARD_STATUSES,
    ...overrides,
  };
}

/** A fake of the three board reads; spread it over `fakeManagement()` to build a full ManagementApi. */
export function fakeBoardManagement() {
  const phases = vi.fn(async (): Promise<Result<BoardPhases>> => ({ ok: true, data: boardPhasesFixture() }));
  const tickets = vi.fn(async (_id: string, _input: { phase?: string }): Promise<Result<BoardTicketList>> => ({ ok: true, data: boardTicketListFixture() }));
  const ticket = vi.fn(async (_id: string, input: { key: string }): Promise<Result<BoardTicketDetail>> => ({ ok: true, data: boardTicketDetailFixture(input.key) }));
  const api = {
    boardPhases: phases,
    boardTickets: tickets,
    boardTicket: ticket,
  } as Pick<ManagementApi, 'boardPhases' | 'boardTickets' | 'boardTicket'>;
  return { api, phases, tickets, ticket };
}
