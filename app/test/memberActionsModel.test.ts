import { describe, expect, it, vi } from 'vitest';
import type { AttentionCommandRequest, AttentionRun, BlockedTicket, OverviewMember, OverviewTeam } from '../src/renderer/api';
import type { MenuActionItem, MenuItem, MenuSubmenuItem } from '../src/renderer/ui/actionMenuModel';
import { buildMemberMenu, type MemberMenuCallbacks } from '../src/renderer/teams/memberActionsModel';
import { canEditTeam } from '../src/renderer/teams/teamEditModel';
import { member, team } from './teamsFixtures';
import { roleItem } from './rolesFixtures';

const trigger = {} as HTMLElement;

function callbacks(): MemberMenuCallbacks {
  return {
    openDetails: vi.fn(),
    switchAgent: vi.fn(),
    resumeAgent: vi.fn(),
    retryRun: vi.fn(),
    requeueTicket: vi.fn(),
    stopRun: vi.fn(),
    unblockTicket: vi.fn(),
    approveCommand: vi.fn(),
    rejectCommand: vi.fn(),
    cancelCommand: vi.fn(),
    editConfiguration: vi.fn(),
    viewRole: vi.fn(),
    copy: vi.fn(),
    removeMember: vi.fn(),
  };
}

const statuses = [
  { id: 'dev-ready', name: null, kind: null },
  { id: 'qa-ready', name: null, kind: null },
  { id: 'done', name: null, kind: 'done' },
];

const run = (overrides: Partial<AttentionRun> = {}): AttentionRun => ({
  workflowRunId: 'run-1', status: 'paused', stage: 'develop', memberId: 'dev', ticketKey: 'T-091',
  assignmentId: 'as-1', assignmentStatus: 'paused', diagnosticCode: 'NEEDS_INPUT', delegating: false, ...overrides,
});

const request = (overrides: Partial<AttentionCommandRequest> = {}): AttentionCommandRequest => ({
  id: 'cmd-1', command: 'app-dev-dependency-add', status: 'requested', reason: 'needs a package',
  workflowRunId: 'run-1', memberId: 'dev', ...overrides,
});

const ticket = (overrides: Partial<BlockedTicket> = {}): BlockedTicket => ({
  key: 'T-090', title: 'Finish the Teams overview states', reason: 'ROUND_LIMIT:qa-ready',
  returnStatus: 'qa-ready', memberId: 'dev', updatedAt: '2026-01-01T00:00:00Z', ...overrides,
});

function build(overrides: {
  member?: OverviewMember;
  team?: OverviewTeam;
  runs?: AttentionRun[];
  requests?: AttentionCommandRequest[];
  blockedTickets?: BlockedTicket[];
  roleState?: OverviewMember['roleState'];
  canEdit?: boolean;
  disabledReason?: string | null;
  actions?: MemberMenuCallbacks;
} = {}): { items: MenuItem[]; actions: MemberMenuCallbacks } {
  const actions = overrides.actions ?? callbacks();
  const target = overrides.member ?? member();
  const items = buildMemberMenu({
    team: overrides.team ?? team({ runtime: { state: 'running', teamId: 'runtime-1', status: 'running' } }),
    member: { ...target, roleState: overrides.roleState ?? target.roleState },
    attention: {
      runs: overrides.runs ?? [],
      commandRequests: overrides.requests ?? [],
      truncated: { runs: false, commandRequests: false },
    },
    blockedTickets: overrides.blockedTickets ?? [],
    boardStatuses: statuses,
    roleItem: target.role === null ? null : roleItem(target.role),
    canEdit: overrides.canEdit ?? true,
    catalog: [],
    connected: true,
    inFlight: null,
    disabledReason: overrides.disabledReason ?? null,
    callbacks: actions,
  });
  return { items, actions };
}

function submenu(items: MenuItem[], id: string): MenuSubmenuItem {
  const found = items.find((entry): entry is MenuSubmenuItem => entry.kind === 'submenu' && entry.id === id);
  if (found === undefined) throw new Error(`No submenu ${id}`);
  return found;
}

