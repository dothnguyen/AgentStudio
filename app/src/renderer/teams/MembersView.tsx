import { useEffect, useRef, useState, type JSX } from 'react';
import { MemberDetailPanel, type MemberDetailPanelProps } from './MemberDetailPanel';
import { MemberList } from './MemberList';
import { MemberForm } from './TeamEditForms';
import { canEditTeam, emptyMemberForm } from './teamEditModel';
import { missingMemberNotice, resolveMemberSelection, type MemberSelection } from './teamsModel';

export interface MembersViewProps extends Omit<MemberDetailPanelProps, 'member' | 'onBack'> { teamKey: string; selection: MemberSelection | null; onSelect(s: MemberSelection | null): void }
export function MembersView(props: MembersViewProps): JSX.Element {
  const { team, teamKey, selection, onSelect } = props;
  const [adding, setAdding] = useState(false);
  const [lost, setLost] = useState<string | null>(null);
  const [lastOpened, setLastOpened] = useState<string | null>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const focusOnReturn = useRef<string | null>(null);
  const result = resolveMemberSelection(team, teamKey, selection);
  useEffect(() => {
    if (result.state === 'missing') { setLost(result.memberId); onSelect(null); }
    else if (result.state === 'other-team') onSelect(null);
  }, [result.state, selection]);
  useEffect(() => { if (selection === null && focusOnReturn.current !== null) { rows.current.get(focusOnReturn.current)?.focus(); focusOnReturn.current = null; } }, [selection]);
  function open(id: string): void { setLost(null); setAdding(false); setLastOpened(id); onSelect({ teamKey, memberId: id }); }
  function back(): void { focusOnReturn.current = selection?.memberId ?? null; onSelect(null); }
  if (result.state === 'selected') return <MemberDetailPanel {...props} member={result.member} onBack={back} />;
  return <div className="teams-members-view">
    {lost !== null && <p className="panel-note" role="status">{missingMemberNotice(lost, team.membersTruncated)}</p>}
    {canEditTeam(team) && <div className="teams-members-actions"><button type="button" disabled={props.pending} onClick={() => setAdding(true)}>Add member</button></div>}
    {adding && <MemberForm mode="add" heading="Add member" initial={emptyMemberForm()} originalOptions={[]} inlineContext={null} agents={props.agents} roles={props.roleItems} roleCatalogMessage={props.roleCatalogMessage} pending={props.pending} onSubmit={values => { void props.writes.addMember(team, values).then(ok => { if (ok) setAdding(false); }); }} onCancel={() => setAdding(false)} />}
    <MemberList team={team} roleItems={props.roleItems} currentMemberId={lastOpened} rowRef={(id, el) => { if (el) rows.current.set(id, el); else rows.current.delete(id); }} onOpen={open} />
    {team.membersTruncated && <p className="panel-note">{`Showing the first ${team.members.length} members.`}</p>}
  </div>;
}
