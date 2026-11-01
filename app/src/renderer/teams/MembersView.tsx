import { useEffect, useId, useRef, useState, type JSX } from 'react';
import { MemberDetailPanel, type MemberDetailPanelProps } from './MemberDetailPanel';
import { MemberLiveAgentActions } from './MemberLiveAgentActions';
import { memberActionKey, type MemberActionInFlight } from './memberAgentActionsModel';
import type { AttentionRun, BlockedTicket, OverviewMember, OverviewTeam, TeamAttention } from '../api';
import { Icon } from '../icons/Icon';
import { MemberList, type MemberListActions } from './MemberList';
import { MemberForm } from './TeamEditForms';
import { canEditTeam, emptyMemberForm } from './teamEditModel';
import type { BoardStatus } from './teamActionsModel';
import { teamsPanelId } from './teamsViewModel';
import { filterMembers, missingMemberNotice, resolveMemberSelection, type MemberSelection } from './teamsModel';

export interface MembersViewProps extends Omit<MemberDetailPanelProps, 'member' | 'onBack' | 'onRemoved' | 'liveActions'> {
  announce?: boolean;
  onNoticeChange?(active: boolean): void;
  actions: Record<string, MemberActionInFlight>;
  polling: Record<string, boolean>;
  onSwitch(team: OverviewTeam, member: OverviewMember, id: string, label: string, trigger: HTMLButtonElement): void;
  onResume(team: OverviewTeam, member: OverviewMember, id: string, label: string): void;
  teamKey: string;
  selection: MemberSelection | null;
  onSelect(s: MemberSelection | null): void;
  summary: JSX.Element;
  attention: TeamAttention;
  blockedTickets: readonly BlockedTicket[];
  boardStatuses: readonly BoardStatus[] | null;
  memberActions: MemberListActions;
  copy(text: string, label: string): void;
}
export function MembersView(props: MembersViewProps): JSX.Element {
  const { team, teamKey, selection, onSelect } = props;
  const [adding, setAdding] = useState(false);
  const [lost, setLost] = useState<string | null>(null);
  const [lastOpened, setLastOpened] = useState<string | null>(null);
  const [intent, setIntent] = useState<'edit' | 'remove' | null>(null);
  const [query, setQuery] = useState('');
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const [returnFocus, setReturnFocus] = useState<{ memberId: string | null } | 'add' | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const result = resolveMemberSelection(team, teamKey, selection);
  const filtered = filterMembers(team.members, props.roleItems, props.agents, query);
  const filterActive = query.trim() !== '';
  const headingId = useId();
  useEffect(() => { props.onNoticeChange?.(lost !== null && result.state !== 'selected'); return () => props.onNoticeChange?.(false); }, [lost, result.state, props.onNoticeChange]);
  useEffect(() => {
    if (result.state === 'missing') { setLost(result.memberId); setReturnFocus({ memberId: null }); onSelect(null); }
    else if (result.state === 'other-team') onSelect(null);
  }, [result.state, selection]);
  useEffect(() => { if (selection !== null || returnFocus === null) return; const target = returnFocus === 'add' ? addRef.current : returnFocus.memberId === null ? null : rows.current.get(returnFocus.memberId); if (target?.disabled) return; (target ?? document.getElementById(headingId) ?? document.getElementById(teamsPanelId('overview')))?.focus(); setReturnFocus(null); }, [selection, returnFocus, props.pending, props.readOnly, filtered]);
  function open(id: string, nextIntent?: 'edit' | 'remove'): void { setLost(null); setAdding(false); setLastOpened(id); setIntent(nextIntent ?? null); onSelect({ teamKey, memberId: id }); }
  function back(): void { setReturnFocus({ memberId: selection?.memberId ?? null }); setIntent(null); onSelect(null); }
  function removed(): void { setReturnFocus(canEditTeam(team) ? 'add' : { memberId: null }); setIntent(null); onSelect(null); }
  if (result.state === 'selected') return <MemberDetailPanel key={result.member.memberId} {...props} member={result.member} intent={intent ?? undefined} onIntentConsumed={() => setIntent(null)} liveActions={<MemberLiveAgentActions team={team} member={result.member} catalog={props.agents} connected={props.connected} announce={props.announce} inFlight={props.actions[memberActionKey(team.id ?? '', result.member.memberId ?? '')] ?? null} polling={!!props.polling[memberActionKey(team.id ?? '', result.member.memberId ?? '')]} onSwitch={(id, label, trigger) => props.onSwitch(team, result.member, id, label, trigger)} onResume={(id, label) => props.onResume(team, result.member, id, label)} />} onBack={back} onRemoved={removed} />;
  const empty = team.members.length === 0;
  return <div className="teams-members teams-members-view">
    {props.summary}
    <section className="teams-roster teams-members-card" aria-labelledby={headingId}>
      <div className="teams-members-head">
        <div className="teams-members-title"><h3 id={headingId} tabIndex={-1}>Members</h3><span className="teams-members-count">{team.membersTruncated ? `${team.members.length}+` : String(team.members.length)}</span></div>
        <div className="teams-members-tools">
          <label className="teams-members-filter"><Icon name="search" size={14} /><span className="teams-visually-hidden">Filter members</span><input type="search" value={query} placeholder="Filter members" onChange={e => setQuery(e.target.value)} /></label>
          {filterActive && <button type="button" className="teams-members-clear" onClick={() => setQuery('')}>Clear filter</button>}
          {canEditTeam(team) && <button ref={addRef} type="button" className="teams-members-add" disabled={props.pending || props.readOnly === true || adding} onClick={() => setAdding(true)}><Icon name="plus" size={13} />Add member</button>}
        </div>
      </div>
      {lost !== null && <p className="panel-note teams-members-note" role={props.announce === false ? undefined : 'status'}>{missingMemberNotice(lost, team.membersTruncated)}</p>}
      {adding && <div className="teams-members-inline"><MemberForm mode="add" heading="Add member" initial={emptyMemberForm()} originalOptions={[]} inlineContext={null} agents={props.agentsFresh === false ? null : props.agents} roles={props.rolesFresh === false ? null : props.roleItems} roleCatalogMessage={props.roleCatalogMessage} pending={props.pending} readOnly={props.readOnly === true} onSubmit={values => { void props.writes.addMember(team, values).then(ok => { if (ok) { setAdding(false); setReturnFocus('add'); } }); }} onCancel={() => { setAdding(false); setReturnFocus('add'); }} /></div>}
      {empty ? <p className="panel-empty teams-members-note">This team has no members.</p> : filtered.length === 0 && <p className="panel-empty teams-members-note">No returned members match the current filters.</p>}
      {filtered.length > 0 && <MemberList
        team={team}
        members={filtered}
        roleItems={props.roleItems}
        agents={props.agents}
        currentMemberId={lastOpened}
        rowRef={(id, el) => { if (el) rows.current.set(id, el); else rows.current.delete(id); }}
        onOpen={open}
        attention={props.attention}
        blockedTickets={props.blockedTickets}
        boardStatuses={props.boardStatuses}
        pending={props.pending}
        readOnly={props.readOnly === true}
        connected={props.connected && props.readOnly !== true}
        actions={props.actions}
        onSwitch={props.onSwitch}
        onResume={props.onResume}
        memberActions={props.memberActions}
        copy={props.copy}
        onViewRole={props.onViewRole}
      />}
      {team.membersTruncated && <p className="panel-note teams-members-note teams-members-truncated">{`Showing ${filtered.length} of ${team.members.length} returned members. More members may exist; filters apply only to returned members.`}</p>}
    </section>
  </div>;
}
