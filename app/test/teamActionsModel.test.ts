import { describe, expect, it, vi } from 'vitest';
import type { AttentionCommandRequest, AttentionRun, BlockedTicket, OverviewTeam } from '../src/renderer/api';
import type { MenuActionItem, MenuItem, MenuSubmenuItem } from '../src/renderer/ui/actionMenuModel';
import { shortenText } from '../src/renderer/ui/actionMenuModel';
import { buildTeamMenu, providerLabel, type TeamMenuActions } from '../src/renderer/teams/teamActionsModel';
import { member, team } from './teamsFixtures';

const trigger = {} as HTMLElement;

function menuActions(): TeamMenuActions {
  return {
    resetUsage: vi.fn(),
    resetUsageAll: vi.fn(),
    unblockTicket: vi.fn(),
    retryPausedRuns: vi.fn(),
    approveCommand: vi.fn(),
    rejectCommand: vi.fn(),
    cancelCommand: vi.fn(),
    copy: vi.fn(),
    attach: vi.fn(),
    deleteTeam: vi.fn(),
  };
}

function submenu(items: MenuItem[], id: string): MenuSubmenuItem {
  const found = items.find((item): item is MenuSubmenuItem => item.kind === 'submenu' && item.id === id);
  if (found === undefined) throw new Error(`No submenu ${id}`);
  return found;
}

function action(items: MenuItem[], id: string): MenuActionItem {
  const found = items.find((item): item is MenuActionItem => item.kind === 'action' && item.id === id);
  if (found === undefined) throw new Error(`No action ${id}`);
  return found;
}

function labelOf(items: MenuItem[], id: string): string {
  const found = items.find((item) => (item.kind === 'action' || item.kind === 'submenu') && item.id === id);
  return found !== undefined && 'label' in found ? found.label : '';
}

function runningTeam(members = [
  member({
    memberId: 'claude-dev',
    agentOptions: [{ id: 'claude-opus', name: 'Claude Opus', provider: 'claude', model: null, reasoning: null, description: null, state: 'ok' }],
    runtime: {
      agentId: 'a-1', availability: 'busy', paneState: 'alive', provider: 'claude', model: null, reasoning: null,
      stale: false, configuredAgents: ['claude-opus'], activeAgent: 'claude-opus', quotaHolds: { 'claude-opus': '2026-01-01T01:00:00Z' },
      pendingAgent: null, lastSwitch: null, assignment: null,
    },
  }),
  member({
    memberId: 'codex-dev',
    agentOptions: [{ id: 'codex-gpt', name: 'Codex', provider: 'codex', model: null, reasoning: null, description: null, state: 'ok' }],
    runtime: {
      agentId: 'a-2', availability: 'idle', paneState: 'alive', provider: 'codex', model: null, reasoning: null,
      stale: false, configuredAgents: ['codex-gpt'], activeAgent: 'codex-gpt', quotaHolds: {},
      pendingAgent: null, lastSwitch: null, assignment: null,
    },
  }),
]): OverviewTeam {
  return team({ runtime: { state: 'running', teamId: 'runtime-1', status: 'running' }, members });
}

const ticket = (overrides: Partial<BlockedTicket> = {}): BlockedTicket => ({
  key: 'T-090', title: 'Finish the Teams overview states and the action menus', reason: 'ROUND_LIMIT:qa-ready',
  returnStatus: 'qa-ready', memberId: 'claude-dev', updatedAt: '2026-01-01T00:00:00Z', ...overrides,
});

const run = (overrides: Partial<AttentionRun> = {}): AttentionRun => ({
  workflowRunId: 'run-1', status: 'paused', stage: 'develop', memberId: 'claude-dev', ticketKey: 'T-091',
  assignmentId: 'as-1', assignmentStatus: 'paused', diagnosticCode: 'NEEDS_INPUT', delegating: false, ...overrides,
});

