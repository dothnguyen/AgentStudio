import { fireEvent, screen, within } from "@testing-library/react";
import { vi } from 'vitest';
import { roleItem, rolesFixture } from './rolesFixtures';
import { fakeSkillManagement } from './skillFixtures';
import { boardPhasesFixture, boardTicketListFixture } from './boardFixtures';
import type {
  AgentCatalogList,
  BoardPhases,
  BoardRunner,
  BoardSettings,
  BoardTicketList,
  ManagementApi,
  OverviewMember,
  OverviewTeam,
  Result,
  RoleCatalogList,
  RuntimeSwitchState,
  TeamDefinition,
  TeamOverview,
} from '../src/renderer/api';

type Response<T> = Result<T> | Promise<Result<T>>;

export const RUN_TEAM_ID = '123e4567-e89b-42d3-a456-426614174000';

export function runner(overrides: Partial<BoardRunner> = {}): BoardRunner {
  return {
    status: 'not_bound', runStatus: null, teamId: null, teamStatus: null, teamDefId: null,
    coordinatorRunning: true, error: null, ...overrides,
  };
}

export function boardSettingsFixture(r: BoardRunner = runner()): BoardSettings {
  return {
    workspace: '/work/alpha',
    board: { state: 'ok', sha256: 'a'.repeat(64), message: null, problems: [], config: {} },
    statuses: [],
    workflowStatuses: [], todoEntry: [], todoDefault: null,
    rules: [],
    actionRules: [],
    worktree: { baseBranch: 'main', worktreeStatuses: [] },
    protectedRoutes: [],
    roles: { state: 'ok', sha256: null, message: null, items: [] },
    workflows: [],
    runner: r,
  } as unknown as BoardSettings;
}

export function member(overrides: Partial<OverviewMember> = {}): OverviewMember {
  return {
    memberId: 'dev',
    name: 'dev',
    role: 'Developer',
    roleDescription: 'Implements scoped tickets.',
    roleState: 'defined',
    source: 'catalog',
    agentMode: 'single_catalog', agentOptions: [{ id: 'opencode-sonnet', name: 'OpenCode Sonnet', provider: 'opencode', model: 'sonnet', reasoning: null, description: null, state: 'ok' }], defaultAgent: 'opencode-sonnet',
    agentDefId: 'opencode-sonnet',
    agentDefState: 'ok',
    provider: 'opencode',
    model: 'claude-sonnet',
    reasoning: null,
    runtime: null,
    presence: 'not_started',
    work: { state: 'unavailable', reason: 'not_started' },
    ...overrides,
  };
}

export function team(overrides: Partial<OverviewTeam> = {}): OverviewTeam {
  return {
    id: 'dev-team',
    name: 'Dev Team',
    definition: { state: 'valid', problems: [] },
    runtime: { state: 'not_started', teamId: null, status: null },
    members: [member()],
    membersTruncated: false,
    attention: { runs: [], commandRequests: [], truncated: { runs: false, commandRequests: false } },
    ...overrides,
  };
}

export function overviewFixture(teams: OverviewTeam[], overrides: Partial<TeamOverview> = {}): TeamOverview {
  return {
    workspace: '/work/alpha',
    coordinator: { running: true },
    runtimeState: { available: true, error: null },
    roles: { state: 'ok', message: null },
    catalog: { state: 'ok', message: null },
    teams,
    blockedTickets: [],
    blockedTicketsTruncated: false,
    truncated: false,
    partial: false,
    ...overrides,
  };
}

