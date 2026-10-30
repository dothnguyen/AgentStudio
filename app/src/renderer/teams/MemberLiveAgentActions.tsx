import type { JSX } from 'react';
import type { AgentDef, OverviewMember, OverviewTeam } from '../api';
import { memberAgentActions, type MemberActionInFlight } from './memberAgentActionsModel';

export interface MemberLiveAgentActionsProps {
  team: OverviewTeam; member: OverviewMember; catalog: AgentDef[] | null; connected: boolean;
  inFlight: MemberActionInFlight; polling: boolean; announce?: boolean;
  onSwitch(agentId: string, agentLabel: string, trigger: HTMLButtonElement): void;
  onResume(agentId: string, agentLabel: string): void;
}
export function MemberLiveAgentActions(props: MemberLiveAgentActionsProps): JSX.Element {
  const { team, member, inFlight, polling } = props;
  const view = memberAgentActions(team, member, props.catalog, props.connected, inFlight);
  return <section className="teams-live-actions" aria-label={`Live agent actions for ${member.name ?? member.memberId}`}>
    <h4>Live agent</h4>
    {!view.visible ? <p>Live controls are unavailable because this member has no running runtime record.</p> : <>
      <p>Active agent: <span>{view.activeText}</span></p><p>Availability: <span>{view.availabilityText}</span></p><p>Current assignment: <span>{view.assignmentText}</span></p>
      {view.pendingText && <p>{view.pendingText}</p>}{view.lastResultText && <p>{view.lastResultText}</p>}{view.notice && <p>{view.notice}</p>}
      {inFlight && !polling && <p role={props.announce === false ? undefined : 'status'}>Requesting…</p>}
      <h5>Live agent options — frozen at team start</h5>
      {member.runtime?.configuredAgents === null && <p>Live agent eligibility is unavailable.</p>}
      <ul>{view.options.map(option => <li key={option.id}><span>{option.label}{option.active && ' · Active'}{option.holdText && ` · ${option.holdText}`}</span>
        {!option.active && member.runtime?.configuredAgents?.includes(option.id) && <button type="button" disabled={!option.canSwitch || team.id === null || member.memberId === null} onClick={e => props.onSwitch(option.id, option.label, e.currentTarget)}>Switch</button>}
        {option.holdText && <button type="button" disabled={!option.canResume || team.id === null || member.memberId === null} onClick={() => props.onResume(option.id, option.label)}>Resume</button>}
        {option.disabledReason && !(polling && option.disabledReason === 'Requesting…') && <p className="teams-live-reason">{option.disabledReason}</p>}
      </li>)}</ul>
    </>}
  </section>;
}
