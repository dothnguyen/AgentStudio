import { fireEvent, within } from "@testing-library/react";
import { vi } from 'vitest';
import { roleItem, rolesFixture } from './rolesFixtures';
import type {
  AgentCatalogList,
  BoardRunner,
  BoardSettings,
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
  roles?: Array<Response<RoleCatalogList>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  calls?: Partial<Record<keyof ManagementApi, (...args: any[]) => unknown>>;
} = {}) {
  const overviewList = opts.overview ?? [{ ok: true, data: twoTeams() }];
  const agentList = opts.agents ?? [{ ok: true, data: catalogFixture() }];
  const boardList = opts.boardSettings ?? [{ ok: true, data: boardSettingsFixture() }];
  const roleList = opts.roles ?? [{ ok: true, data: teamRolesFixture() }];
  let rl = 0;
  let b = 0;
  let o = 0;
  let a = 0;
  const overview = vi.fn((_id: string) => Promise.resolve(overviewList[Math.min(o++, overviewList.length - 1)]!));
  const agents = vi.fn((_id: string) => Promise.resolve(agentList[Math.min(a++, agentList.length - 1)]!));
  const boardSettings = vi.fn((_id: string) => Promise.resolve(boardList[Math.min(b++, boardList.length - 1)]!));
  const roles = vi.fn((_id: string) => Promise.resolve(roleList[Math.min(rl++, roleList.length - 1)]!));
  const unused = () => vi.fn(() => Promise.reject(new Error('not used')));
  const api = new Proxy({ overview, agents, boardSettings, roles, ...opts.calls } as Record<string, unknown>, {
    get: (target, prop: string) => target[prop] ?? (target[prop] = unused()),
  }) as unknown as ManagementApi;
  return { api, overview, agents, boardSettings, roles };
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
    rules: raw.map((r, index) => ({ index, status: r.when.status, type: r.type as 'agent' | 'action', role: r.role ?? null, workflow: r.workflow ?? null, action: r.action ?? null, onPass: r.onPass, onFail: r.onFail, onBlocked: null, workspace: r.workspace ?? null, syncBase: !!r.syncBase, maxRounds: r.maxRounds ?? null, priority: null, onFailureLimit: null, protected: r.when.status.includes('conflict') })),
    roles: { state: 'ok', sha256: 'b'.repeat(64), message: null, items: [{ id: 'Developer', description: 'Develops' }, { id: 'TeamLead', description: 'Leads' }] },
    workflows: [{ name: 'board-develop', builtin: true, roles: ['Developer'], errors: [] }, { name: 'board-resolve-merge', builtin: true, roles: ['TeamLead'], errors: [] }],
    protectedRoutes: ['merge-conflict', 'plan-merge-conflict'].map(status => ({ status, role: 'TeamLead', satisfied: true })), ...overrides };
}

export function escalationSettingsFixture(): BoardSettings {
  const base = routingSettingsFixture();
  const policy = { count: 3, status: 'need-escalate' };
  const raw = [
    ...(base.board.config!.rules as Array<Record<string, unknown>>),
    { type: 'agent', when: { status: 'qa-ready' }, role: 'QA', workflow: 'board-qa', workspace: 'worktree', onPass: 'merge-ready', onFail: 'dev-ready', onFailPriority: 0, onFailureLimit: { ...policy } },
    { type: 'agent', when: { status: 'review-ready' }, role: 'Reviewer', workflow: 'board-review', workspace: 'worktree', onPass: 'merge-ready', onFail: 'dev-ready', onFailPriority: 0, onFailureLimit: { ...policy } },
    { type: 'agent', when: { status: 'need-escalate' }, role: 'SeniorDeveloper', workflow: 'board-senior-develop', workspace: 'worktree', syncBase: true, onPass: 'qa-ready', onFail: 'need-escalate', maxRounds: 3, priority: 0 },
  ];
  const view = (index: number, status: string, role: string, workflow: string, onPass: string, onFail: string, extra: Partial<BoardSettings['rules'][number]>): BoardSettings['rules'][number] => ({
    index, status, type: 'agent', role, workflow, action: null, onPass, onFail, onBlocked: null, workspace: 'worktree',
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
  const tab = within(root).queryByRole('tab', { name: 'Members' });
  if (tab && tab.getAttribute('aria-selected') !== 'true') fireEvent.click(tab);
  return within(root).getByRole('list', { name: /^Members of / });
}
export function memberRow(name: string, root: HTMLElement = document.body): HTMLElement {
  const list = showMembers(root);
  const row = Array.from(list.querySelectorAll<HTMLElement>('.teams-member-row')).find(el => el.querySelector('.teams-member-name')?.textContent === name);
  if (!row) throw new Error(`No member row named ${name}`);
  return row;
}
export function openMember(name: string, root: HTMLElement = document.body): HTMLElement {
  fireEvent.click(memberRow(name, root));
  return within(root).getByRole('region', { name });
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
