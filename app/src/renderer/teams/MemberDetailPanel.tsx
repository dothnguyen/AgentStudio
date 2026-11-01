import { useEffect, useId, useRef, useState, type JSX, type RefObject } from 'react';
import type { AgentDef, ManagementApi, OverviewMember, OverviewTeam, Result, RoleCatalogItem, RoleCatalogList } from '../api';
import { Icon } from '../icons/Icon';
import {
  canEditMember, ticketPermissionValue,
  uneditableNote, liveNote, MEMBER_DETAIL_TIMING_NOTE,
  type TeamWrites, type TicketPermissionState,
} from './teamEditModel';
import {
  memberName, memberSourceNote, roleText, teamLabel,
  presenceLabel, presenceTone, memberInitials, RUNTIME_LABELS,
} from './teamsModel';
import { memberAgentActions, type MemberActionInFlight } from './memberAgentActionsModel';
import { SectionCard } from './SectionCard';
import { MemberSettingsDialog } from './MemberSettingsDialog';
import { RoleInstructionsSection } from './RoleInstructionsSection';
import { useTicketPermission } from './useTicketPermission';

export interface MemberDetailPanelProps {
  workspaceId: string; management: ManagementApi; savedRevision: number;
  team: OverviewTeam; member: OverviewMember; agents: AgentDef[] | null; roleItems: RoleCatalogItem[] | null; roleCatalogMessage: string | null;
  /** Expected roles.json token, needed to save a role's description and prompt. */
  roleCatalogSha?: string | null;
  /** Reloads the role catalog fresh so the card and the Roles screen show the saved text. */
  reloadRoleCatalog?(): Promise<Result<RoleCatalogList>>;
  onViewRole?(roleId: string): void; writes: TeamWrites; pending: boolean; connected: boolean;
  agentsFresh?: boolean; rolesFresh?: boolean; readOnly?: boolean;
  agentsSection: JSX.Element; onBack(): void; onRemoved(): void;
  /** In-flight live-agent action for this member, so the status card and live section agree. */
  inFlight?: MemberActionInFlight;
  /** One-shot intent from the row actions menu. */
  intent?: 'edit' | 'remove';
  onIntentConsumed?(): void;
}

/** Read-only live summary for the member details aside. Values come from the same model as the live section. */
function MemberLiveStatusCard(props: { team: OverviewTeam; member: OverviewMember; catalog: AgentDef[] | null; connected: boolean; inFlight: MemberActionInFlight }): JSX.Element {
  const { team, member } = props;
  const view = memberAgentActions(team, member, props.catalog, props.connected, props.inFlight);
  return <SectionCard
    title={<><span className={`teams-live-status-dot teams-tone-${presenceTone(member.presence)}`} aria-hidden="true" />Live status</>}
    className="teams-live-status-card"
  >
    {!view.visible
      ? <p className="teams-live-status-empty">Live state is unavailable because this member has no running runtime record.</p>
      : <dl className="teams-live-status-grid">
        <div><dt>Availability</dt><dd><span className={`teams-live-status-value teams-tone-${presenceTone(member.presence)}`}><span className="status-dot" aria-hidden="true" />{view.availabilityText}</span></dd></div>
        <div><dt>Current assignment</dt><dd>{view.assignmentText}</dd></div>
        <div><dt>Team</dt><dd>{RUNTIME_LABELS[team.runtime.state]}</dd></div>
        <div><dt>Active agent</dt><dd>{view.activeText}</dd></div>
      </dl>}
  </SectionCard>;
}

/** Read-only Member settings card in the aside; its Edit button opens the single settings dialog. */
function MemberSettingsCard(props: {
  member: OverviewMember; permission: TicketPermissionState; canEdit: boolean;
  pending: boolean; readOnly: boolean; editRef: RefObject<HTMLButtonElement | null>; onEdit(): void;
}): JSX.Element {
  const { member } = props;
  return <SectionCard
    title="Member settings"
    subtitle="Name, role and permissions"
    className="teams-member-settings-card"
    action={props.canEdit ? {
      label: 'Edit',
      ariaLabel: 'Edit member settings',
      disabled: props.pending || props.readOnly,
      buttonRef: props.editRef,
      onClick: props.onEdit,
    } : undefined}
  >
    <dl className="teams-member-settings-grid">
      <div><dt>Display name</dt><dd>{memberName(member)}</dd></div>
      <div><dt>Member id</dt><dd><code className="entity-id">{member.memberId}</code></dd></div>
      <div><dt>Assigned role</dt><dd>{roleText(member)}</dd></div>
      <div><dt>Can add tickets</dt><dd>{ticketPermissionValue(props.permission)}</dd></div>
    </dl>
  </SectionCard>;
}

