import type {
  AgentDef,
  AttentionCommandRequest,
  AttentionRun,
  BlockedTicket,
  OverviewMember,
  OverviewTeam,
  RoleCatalogItem,
  TeamAttention,
} from '../api';
import type { MenuItem } from '../ui/actionMenuModel';
import { memberAgentActionRows, type MemberActionInFlight } from './memberAgentActionsModel';
import { canEditMember, uneditableNote } from './teamEditModel';
import { buildCommandRequestItems, buildUnblockTicketMenu, type BoardStatus } from './teamActionsModel';

export interface MemberMenuCallbacks {
  openDetails(): void;
  switchAgent(optionId: string, label: string, trigger: HTMLElement): void;
  resumeAgent(optionId: string, label: string): void;
  retryRun(run: AttentionRun): void;
  requeueTicket(key: string): void;
  stopRun(run: AttentionRun): void;
  unblockTicket(key: string, to?: string): void;
  approveCommand(id: string): void;
  rejectCommand(id: string): void;
  cancelCommand(id: string): void;
  editConfiguration(): void;
  viewRole(roleId: string): void;
  copy(text: string, label: string): void;
  removeMember(): void;
}

export interface BuildMemberMenuInput {
  team: OverviewTeam;
  member: OverviewMember;
  attention: TeamAttention;
  blockedTickets: readonly BlockedTicket[];
  boardStatuses: readonly BoardStatus[] | null;
  roleItem: RoleCatalogItem | null;
  canEdit: boolean;
  /** Live option rules need these; the row supplies its catalog and in-flight request. */
  catalog?: AgentDef[] | null;
  connected?: boolean;
  inFlight?: MemberActionInFlight;
  /** Global reason that disables every item that changes something. */
  disabledReason?: string | null;
  callbacks: MemberMenuCallbacks;
}

/**
 * The run shown for a member: the one attached to a ticket, else the newest
 * returned one. The read model returns each team's runs newest first.
 */
export function memberCurrentRun(member: OverviewMember, attention: TeamAttention): AttentionRun | null {
  if (member.memberId === null) return null;
  const runs = attention.runs.filter((run) => run.memberId === member.memberId);
  return runs.find((run) => run.ticketKey !== null) ?? runs[0] ?? null;
}

/** The claimed ticket of the member's current work, if any. */
export function memberClaimedTicket(member: OverviewMember): { key: string } | null {
  return member.work.state === 'working' ? member.work.ticket : null;
}

function retryReason(run: AttentionRun | null): string | undefined {
  // design/teams-actions-menus.md §3 uses this reason for every stage that is not stuck.
  if (run === null) return 'The current stage is not stuck.';
  if (run.status === 'paused') return undefined;
  if (run.assignmentStatus === 'waiting_input' || run.assignmentStatus === 'reconciling') return undefined;
  return 'The current stage is not stuck.';
}

/**
 * Edits and removal live in the saved configuration, which only exists for
 * catalog members of an editable team. A runtime-only member can still have a
 * row (and this menu) but must not open actions the detail panel refuses.
 */
function editReason(team: OverviewTeam, member: OverviewMember, canEdit: boolean): string | undefined {
  if (canEdit) return undefined;
  const teamNote = uneditableNote(team);
  if (teamNote !== null) return teamNote;
  if (member.memberId === null) return 'This member has no member id, so it cannot be edited here.';
  if (member.source === 'runtime') return 'Saved configuration and removal are not available for runtime-only members.';
  return 'This member cannot be edited here.';
}

function switchMenu(
  input: BuildMemberMenuInput,
  rows: ReturnType<typeof memberAgentActionRows>,
  disabledReason: string | null,
): MenuItem {
  if (rows.length === 0) {
    return {
      kind: 'submenu',
      id: 'switch-agent',
      label: 'Switch agent',
      disabledReason: disabledReason ?? (input.member.runtime === null ? 'Live state is unavailable because this member has no running runtime record.' : 'No live agent options are available.'),
      items: [],
    };
  }
  return {
    kind: 'submenu',
    id: 'switch-agent',
    label: 'Switch agent',
    items: rows.map((option) => ({
      kind: 'action' as const,
      id: `switch-${option.id}`,
      label: option.label,
      description: option.holdText ?? undefined,
      checked: option.active ? true : undefined,
      disabledReason: disabledReason ?? option.disabledReason ?? undefined,
      onSelect: (trigger) => input.callbacks.switchAgent(option.id, option.label, trigger),
    })),
  };
}

function resumeMenu(
  input: BuildMemberMenuInput,
  rows: ReturnType<typeof memberAgentActionRows>,
  disabledReason: string | null,
): MenuItem | null {
  const held = rows.filter((option) => option.holdText !== null);
  if (held.length === 0) return null;
  return {
    kind: 'submenu',
    id: 'resume-agent',
    label: 'Resume agent',
    items: held.map((option) => ({
      kind: 'action' as const,
      id: `resume-${option.id}`,
      label: option.label,
      description: option.holdText ?? undefined,
      disabledReason: disabledReason ?? (!option.canResume ? option.disabledReason ?? 'This agent cannot be resumed.' : undefined),
      onSelect: () => input.callbacks.resumeAgent(option.id, option.label),
    })),
  };
}