const request = (overrides: Partial<AttentionCommandRequest> = {}): AttentionCommandRequest => ({
  id: 'cmd-1', command: 'app-dev-dependency-add', status: 'requested', reason: 'needs a package',
  workflowRunId: 'run-1', memberId: 'claude-dev', ...overrides,
});

function build(overrides: Partial<{
  team: OverviewTeam;
  blockedTickets: BlockedTicket[];
  blockedTicketsTruncated: boolean;
  statuses: Array<{ id: string; name: string | null; kind: string | null }> | null;
  disabledReason: string | null;
  actions: TeamMenuActions;
}> = {}): { items: MenuItem[]; actions: TeamMenuActions } {
  const actions = overrides.actions ?? menuActions();
  const items = buildTeamMenu({
    team: overrides.team ?? runningTeam(),
    blockedTickets: overrides.blockedTickets ?? [],
    blockedTicketsTruncated: overrides.blockedTicketsTruncated ?? false,
    statuses: overrides.statuses ?? null,
    disabledReason: overrides.disabledReason ?? null,
    actions,
  });
  return { items, actions };
}

describe('buildTeamMenu usage limits', () => {
  it('counts the members on hold per provider and offers All providers first', () => {
    const { items, actions } = build();
    const reset = submenu(items, 'reset-usage');
    expect(reset.label).toBe('Reset usage limits');
    expect(reset.disabledReason).toBeUndefined();
    expect(reset.items[0]!.kind).toBe('action');
    expect(labelOf(reset.items, 'reset-all-providers')).toBe('All providers');
    expect(action(reset.items, 'reset-all-providers').description).toBe('1 member on hold');
    expect(action(reset.items, 'reset-claude').description).toBe('1 member on hold');
    expect(action(reset.items, 'reset-claude').disabledReason).toBeUndefined();
    expect(action(reset.items, 'reset-codex').description).toBe('No hold');
    expect(action(reset.items, 'reset-codex').disabledReason).toBe('No usage hold for Codex.');
    action(reset.items, 'reset-all-providers').onSelect(trigger);
    expect(actions.resetUsageAll).toHaveBeenCalledWith(['claude']);
    action(reset.items, 'reset-claude').onSelect(trigger);
    expect(actions.resetUsage).toHaveBeenCalledWith('claude');
  });

  it('passes every provider with holds to All providers and counts members across providers', () => {
    const members = runningTeam().members.map((entry) => entry.memberId === 'codex-dev' && entry.runtime !== null
      ? { ...entry, runtime: { ...entry.runtime, quotaHolds: { 'codex-gpt': '2026-01-01T01:00:00Z' } } }
      : entry);
    const { items, actions } = build({ team: runningTeam(members) });
    const reset = submenu(items, 'reset-usage');
    expect(action(reset.items, 'reset-all-providers').description).toBe('2 members on hold');
    expect(action(reset.items, 'reset-claude').description).toBe('1 member on hold');
    expect(action(reset.items, 'reset-codex').description).toBe('1 member on hold');
    action(reset.items, 'reset-all-providers').onSelect(trigger);
    expect(actions.resetUsageAll).toHaveBeenCalledWith(['claude', 'codex']);
  });

  it('lists a catalog option provider when the member has no live runtime', () => {
    const catalogOnly = member({
      memberId: 'catalog-only',
      agentOptions: [{ id: 'claude-opus', name: 'Claude Opus', provider: 'claude', model: null, reasoning: null, description: null, state: 'ok' }],
      runtime: null,
    });
    const { items } = build({ team: runningTeam([catalogOnly]) });
    const reset = submenu(items, 'reset-usage');
    expect(action(reset.items, 'reset-claude').description).toBe('No hold');
    expect(action(reset.items, 'reset-claude').disabledReason).toBe('No usage hold for Claude.');
  });

  it('keeps reset open and disables its items when nothing is on hold', () => {
    const { items } = build({ team: runningTeam([member({ memberId: 'idle', agentOptions: [], runtime: null })]) });
    const reset = submenu(items, 'reset-usage');
    expect(reset.disabledReason).toBeUndefined();
    expect(action(reset.items, 'reset-all-providers').disabledReason).toBe('No usage holds to reset.');
  });

  it('keeps reset open and disables its items when the team is not running', () => {
    const stopped = team({ runtime: { state: 'stopped', teamId: 'runtime-1', status: 'stopped' }, members: runningTeam().members });
    const { items } = build({ team: stopped });
    expect(submenu(items, 'reset-usage').disabledReason).toBeUndefined();
    expect(action(submenu(items, 'reset-usage').items, 'reset-all-providers').disabledReason).toBe('The team is not running.');
  });

  it('disables reset for a running runtime-only team without a definition id', () => {
    const runtimeOnly = team({
      id: null,
      name: null,
      definition: { state: 'missing', problems: [] },
      runtime: { state: 'running', teamId: 'runtime-1', status: 'running' },
      members: runningTeam().members,
    });
    const { items } = build({ team: runtimeOnly });
    const reset = submenu(items, 'reset-usage');
    expect(action(reset.items, 'reset-all-providers').disabledReason).toBe('This team has no definition id.');
    expect(action(reset.items, 'reset-claude').disabledReason).toBe('This team has no definition id.');
  });

  it('uses the catalog option provider for a quota hold and provider labels', () => {
    expect(providerLabel('opencode')).toBe('OpenCode');
    expect(providerLabel('claude')).toBe('Claude');
    expect(providerLabel('custom')).toBe('Custom');
  });
});

