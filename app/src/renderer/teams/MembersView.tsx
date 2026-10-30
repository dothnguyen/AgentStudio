import { useEffect, useRef, useState, type JSX } from 'react';
import { MemberDetailPanel, type MemberDetailPanelProps } from './MemberDetailPanel';
import { MemberList } from './MemberList';
import { MemberForm } from './TeamEditForms';
import { canEditTeam, emptyMemberForm } from './teamEditModel';
import { teamsPanelId } from './teamsViewModel';
import { missingMemberNotice, resolveMemberSelection, type MemberSelection } from './teamsModel';

export interface MembersViewProps extends Omit<MemberDetailPanelProps, 'member' | 'onBack' | 'onRemoved'> { teamKey: string; selection: MemberSelection | null; onSelect(s: MemberSelection | null): void }
export function MembersView(props: MembersViewProps): JSX.Element {
  const { team, teamKey, selection, onSelect } = props;
  const [adding, setAdding] = useState(false);
  const [lost, setLost] = useState<string | null>(null);
  const [lastOpened, setLastOpened] = useState<string | null>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const [returnFocus, setReturnFocus] = useState<{ memberId: string | null } | 'add' | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const result = resolveMemberSelection(team, teamKey, selection);
  useEffect(() => {
    if (result.state === 'missing') { setLost(result.memberId); onSelect(null); }
    else if (result.state === 'other-team') onSelect(null);
  }, [result.state, selection]);
  useEffect(() => { if (selection !== null || returnFocus === null) return; const target = returnFocus === 'add' ? addRef.current : returnFocus.memberId === null ? null : rows.current.get(returnFocus.memberId); if (target?.disabled) return; (target ?? document.getElementById(teamsPanelId('members')))?.focus(); setReturnFocus(null); }, [selection, returnFocus, props.pending]);
  function open(id: string): void { setLost(null); setAdding(false); setLastOpened(id); onSelect({ teamKey, memberId: id }); }
  function back(): void { setReturnFocus({ memberId: selection?.memberId ?? null }); onSelect(null); }
  function removed(): void { setReturnFocus({ memberId: null }); onSelect(null); }
  if (result.state === 'selected') return <MemberDetailPanel key={result.member.memberId} {...props} member={result.member} onBack={back} onRemoved={removed} />;
  return <div className="teams-members-view">
    {lost !== null && <p className="panel-note" role="status">{missingMemberNotice(lost, team.membersTruncated)}</p>}
    {canEditTeam(team) && <div className="teams-members-actions"><button ref={addRef} type="button" disabled={props.pending || adding} onClick={() => setAdding(true)}>Add member</button></div>}
    {adding && <MemberForm mode="add" heading="Add member" initial={emptyMemberForm()} originalOptions={[]} inlineContext={null} agents={props.agents} roles={props.roleItems} roleCatalogMessage={props.roleCatalogMessage} pending={props.pending} onSubmit={values => { void props.writes.addMember(team, values).then(ok => { if (ok) { setAdding(false); setReturnFocus('add'); } }); }} onCancel={() => { setAdding(false); setReturnFocus('add'); }} />}
    <MemberList team={team} roleItems={props.roleItems} currentMemberId={lastOpened} rowRef={(id, el) => { if (el) rows.current.set(id, el); else rows.current.delete(id); }} onOpen={open} />
    {team.membersTruncated && <p className="panel-note">{`Showing the first ${team.members.length} members.`}</p>}
  </div>;
}
