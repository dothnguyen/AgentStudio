import { vi } from 'vitest';
import type {
  AgentCatalogList,
  BoardRunner,
  BoardSettings,
  ManagementApi,
  OverviewMember,
  OverviewTeam,
  Result,
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

export function fakeManagement(opts: {
  overview?: Array<Response<TeamOverview>>;
  agents?: Array<Response<AgentCatalogList>>;
  boardSettings?: Array<Response<BoardSettings>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  calls?: Partial<Record<keyof ManagementApi, (...args: any[]) => unknown>>;
} = {}) {
  const overviewList = opts.overview ?? [{ ok: true, data: twoTeams() }];
  const agentList = opts.agents ?? [{ ok: true, data: catalogFixture() }];
  const boardList = opts.boardSettings ?? [{ ok: true, data: boardSettingsFixture() }];
  let b = 0;
  let o = 0;
  let a = 0;
  const overview = vi.fn((_id: string) => Promise.resolve(overviewList[Math.min(o++, overviewList.length - 1)]!));
  const agents = vi.fn((_id: string) => Promise.resolve(agentList[Math.min(a++, agentList.length - 1)]!));
  const boardSettings = vi.fn((_id: string) => Promise.resolve(boardList[Math.min(b++, boardList.length - 1)]!));
  const unused = () => vi.fn(() => Promise.reject(new Error('not used')));
  const api = new Proxy({ overview, agents, boardSettings, ...opts.calls } as Record<string, unknown>, {
    get: (target, prop: string) => target[prop] ?? (target[prop] = unused()),
  }) as unknown as ManagementApi;
  return { api, overview, agents, boardSettings };
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
  const raw = [
    { type: 'agent', when: { status: 'backlog' }, role: 'Developer', workflow: 'board-develop', workspace: 'worktree', onPass: 'merge-ready', onFail: 'dev-ready', maxRounds: 3, syncBase: true, onFailPriority: 2, onPassCreatedTickets: { status: 'backlog' } },
    { type: 'action', when: { status: 'merge-ready' }, action: 'merge', onPass: 'done', onFail: 'merge-conflict' },
    { type: 'action', when: { status: 'plan-merge-ready' }, action: 'merge', onPass: 'done', onFail: 'plan-merge-conflict' },
    { type: 'agent', when: { status: 'merge-conflict' }, role: 'TeamLead', workflow: 'board-resolve-merge', workspace: 'worktree', onPass: 'merge-ready', onFail: 'dev-ready' },
    { type: 'agent', when: { status: 'plan-merge-conflict' }, role: 'TeamLead', workflow: 'board-resolve-merge', workspace: 'worktree', onPass: 'plan-merge-ready', onFail: 'dev-ready' },
  ];
  return { ...boardSettingsFixture(), board: { state: 'ok', sha256: 'a'.repeat(64), message: null, problems: [], config: { rules: raw } },
    statuses: ['backlog', 'dev-ready', 'merge-ready', 'merge-conflict', 'plan-merge-ready', 'plan-merge-conflict', 'done'].map(id => ({ id, name: id, kind: id === 'backlog' ? 'initial' : id === 'done' ? 'done' : null })),
    rules: raw.map((r, index) => ({ index, status: r.when.status, type: r.type as 'agent' | 'action', role: r.role ?? null, workflow: r.workflow ?? null, action: r.action ?? null, onPass: r.onPass, onFail: r.onFail, onBlocked: null, workspace: r.workspace ?? null, syncBase: !!r.syncBase, maxRounds: r.maxRounds ?? null, priority: null, protected: r.when.status.includes('conflict') })),
    roles: { state: 'ok', sha256: 'b'.repeat(64), message: null, items: [{ id: 'Developer', description: 'Develops' }, { id: 'TeamLead', description: 'Leads' }] },
    workflows: [{ name: 'board-develop', builtin: true, roles: ['Developer'], errors: [] }, { name: 'board-resolve-merge', builtin: true, roles: ['TeamLead'], errors: [] }],
    protectedRoutes: ['merge-conflict', 'plan-merge-conflict'].map(status => ({ status, role: 'TeamLead', satisfied: true })), ...overrides };
}