describe('buildTeamMenu blocked tickets', () => {
  const statuses = [
    { id: 'dev-ready', name: null, kind: null },
    { id: 'qa-ready', name: null, kind: null },
    { id: 'done', name: null, kind: 'done' },
    { id: 'closed', name: null, kind: 'closed' },
  ];

  it('offers the return status and a working-status submenu', () => {
    const { items, actions } = build({ blockedTickets: [ticket()], statuses });
    const blocked = submenu(items, 'blocked-tickets');
    expect(blocked.label).toBe('Blocked tickets (1)');
    expect(blocked.disabledReason).toBeUndefined();
    const ticketMenu = submenu(blocked.items, 'ticket-T-090');
    expect(ticketMenu.label).toBe('T-090 · Finish the Teams overview states and th… · ROUND_LIMIT:qa-ready');
    expect(ticketMenu.label).toContain('T-090');
    expect(ticketMenu.label).toContain('Finish the Teams overview states and th…');
    expect(ticketMenu.label).toContain('ROUND_LIMIT:qa-ready');
    action(ticketMenu.items, 'unblock-T-090-return').onSelect(trigger);
    expect(actions.unblockTicket).toHaveBeenCalledWith('T-090', 'qa-ready');
    const choices = submenu(ticketMenu.items, 'unblock-T-090-choose');
    expect(choices.items.map((entry) => (entry.kind === 'action' ? entry.label : ''))).toEqual(['Unblock to dev-ready', 'Unblock to qa-ready']);
    action(choices.items, 'unblock-T-090-dev-ready').onSelect(trigger);
    expect(actions.unblockTicket).toHaveBeenCalledWith('T-090', 'dev-ready');
  });

  it('offers only the status list when there is no return status', () => {
    const { items } = build({ blockedTickets: [ticket({ returnStatus: null })], statuses });
    const ticketMenu = submenu(submenu(items, 'blocked-tickets').items, 'ticket-T-090');
    expect(ticketMenu.items.some((entry) => entry.kind === 'action' && entry.id.endsWith('-return'))).toBe(false);
    expect(submenu(ticketMenu.items, 'unblock-T-090-choose').items).toHaveLength(2);
  });

  it('offers only the return status when board settings are not loaded', () => {
    const { items } = build({ blockedTickets: [ticket()], statuses: null });
    const ticketMenu = submenu(submenu(items, 'blocked-tickets').items, 'ticket-T-090');
    expect(ticketMenu.items).toHaveLength(1);
    expect(ticketMenu.items[0]!.kind).toBe('action');
  });

  it('offers a disabled fallback when nothing can receive the ticket', () => {
    const { items } = build({ blockedTickets: [ticket({ returnStatus: null })], statuses: null });
    const ticketMenu = submenu(submenu(items, 'blocked-tickets').items, 'ticket-T-090');
    expect(ticketMenu.items).toHaveLength(1);
    const fallback = ticketMenu.items[0]!;
    expect(fallback.kind).toBe('action');
    if (fallback.kind === 'action') {
      expect(fallback.label).toBe('No target status is available.');
      expect(fallback.disabledReason).toBe('The board has no working statuses and the ticket has no return status.');
    }
  });

  it('disables the group and explains when there are no blocked tickets', () => {
    const { items } = build();
    expect(submenu(items, 'blocked-tickets').disabledReason).toBe('No blocked tickets.');
  });

  it('adds the truncation heading', () => {
    const { items } = build({ blockedTickets: [ticket()], blockedTicketsTruncated: true, statuses });
    const blocked = submenu(items, 'blocked-tickets');
    expect(blocked.items.some((entry) => entry.kind === 'heading' && entry.label === 'Showing the 25 most recent')).toBe(true);
  });
});

