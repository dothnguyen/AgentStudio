import { useEffect, useId, useRef, useState, type JSX } from 'react';
import type { AgentDef, ManagementApi, OverviewMember, OverviewTeam, RoleCatalogItem } from '../api';
import { Icon } from '../icons/Icon';
import { MemberForm } from './TeamEditForms';
import {
  canEditMember, findCatalogRole, memberChanges, memberFormInitial, thrownError, ticketPermissionText,
  uneditableNote, liveNote, MEMBER_DETAIL_TIMING_NOTE, ROLE_SHARING_NOTE, SAVED_OPTIONS_NOTE, NEXT_START_DEFAULT,
  type MemberFormValues, type TeamWrites, type TicketPermissionState,
} from './teamEditModel';
import {
  memberName, memberSourceNote, roleNote, roleText, providerModelText, teamLabel,
  presenceLabel, presenceTone, memberInitials, RUNTIME_LABELS,
} from './teamsModel';
import { memberAgentActions, type MemberActionInFlight } from './memberAgentActionsModel';
import { SectionCard } from './SectionCard';

export interface MemberDetailPanelProps {
  workspaceId: string; management: ManagementApi; savedRevision: number;
  team: OverviewTeam; member: OverviewMember; agents: AgentDef[] | null; roleItems: RoleCatalogItem[] | null; roleCatalogMessage: string | null;
  onViewRole?(roleId: string): void; writes: TeamWrites; pending: boolean; connected: boolean;
  agentsFresh?: boolean; rolesFresh?: boolean; readOnly?: boolean;
  liveActions: JSX.Element; onBack(): void; onRemoved(): void;
  /** In-flight live-agent action for this member, so the status card and live section agree. */
  inFlight?: MemberActionInFlight;
  /** One-shot intent from the row actions menu. */
  intent?: 'edit' | 'remove';
  onIntentConsumed?(): void;
}
function useTicketPermission(props: MemberDetailPanelProps, retry: number): TicketPermissionState {
  const { workspaceId, management, team, member, savedRevision } = props;
  const [permission, setPermission] = useState<TicketPermissionState>({ state: 'loading' });
  useEffect(() => {
    if (team.id === null || member.memberId === null || member.source === 'runtime') { setPermission({ state: 'ready', canAddTickets: null }); return; }
    let cancelled = false;
    void (async () => {
      let result;
      try { result = await management.team(workspaceId, team.id!); } catch (reason) { result = { ok: false as const, error: thrownError(reason) }; }
      if (cancelled) return;
      if (!result.ok) setPermission({ state: 'error', error: result.error });
      else { const raw = result.data.team.members.find(m => m.id === member.memberId); setPermission({ state: 'ready', canAddTickets: raw === undefined ? null : raw.canAddTickets === true }); }
    })();
    return () => { cancelled = true; };
  }, [workspaceId, team.id, member.memberId, member.source, savedRevision, retry]);
  return permission;
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

export function MemberDetailPanel(props: MemberDetailPanelProps): JSX.Element {
  const { team, member, writes } = props;
  const agents = props.agentsFresh === false ? null : props.agents;
  const formRoles = props.rolesFresh === false ? null : props.roleItems;
  const pending = props.pending || props.readOnly === true;
  const memberId = member.memberId!;
  const name = memberName(member);
  const uid = useId();
  const [editing, setEditing] = useState<MemberFormValues | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [retry, setRetry] = useState(0);
  const [focusTarget, setFocusTarget] = useState<'edit' | 'remove' | 'confirm' | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null), editRef = useRef<HTMLButtonElement>(null), removeRef = useRef<HTMLButtonElement>(null), cancelRemoveRef = useRef<HTMLButtonElement>(null), confirmRemoveRef = useRef<HTMLButtonElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const intentApplied = useRef(false);
  const focusFirstField = useRef(false);
  const permission = useTicketPermission(props, retry);
  useEffect(() => { headingRef.current?.focus(); }, [member.memberId]);
  useEffect(() => {
    if (intentApplied.current || props.intent === undefined) return;
    if (props.intent === 'edit' && permission.state === 'loading') return;
    intentApplied.current = true;
    if (props.intent === 'edit') {
      focusFirstField.current = true;
      setEditing(memberFormInitial(member, permission.state === 'ready' ? permission.canAddTickets : null));
    } else setConfirmingRemove(true);
    props.onIntentConsumed?.();
    // The menu intent is consumed exactly once per mounted member panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.intent, permission.state]);
  useEffect(() => {
    if (editing === null || !focusFirstField.current) return;
    focusFirstField.current = false;
    sectionRef.current?.querySelector<HTMLElement>('.teams-edit-form input, .teams-edit-form select, .teams-edit-form textarea')?.focus();
  }, [editing]);
  useEffect(() => { if (!focusTarget) return; const el = focusTarget === 'edit' ? editRef.current : focusTarget === 'confirm' ? confirmRemoveRef.current : removeRef.current; if (el?.isConnected && !el.disabled) { el.focus(); setFocusTarget(null); } }, [focusTarget, pending, editing]);
  useEffect(() => { if (confirmingRemove) cancelRemoveRef.current?.focus(); }, [confirmingRemove]);
  const catalogRole = member.roleState === 'undefined' || props.roleItems === null ? null : findCatalogRole(props.roleItems, member.role);
  const noticeRows = [MEMBER_DETAIL_TIMING_NOTE, memberSourceNote(member), uneditableNote(team), liveNote(team)].filter((note): note is string => note !== null);
  const removeTitleId = `${uid}-remove-title`;
  return <section className="teams-member-detail" aria-labelledby="teams-member-detail-title" ref={sectionRef}>
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
        <SectionCard title="Saved configuration (temporary)" className="teams-saved-configuration">
          {/* LEGACY: removed by "Member details v7 (5/5)" */}
          {editing ? <MemberForm key={memberId} mode="edit" heading={`Edit ${name}`} submitLabel="Save changes" cancelLabel="Discard changes" initial={editing} originalOptions={member.agentOptions} inlineContext={member.agentMode === 'inline' ? { provider: member.provider, model: member.model, reasoning: member.reasoning } : null} agents={agents} roles={formRoles} roleCatalogMessage={props.roleCatalogMessage} pending={props.pending} readOnly={props.readOnly === true} onSubmit={values => { const changes = memberChanges(editing, values); if (changes) void writes.updateMember(team, memberId, changes).then(ok => { if (ok) { setEditing(null); setFocusTarget('edit'); } }); }} onCancel={() => { setEditing(null); setFocusTarget('edit'); }} /> : <>
            <dl className="teams-member-settings"><dt>Name</dt><dd>{name}</dd><dt>Member id</dt><dd><code className="entity-id">{memberId}</code></dd><dt>Role</dt><dd>
              {catalogRole ? <><span className="teams-role-name">{catalogRole.name}</span> <code className="entity-id">{catalogRole.id}</code><p>{catalogRole.description ?? 'No description'}</p>{catalogRole.warnings.length > 0 && <ul aria-label="Role warnings">{catalogRole.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}{props.onViewRole && <button type="button" onClick={() => props.onViewRole?.(catalogRole.id)}>{`View ${catalogRole.name} in Roles`}</button>}</> : <>{roleText(member)}{roleNote(member) && <p>{roleNote(member)}</p>}{props.roleItems === null && props.roleCatalogMessage && <p>{props.roleCatalogMessage}</p>}{props.roleItems !== null && member.role !== null && canEditMember(team, member) && <p>Choose an existing role by editing this member.</p>}</>}
              <p>{ROLE_SHARING_NOTE}</p></dd><dt>Ticket permission</dt><dd>{ticketPermissionText(permission)} {permission.state === 'error' && <button type="button" onClick={() => setRetry(n => n + 1)}>Retry loading ticket permission</button>}</dd></dl>
            <h3 id="teams-member-agents-title">Agent options</h3><p className="panel-note">{SAVED_OPTIONS_NOTE}</p>
            {member.source === 'runtime' ? <p>Saved configuration is not available for runtime-only members.</p> : member.agentMode === 'inline' ? <><p>Inline agent — {providerModelText(member.provider, member.model)}{member.reasoning ? ` · Reasoning: ${member.reasoning}` : ''}</p><p>This member uses inline provider settings, not an Agents catalog entry. They stay unchanged unless you choose Use catalog agents while editing.</p></> : member.agentOptions.length === 0 ? <p>No saved agent options were returned.</p> : <ol className="teams-saved-options" aria-label="Saved agent options">{member.agentOptions.map((o, i) => <li key={`${o.id}-${i}`}><strong>{o.name ?? o.id}</strong>{o.name !== null && <> <code className="entity-id">{o.id}</code></>}{i === 0 && <> <span className="teams-option-default">{NEXT_START_DEFAULT}</span></>}{o.state === 'missing' && <> <span className="teams-option-missing">Missing from catalog</span></>} <span className="teams-saved-option-detail">{providerModelText(o.provider, o.model)}{o.reasoning ? ` · Reasoning: ${o.reasoning}` : ''}</span>{o.description !== null && <> <span className="teams-saved-option-detail">{o.description}</span></>}</li>)}</ol>}
            <p>Saved agents are defined in the Agents catalog.</p>
            {canEditMember(team, member) && <div className="teams-member-actions"><button ref={editRef} type="button" disabled={pending} onClick={() => setEditing(memberFormInitial(member, permission.state === 'ready' ? permission.canAddTickets : null))}>Edit saved configuration</button></div>}
          </>}
        </SectionCard>
        <SectionCard title="Live agent (temporary)" className="teams-live-actions-card">
          {/* LEGACY: removed by "Member details v7 (5/5)" */}
          {props.liveActions}
        </SectionCard>
      </div>
      <aside className="teams-member-aside" aria-label="Member status and actions">
        <MemberLiveStatusCard team={team} member={member} catalog={props.agents} connected={props.connected} inFlight={props.inFlight ?? null} />
        {canEditMember(team, member) && <section className="teams-member-remove" aria-labelledby={removeTitleId}>
          <div className="teams-member-remove-text"><h2 id={removeTitleId}>Remove member</h2><p>{`Stop the team before removing ${name}.`}</p></div>
          <div className="teams-member-remove-actions"><button ref={removeRef} type="button" aria-label={`Remove ${name}`} disabled={pending} onClick={() => setConfirmingRemove(true)}>Remove</button></div>
          {confirmingRemove && <div className="teams-confirm" role="alertdialog" aria-labelledby={`${uid}-remove-confirm-title`} aria-describedby={`${uid}-remove-desc`} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); setConfirmingRemove(false); setFocusTarget('remove'); } }}><h3 id={`${uid}-remove-confirm-title`}>Remove {name}?</h3><p id={`${uid}-remove-desc`}>Remove {name} ({memberId}) from {teamLabel(team)}? Only this member's saved settings are deleted; shared roles and Agents catalog entries are not changed.</p><button ref={confirmRemoveRef} type="button" aria-label={`Confirm remove ${name}`} disabled={pending} onClick={() => { void writes.removeMember(team, memberId).then(ok => { if (ok) props.onRemoved(); else setFocusTarget('confirm'); }); }}>Confirm remove</button><button ref={cancelRemoveRef} type="button" aria-label={`Cancel removing ${name}`} onClick={() => { setConfirmingRemove(false); setFocusTarget('remove'); }}>Cancel</button></div>}
        </section>}
      </aside>
    </div>
  </section>;
}