export function twoTeams(): TeamOverview {
  return overviewFixture([
    team({
      id: 'release',
      name: 'Release Team',
      runtime: { state: 'stopped', teamId: 't-old', status: 'stopped' },
      members: [member({
        memberId: 'qa', name: 'qa', role: 'QA', roleDescription: 'Validates changes.',
        agentDefId: 'codex-gpt', provider: 'codex', model: 'gpt-6', presence: 'stopped',
        work: { state: 'unavailable', reason: 'stopped' },
      })],
    }),
    team({
      id: 'dev-team',
      name: 'Dev Team',
      runtime: { state: 'running', teamId: 't-1', status: 'running' },
      members: [
        member({
          presence: 'busy',
          runtime: {
            agentId: 'a-1', availability: 'busy', paneState: null, provider: 'opencode',
            model: 'claude-sonnet', reasoning: null, stale: false, configuredAgents: ['opencode-sonnet'],
            activeAgent: 'opencode-sonnet', quotaHolds: {}, pendingAgent: null, lastSwitch: null, assignment: null,
          },
          work: {
            state: 'working',
            assignment: null,
            ticket: { key: 'T-031', title: 'Teams screen', status: 'dev-ready', workflowRunId: null },
          },
        }),
        member({
          memberId: 'lead', name: 'lead', role: 'TeamLead', roleDescription: null, source: 'inline', agentMode: 'inline', agentOptions: [], defaultAgent: null,
          agentDefId: null, agentDefState: null, provider: 'codex', model: null, presence: 'idle',
          work: { state: 'none' },
        }),
      ],
    }),
  ]);
}