describe('buildTeamMenu attention items', () => {
  it('offers retry for paused runs only', () => {
    const paused = [run({ workflowRunId: 'run-1' }), run({ workflowRunId: 'run-2', ticketKey: 'T-092' })];
    const attention = { runs: [...paused, run({ workflowRunId: 'run-3', status: 'running' })], commandRequests: [], truncated: { runs: false, commandRequests: false } };
    const { items, actions } = build({ team: team({ ...runningTeam(), attention }) });
    const retry = action(items, 'retry-paused-runs');
    expect(retry.label).toBe('Retry paused runs (2)…');
    expect(retry.disabledReason).toBeUndefined();
    retry.onSelect(trigger);
    expect(actions.retryPausedRuns).toHaveBeenCalledWith(paused);
  });

  it('disables retry when there are no paused runs', () => {
    const { items } = build();
    expect(action(items, 'retry-paused-runs').disabledReason).toBe('No paused runs.');
  });

  it('shows command approvals only when there are requests, with cancel for running commands', () => {
    const requests = [request(), request({ id: 'cmd-2', command: 'app-deps-install', status: 'running', workflowRunId: 'run-2' })];
    const attention = { runs: [run({ workflowRunId: 'run-1' }), run({ workflowRunId: 'run-2', ticketKey: 'T-092' })], commandRequests: requests, truncated: { runs: false, commandRequests: false } };
    const { items, actions } = build({ team: team({ ...runningTeam(), attention }) });
    const commands = submenu(items, 'command-approvals');
    expect(commands.label).toBe('Command approvals (2)');
    const first = submenu(commands.items, 'command-cmd-1');
    expect(first.label).toBe('app-dev-dependency-add · T-091');
    expect(first.items.some((entry) => entry.kind === 'action' && entry.id === 'cancel-cmd-1')).toBe(false);
    const second = submenu(commands.items, 'command-cmd-2');
    expect(second.items.some((entry) => entry.kind === 'action' && entry.id === 'cancel-cmd-2')).toBe(true);
    action(first.items, 'approve-cmd-1').onSelect(trigger);
    action(first.items, 'reject-cmd-1').onSelect(trigger);
    action(second.items, 'cancel-cmd-2').onSelect(trigger);
    expect(actions.approveCommand).toHaveBeenCalledWith('cmd-1');
    expect(actions.rejectCommand).toHaveBeenCalledWith('cmd-1');
    expect(actions.cancelCommand).toHaveBeenCalledWith('cmd-2');
  });

  it('hides command approvals when there are no requests', () => {
    const { items } = build();
    expect(items.some((entry) => entry.kind === 'submenu' && entry.id === 'command-approvals')).toBe(false);
  });
});

