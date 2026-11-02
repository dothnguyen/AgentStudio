import { useId, useRef, useState, type JSX, type KeyboardEvent, type MouseEvent } from 'react';
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
import { Icon } from '../icons/Icon';
import { ActionMenu } from '../ui/ActionMenu';
import type { MenuItem } from '../ui/actionMenuModel';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { buildMemberMenu, memberClaimedTicket } from './memberActionsModel';
import { memberActionKey, type MemberActionInFlight } from './memberAgentActionsModel';
import { canEditMember } from './teamEditModel';
import type { BoardStatus } from './teamActionsModel';
import { memberIdentity, memberInitials, memberLiveAgent, memberRoleSummary, memberRowWorkParts, presenceLabel, presenceTone, teamLabel } from './teamsModel';

export interface MemberListActions {
  onRetryRun(run: AttentionRun): void;
  onRequeueTicket(key: string): void;
  onStopRun(run: AttentionRun): void;
  onUnblockTicket(key: string, to?: string): void;
  onApproveCommand(id: string): void;
  onRejectCommand(id: string, reason?: string): void;
  onCancelCommand(id: string, reason?: string): void;
}

export interface MemberListProps {
  team: OverviewTeam;
  members: readonly OverviewMember[];
  roleItems: RoleCatalogItem[] | null;
  agents: AgentDef[] | null;
  currentMemberId: string | null;
  rowRef(memberId: string, el: HTMLButtonElement | null): void;
  onOpen(memberId: string, intent?: 'edit' | 'remove'): void;
  attention: TeamAttention;
  blockedTickets: readonly BlockedTicket[];
  boardStatuses: readonly BoardStatus[] | null;
  pending: boolean;
  readOnly: boolean;
  connected: boolean;
  actions: Record<string, MemberActionInFlight>;
  onSwitch(team: OverviewTeam, member: OverviewMember, id: string, label: string, trigger: HTMLButtonElement): void;
  onResume(team: OverviewTeam, member: OverviewMember, id: string, label: string): void;
  memberActions: MemberListActions;
  copy(text: string, label: string): void;
  onViewRole?(roleId: string): void;
  /** Opens the read-only ticket page for the current work key. */
  onOpenTicket?(key: string): void;
}

type RowConfirm =
  | { kind: 'requeue'; key: string }
  | { kind: 'stop'; run: AttentionRun; key: string | null }
  | { kind: 'reject'; request: AttentionCommandRequest }
  | { kind: 'cancel'; request: AttentionCommandRequest };

interface MemberRowProps extends Omit<MemberListProps, 'members' | 'currentMemberId' | 'rowRef'> {
  member: OverviewMember;
  rowId: string;
  current: boolean;
  registerOpen(el: HTMLButtonElement | null): void;
}