export function MemberDetailPanel(props: MemberDetailPanelProps): JSX.Element {
  const { team, member, writes } = props;
  const formRoles = props.rolesFresh === false ? null : props.roleItems;
  const pending = props.pending || props.readOnly === true;
  const memberId = member.memberId!;
  const name = memberName(member);
  const uid = useId();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [retry, setRetry] = useState(0);
  const [focusTarget, setFocusTarget] = useState<'settings' | 'remove' | 'confirm' | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null), settingsEditRef = useRef<HTMLButtonElement>(null), removeRef = useRef<HTMLButtonElement>(null), cancelRemoveRef = useRef<HTMLButtonElement>(null), confirmRemoveRef = useRef<HTMLButtonElement>(null);
  const intentApplied = useRef(false);
  const permission = useTicketPermission({ workspaceId: props.workspaceId, management: props.management, team, member, savedRevision: props.savedRevision, retry });
  useEffect(() => { headingRef.current?.focus(); }, [member.memberId]);
  useEffect(() => {
    if (intentApplied.current || props.intent === undefined) return;
    intentApplied.current = true;
    if (props.intent === 'edit') setSettingsOpen(true);
    else setConfirmingRemove(true);
    props.onIntentConsumed?.();
    // The menu intent is consumed exactly once per mounted member panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.intent]);
  useEffect(() => { if (!focusTarget) return; const el = focusTarget === 'settings' ? settingsEditRef.current : focusTarget === 'confirm' ? confirmRemoveRef.current : removeRef.current; if (el?.isConnected && !el.disabled) { el.focus(); setFocusTarget(null); } }, [focusTarget, pending, settingsOpen]);
  useEffect(() => { if (confirmingRemove) cancelRemoveRef.current?.focus(); }, [confirmingRemove]);
  const noticeRows = [MEMBER_DETAIL_TIMING_NOTE, memberSourceNote(member), uneditableNote(team), liveNote(team)].filter((note): note is string => note !== null);
  const removeTitleId = `${uid}-remove-title`;
  return <section className="teams-member-detail" aria-labelledby="teams-member-detail-title">
    <div className="teams-member-detail-top">
      <button type="button" className="teams-back-button" onClick={props.onBack}>Back to members</button>
      <nav className="breadcrumb teams-member-breadcrumb" aria-label="Member location"><ol><li>{teamLabel(team)}</li><li>Members</li><li aria-current="page">{name}</li></ol></nav>
    </div>
    <header className="teams-member-header">
      <div className="teams-member-identity">
        <span className="teams-member-hero-avatar" aria-hidden="true">{memberInitials(name)}</span>
        <div className="teams-member-identity-text">
          <div className="teams-member-title-row">
            <h1 id="teams-member-detail-title" ref={headingRef} tabIndex={-1}>{name}</h1>
            <span className="teams-role-chip">{roleText(member)}</span>
            {member.runtime !== null && <span className={`teams-page-pill teams-page-pill-${presenceTone(member.presence)}`}><span className="status-dot" aria-hidden="true" />{presenceLabel(member.presence)}</span>}
          </div>
          <p className="teams-member-subline">Member of {teamLabel(team)} · id <code className="entity-id">{memberId}</code></p>
        </div>
      </div>
    </header>
    <div className="teams-member-notices">
      {noticeRows.map((note, index) => <p className="teams-member-notice" key={`${index}-${note}`}><Icon name="info" size={14} className="teams-member-notice-icon" /><span>{note}</span></p>)}
    </div>
    <div className="teams-member-layout">
      <div className="teams-member-main">
        {props.agentsSection}
        <RoleInstructionsSection
          workspaceId={props.workspaceId}
          management={props.management}
          member={member}
          roles={props.roleItems}
          catalogSha={props.roleCatalogSha ?? null}
          roleCatalogMessage={props.roleCatalogMessage}
          pending={props.pending}
          readOnly={props.readOnly === true}
          reloadRoles={() => props.reloadRoleCatalog ? props.reloadRoleCatalog() : props.management.roles(props.workspaceId)}
          onViewRole={props.onViewRole}
        />
      </div>
      <aside className="teams-member-aside" aria-label="Member status and actions">
        <MemberLiveStatusCard team={team} member={member} catalog={props.agents} connected={props.connected} inFlight={props.inFlight ?? null} />
        <MemberSettingsCard
          member={member}
          permission={permission}
          canEdit={canEditMember(team, member)}
          pending={props.pending}
          readOnly={props.readOnly === true}
          editRef={settingsEditRef}
          onEdit={() => setSettingsOpen(true)}
        />
        {canEditMember(team, member) && <section className="teams-member-remove" aria-labelledby={removeTitleId}>
          <div className="teams-member-remove-text"><h2 id={removeTitleId}>Remove member</h2><p>{`Stop the team before removing ${name}.`}</p></div>
          <div className="teams-member-remove-actions"><button ref={removeRef} type="button" aria-label={`Remove ${name}`} disabled={pending} onClick={() => setConfirmingRemove(true)}>Remove</button></div>
          {confirmingRemove && <div className="teams-confirm" role="alertdialog" aria-labelledby={`${uid}-remove-confirm-title`} aria-describedby={`${uid}-remove-desc`} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); setConfirmingRemove(false); setFocusTarget('remove'); } }}><h3 id={`${uid}-remove-confirm-title`}>Remove {name}?</h3><p id={`${uid}-remove-desc`}>Remove {name} ({memberId}) from {teamLabel(team)}? Only this member's saved settings are deleted; shared roles and Agents catalog entries are not changed.</p><button ref={confirmRemoveRef} type="button" aria-label={`Confirm remove ${name}`} disabled={pending} onClick={() => { void writes.removeMember(team, memberId).then(ok => { if (ok) props.onRemoved(); else setFocusTarget('confirm'); }); }}>Confirm remove</button><button ref={cancelRemoveRef} type="button" aria-label={`Cancel removing ${name}`} onClick={() => { setConfirmingRemove(false); setFocusTarget('remove'); }}>Cancel</button></div>}
        </section>}
      </aside>
    </div>
    {settingsOpen && <MemberSettingsDialog
      team={team}
      member={member}
      roles={formRoles}
      roleCatalogMessage={props.roleCatalogMessage}
      permission={permission}
      onRetryPermission={() => setRetry(n => n + 1)}
      pending={props.pending}
      readOnly={props.readOnly === true}
      writes={writes}
      onClose={() => setSettingsOpen(false)}
      onSaved={() => { setSettingsOpen(false); setFocusTarget('settings'); }}
    />}
  </section>;
}