describe('buildTeamMenu copy, delete and global disablement', () => {
  it('offers copy items with runtime disabled when stopped', () => {
    const stopped = team({ runtime: { state: 'stopped', teamId: null, status: 'stopped' } });
    const { items, actions } = build({ team: stopped });
    const copyMenu = submenu(items, 'copy');
    action(copyMenu.items, 'copy-team-id').onSelect(trigger);
    expect(actions.copy).toHaveBeenCalledWith('dev-team', 'Team id');
    expect(action(copyMenu.items, 'copy-runtime-id').disabledReason).toBe('The team is not running.');
    expect(action(copyMenu.items, 'copy-attach-wsl').disabledReason).toBe('The team is not running.');
  });

  it('disables Team id when the runtime-only team has no definition id', () => {
    const runtimeOnly = team({
      id: null,
      name: null,
      definition: { state: 'missing', problems: [] },
      runtime: { state: 'running', teamId: 'runtime-1', status: 'running' },
    });
    const { items } = build({ team: runtimeOnly });
    expect(action(submenu(items, 'copy').items, 'copy-team-id').disabledReason).toBe('This team has no definition id.');
  });

  it('copies the runtime id and attaches on selection', () => {
    const { items, actions } = build();
    const copyMenu = submenu(items, 'copy');
    action(copyMenu.items, 'copy-runtime-id').onSelect(trigger);
    action(copyMenu.items, 'copy-attach-wsl').onSelect(trigger);
    action(copyMenu.items, 'copy-attach-windows').onSelect(trigger);
    expect(actions.copy).toHaveBeenCalledWith('runtime-1', 'Runtime id');
    expect(actions.attach).toHaveBeenCalledWith('wsl');
    expect(actions.attach).toHaveBeenCalledWith('windowsTerminal');
  });

  it('keeps Delete team last, dangerous and disabled for uneditable teams', () => {
    const { items, actions } = build({ team: team({ definition: { state: 'unreadable', problems: [] } }) });
    const last = items[items.length - 1]!;
    expect(last.kind).toBe('action');
    if (last.kind === 'action') {
      expect(last.id).toBe('delete-team');
      expect(last.label).toBe('Delete team…');
      expect(last.danger).toBe(true);
      expect(last.disabledReason).toMatch(/could not be read; fix the file/);
    }
    expect(actions.deleteTeam).not.toHaveBeenCalled();
  });

  it('disables every actionable item with the global reason', () => {
    const { items } = build({ disabledReason: 'Another change is in progress.', blockedTickets: [ticket()], statuses: null });
    for (const entry of items) {
      if (entry.kind === 'action' || entry.kind === 'submenu') expect(entry.disabledReason).toBe('Another change is in progress.');
    }
  });
});

function actionable(items: MenuItem[]): Array<MenuActionItem | MenuSubmenuItem> {
  const found: Array<MenuActionItem | MenuSubmenuItem> = [];
  for (const entry of items) {
    if (entry.kind === 'action' || entry.kind === 'submenu') found.push(entry);
    if (entry.kind === 'submenu') found.push(...actionable(entry.items));
  }
  return found;
}

const workingStatuses = [
  { id: 'dev-ready', name: null, kind: null },
  { id: 'qa-ready', name: null, kind: null },
  { id: 'done', name: null, kind: 'done' },
  { id: 'closed', name: null, kind: 'closed' },
];

