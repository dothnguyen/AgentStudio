import { useId, type JSX } from 'react';
import type { AgentDef, OverviewMember, OverviewTeam } from '../api';
import { memberAgentActions, type AgentActionState, type MemberActionInFlight } from './memberAgentActionsModel';

export interface MemberLiveAgentActionsProps {
  team: OverviewTeam; member: OverviewMember; catalog: AgentDef[] | null; connected: boolean;
  inFlight: MemberActionInFlight; polling: boolean; announce?: boolean;
  onSwitch(agentId: string, agentLabel: string, trigger: HTMLButtonElement): void;
  onResume(agentId: string, agentLabel: string): void;
}
const STATE_TEXT: Record<AgentActionState, string> = { active: 'Active', switchable: 'Available', held: 'On quota hold', missing_catalog: 'Missing from catalog', pending: 'Pending', pane_dead: 'Unavailable', ineligible: 'Unavailable' };
export function MemberLiveAgentActions(props: MemberLiveAgentActionsProps): JSX.Element {
  const { team, member, inFlight, polling } = props;
  const headingId = useId();
  const view = memberAgentActions(team, member, props.catalog, props.connected, inFlight);
  const inline = member.agentMode === 'inline' || member.source === 'inline';
  const frozen = inline ? null : member.runtime?.configuredAgents ?? null;
  return <section className="teams-live-actions" aria-labelledby={`${headingId} ${headingId}-for`}>
    <h3 id={headingId}>Live</h3><span id={`${headingId}-for`} hidden>for {member.name ?? member.memberId}</span>
    {!view.visible ? <p>Live state is unavailable because this member has no running runtime record.</p> : <>
      <dl className="teams-live-summary">
        <dt>Active agent</dt><dd>{view.activeText}</dd>
        <dt>Availability</dt><dd>{view.availabilityText}</dd>
        <dt>Pane</dt><dd>{view.paneText}</dd>
        <dt>Current assignment</dt><dd>{view.assignmentText}</dd>
        {view.workText !== null && <><dt>Current ticket or work</dt><dd>{view.workText}</dd></>}
      </dl>
      {view.staleText && <p className="panel-note">{view.staleText}</p>}
      {view.pendingText && <p>{view.pendingText}</p>}{view.lastResultText && <p>{view.lastResultText}</p>}{view.notice && <p>{view.notice}</p>}
      {inFlight && !polling && <p role={props.announce === false ? undefined : 'status'}>Requesting…</p>}
      {view.options.length > 0 && <>
        <h4>Live agent options — frozen at team start</h4>
        <ul className="teams-live-options">{view.options.map(option => <li key={option.id}>
          <span className="teams-live-option-label">{option.label} · {STATE_TEXT[option.state]}{option.holdText && ` · ${option.holdText}`}</span>
          <span className="teams-live-option-actions">
            {!option.active && frozen !== null && frozen.includes(option.id) && <button type="button" disabled={!option.canSwitch || team.id === null || member.memberId === null} onClick={e => props.onSwitch(option.id, option.label, e.currentTarget)}>Switch</button>}
            {option.holdText && <button type="button" disabled={!option.canResume || team.id === null || member.memberId === null} onClick={() => props.onResume(option.id, option.label)}>Resume</button>}
          </span>
          {option.disabledReason && option.disabledReason !== 'Requesting…' && <p className="teams-live-reason">{option.disabledReason}</p>}
        </li>)}</ul>
      </>}
    </>}
  </section>;
}