function action(items: MenuItem[], id: string): MenuActionItem {
  const found = items.find((entry): entry is MenuActionItem => entry.kind === 'action' && entry.id === id);
  if (found === undefined) throw new Error(`No action ${id}`);
  return found;
}

function topLevelIds(items: MenuItem[]): string[] {
  return items.filter((entry): entry is MenuActionItem | MenuSubmenuItem => entry.kind === 'action' || entry.kind === 'submenu').map((entry) => entry.id);
}

describe('buildMemberMenu order and always-present items', () => {
  it('lists the member menu in design order for an idle member', () => {
    const { items, actions } = build();
    expect(topLevelIds(items)).toEqual(['open-details', 'switch-agent', 'edit-configuration', 'view-role', 'copy', 'remove-member']);
    expect(items.some((entry) => entry.kind === 'submenu' && entry.id === 'current-work')).toBe(false);
    expect(items.some((entry) => entry.kind === 'submenu' && entry.id === 'unblock')).toBe(false);
    expect(items.some((entry) => entry.kind === 'submenu' && entry.id === 'command-requests')).toBe(false);
    action(items, 'open-details').onSelect(trigger);
    expect(actions.openDetails).toHaveBeenCalledTimes(1);
    action(items, 'edit-configuration').onSelect(trigger);
    expect(actions.editConfiguration).toHaveBeenCalledTimes(1);
    action(items, 'remove-member').onSelect(trigger);
    expect(actions.removeMember).toHaveBeenCalledTimes(1);
  });

  it('marks removal dangerous and last', () => {
    const { items } = build();
    const last = items[items.length - 1]!;
    expect(last.kind).toBe('action');
    if (last.kind === 'action') {
      expect(last.id).toBe('remove-member');
      expect(last.danger).toBe(true);
    }
  });
});