function currentWorkMenu(
  input: BuildMemberMenuInput,
  run: AttentionRun | null,
  ticketKey: string | null,
  disabledReason: string | null,
): MenuItem | null {
  const workTicket = memberClaimedTicket(input.member);
  if (run === null && workTicket === null) return null;
  const key = ticketKey;
  const items: MenuItem[] = [
    {
      kind: 'action',
      id: 'retry-stage',
      label: 'Retry stage',
      disabledReason: disabledReason ?? retryReason(run),
      onSelect: () => {
        if (run !== null && disabledReason === null && retryReason(run) === undefined) input.callbacks.retryRun(run);
      },
    },
  ];
  items.push({
    kind: 'action',
    id: 'requeue-ticket',
    label: 'Requeue ticket…',
    disabledReason: disabledReason ?? (key === null ? 'No ticket is attached to this run.' : undefined),
    onSelect: () => { if (key !== null) input.callbacks.requeueTicket(key); },
  });
  items.push({
    kind: 'action',
    id: 'stop-run',
    label: 'Stop run and block ticket…',
    danger: true,
    disabledReason: disabledReason ?? (run === null ? 'This ticket has no run to stop.' : undefined),
    onSelect: () => { if (run !== null) input.callbacks.stopRun(run); },
  });
  return { kind: 'submenu', id: 'current-work', label: 'Current work', items };
}

function commandRequestsMenu(
  input: BuildMemberMenuInput,
  requests: readonly AttentionCommandRequest[],
  disabledReason: string | null,
): MenuItem | null {
  if (requests.length === 0) return null;
  return {
    kind: 'submenu',
    id: 'command-requests',
    label: 'Command requests',
    items: buildCommandRequestItems(requests, input.attention.runs, disabledReason, input.callbacks),
  };
}

function copyMenu(input: BuildMemberMenuInput, ticketKey: string | null, run: AttentionRun | null): MenuItem {
  const items: MenuItem[] = [
    {
      kind: 'action',
      id: 'copy-member-id',
      label: 'Member id',
      disabledReason: input.member.memberId === null ? 'No member id returned.' : undefined,
      onSelect: () => { if (input.member.memberId !== null) input.callbacks.copy(input.member.memberId, 'Member id'); },
    },
  ];
  if (ticketKey !== null) {
    items.push({
      kind: 'action',
      id: 'copy-ticket-key',
      label: 'Ticket key',
      onSelect: () => input.callbacks.copy(ticketKey, 'Ticket key'),
    });
  }
  if (run !== null) {
    items.push({
      kind: 'action',
      id: 'copy-run-id',
      label: 'Run id',
      onSelect: () => input.callbacks.copy(run.workflowRunId, 'Run id'),
    });
  }
  return { kind: 'submenu', id: 'copy', label: 'Copy', items };
}

/**
 * Builds the member row menu: order, enablement and confirmations follow
 * design/teams-actions-menus.md (§2 member menu, §3, §4). Confirmations are the
 * component's job; each callback is the action that runs once confirmed.
 */
export function buildMemberMenu(input: BuildMemberMenuInput): MenuItem[] {
  const { team, member, callbacks } = input;
  const disabledReason = input.disabledReason ?? null;
  const roleId = input.roleItem?.id ?? member.role;
  const run = memberCurrentRun(member, input.attention);
  const ticketKey = run?.ticketKey ?? memberClaimedTicket(member)?.key ?? null;
  const memberBlocked = member.memberId === null
    ? []
    : input.blockedTickets.filter((ticket) => ticket.memberId === member.memberId);
  const memberCommands = member.memberId === null
    ? []
    : input.attention.commandRequests.filter((request) => request.memberId === member.memberId);
  const rows = memberAgentActionRows(team, member, input.catalog ?? null, input.connected ?? true, input.inFlight ?? null);
  // `canEdit` is the caller's permission for this member; the detail panel's
  // canEditMember is the authority, so both must agree before either item is enabled.
  const mayEdit = input.canEdit && canEditMember(team, member);
  const editDisabled = disabledReason ?? editReason(team, member, mayEdit);

  const items: MenuItem[] = [
    { kind: 'action', id: 'open-details', label: 'Open details', onSelect: () => callbacks.openDetails() },
    switchMenu(input, rows, disabledReason),
  ];
  const resume = resumeMenu(input, rows, disabledReason);
  if (resume !== null) items.push(resume);

  const middle: MenuItem[] = [];
  const work = currentWorkMenu(input, run, ticketKey, disabledReason);
  if (work !== null) middle.push(work);
  if (memberBlocked.length > 0) {
    middle.push({
      kind: 'submenu',
      id: 'unblock',
      label: 'Unblock',
      items: memberBlocked.map((ticket) => buildUnblockTicketMenu(ticket, input.boardStatuses, disabledReason, callbacks.unblockTicket)),
    });
  }
  const commands = commandRequestsMenu(input, memberCommands, disabledReason);
  if (commands !== null) middle.push(commands);
  if (middle.length > 0) items.push({ kind: 'separator' }, ...middle);

  items.push({ kind: 'separator' });
  items.push({
    kind: 'action',
    id: 'edit-configuration',
    label: 'Edit configuration…',
    disabledReason: editDisabled,
    onSelect: () => { if (mayEdit) callbacks.editConfiguration(); },
  });
  items.push({
    kind: 'action',
    id: 'view-role',
    label: 'View role in Roles',
    disabledReason: member.roleState !== 'defined' || roleId === null ? "This member's role is not defined." : undefined,
    onSelect: () => { if (roleId !== null) callbacks.viewRole(roleId); },
  });
  items.push(copyMenu(input, ticketKey, run));

  items.push({ kind: 'separator' });
  items.push({
    kind: 'action',
    id: 'remove-member',
    label: 'Remove member…',
    danger: true,
    disabledReason: disabledReason ?? editReason(team, member, mayEdit),
    onSelect: () => { if (mayEdit) callbacks.removeMember(); },
  });

  return items;
}