describe('buildTeamMenu provider detection and order', () => {
  it('offers the runtime provider and counts a limit-reached runtime as a hold', () => {
    const limited = member({
      memberId: 'limited',
      agentOptions: [],
      runtime: {
        agentId: 'a-limited', availability: 'limit_reached', paneState: 'alive', provider: 'gemini', model: null,
        reasoning: null, stale: false, configuredAgents: [], activeAgent: null, quotaHolds: {},
        pendingAgent: null, lastSwitch: null, assignment: null,
      },
    });
    const { items } = build({ team: runningTeam([limited]) });
    const reset = submenu(items, 'reset-usage');
    expect(action(reset.items, 'reset-gemini').description).toBe('1 member on hold');
    expect(action(reset.items, 'reset-gemini').disabledReason).toBeUndefined();
    expect(action(reset.items, 'reset-all-providers').description).toBe('1 member on hold');
  });

  it('matches a quota hold to the provider of its catalog option, not the runtime provider', () => {
    const mixed = member({
      memberId: 'mixed',
      agentOptions: [
        { id: 'claude-opus', name: 'Claude Opus', provider: 'claude', model: null, reasoning: null, description: null, state: 'ok' },
        { id: 'codex-gpt', name: 'Codex', provider: 'codex', model: null, reasoning: null, description: null, state: 'ok' },
      ],
      runtime: {
        agentId: 'a-mixed', availability: 'busy', paneState: 'alive', provider: 'claude', model: null, reasoning: null,
        stale: false, configuredAgents: ['claude-opus', 'codex-gpt'], activeAgent: 'claude-opus',
        quotaHolds: { 'codex-gpt': '2026-01-01T01:00:00Z' }, pendingAgent: null, lastSwitch: null, assignment: null,
      },
    });
    const { items } = build({ team: runningTeam([mixed]) });
    const reset = submenu(items, 'reset-usage');
    expect(action(reset.items, 'reset-claude').description).toBe('No hold');
    expect(action(reset.items, 'reset-claude').disabledReason).toBe('No usage hold for Claude.');
    expect(action(reset.items, 'reset-codex').description).toBe('1 member on hold');
  });

  it("labels a command submenu with the member when its run is not in the attention list", () => {
    const attention = {
      runs: [],
      commandRequests: [request({ workflowRunId: 'missing-run' })],
      truncated: { runs: false, commandRequests: false },
    };
    const { items } = build({ team: team({ ...runningTeam(), attention }) });
    const commands = submenu(items, 'command-approvals');
    expect(submenu(commands.items, 'command-cmd-1').label).toBe('app-dev-dependency-add · claude-dev');
  });

  it('lists exactly the design items in order and leaves no Start/Stop placeholder', () => {
    const attention = {
      runs: [run()],
      commandRequests: [request()],
      truncated: { runs: false, commandRequests: false },
    };
    const { items, actions } = build({
      team: team({ ...runningTeam(), attention }),
      blockedTickets: [ticket()],
      statuses: workingStatuses,
    });
    const order = items
      .filter((entry): entry is MenuActionItem | MenuSubmenuItem => entry.kind === 'action' || entry.kind === 'submenu')
      .map((entry) => entry.id);
    expect(order).toEqual(['reset-usage', 'blocked-tickets', 'retry-paused-runs', 'command-approvals', 'copy', 'delete-team']);
    expect(order.some((id) => /^(start|stop)-team$/.test(id))).toBe(false);
    action(items, 'delete-team').onSelect(trigger);
    expect(actions.deleteTeam).toHaveBeenCalledTimes(1);
  });

  it('applies the global reason to nested actions too', () => {
    const attention = {
      runs: [run()],
      commandRequests: [request()],
      truncated: { runs: false, commandRequests: false },
    };
    const { items } = build({
      team: team({ ...runningTeam(), attention }),
      blockedTickets: [ticket()],
      statuses: workingStatuses,
      disabledReason: 'Another change is in progress.',
    });
    for (const entry of actionable(items)) {
      if (entry.kind === 'action') expect(entry.disabledReason).toBe('Another change is in progress.');
    }
  });
});

describe('shortenText', () => {
  it('keeps a 40 character title and shortens longer ones to exactly 40', () => {
    const exactly = 'x'.repeat(40);
    expect(shortenText(exactly)).toBe(exactly);
    const longer = 'y'.repeat(41);
    expect(shortenText(longer)).toBe(`${'y'.repeat(39)}…`);
    expect(shortenText(longer)).toHaveLength(40);
  });
});