describe('buildMemberMenu current work', () => {
  it('disables Retry stage and explains why for a running stage', () => {
    const { items, actions } = build({ runs: [run({ status: 'running', assignmentStatus: 'running' })] });
    const work = submenu(items, 'current-work');
    expect(work.items.map((entry) => (entry.kind === 'action' || entry.kind === 'submenu' ? entry.label : ''))).toEqual([
      'Retry stage', 'Requeue ticket…', 'Stop run and block ticket…',
    ]);
    const retry = action(work.items, 'retry-stage');
    expect(retry.disabledReason).toBe('The current stage is not stuck.');
    retry.onSelect(trigger);
    expect(actions.retryRun).not.toHaveBeenCalled();
  });

  it('enables Retry stage for a paused run', () => {
    const { items, actions } = build({ runs: [run({ status: 'paused' })] });
    const retry = action(submenu(items, 'current-work').items, 'retry-stage');
    expect(retry.disabledReason).toBeUndefined();
    retry.onSelect(trigger);
    expect(actions.retryRun).toHaveBeenCalledWith(expect.objectContaining({ workflowRunId: 'run-1' }));
  });

  it('enables Retry stage for a waiting_input assignment', () => {
    const { items } = build({ runs: [run({ status: 'running', assignmentStatus: 'waiting_input' })] });
    expect(action(submenu(items, 'current-work').items, 'retry-stage').disabledReason).toBeUndefined();
  });

  it('enables Retry stage for a reconciling assignment', () => {
    const { items } = build({ runs: [run({ status: 'running', assignmentStatus: 'reconciling' })] });
    expect(action(submenu(items, 'current-work').items, 'retry-stage').disabledReason).toBeUndefined();
  });

  it('keeps the group for a claimed ticket without run data and disables the run-only actions', () => {
    const claimed = member({
      work: { state: 'working', assignment: null, ticket: { key: 'T-091', title: 'Ticket', status: 'dev-ready', workflowRunId: null } },
    });
    const { items, actions } = build({ member: claimed });
    const work = submenu(items, 'current-work');
    // design/teams-actions-menus.md §3 gives this reason for a stage that is not stuck.
    expect(action(work.items, 'retry-stage').disabledReason).toBe('The current stage is not stuck.');
    expect(action(work.items, 'stop-run').disabledReason).toBe('This ticket has no run to stop.');
    const requeue = action(work.items, 'requeue-ticket');
    expect(requeue.disabledReason).toBeUndefined();
    requeue.onSelect(trigger);
    expect(actions.requeueTicket).toHaveBeenCalledWith('T-091');
  });

  it('uses the run with a ticket when a member has several runs', () => {
    const runs = [
      run({ workflowRunId: 'run-no-ticket', ticketKey: null, memberId: 'dev' }),
      run({ workflowRunId: 'run-ticket', ticketKey: 'T-092' }),
    ];
    const { items, actions } = build({ runs });
    action(submenu(items, 'current-work').items, 'stop-run').onSelect(trigger);
    expect(actions.stopRun).toHaveBeenCalledWith(expect.objectContaining({ workflowRunId: 'run-ticket' }));
    action(submenu(items, 'copy').items, 'copy-ticket-key').onSelect(trigger);
    expect(actions.copy).toHaveBeenCalledWith('T-092', 'Ticket key');
  });

  it('uses the newest run when no run has a ticket', () => {
    const { items, actions } = build({
      runs: [
        run({ workflowRunId: 'run-newest', ticketKey: null, status: 'paused' }),
        run({ workflowRunId: 'run-oldest', ticketKey: null, status: 'paused' }),
      ],
    });
    action(submenu(items, 'current-work').items, 'retry-stage').onSelect(trigger);
    expect(actions.retryRun).toHaveBeenCalledWith(expect.objectContaining({ workflowRunId: 'run-newest' }));
    action(submenu(items, 'copy').items, 'copy-run-id').onSelect(trigger);
    expect(actions.copy).toHaveBeenCalledWith('run-newest', 'Run id');
  });

  it('requires no confirmation itself: Requeue and Stop call the screen callbacks', () => {
    const { items, actions } = build({ runs: [run()] });
    action(submenu(items, 'current-work').items, 'requeue-ticket').onSelect(trigger);
    action(submenu(items, 'current-work').items, 'stop-run').onSelect(trigger);
    expect(actions.requeueTicket).toHaveBeenCalledWith('T-091');
    expect(actions.stopRun).toHaveBeenCalledWith(expect.objectContaining({ workflowRunId: 'run-1' }));
  });

  it('hides Current work when the member has neither a run nor a claimed ticket', () => {
    const { items } = build({ member: member({ work: { state: 'none' } }) });
    expect(items.some((entry) => entry.kind === 'submenu' && entry.id === 'current-work')).toBe(false);
  });

  it('ignores runs that belong to another member', () => {
    const { items } = build({ member: member({ work: { state: 'none' } }), runs: [run({ memberId: 'qa' })] });
    expect(items.some((entry) => entry.kind === 'submenu' && entry.id === 'current-work')).toBe(false);
    expect(topLevelIds(submenu(items, 'copy').items)).toEqual(['copy-member-id']);
  });
});

describe('buildMemberMenu per-member data', () => {
  it('offers only blocked tickets whose last member is this one', () => {
    const { items } = build({
      blockedTickets: [ticket(), ticket({ key: 'T-093', memberId: 'other' })],
    });
    const unblock = submenu(items, 'unblock');
    expect(unblock.items.map((entry) => (entry.kind === 'submenu' ? entry.label : ''))).toEqual(['T-090 · Finish the Teams overview states · ROUND_LIMIT:qa-ready']);
  });

  it('offers only command requests of this member', () => {
    const { items } = build({
      requests: [request(), request({ id: 'cmd-2', memberId: 'other' })],
    });
    const commands = submenu(items, 'command-requests');
    expect(commands.items).toHaveLength(1);
    expect(submenu(commands.items, 'command-cmd-1')).toBeTruthy();
    expect(commands.items.some((entry) => entry.kind === 'submenu' && entry.id === 'command-cmd-2')).toBe(false);
  });

  it('copies member id, ticket key and run id, and announces each label', () => {
    const { items, actions } = build({ runs: [run()] });
    const copy = submenu(items, 'copy');
    expect(copy.items.map((entry) => (entry.kind === 'action' ? entry.label : ''))).toEqual(['Member id', 'Ticket key', 'Run id']);
    for (const id of ['copy-member-id', 'copy-ticket-key', 'copy-run-id']) action(copy.items, id).onSelect(trigger);
    expect(actions.copy.mock.calls).toEqual([
      ['dev', 'Member id'],
      ['T-091', 'Ticket key'],
      ['run-1', 'Run id'],
    ]);
  });

  it('omits ticket key and run id when there is no ticket or run', () => {
    const { items } = build({ member: member({ work: { state: 'none' } }) });
    expect(topLevelIds(submenu(items, 'copy').items)).toEqual(['copy-member-id']);
  });
});