export function catalogFixture(overrides: Partial<AgentCatalogList> = {}): AgentCatalogList {
  return {
    workspace: '/work/alpha',
    version: 1,
    agents: [
      { id: 'opencode-sonnet', name: 'OpenCode Sonnet', provider: 'opencode', model: 'claude-sonnet', description: 'Implements tickets.' },
      { id: 'codex-gpt', name: 'Codex GPT', provider: 'codex', model: 'gpt-6' },
      { id: 'spare', name: 'Spare agent', provider: 'claude' },
    ],
    problems: [],
    editorOptions: { providers: [
      { id: 'codex', modelSelectable: true, reasoningLevels: ['minimal', 'low', 'medium', 'high', 'xhigh'], configuredModels: ['gpt-6'] },
      { id: 'claude', modelSelectable: true, reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'], configuredModels: [] },
      { id: 'agy', modelSelectable: true, reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'], configuredModels: [] },
      { id: 'opencode', modelSelectable: true, reasoningLevels: [], configuredModels: ['claude-sonnet'] },
    ] },
    ...overrides,
  };
}

export function teamRolesFixture(): RoleCatalogList {
  return rolesFixture({
    items: [
      roleItem('Developer', { description: 'Implements scoped tickets.' }),
      roleItem('QA', { description: 'Validates changes.' }),
      roleItem('Reviewer', { description: 'Reviews changes.' }),
      roleItem('TeamLead'),
    ],
  });
}

export function fakeManagement(opts: {
  overview?: Array<Response<TeamOverview>>;
  agents?: Array<Response<AgentCatalogList>>;
  boardSettings?: Array<Response<BoardSettings>>;
  boardPhases?: Array<Response<BoardPhases>>;
  boardTickets?: Array<Response<BoardTicketList>>;
  roles?: Array<Response<RoleCatalogList>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  calls?: Partial<Record<keyof ManagementApi, (...args: any[]) => unknown>>;
} = {}) {
  const overviewList = opts.overview ?? [{ ok: true, data: twoTeams() }];
  const agentList = opts.agents ?? [{ ok: true, data: catalogFixture() }];
  const boardList = opts.boardSettings ?? [{ ok: true, data: boardSettingsFixture() }];
  const phaseList = opts.boardPhases ?? [{ ok: true, data: boardPhasesFixture() }];
  const ticketList = opts.boardTickets ?? [{ ok: true, data: boardTicketListFixture() }];
  const roleList = opts.roles ?? [{ ok: true, data: teamRolesFixture() }];
  let rl = 0;
  let b = 0;
  let o = 0;
  let a = 0;
  let p = 0;
  let t = 0;
  const overview = vi.fn((_id: string) => Promise.resolve(overviewList[Math.min(o++, overviewList.length - 1)]!));
  const agents = vi.fn((_id: string) => Promise.resolve(agentList[Math.min(a++, agentList.length - 1)]!));
  const boardSettings = vi.fn((_id: string) => Promise.resolve(boardList[Math.min(b++, boardList.length - 1)]!));
  const boardPhases = vi.fn((_id: string) => Promise.resolve(phaseList[Math.min(p++, phaseList.length - 1)]!));
  const boardTickets = vi.fn((_id: string) => Promise.resolve(ticketList[Math.min(t++, ticketList.length - 1)]!));
  const roles = vi.fn((_id: string) => Promise.resolve(roleList[Math.min(rl++, roleList.length - 1)]!));
  const skillFake = fakeSkillManagement();
  const unused = () => vi.fn(() => Promise.reject(new Error('not used')));
  const api = new Proxy({
    overview, agents, boardSettings, boardPhases, boardTickets, roles,
    boardWorkflows: vi.fn(async () => ({ ok: true, data: { workflows: [], problems: [] } })),
    boardWorkflow: vi.fn(async () => ({ ok: false, error: { code: "NOT_FOUND", message: "Not found", retryable: false } })),
    prompts: vi.fn(async () => ({ ok: true, data: { prompts: [] } })),
    prompt: vi.fn(async () => ({ ok: false, error: { code: "NOT_FOUND", message: "Not found", retryable: false } })),
    checkSets: vi.fn(async () => ({ ok: true, data: { checkSets: [], commands: [], problems: [] } })),
    boardStatuses: vi.fn(async () => ({ ok: true, data: { statuses: [], sha256: "a".repeat(64) } })),
    skills: skillFake.skills,
    skill: skillFake.skill,
    createSkill: skillFake.createSkill,
    updateSkill: skillFake.updateSkill,
    deleteSkill: skillFake.deleteSkill,
    updateSkillRoles: skillFake.updateSkillRoles,
    ...opts.calls,
  } as Record<string, unknown>, {
    get: (target, prop: string) => target[prop] ?? (target[prop] = unused()),
  }) as unknown as ManagementApi;
  return { api, overview, agents, boardSettings, boardPhases, boardTickets, roles, skillFake };
}

export function teamDefinition(overrides: Partial<TeamDefinition> = {}): TeamDefinition {
  return {
    id: 'dev-team',
    name: 'Dev Team',
    members: [{ id: 'dev', name: 'dev', role: 'Developer', agent: 'opencode-sonnet' }],
    ...overrides,
  };
}

export function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

export function routingSettingsFixture(overrides: Partial<BoardSettings> = {}): BoardSettings {
  const raw: Array<Record<string, unknown>> = [
    { when: { status: 'backlog' }, role: 'Developer', workflow: 'board-develop', workspace: 'worktree', onPass: 'merge-ready', onFail: 'dev-ready', maxRounds: 3, syncBase: true, onFailPriority: 2, onPassCreatedTickets: { status: 'backlog' } },
    { when: { status: 'merge-ready' }, action: 'merge', onPass: 'done', onFail: 'merge-conflict' },
    { when: { status: 'plan-merge-ready' }, action: 'merge', onPass: 'done', onFail: 'plan-merge-conflict' },
    { when: { status: 'merge-conflict' }, role: 'TeamLead', workflow: 'board-resolve-merge', workspace: 'worktree', onPass: 'merge-ready', onFail: 'dev-ready' },
    { when: { status: 'plan-merge-conflict' }, role: 'TeamLead', workflow: 'board-resolve-merge', workspace: 'worktree', onPass: 'plan-merge-ready', onFail: 'dev-ready' },
  ];
  return { ...boardSettingsFixture(), board: { state: 'ok', sha256: 'a'.repeat(64), message: null, problems: [], config: { rules: raw } },
    statuses: ['backlog', 'dev-ready', 'merge-ready', 'merge-conflict', 'plan-merge-ready', 'plan-merge-conflict', 'done'].map(id => ({ id, name: id, kind: id === 'backlog' ? 'initial' : id === 'done' ? 'done' : null })),
    rules: raw.map((r, index) => {
      const status = (r.when as { status: string }).status;
      return { index, status, type: 'action' in r ? 'action' as const : 'agent' as const, role: typeof r.role === 'string' ? r.role : null, workflow: typeof r.workflow === 'string' ? r.workflow : null, during: null, action: typeof r.action === 'string' ? r.action : null, onPass: r.onPass as string, onFail: r.onFail as string, onBlocked: null, workspace: typeof r.workspace === 'string' ? r.workspace : null, syncBase: !!r.syncBase, maxRounds: typeof r.maxRounds === 'number' ? r.maxRounds : null, priority: null, onFailureLimit: null, protected: status.includes('conflict') };
    }),
    roles: { state: 'ok', sha256: 'b'.repeat(64), message: null, items: [{ id: 'Developer', description: 'Develops' }, { id: 'TeamLead', description: 'Leads' }] },
    workflows: [{ name: 'board-develop', builtin: true, roles: ['Developer'], errors: [] }, { name: 'board-resolve-merge', builtin: true, roles: ['TeamLead'], errors: [] }],
    protectedRoutes: ['merge-conflict', 'plan-merge-conflict'].map(status => ({ status, role: 'TeamLead', satisfied: true })), ...overrides };
}

export function escalationSettingsFixture(): BoardSettings {
  const base = routingSettingsFixture();
  const policy = { count: 3, status: 'need-escalate' };
  const raw: Array<Record<string, unknown>> = [
    ...(base.board.config!.rules as Array<Record<string, unknown>>),
    { when: { status: 'qa-ready' }, role: 'QA', workflow: 'board-qa', workspace: 'worktree', onPass: 'merge-ready', onFail: 'dev-ready', onFailPriority: 0, onFailureLimit: { ...policy } },
    { when: { status: 'review-ready' }, role: 'Reviewer', workflow: 'board-review', workspace: 'worktree', onPass: 'merge-ready', onFail: 'dev-ready', onFailPriority: 0, onFailureLimit: { ...policy } },
    { when: { status: 'need-escalate' }, role: 'SeniorDeveloper', workflow: 'board-senior-develop', workspace: 'worktree', syncBase: true, onPass: 'qa-ready', onFail: 'need-escalate', maxRounds: 3, priority: 0 },
  ];
  const view = (index: number, status: string, role: string, workflow: string, onPass: string, onFail: string, extra: Partial<BoardSettings['rules'][number]>): BoardSettings['rules'][number] => ({
    index, status, type: 'agent', role, workflow, during: null, action: null, onPass, onFail, onBlocked: null, workspace: 'worktree',
    syncBase: false, maxRounds: null, priority: null, onFailureLimit: null, protected: false, ...extra,
  });
  return {
    ...base,
    board: { ...base.board, config: { rules: raw } },
    statuses: [...base.statuses, ...['qa-ready', 'review-ready', 'need-escalate'].map(id => ({ id, name: id, kind: null }))],
    rules: [
      ...base.rules,
      view(5, 'qa-ready', 'QA', 'board-qa', 'merge-ready', 'dev-ready', { onFailureLimit: { ...policy } }),
      view(6, 'review-ready', 'Reviewer', 'board-review', 'merge-ready', 'dev-ready', { onFailureLimit: { ...policy } }),
      view(7, 'need-escalate', 'SeniorDeveloper', 'board-senior-develop', 'qa-ready', 'need-escalate', { syncBase: true, maxRounds: 3, priority: 0 }),
    ],
    roles: { ...base.roles, items: [...base.roles.items, { id: 'QA', description: 'Tests' }, { id: 'Reviewer', description: 'Reviews' }, { id: 'SeniorDeveloper', description: 'Escalation' }] },
    workflows: [...base.workflows,
      { name: 'board-qa', builtin: true, roles: ['QA'], errors: [] },
      { name: 'board-review', builtin: true, roles: ['Reviewer'], errors: [] },
      { name: 'board-senior-develop', builtin: true, roles: ['SeniorDeveloper'], errors: [] }],
  };
}

export function showMembers(root: HTMLElement = document.body): HTMLElement {
  return within(root).getByRole('list', { name: /^Members of / });
}
export function memberRow(name: string, root: HTMLElement = document.body): HTMLElement {
  const list = showMembers(root);
  const row = Array.from(list.querySelectorAll<HTMLElement>('.teams-member-row')).find(el => el.querySelector('.teams-member-name')?.textContent === name);
  if (!row) throw new Error(`No member row named ${name}`);
  return row;
}
export function openMember(name: string, root: HTMLElement = document.body): HTMLElement {
  fireEvent.click(memberOpen(name, root));
  return within(root).getByRole('region', { name });
}
export function memberOpen(name: string, root: HTMLElement = document.body): HTMLButtonElement {
  const open = memberRow(name, root).querySelector<HTMLButtonElement>('.teams-member-open');
  if (!open) throw new Error(`Member row ${name} has no open button`);
  return open;
}
export function field(row: HTMLElement, f: string): string { return row.querySelector(`[data-field="${f}"]`)?.textContent ?? ''; }

export function escalationRoutingFixture(): BoardSettings {
  const s = escalationSettingsFixture();
  s.statuses = [...s.statuses.map(x => ({ ...x, name: ({ 'qa-ready': 'QA ready', 'review-ready': 'Review ready', 'need-escalate': 'Escalate' } as Record<string, string>)[x.id] ?? x.name })), { id: 'blocked-x', name: null, kind: null }];
  s.rules[5] = { ...s.rules[5], workflow: 'board-develop', onPass: 'review-ready', maxRounds: 4, priority: 5 };
  s.rules[6] = { ...s.rules[6], workflow: 'board-develop', onBlocked: 'blocked-x' };
  s.rules[7] = { ...s.rules[7], workflow: 'board-senior', onPass: 'merge-ready' };
  s.workflows.push({ name: 'board-senior', builtin: true, roles: ['SeniorDeveloper'], errors: [] });
  s.actionRules = s.rules.filter(r => r.type === 'action').map((r, i) => ({ status: r.status, action: r.action!, onPass: r.onPass, onFail: r.onFail, onPassCreatedTickets: i === 0 ? 'backlog' : null }));
  const raw = s.board.config!.rules as Array<Record<string, unknown>>;
  for (const r of s.rules.slice(5)) raw[r.index] = { ...raw[r.index], workflow: r.workflow, onPass: r.onPass, ...(r.onBlocked ? { onBlocked: r.onBlocked } : {}), ...(r.maxRounds !== null ? { maxRounds: r.maxRounds } : {}), ...(r.priority !== null ? { priority: r.priority } : {}) };
  return s;
}

// --- T-082 state overrides: each helper returns a real-shaped value, never illustrative data. ---
export type ConnectionState = 'connecting' | 'connected' | 'lost';
export function connectionFixture(state: ConnectionState) {
  return { state, error: state === 'lost' ? 'serve exited' : null, distro: null, command: 'serve' };
}
export function emptyWorkspace(overrides: Partial<TeamOverview> = {}): TeamOverview {
  return overviewFixture([], overrides);
}
export function emptyRoster(overrides: Partial<OverviewTeam> = {}): TeamOverview {
  return overviewFixture([team({ members: [], ...overrides })]);
}
export function coordinatorStopped(): TeamOverview {
  return overviewFixture([team()], { coordinator: { running: false } });
}
export function runtimeUnavailable(code = 'RUNTIME_DOWN', message = 'tmux is not reachable'): TeamOverview {
  return overviewFixture([team()], { runtimeState: { available: false, error: { code, message, retryable: true } } } as Partial<TeamOverview>);
}
export function partialOverview(): TeamOverview {
  return overviewFixture([team({ definition: { state: 'unreadable', problems: [{ path: 'members', message: 'cannot read' }] } as never })], { partial: true });
}
export function truncatedOverview(): TeamOverview {
  return overviewFixture([team()], { truncated: true });
}
export function memberTruncatedOverview(): TeamOverview {
  return overviewFixture([team({ membersTruncated: true })]);
}
export function missingRoleCatalog(): TeamOverview {
  return overviewFixture([team()], { roles: { state: 'missing', message: 'roles.json is missing' } } as Partial<TeamOverview>);
}
export function invalidRoleCatalog(): RoleCatalogList {
  return rolesFixture({ state: 'invalid', items: [] } as never);
}
export function invalidBoardSettings(): BoardSettings {
  return { ...boardSettingsFixture(), board: { state: 'invalid', sha256: null, message: 'board.json is invalid', problems: [{ path: 'rules[0]', message: 'bad rule' }], config: null } } as unknown as BoardSettings;
}
export function missingBoardSettings(): BoardSettings {
  return { ...boardSettingsFixture(), board: { state: 'missing', sha256: null, message: null, problems: [], config: null }, rules: [] } as unknown as BoardSettings;
}
export function managementError(code: string, message: string, remediation?: string) {
  return { ok: false as const, error: { code, message, retryable: true, ...(remediation === undefined ? {} : { remediation }) } };
}
export const LONG_UNBROKEN = 'x'.repeat(240);
export function longContentOverview(): TeamOverview {
  return overviewFixture([team({
    id: `team-${LONG_UNBROKEN}`,
    name: `Team ${LONG_UNBROKEN}`,
    members: [member({
      memberId: `member-${LONG_UNBROKEN}`, name: `Ünï ${LONG_UNBROKEN}`, role: `Role-${LONG_UNBROKEN}`,
      work: { state: 'working', assignment: { goal: `Goal ${LONG_UNBROKEN}` }, ticket: null } as never,
    })],
  })]);
}
export function longRoutingSettings(): BoardSettings {
  const base = routingSettingsFixture();
  const route = `route-${LONG_UNBROKEN}`;
  return { ...base, statuses: [...base.statuses, { id: route, name: null, kind: null }],
    rules: base.rules.map((r, i) => i === 0 ? { ...r, onPass: route } : r) } as BoardSettings;
}
export function onFailureLimitRouting(count: number | null = 3, status = 'need-escalate'): BoardSettings {
  const base = escalationSettingsFixture();
  return { ...base, rules: base.rules.map(r => r.onFailureLimit ? { ...r, onFailureLimit: count === null ? null : { count, status } } : r) };
}
export function switchEvidence(state: 'pending' | 'completed' | 'failed', requestedAgent = 'codex-gpt'): RuntimeSwitchState {
  return { state, requestedAgent, assignmentId: null, code: state === 'failed' ? 'SWITCH_FAILED' : null, message: state === 'failed' ? 'Switch failed' : null, at: '2026-01-01T00:00:00Z' };
}

// --- T-090 completion fixtures: real-shaped, each value visibly unique so stale responses are provable. ---
export type RuntimeMemberState = 'starting' | 'idle' | 'busy' | 'waiting_input' | 'limit_reached' | 'offline' | 'error';
export function runtimeMemberState(state: RuntimeMemberState, overrides: Partial<OverviewMember> = {}): OverviewMember {
  const paneState: Record<RuntimeMemberState, string | null> = {
    starting: null, idle: 'alive', busy: 'alive', waiting_input: 'alive', limit_reached: 'alive', offline: 'dead', error: 'alive',
  };
  return member({
    memberId: `member-${state}`, name: `${state}-member`,
    presence: state,
    runtime: {
      agentId: `agent-${state}`, availability: state, paneState: paneState[state], provider: 'opencode', model: 'claude-sonnet',
      reasoning: null, stale: false, configuredAgents: ['opencode-sonnet'], activeAgent: 'opencode-sonnet',
      quotaHolds: state === 'limit_reached' ? { 'opencode-sonnet': '2026-01-01T01:00:00Z' } : {},
      pendingAgent: null, lastSwitch: null, assignment: null,
    },
    work: state === 'busy'
      ? { state: 'working', assignment: null, ticket: { key: `T-${state}`, title: `Ticket ${state}`, status: 'dev-ready', workflowRunId: null } }
      : { state: 'none' },
    ...overrides,
  });
}

export function boardRunnerFixture(state: 'stopped' | 'running_this' | 'running_other' | 'unavailable'): BoardRunner {
  switch (state) {
    case 'stopped': return runner({ status: 'stopped', runStatus: 'stopped', coordinatorRunning: true });
    case 'running_this': return runner({ status: 'running', runStatus: 'running', teamId: RUN_TEAM_ID, teamStatus: 'running', teamDefId: 'dev-team' });
    case 'running_other': return runner({ status: 'running', runStatus: 'running', teamId: '223e4567-e89b-42d3-a456-426614174999', teamStatus: 'running', teamDefId: 'other-team' });
    case 'unavailable': return runner({ status: 'unavailable', coordinatorRunning: false, error: { code: 'RUNNER_DOWN', message: 'runner is unreachable' } });
  }
}

export function catalogReferenceOverview(kind: 'missing-role' | 'missing-agent' | 'catalog-unavailable'): TeamOverview {
  if (kind === 'missing-role') {
    return overviewFixture([team({ id: 'ref-team', name: 'Reference Team', members: [member({ memberId: 'ghost-role', name: 'ghost-role', role: 'GhostRole', roleState: 'undefined', roleDescription: null })] })]);
  }
  if (kind === 'missing-agent') {
    return overviewFixture([team({ id: 'ref-team', name: 'Reference Team', members: [member({
      memberId: 'ghost-agent', name: 'ghost-agent', agentDefId: 'ghost-agent-def', agentDefState: 'missing', defaultAgent: 'ghost-agent-def',
      agentOptions: [{ id: 'ghost-agent-def', name: null, provider: null, model: null, reasoning: null, description: null, state: 'missing' }],
    })] })]);
  }
  return overviewFixture([team({ id: 'ref-team', name: 'Reference Team', members: [member({ memberId: 'no-catalog', name: 'no-catalog', agentDefState: 'unavailable' })] })],
    { catalog: { state: 'invalid', message: 'agents.json is invalid' } });
}

export function switchStateOverview(state: 'pending' | 'failed'): TeamOverview {
  const requested = state === 'pending' ? 'codex-pending' : 'codex-failed';
  return overviewFixture([team({ id: 'switch-team', name: 'Switch Team', runtime: { state: 'running', teamId: 't-switch', status: 'running' }, members: [member({
    memberId: 'switcher', name: 'switcher', presence: 'idle',
    agentMode: 'ordered_catalog',
    agentOptions: [
      { id: 'opencode-sonnet', name: 'OpenCode Sonnet', provider: 'opencode', model: 'sonnet', reasoning: null, description: null, state: 'ok' },
      { id: requested, name: null, provider: 'codex', model: 'gpt', reasoning: null, description: null, state: 'ok' },
    ],
    runtime: {
      agentId: 'agent-switcher', availability: 'idle', paneState: 'alive', provider: 'opencode', model: 'claude-sonnet', reasoning: null, stale: false,
      configuredAgents: ['opencode-sonnet', requested], activeAgent: 'opencode-sonnet', quotaHolds: {},
      pendingAgent: state === 'pending' ? requested : null, lastSwitch: switchEvidence(state, requested), assignment: null,
    },
    work: { state: 'none' },
  })] })]);
}

/** Opens the "More team actions" menu and chooses Delete team. */
export function chooseDeleteTeam(): void {
  fireEvent.click(screen.getByRole('button', { name: 'More team actions' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete team…' }));
}
