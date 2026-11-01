import type { AttentionRun, BlockedTicket, BoardSettings, OverviewMember, OverviewTeam } from '../api';
import type { MenuItem } from '../ui/actionMenuModel';
import { shortenText } from '../ui/actionMenuModel';
import { canEditTeam, uneditableNote } from './teamEditModel';
import { teamAttention } from './teamsModel';

export type BoardStatus = BoardSettings['statuses'][number];

export interface TeamMenuActions {
  resetUsage(provider: string): void;
  resetUsageAll(providers: string[]): void;
  unblockTicket(key: string, to?: string): void;
  retryPausedRuns(runs: AttentionRun[]): void;
  approveCommand(id: string): void;
  rejectCommand(id: string): void;
  cancelCommand(id: string): void;
  copy(text: string, label: string): void;
  attach(kind: 'wsl' | 'windowsTerminal'): void;
  deleteTeam(): void;
}

export interface BuildTeamMenuInput {
  team: OverviewTeam;
  blockedTickets: readonly BlockedTicket[];
  blockedTicketsTruncated: boolean;
  statuses: readonly BoardStatus[] | null;
  /** Global reason that disables every item, e.g. a pending write or a disconnect. */
  disabledReason?: string | null;
  actions: TeamMenuActions;
}

const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  gemini: 'Gemini',
  agy: 'Agy',
};

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

function memberProviders(member: OverviewMember): string[] {
  const providers: string[] = [];
  for (const option of member.agentOptions) {
    if (option.provider !== null && !providers.includes(option.provider)) providers.push(option.provider);
  }
  const runtimeProvider = member.runtime?.provider ?? null;
  if (runtimeProvider !== null && !providers.includes(runtimeProvider)) providers.push(runtimeProvider);
  return providers;
}

/** The hold for a provider: a live quotaHolds entry on one of its options, or a limit-reached runtime. */
function memberHeldFor(member: OverviewMember, provider: string): boolean {
  const runtime = member.runtime;
  if (runtime === null) return false;
  const optionProviders = new Map(member.agentOptions.map((option) => [option.id, option.provider]));
  for (const [optionId, until] of Object.entries(runtime.quotaHolds)) {
    if (until === null) continue;
    const optionProvider = optionProviders.get(optionId) ?? (optionId === runtime.activeAgent ? runtime.provider : null);
    if (optionProvider === provider) return true;
  }
  return runtime.availability === 'limit_reached' && runtime.provider === provider;
}

interface ProviderHolds {
  provider: string;
  label: string;
  count: number;
}

function holdsByProvider(team: OverviewTeam): { providers: ProviderHolds[]; heldMembers: number } {
  const order: string[] = [];
  for (const member of team.members) {
    for (const provider of memberProviders(member)) if (!order.includes(provider)) order.push(provider);
  }
  const held = new Set<number>();
  const providers = order.map((provider) => {
    let count = 0;
    team.members.forEach((member, index) => {
      if (memberHeldFor(member, provider)) {
        count += 1;
        held.add(index);
      }
    });
    return { provider, label: providerLabel(provider), count };
  });
  return { providers, heldMembers: held.size };
}

function workingStatuses(statuses: readonly BoardStatus[] | null): BoardStatus[] {
  if (statuses === null) return [];
  return statuses.filter((status) => status.kind !== 'done' && status.kind !== 'closed');
}