describe('buildMemberMenu live agents', () => {
  const live = (overrides: Partial<NonNullable<OverviewMember['runtime']>> = {}): OverviewMember => member({
    agentOptions: [
      { id: 'claude-pro', name: 'Claude Pro', provider: 'claude', model: null, reasoning: null, description: null, state: 'ok' },
      { id: 'codex-pro', name: 'Codex Pro', provider: 'codex', model: null, reasoning: null, description: null, state: 'ok' },
    ],
    runtime: {
      agentId: 'a-1', configuredAgents: ['claude-pro', 'codex-pro'], activeAgent: 'claude-pro',
      quotaHolds: {}, pendingAgent: null, lastSwitch: null, assignment: null, availability: 'idle',
      paneState: 'alive', provider: 'claude', model: null, reasoning: null, stale: false, ...overrides,
    },
  });

  function catalog() {
    return [
      { id: 'claude-pro', name: 'Claude Pro', provider: 'claude' },
      { id: 'codex-pro', name: 'Codex Pro', provider: 'codex' },
    ];
  }

  function buildLive(target: OverviewMember, actions = callbacks()): { items: MenuItem[]; actions: MemberMenuCallbacks } {
    const items = buildMemberMenu({
      team: team({ runtime: { state: 'running', teamId: 'runtime-1', status: 'running' } }),
      member: target,
      attention: { runs: [], commandRequests: [], truncated: { runs: false, commandRequests: false } },
      blockedTickets: [],
      boardStatuses: statuses,
      roleItem: roleItem(target.role ?? 'Developer'),
      canEdit: true,
      catalog: catalog(),
      connected: true,
      inFlight: null,
      disabledReason: null,
      callbacks: actions,
    });
    return { items, actions };
  }

  it('marks the active option as a checked radio and switches through the detail flow', () => {
    const target = live();
    const actions = callbacks();
    const { items } = buildLive(target, actions);
    const switchMenu = submenu(items, 'switch-agent');
    const active = action(switchMenu.items, 'switch-claude-pro');
    expect(active.checked).toBe(true);
    expect(active.disabledReason).toBe('That agent is already active.');
    const other = action(switchMenu.items, 'switch-codex-pro');
    expect(other.checked).toBeUndefined();
    expect(other.disabledReason).toBeUndefined();
    other.onSelect(trigger);
    expect(actions.switchAgent).toHaveBeenCalledWith('codex-pro', 'Codex Pro', trigger);
  });

  it('shows Resume only for held options and disables a held switch target', () => {
    const target = live({ quotaHolds: { 'codex-pro': '2026-01-01T01:00:00Z' } });
    const actions = callbacks();
    const { items } = buildLive(target, actions);
    const switchMenu = submenu(items, 'switch-agent');
    expect(action(switchMenu.items, 'switch-codex-pro').disabledReason).toBe("Agent 'codex-pro' is on quota hold.");
    const resume = submenu(items, 'resume-agent');
    expect(topLevelIds(resume.items)).toEqual(['resume-codex-pro']);
    expect(action(resume.items, 'resume-codex-pro').description).toContain('Resets at');
    action(resume.items, 'resume-codex-pro').onSelect(trigger);
    expect(actions.resumeAgent).toHaveBeenCalledWith('codex-pro', 'Codex Pro');
  });

  it('hides Resume when no option is on hold', () => {
    const { items } = buildLive(live());
    expect(items.some((entry) => entry.kind === 'submenu' && entry.id === 'resume-agent')).toBe(false);
  });
});

