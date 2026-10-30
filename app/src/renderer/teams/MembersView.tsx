import { useEffect, useId, useRef, useState, type JSX } from 'react';
import { MemberDetailPanel, type MemberDetailPanelProps } from './MemberDetailPanel';
import { MemberLiveAgentActions } from './MemberLiveAgentActions';
import { memberActionKey, type MemberActionInFlight } from './memberAgentActionsModel';
import type { OverviewMember, OverviewTeam } from '../api';
import { MemberList } from './MemberList';
import { MemberForm } from './TeamEditForms';
import { canEditTeam, emptyMemberForm } from './teamEditModel';
import { teamsPanelId } from './teamsViewModel';
import { availabilityCounts, filterMembers, missingMemberNotice, presenceLabel, resolveMemberSelection, type MemberSelection } from './teamsModel';

export interface MembersViewProps extends Omit<MemberDetailPanelProps, 'member' | 'onBack' | 'onRemoved' | 'liveActions'> { announce?: boolean; onNoticeChange?(active: boolean): void; actions: Record<string, MemberActionInFlight>; polling: Record<string, boolean>; onSwitch(team: OverviewTeam, member: OverviewMember, id: string, label: string, trigger: HTMLButtonElement): void; onResume(team: OverviewTeam, member: OverviewMember, id: string, label: string): void; teamKey: string; selection: MemberSelection | null; onSelect(s: MemberSelection | null): void; summary: JSX.Element }
export function MembersView(props: MembersViewProps): JSX.Element {
  const { team, teamKey, selection, onSelect } = props;
  const [adding, setAdding] = useState(false);
  const [lost, setLost] = useState<string | null>(null);
  const [lastOpened, setLastOpened] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [availability, setAvailability] = useState<string | null>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const [returnFocus, setReturnFocus] = useState<{ memberId: string | null } | 'add' | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const result = resolveMemberSelection(team, teamKey, selection);
  const counts = availabilityCounts(team.members);
  const filtered = filterMembers(team.members, props.roleItems, { query, availability });
  const filtersActive = query.trim() !== '' || availability !== null;
  const headingId = useId();
  useEffect(() => { if (availability !== null && !team.members.some(m => m.presence === availability)) setAvailability(null); }, [team.members, availability]);
  useEffect(() => { props.onNoticeChange?.(lost !== null && result.state !== 'selected'); return () => props.onNoticeChange?.(false); }, [lost, result.state, props.onNoticeChange]);
  useEffect(() => {
    if (result.state === 'missing') { setLost(result.memberId); setReturnFocus({ memberId: null }); onSelect(null); }
    else if (result.state === 'other-team') onSelect(null);
  }, [result.state, selection]);
  useEffect(() => { if (selection !== null || returnFocus === null) return; const target = returnFocus === 'add' ? addRef.current : returnFocus.memberId === null ? null : rows.current.get(returnFocus.memberId); if (target?.disabled) return; (target ?? document.getElementById(headingId) ?? document.getElementById(teamsPanelId('overview')))?.focus(); setReturnFocus(null); }, [selection, returnFocus, props.pending, props.readOnly, filtered]);
  function open(id: string): void { setLost(null); setAdding(false); setLastOpened(id); onSelect({ teamKey, memberId: id }); }
  function back(): void { setReturnFocus({ memberId: selection?.memberId ?? null }); onSelect(null); }
  function removed(): void { setReturnFocus(canEditTeam(team) ? 'add' : { memberId: null }); onSelect(null); }
  if (result.state === 'selected') return <MemberDetailPanel key={result.member.memberId} {...props} member={result.member} liveActions={<MemberLiveAgentActions team={team} member={result.member} catalog={props.agents} connected={props.connected} announce={props.announce} inFlight={props.actions[memberActionKey(team.id ?? '', result.member.memberId ?? '')] ?? null} polling={!!props.polling[memberActionKey(team.id ?? '', result.member.memberId ?? '')]} onSwitch={(id, label, trigger) => props.onSwitch(team, result.member, id, label, trigger)} onResume={(id, label) => props.onResume(team, result.member, id, label)} />} onBack={back} onRemoved={removed} />;
  const empty = team.members.length === 0;
  return <div className="teams-members teams-members-view">
    {props.summary}
    <section className="teams-roster" aria-labelledby={headingId}>
      <h3 id={headingId} tabIndex={-1}>Members</h3>
      {lost !== null && <p className="panel-note" role={props.announce === false ? undefined : 'status'}>{missingMemberNotice(lost, team.membersTruncated)}</p>}
      {canEditTeam(team) && <div className="teams-members-actions"><button ref={addRef} type="button" disabled={props.pending || props.readOnly === true || adding} onClick={() => setAdding(true)}>Add member</button></div>}
      {adding && <MemberForm mode="add" heading="Add member" initial={emptyMemberForm()} originalOptions={[]} inlineContext={null} agents={props.agentsFresh === false ? null : props.agents} roles={props.rolesFresh === false ? null : props.roleItems} roleCatalogMessage={props.roleCatalogMessage} pending={props.pending} readOnly={props.readOnly === true} onSubmit={values => { void props.writes.addMember(team, values).then(ok => { if (ok) { setAdding(false); setReturnFocus('add'); } }); }} onCancel={() => { setAdding(false); setReturnFocus('add'); }} />}
      <div className="teams-member-filters">
        <label className="teams-member-filter"><span>Search members</span><input type="search" value={query} placeholder="Name, role, agent, or current work" onChange={e => setQuery(e.target.value)} /></label>
        <label className="teams-member-filter"><span>Availability</span><select value={availability ?? ''} onChange={e => setAvailability(e.target.value === '' ? null : e.target.value)}><option value="">All availability</option>{counts.map(c => <option key={c.presence} value={c.presence}>{`${presenceLabel(c.presence)} (${c.count})`}</option>)}</select></label>
        {filtersActive && <button type="button" className="teams-member-filter-clear" onClick={() => { setQuery(''); setAvailability(null); }}>Clear filters</button>}
      </div>
      {empty ? <p className="panel-empty">This team has no members.</p> : filtered.length === 0 && <p className="panel-empty">No returned members match the current filters.</p>}
      {filtered.length > 0 && <MemberList team={team} members={filtered} roleItems={props.roleItems} currentMemberId={lastOpened} rowRef={(id, el) => { if (el) rows.current.set(id, el); else rows.current.delete(id); }} onOpen={open} />}
      {team.membersTruncated && <p className="panel-note">{`Showing ${filtered.length} of ${team.members.length} returned members. More members may exist; filters apply only to returned members.`}</p>}
    </section>
  </div>;
}
