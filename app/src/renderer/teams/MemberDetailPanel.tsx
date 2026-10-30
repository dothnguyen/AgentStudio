import { useEffect, useId, useRef, useState, type JSX } from 'react';
import type { AgentDef, ManagementApi, OverviewMember, OverviewTeam, RoleCatalogItem } from '../api';
import { memberAgentActions, memberActionKey, type MemberActionInFlight } from './memberAgentActionsModel';
import { MemberForm } from './TeamEditForms';
import { canEditMember, findCatalogRole, memberChanges, memberFormInitial, thrownError, ticketPermissionText, uneditableNote, liveNote, MEMBER_TIMING_NOTE, ROLE_SHARING_NOTE, SAVED_OPTIONS_NOTE, LIVE_STATE_NOTE, type MemberFormValues, type TeamWrites, type TicketPermissionState } from './teamEditModel';
import { memberName, memberSourceNote, roleNote, roleText, savedAgentOptionText, providerModelText, liveAgentText, presenceLabel, workText, teamLabel } from './teamsModel';

export interface MemberDetailPanelProps {
  workspaceId: string; management: ManagementApi; savedRevision: number;
  team: OverviewTeam; member: OverviewMember; agents: AgentDef[] | null; roleItems: RoleCatalogItem[] | null; roleCatalogMessage: string | null;
  onViewRole?(roleId: string): void; writes: TeamWrites; pending: boolean; connected: boolean;
  actions: Record<string, MemberActionInFlight>; polling: Record<string, boolean>;
  onSwitch(team: OverviewTeam, member: OverviewMember, id: string, label: string, trigger: HTMLButtonElement): void;
  onResume(team: OverviewTeam, member: OverviewMember, id: string, label: string): void; onBack(): void; onRemoved(): void;
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
export function MemberDetailPanel(props: MemberDetailPanelProps): JSX.Element {
  const { team, member, agents, writes, pending } = props;
  const memberId = member.memberId!;
  const name = memberName(member);
  const uid = useId();
  const [editing, setEditing] = useState<MemberFormValues | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [retry, setRetry] = useState(0);
  const [focusTarget, setFocusTarget] = useState<'edit' | 'remove' | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null), editRef = useRef<HTMLButtonElement>(null), removeRef = useRef<HTMLButtonElement>(null), cancelRemoveRef = useRef<HTMLButtonElement>(null);
  const permission = useTicketPermission(props, retry);
  useEffect(() => { headingRef.current?.focus(); }, [member.memberId]);
  useEffect(() => { if (!focusTarget) return; const el = focusTarget === 'edit' ? editRef.current : removeRef.current; if (el?.isConnected && !el.disabled) { el.focus(); setFocusTarget(null); } }, [focusTarget, pending]);
  useEffect(() => { if (confirmingRemove) cancelRemoveRef.current?.focus(); }, [confirmingRemove]);
  const catalogRole = member.roleState === 'undefined' || props.roleItems === null ? null : findCatalogRole(props.roleItems, member.role);
  return <section className="teams-member-detail" aria-labelledby="teams-member-detail-title">
    <button type="button" className="teams-back-button" onClick={props.onBack}>Back to members</button>
    <nav className="breadcrumb" aria-label="Member location"><ol><li>{teamLabel(team)}</li><li>Members</li><li aria-current="page">{name}</li></ol></nav>
    <h3 id="teams-member-detail-title" ref={headingRef} tabIndex={-1}>{name}</h3>
    {[memberSourceNote(member), uneditableNote(team), liveNote(team)].map((note, i) => note && <p className="panel-note" key={i}>{note}</p>)}
    <h4 id="teams-member-settings-title">Member settings</h4>
    <dl className="teams-member-settings"><dt>Name</dt><dd>{name}</dd><dt>Member id</dt><dd><code className="entity-id">{memberId}</code></dd><dt>Role</dt><dd>
      {catalogRole ? <><span className="teams-role-name">{catalogRole.name}</span> <code className="entity-id">{catalogRole.id}</code><p>{catalogRole.description ?? 'No description'}</p>{catalogRole.warnings.length > 0 && <ul aria-label="Role warnings">{catalogRole.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}{props.onViewRole && <button type="button" onClick={() => props.onViewRole?.(catalogRole.id)}>{`View ${catalogRole.name} in Roles`}</button>}</> : <>{roleText(member)}{roleNote(member) && <p>{roleNote(member)}</p>}{props.roleItems === null && props.roleCatalogMessage && <p>{props.roleCatalogMessage}</p>}{props.roleItems !== null && member.role !== null && canEditMember(team, member) && <p>Choose an existing role by editing this member.</p>}</>}
      <p>{ROLE_SHARING_NOTE}</p></dd><dt>Ticket permission</dt><dd>{ticketPermissionText(permission)} {permission.state === 'error' && <button type="button" onClick={() => setRetry(n => n + 1)}>Retry loading ticket permission</button>}</dd></dl>
    <p className="panel-note">{MEMBER_TIMING_NOTE}</p>
    <h4 id="teams-member-agents-title">Saved agent options</h4><p className="panel-note">{SAVED_OPTIONS_NOTE}</p>
    {member.source === 'runtime' ? <p>Saved options are not available for runtime-only members.</p> : member.agentMode === 'inline' ? <><p>Inline agent — {providerModelText(member.provider, member.model)}{member.reasoning ? ` · Reasoning: ${member.reasoning}` : ''}</p><p>This member uses inline provider settings, not an Agents catalog entry. They stay unchanged unless you choose Use catalog agents while editing.</p></> : member.agentOptions.length === 0 ? <p>No saved agent options were returned.</p> : <ol aria-label="Saved agent options">{member.agentOptions.map((o, i) => <li key={`${o.id}-${i}`}>{savedAgentOptionText(o, i)}</li>)}</ol>}
    <p>Saved agents are defined in the Agents catalog.</p>
    <h4 id="teams-member-live-title">Live agent</h4><p>Active agent: {liveAgentText(member)}</p><p>Availability: {presenceLabel(member.presence)}</p><p>Current work: {workText(member.work)}</p><p className="panel-note">{LIVE_STATE_NOTE}</p>
    {(() => {
const view = memberAgentActions(team, member, agents, props.connected, memberId ? props.actions[memberActionKey(team.id ?? '', memberId)] ?? null : null);
                      if (!view.visible) return null;
                      return <section className="teams-live-actions" aria-label={`Live agent actions for ${name}`}><h4>Live agent actions</h4><p>{view.activeText}</p><p>{view.availabilityText}</p><p>{view.assignmentText}</p>{view.pendingText && <p>{view.pendingText}</p>}{view.lastResultText && <p>{view.lastResultText}</p>}{view.notice && <p>{view.notice}</p>}{memberId && props.actions[memberActionKey(team.id ?? '', memberId)] && !props.polling[memberActionKey(team.id ?? '', memberId)] && <p role="status">Requesting…</p>}<ul>{view.options.map(option => <li key={option.id}><span>{option.label}{option.active && ' · Active'}{option.holdText && ` · ${option.holdText}`}</span>{!option.active && member.runtime?.configuredAgents?.includes(option.id) && <button type="button" disabled={!option.canSwitch || !team.id || !memberId} onClick={e => props.onSwitch(team, member, option.id, option.label, e.currentTarget)}>Switch</button>}{option.holdText && <button type="button" disabled={!option.canResume || !team.id || !memberId} onClick={() => props.onResume(team, member, option.id, option.label)}>Resume</button>}{option.disabledReason && !(memberId && props.polling[memberActionKey(team.id ?? '', memberId)] && option.disabledReason === 'Requesting…') && <p className="teams-live-reason">{option.disabledReason}</p>}</li>)}</ul></section>;
    })()}
    {canEditMember(team, member) && <div className="teams-member-actions"><button ref={editRef} type="button" aria-label={`Edit ${name}`} disabled={pending || editing !== null} onClick={() => setEditing(memberFormInitial(member, permission.state === 'ready' ? permission.canAddTickets : null))}>Edit member</button><button ref={removeRef} type="button" aria-label={`Remove ${name}`} disabled={pending} onClick={() => setConfirmingRemove(true)}>Remove member</button></div>}
    {editing && <MemberForm key={memberId} mode="edit" heading={`Edit ${name}`} initial={editing} originalOptions={member.agentOptions} inlineContext={member.agentMode === 'inline' ? { provider: member.provider, model: member.model, reasoning: member.reasoning } : null} agents={agents} roles={props.roleItems} roleCatalogMessage={props.roleCatalogMessage} pending={pending} onSubmit={values => { const changes = memberChanges(editing, values); if (changes) void writes.updateMember(team, memberId, changes).then(ok => { if (ok) { setEditing(null); setFocusTarget('edit'); } }); }} onCancel={() => { setEditing(null); setFocusTarget('edit'); }} />}
    {confirmingRemove && <div className="teams-confirm" role="alertdialog" aria-labelledby={`${uid}-remove-title`} aria-describedby={`${uid}-remove-desc`} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); setConfirmingRemove(false); setFocusTarget('remove'); } }}><h4 id={`${uid}-remove-title`}>Remove {name}?</h4><p id={`${uid}-remove-desc`}>Remove {name} ({memberId}) from {teamLabel(team)}? Only this member's saved settings are deleted; shared roles and Agents catalog entries are not changed.</p><button type="button" aria-label={`Confirm remove ${name}`} disabled={pending} onClick={() => { void writes.removeMember(team, memberId).then(ok => { if (ok) props.onRemoved(); else { setConfirmingRemove(false); setFocusTarget('remove'); } }); }}>Confirm remove</button><button ref={cancelRemoveRef} type="button" aria-label={`Cancel removing ${name}`} onClick={() => { setConfirmingRemove(false); setFocusTarget('remove'); }}>Cancel</button></div>}
  </section>;
}