describe('buildMemberMenu enablement', () => {
  it('disables View role when the role is not defined', () => {
    const { items } = build({ member: member({ role: 'retired', roleState: 'undefined' }), roleState: 'undefined' });
    expect(action(items, 'view-role').disabledReason).toBe("This member's role is not defined.");
  });

  it('views the defined role by id', () => {
    const { items, actions } = build({ member: member({ role: 'Developer' }) });
    action(items, 'view-role').onSelect(trigger);
    expect(actions.viewRole).toHaveBeenCalledWith('Developer');
  });

  it('disables Edit configuration and Remove member for an uneditable team', () => {
    const uneditable = team({ definition: { state: 'unreadable', problems: [] } });
    expect(canEditTeam(uneditable)).toBe(false);
    const { items } = build({ team: uneditable, canEdit: false });
    expect(action(items, 'edit-configuration').disabledReason).toMatch(/could not be read; fix the file/);
    expect(action(items, 'remove-member').disabledReason).toMatch(/could not be read; fix the file/);
  });

  it('disables Edit configuration and Remove member for a runtime-only member with an id', () => {
    // A runtime-only member has a non-null id, so it gets a row and a menu, but the
    // detail panel refuses saved edits and removal for it. Both items must match.
    const runtimeOnly = member({ memberId: 'live', name: 'live', source: 'runtime' });
    const { items, actions } = build({ member: runtimeOnly, canEdit: true });
    expect(action(items, 'edit-configuration').disabledReason).toBe('Saved configuration and removal are not available for runtime-only members.');
    expect(action(items, 'remove-member').disabledReason).toBe('Saved configuration and removal are not available for runtime-only members.');
    action(items, 'edit-configuration').onSelect(trigger);
    action(items, 'remove-member').onSelect(trigger);
    expect(actions.editConfiguration).not.toHaveBeenCalled();
    expect(actions.removeMember).not.toHaveBeenCalled();
  });

  it('prefers the team reason over the runtime-only reason for an uneditable team', () => {
    // The team-level refusal is the first thing a person can fix, so it must win
    // for a runtime-only member too.
    const uneditable = team({ definition: { state: 'unreadable', problems: [] } });
    const runtimeOnly = member({ memberId: 'live', name: 'live', source: 'runtime' });
    const { items, actions } = build({ team: uneditable, member: runtimeOnly, canEdit: false });
    expect(action(items, 'edit-configuration').disabledReason).toMatch(/could not be read; fix the file/);
    expect(action(items, 'remove-member').disabledReason).toMatch(/could not be read; fix the file/);
    action(items, 'edit-configuration').onSelect(trigger);
    action(items, 'remove-member').onSelect(trigger);
    expect(actions.editConfiguration).not.toHaveBeenCalled();
    expect(actions.removeMember).not.toHaveBeenCalled();
  });

  it('disables every mutating item with the global reason', () => {
    const { items } = build({ disabledReason: 'Another change is in progress.', runs: [run()], requests: [request()], blockedTickets: [ticket()] });
    for (const id of ['edit-configuration', 'remove-member']) expect(action(items, id).disabledReason).toBe('Another change is in progress.');
    for (const id of ['current-work', 'unblock', 'command-requests']) {
      const group = submenu(items, id);
      for (const entry of group.items) {
        if (entry.kind === 'action' || entry.kind === 'submenu') expect(entry.disabledReason).toBe('Another change is in progress.');
      }
    }
  });

  it('keeps Open details, View role and Copy enabled during a global lock', () => {
    const { items } = build({ disabledReason: 'Another change is in progress.', runs: [run()] });
    expect(action(items, 'open-details').disabledReason).toBeUndefined();
    expect(action(items, 'view-role').disabledReason).toBeUndefined();
    for (const entry of submenu(items, 'copy').items) {
      if (entry.kind === 'action') expect(entry.disabledReason).toBeUndefined();
    }
  });
});