function MemberRow(props: MemberRowProps): JSX.Element {
  const { team, member, roleItems, agents } = props;
  const identity = memberIdentity(member);
  const role = memberRoleSummary(member, roleItems);
  const live = memberLiveAgent(member, agents);
  const work = memberRowWorkParts(member.work);
  const interactive = member.memberId !== null;
  const catalog = props.roleItems;
  const roleId = catalog !== null && member.role !== null ? catalog.find((item) => item.id === member.role) ?? null : null;

  const openRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLButtonElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | undefined>(undefined);
  const [confirm, setConfirm] = useState<RowConfirm | null>(null);

  const triggerDisabled = props.readOnly || !props.connected;
  const globalReason = props.pending
    ? 'Another change is in progress.'
    : props.readOnly
      ? 'Team data is not current.'
      : !props.connected
        ? 'The app is disconnected.'
        : null;
  const inFlight = props.actions[memberActionKey(team.id ?? '', member.memberId ?? '')] ?? null;
  const memberCommands = member.memberId === null
    ? []
    : props.attention.commandRequests.filter((request) => request.memberId === member.memberId);

  function openMenuAt(point: { x: number; y: number } | undefined, opener: HTMLElement | null): void {
    if (triggerDisabled) return;
    returnFocusRef.current = opener;
    setAnchor(point);
    setMenuOpen(true);
  }

  function requestReject(id: string): void {
    const request = memberCommands.find((entry) => entry.id === id);
    if (request === undefined) { props.memberActions.onRejectCommand(id); return; }
    setConfirm({ kind: 'reject', request });
  }

  function requestCancel(id: string): void {
    const request = memberCommands.find((entry) => entry.id === id);
    if (request === undefined) { props.memberActions.onCancelCommand(id); return; }
    setConfirm({ kind: 'cancel', request });
  }

  const menuItems: MenuItem[] = interactive ? buildMemberMenu({
    team,
    member,
    attention: props.attention,
    blockedTickets: props.blockedTickets,
    boardStatuses: props.boardStatuses,
    roleItem: roleId,
    canEdit: canEditMember(team, member),
    catalog: agents,
    connected: props.connected,
    inFlight,
    disabledReason: globalReason,
    callbacks: {
      openDetails: () => props.onOpen(member.memberId!),
      switchAgent: (id, label, trigger) => props.onSwitch(team, member, id, label, trigger as HTMLButtonElement),
      resumeAgent: (id, label) => props.onResume(team, member, id, label),
      retryRun: (run) => props.memberActions.onRetryRun(run),
      requeueTicket: (key) => setConfirm({ kind: 'requeue', key }),
      stopRun: (run) => setConfirm({ kind: 'stop', run, key: run.ticketKey ?? memberClaimedTicket(member)?.key ?? null }),
      unblockTicket: (key, to) => props.memberActions.onUnblockTicket(key, to),
      approveCommand: (id) => props.memberActions.onApproveCommand(id),
      rejectCommand: requestReject,
      cancelCommand: requestCancel,
      editConfiguration: () => props.onOpen(member.memberId!, 'edit'),
      viewRole: (id) => props.onViewRole?.(id),
      copy: (text, label) => props.copy(text, label),
      removeMember: () => props.onOpen(member.memberId!, 'remove'),
    },
  }) : [];

  const nameContent = <>
    <span className="teams-member-avatar" aria-hidden="true">{memberInitials(identity.name)}</span>
    <span className="teams-member-ident">
      <span className="teams-member-name">{identity.name}</span>
      {member.memberId !== null && <code className="teams-member-id">{member.memberId}</code>}
      {identity.note && <span className="teams-cell-note">{identity.note}</span>}
    </span>
  </>;

  function onOpenKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault();
      openMenuAt(undefined, openRef.current);
    }
  }

  function onRowClick(event: MouseEvent<HTMLDivElement>): void {
    if (!interactive) return;
    const target = event.target as HTMLElement;
    if (target.closest('.teams-row-menu, .modal-overlay, [data-action-menu-root], [role="alertdialog"]') !== null) return;
    props.onOpen(member.memberId!);
  }

  function onContextMenu(event: MouseEvent<HTMLDivElement>): void {
    // A row that cannot open the menu keeps the native context menu.
    if (!interactive || triggerDisabled) return;
    event.preventDefault();
    openMenuAt({ x: event.clientX, y: event.clientY }, menuRef.current);
  }

  return <div
    className={`teams-member-row${interactive ? '' : ' teams-member-row-static'}`}
    data-current={props.current ? 'true' : undefined}
    onClick={onRowClick}
    onContextMenu={onContextMenu}
  >
    <span className="teams-member-field teams-member-cell" data-field="name">
      {interactive
        ? <button
            type="button"
            className="teams-member-open"
            data-member-row={member.memberId!}
            ref={(el) => { openRef.current = el; props.registerOpen(el); }}
            aria-current={props.current ? 'true' : undefined}
            aria-describedby={`${props.rowId}-role ${props.rowId}-agent ${props.rowId}-status ${props.rowId}-work`}
            onKeyDown={onOpenKeyDown}
          >{nameContent}</button>
        : nameContent}
    </span>
    <span className="teams-member-field" id={`${props.rowId}-role`} data-field="role"><span className="teams-role-chip">{role.label}</span>{role.roleId && <code className="teams-member-id">{role.roleId}</code>}{role.note && <span className="teams-cell-note">{role.note}</span>}</span>
    <span className={`teams-member-field teams-member-agent teams-member-agent-${live.kind}`} id={`${props.rowId}-agent`} data-field="agent">
      <span className="teams-member-agent-line">
        <span className="teams-member-agent-name" data-part="agent-name">{live.name}</span>
        {live.switched && <span className="teams-switched-tag" data-part="agent-switched">Switched</span>}
      </span>
      {live.meta && <span className="teams-member-agent-meta" data-part="agent-meta">{live.meta}</span>}
      {live.note && <span className="teams-cell-note" data-part="agent-note">{live.note}</span>}
    </span>
    <span className={`teams-member-field teams-member-status teams-tone-${presenceTone(member.presence)}`} id={`${props.rowId}-status`} data-field="availability"><span className="status-dot" aria-hidden="true" />{presenceLabel(member.presence)}</span>
    <span className={`teams-member-field teams-member-work${work.muted ? ' teams-member-work-muted' : ''}`} id={`${props.rowId}-work`} data-field="work">
      {work.ticketKey !== null && props.onOpenTicket !== undefined
        ? (
          <>
            <button
              type="button"
              className="teams-member-work-ticket"
              aria-label={`Open ${work.ticketKey}`}
              onClick={(event) => {
                event.stopPropagation();
                props.onOpenTicket?.(work.ticketKey!);
              }}
            >
              {work.ticketKey}
            </button>
            {work.rest}
          </>
        )
        : work.text}
    </span>
    {interactive
      ? <span className="teams-row-menu">
          <ActionMenu
            label={`Actions for ${identity.name}`}
            trigger={{ icon: 'more', ariaLabel: `Actions for ${identity.name}` }}
            triggerClassName="teams-member-menu-trigger"
            triggerRef={menuRef}
            items={menuItems}
            open={menuOpen}
            anchorPoint={anchor}
            returnFocusRef={returnFocusRef}
            disabled={triggerDisabled}
            onOpenChange={(next) => {
              setMenuOpen(next);
              if (next) returnFocusRef.current = menuRef.current;
              else setAnchor(undefined);
            }}
          />
        </span>
      : <span className="teams-row-menu teams-row-menu-empty" aria-hidden="true" />}
    <Icon name="chevron-right" size={16} className="teams-member-chevron" />
    {confirm?.kind === 'requeue' && <ConfirmDialog
      title={`Requeue ${confirm.key}?`}
      body="Releases the claim and cancels the current run. The ticket goes back to its queue and the next free member picks it up. Work already committed on its branch is kept."
      confirmLabel="Requeue ticket"
      busy={props.pending}
      returnFocusRef={menuRef}
      onCancel={() => setConfirm(null)}
      onConfirm={() => { const key = confirm.key; setConfirm(null); props.memberActions.onRequeueTicket(key); }}
    />}
    {confirm?.kind === 'stop' && <ConfirmDialog
      title={confirm.key === null ? 'Stop the run?' : `Stop the run for ${confirm.key}?`}
      body="Cancels the run. The ticket becomes blocked and stays blocked until someone unblocks it."
      confirmLabel="Stop run and block ticket"
      danger
      busy={props.pending}
      returnFocusRef={menuRef}
      onCancel={() => setConfirm(null)}
      onConfirm={() => { const run = confirm.run; setConfirm(null); props.memberActions.onStopRun(run); }}
    />}
    {confirm?.kind === 'reject' && <ConfirmDialog
      title="Reject command?"
      body={`Reject "${confirm.request.command}"? The requesting member is told why.`}
      details={confirm.request.reason === null ? undefined : [confirm.request.reason]}
      confirmLabel="Reject command"
      danger
      reasonLabel="Reason (optional)"
      busy={props.pending}
      returnFocusRef={menuRef}
      onCancel={() => setConfirm(null)}
      onConfirm={(reason) => { const request = confirm.request; setConfirm(null); props.memberActions.onRejectCommand(request.id, reason); }}
    />}
    {confirm?.kind === 'cancel' && <ConfirmDialog
      title="Cancel running command?"
      body={`Cancel "${confirm.request.command}"? The command stops and the run keeps going without its result.`}
      confirmLabel="Cancel command"
      danger
      reasonLabel="Reason (optional)"
      busy={props.pending}
      returnFocusRef={menuRef}
      onCancel={() => setConfirm(null)}
      onConfirm={(reason) => { const request = confirm.request; setConfirm(null); props.memberActions.onCancelCommand(request.id, reason); }}
    />}
  </div>;
}

export function MemberList(props: MemberListProps): JSX.Element {
  const baseId = useId().replace(/:/g, '');
  return <div className="teams-members-scroll"><div className="teams-members-table">
    <div className="teams-member-list-head" aria-hidden="true"><span>Member</span><span>Role</span><span>Live agent</span><span>Status</span><span>Current work</span><span /><span /></div>
    <ul className="teams-member-list" aria-label={`Members of ${teamLabel(props.team)}`}>{props.members.map((m, i) => {
      const rowId = `${baseId}-${i}`;
      return <li key={m.memberId ?? `index:${i}`}>
        <MemberRow
          {...props}
          member={m}
          rowId={rowId}
          current={m.memberId !== null && m.memberId === props.currentMemberId}
          registerOpen={(el) => { if (m.memberId !== null) props.rowRef(m.memberId, el); }}
        />
      </li>;
    })}</ul>
  </div></div>;
}
