import type { JSX } from 'react';
import type { AgentDef, OverviewMember, OverviewTeam, RoleCatalogItem } from '../api';
import { Icon } from '../icons/Icon';
import { memberIdentity, memberInitials, memberLiveAgent, memberRoleSummary, memberRowWork, presenceLabel, presenceTone, teamLabel } from './teamsModel';

export interface MemberListProps { team: OverviewTeam; members: readonly OverviewMember[]; roleItems: RoleCatalogItem[] | null; agents: AgentDef[] | null; currentMemberId: string | null; rowRef(memberId: string, el: HTMLButtonElement | null): void; onOpen(memberId: string): void }
export function MemberList({ team, members, roleItems, agents, currentMemberId, rowRef, onOpen }: MemberListProps): JSX.Element {
  function cells(m: OverviewMember): JSX.Element {
    const identity = memberIdentity(m), role = memberRoleSummary(m, roleItems), live = memberLiveAgent(m, agents), work = memberRowWork(m.work);
    return <>
      <span className="teams-member-field teams-member-cell" data-field="name">
        <span className="teams-member-avatar" aria-hidden="true">{memberInitials(identity.name)}</span>
        <span className="teams-member-ident">
          <span className="teams-member-name">{identity.name}</span>
          {m.memberId !== null && <code className="teams-member-id">{m.memberId}</code>}
          {identity.note && <span className="teams-cell-note">{identity.note}</span>}
        </span>
      </span>
      <span className="teams-member-field" data-field="role"><span className="teams-role-chip">{role.label}</span>{role.roleId && <code className="teams-member-id">{role.roleId}</code>}{role.note && <span className="teams-cell-note">{role.note}</span>}</span>
      <span className={`teams-member-field teams-member-agent teams-member-agent-${live.kind}`} data-field="agent">
        <span className="teams-member-agent-line">
          <span className="teams-member-agent-name" data-part="agent-name">{live.name}</span>
          {live.switched && <span className="teams-switched-tag" data-part="agent-switched">Switched</span>}
        </span>
        {live.meta && <span className="teams-member-agent-meta" data-part="agent-meta">{live.meta}</span>}
        {live.note && <span className="teams-cell-note" data-part="agent-note">{live.note}</span>}
      </span>
      <span className={`teams-member-field teams-member-status teams-tone-${presenceTone(m.presence)}`} data-field="availability"><span className="status-dot" aria-hidden="true" />{presenceLabel(m.presence)}</span>
      <span className={`teams-member-field teams-member-work${work.muted ? ' teams-member-work-muted' : ''}`} data-field="work">{work.text}</span>
      <Icon name="chevron-right" size={16} className="teams-member-chevron" />
    </>;
  }
  return <div className="teams-members-scroll"><div className="teams-members-table">
    <div className="teams-member-list-head" aria-hidden="true"><span>Member</span><span>Role</span><span>Live agent</span><span>Status</span><span>Current work</span><span /></div>
    <ul className="teams-member-list" aria-label={`Members of ${teamLabel(team)}`}>{members.map((m, i) => <li key={m.memberId ?? `index:${i}`}>{m.memberId !== null ? <button type="button" className="teams-member-row" data-member-row={m.memberId} ref={el => rowRef(m.memberId!, el)} aria-current={m.memberId === currentMemberId ? 'true' : undefined} onClick={() => onOpen(m.memberId!)}>{cells(m)}</button> : <div className="teams-member-row teams-member-row-static">{cells(m)}</div>}</li>)}</ul>
  </div></div>;
}
