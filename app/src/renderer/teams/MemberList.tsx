import type { JSX } from 'react';
import type { OverviewMember, OverviewTeam, RoleCatalogItem } from '../api';
import { memberIdentity, memberRoleSummary, memberAgentSummary, presenceLabel, presenceTone, teamLabel, workSummary } from './teamsModel';

export interface MemberListProps { team: OverviewTeam; roleItems: RoleCatalogItem[] | null; currentMemberId: string | null; rowRef(memberId: string, el: HTMLButtonElement | null): void; onOpen(memberId: string): void }
export function MemberList({ team, roleItems, currentMemberId, rowRef, onOpen }: MemberListProps): JSX.Element {
  if (!team.members.length) return <p className="panel-empty">This team has no members.</p>;
  function fields(m: OverviewMember): JSX.Element {
    const identity = memberIdentity(m), role = memberRoleSummary(m, roleItems), agent = memberAgentSummary(m);
    return <>
      <span className="teams-member-field" data-field="name"><span className="teams-member-name">{identity.name}</span>{identity.id && <code className="entity-id">{identity.id}</code>}{identity.note && <span className="teams-cell-note">{identity.note}</span>}</span>
      <span className="teams-member-field" data-field="role"><span className="teams-role-name">{role.label}</span>{role.roleId && <code className="entity-id">{role.roleId}</code>}{role.note && <span className="teams-cell-note">{role.note}</span>}</span>
      <span className="teams-member-field" data-field="agent"><span className={`teams-member-agent teams-member-agent-${agent.kind}`}>{agent.text}</span>{agent.note && <span className="teams-cell-note">{agent.note}</span>}</span>
      <span className="teams-member-field" data-field="availability"><span className={`status-badge teams-presence teams-tone-${presenceTone(m.presence)}`}><span className="status-dot" aria-hidden="true" />{presenceLabel(m.presence)}</span></span>
      <span className="teams-member-field" data-field="work">{workSummary(m.work)}</span>
    </>;
  }
  return <><div className="teams-member-list-head" aria-hidden="true"><span>Member</span><span>Role</span><span>Agent</span><span>Availability</span><span>Current work</span></div>
    <ul className="teams-member-list" aria-label={`Members of ${teamLabel(team)}`}>{team.members.map((m, i) => <li key={m.memberId ?? `index:${i}`}>{m.memberId !== null ? <button type="button" className="teams-member-row" ref={el => rowRef(m.memberId!, el)} aria-current={m.memberId === currentMemberId ? 'true' : undefined} onClick={() => onOpen(m.memberId!)}>{fields(m)}</button> : <div className="teams-member-row teams-member-row-static">{fields(m)}</div>}</li>)}</ul></>;
}