export function buildTeamMenu(input: BuildTeamMenuInput): MenuItem[] {
  const { team, actions } = input;
  const globalReason = input.disabledReason ?? null;
  const running = team.runtime.state === 'running';
  const noDefinitionReason = team.id === null ? 'This team has no definition id.' : null;
  const attention = teamAttention(team);
  const pausedRuns = attention.runs.filter((run) => run.status === 'paused');
  const { providers, heldMembers } = holdsByProvider(team);
  const providersWithHolds = providers.filter((entry) => entry.count > 0);

  const resetItems: MenuItem[] = [
    {
      kind: 'action',
      id: 'reset-all-providers',
      label: 'All providers',
      description: heldMembers === 0 ? 'No holds' : `${heldMembers} member${heldMembers === 1 ? '' : 's'} on hold`,
      disabledReason: globalReason ?? noDefinitionReason ?? (!running ? 'The team is not running.' : heldMembers === 0 ? 'No usage holds to reset.' : undefined),
      onSelect: () => actions.resetUsageAll(providersWithHolds.map((entry) => entry.provider)),
    },
  ];
  if (providers.length > 0) resetItems.push({ kind: 'separator' });
  for (const entry of providers) {
    resetItems.push({
      kind: 'action',
      id: `reset-${entry.provider}`,
      label: entry.label,
      description: entry.count === 0 ? 'No hold' : `${entry.count} member${entry.count === 1 ? '' : 's'} on hold`,
      disabledReason: globalReason ?? noDefinitionReason ?? (!running ? 'The team is not running.' : entry.count === 0 ? `No usage hold for ${entry.label}.` : undefined),
      onSelect: () => actions.resetUsage(entry.provider),
    });
  }

  const ticketItems: MenuItem[] = input.blockedTickets.map((ticket) => {
    const statusItems: MenuItem[] = [];
    if (ticket.returnStatus !== null) {
      statusItems.push({
        kind: 'action',
        id: `unblock-${ticket.key}-return`,
        label: `Unblock to ${ticket.returnStatus}`,
        disabledReason: globalReason ?? undefined,
        onSelect: () => actions.unblockTicket(ticket.key, ticket.returnStatus ?? undefined),
      });
    }
    const statuses = workingStatuses(input.statuses);
    if (statuses.length > 0) {
      statusItems.push({
        kind: 'submenu',
        id: `unblock-${ticket.key}-choose`,
        label: 'Unblock to…',
        items: statuses.map((status) => ({
          kind: 'action' as const,
          id: `unblock-${ticket.key}-${status.id}`,
          label: `Unblock to ${status.id}`,
          disabledReason: globalReason ?? undefined,
          onSelect: () => actions.unblockTicket(ticket.key, status.id),
        })),
      });
    }
    if (statusItems.length === 0) {
      statusItems.push({
        kind: 'action',
        id: `unblock-${ticket.key}-none`,
        label: 'No target status is available.',
        disabledReason: 'The board has no working statuses and the ticket has no return status.',
        onSelect: () => undefined,
      });
    }
    return {
      kind: 'submenu' as const,
      id: `ticket-${ticket.key}`,
      label: `${ticket.key} · ${shortenText(ticket.title, 40)}${ticket.reason === null ? '' : ` · ${ticket.reason}`}`,
      disabledReason: globalReason ?? undefined,
      items: statusItems,
    };
  });
  if (input.blockedTicketsTruncated) ticketItems.push({ kind: 'heading', label: 'Showing the 25 most recent' });

  const blockedMenu: MenuItem = {
    kind: 'submenu',
    id: 'blocked-tickets',
    label: `Blocked tickets (${input.blockedTickets.length})`,
    disabledReason: globalReason ?? (input.blockedTickets.length === 0 ? 'No blocked tickets.' : undefined),
    items: ticketItems,
  };

  const items: MenuItem[] = [
    {
      kind: 'submenu',
      id: 'reset-usage',
      label: 'Reset usage limits',
      // Kept open so the disabled All providers / provider reasons stay readable.
      disabledReason: globalReason ?? undefined,
      items: resetItems,
    },
    blockedMenu,
    {
      kind: 'action',
      id: 'retry-paused-runs',
      label: `Retry paused runs (${pausedRuns.length})…`,
      disabledReason: globalReason ?? (pausedRuns.length === 0 ? 'No paused runs.' : undefined),
      onSelect: () => actions.retryPausedRuns(pausedRuns),
    },
  ];

  if (attention.commandRequests.length > 0) {
    items.push({
      kind: 'submenu',
      id: 'command-approvals',
      label: `Command approvals (${attention.commandRequests.length})`,
      disabledReason: globalReason ?? undefined,
      items: attention.commandRequests.map((request) => {
        const run = attention.runs.find((entry) => entry.workflowRunId === request.workflowRunId);
        const where = run?.ticketKey ?? request.memberId ?? request.workflowRunId;
        const commandItems: MenuItem[] = [
          {
            kind: 'action',
            id: `approve-${request.id}`,
            label: 'Approve',
            disabledReason: globalReason ?? undefined,
            onSelect: () => actions.approveCommand(request.id),
          },
          {
            kind: 'action',
            id: `reject-${request.id}`,
            label: 'Reject…',
            disabledReason: globalReason ?? undefined,
            onSelect: () => actions.rejectCommand(request.id),
          },
        ];
        if (request.status === 'running') {
          commandItems.push({
            kind: 'action',
            id: `cancel-${request.id}`,
            label: 'Cancel running command…',
            danger: true,
            disabledReason: globalReason ?? undefined,
            onSelect: () => actions.cancelCommand(request.id),
          });
        }
        return {
          kind: 'submenu' as const,
          id: `command-${request.id}`,
          label: `${request.command} · ${where}`,
          description: request.reason ?? undefined,
          disabledReason: globalReason ?? undefined,
          items: commandItems,
        };
      }),
    });
  }

  items.push({ kind: 'separator' });

  const runtimeId = team.runtime.teamId;
  const copyItems: MenuItem[] = [
    {
      kind: 'action',
      id: 'copy-team-id',
      label: 'Team id',
      disabledReason: globalReason ?? (team.id === null ? 'This team has no definition id.' : undefined),
      onSelect: () => { if (team.id !== null) actions.copy(team.id, 'Team id'); },
    },
    {
      kind: 'action',
      id: 'copy-runtime-id',
      label: 'Runtime id',
      disabledReason: globalReason ?? (runtimeId === null ? 'The team is not running.' : undefined),
      onSelect: () => { if (runtimeId !== null) actions.copy(runtimeId, 'Runtime id'); },
    },
    {
      kind: 'action',
      id: 'copy-attach-wsl',
      label: 'Attach command (WSL)',
      disabledReason: globalReason ?? (runtimeId === null ? 'The team is not running.' : undefined),
      onSelect: () => actions.attach('wsl'),
    },
    {
      kind: 'action',
      id: 'copy-attach-windows',
      label: 'Attach command (Windows Terminal)',
      disabledReason: globalReason ?? (runtimeId === null ? 'The team is not running.' : undefined),
      onSelect: () => actions.attach('windowsTerminal'),
    },
  ];
  items.push({ kind: 'submenu', id: 'copy', label: 'Copy', items: copyItems, disabledReason: globalReason ?? undefined });

  items.push({ kind: 'separator' });
  // T-101 inserts Start team / Stop team… here, between this separator and Delete team.
  items.push({
    kind: 'action',
    id: 'delete-team',
    label: 'Delete team…',
    danger: true,
    disabledReason: globalReason ?? (canEditTeam(team) ? undefined : uneditableNote(team) ?? 'This team cannot be edited here.'),
    onSelect: () => actions.deleteTeam(),
  });

  return items;
}
