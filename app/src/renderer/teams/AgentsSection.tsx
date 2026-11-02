import { useId, useMemo, useState, type JSX } from 'react';
import type { AgentDef, OverviewMember, OverviewTeam } from '../api';
import { Icon } from '../icons/Icon';
import { SectionCard } from './SectionCard';
import { AgentOptionsDialog } from './AgentOptionsDialog';
import { memberAgentActions, REMOVED_NOTE, type MemberActionInFlight } from './memberAgentActionsModel';
import {
  AGENT_DIFFERS_NOTE, INLINE_AGENT_EXPLANATION, NO_RUNTIME_NOTE, NO_SAVED_OPTIONS_NOTE,
  inlineAgentSummary, liveAgentRow, liveDiffersFromDefault, savedAgentRows,
} from './agentOptionsModel';
import { memberName } from './teamsModel';
import { canEditMember, type TeamWrites } from './teamEditModel';

export interface AgentsSectionProps {
  team: OverviewTeam;
  member: OverviewMember;
  /** Agents catalog, or null while it is unavailable or stale. */
  catalog: AgentDef[] | null;
  connected: boolean;
  /** In-flight live-agent action for this member. */
  inFlight: MemberActionInFlight;
  polling: boolean;
  announce?: boolean;
  pending: boolean;
  readOnly: boolean;
  writes: TeamWrites;
  onSwitch(agentId: string, agentLabel: string, trigger: HTMLButtonElement): void;
  onResume(agentId: string, agentLabel: string): void;
  onManageAgents?(): void;
}

/**
 * The v7 Agents card: the live switch list plus the button that opens the
 * saved-options dialog. The live rows are the `options` of
 * `memberAgentActions`, built by `memberAgentActionRows` — the same model the
 * legacy live section and the row actions menu use.
 */
export function AgentsSection(props: AgentsSectionProps): JSX.Element {
  const { team, member, catalog, inFlight, polling } = props;
  const uid = useId();
  const [dialogOpen, setDialogOpen] = useState(false);
  const inline = member.agentMode === 'inline' || member.source === 'inline';
  const runtimeVisible = !inline && member.runtime !== null && member.presence !== 'not_in_runtime' && team.runtime.state === 'running';
  const view = useMemo(
    () => memberAgentActions(team, member, catalog, props.connected, inFlight),
    [team, member, catalog, props.connected, inFlight],
  );
  const options = runtimeVisible ? view.options : [];
  const saved = useMemo(() => savedAgentRows(member, catalog), [member, catalog]);
  const inlineAgent = inlineAgentSummary(member);
  const name = memberName(member);
  const editable = canEditMember(team, member) && !props.readOnly;
  const switchDisabled = team.id === null || member.memberId === null;

  const rows = runtimeVisible && options.length > 0
    ? <ol className="teams-agents-list" aria-label="Live agent options">{options.map(option => {
      const row = liveAgentRow(option, member, catalog);
      const reason = !option.active && option.disabledReason !== null && option.disabledReason !== 'Requesting…' ? option.disabledReason : null;
      const reasonId = `${uid}-${option.id}-reason`;
      return (
        <li key={option.id} className={`teams-agent-row${option.active ? ' is-active' : ''}`}>
          <span className="teams-agent-mark" aria-hidden="true">{row.mark}</span>
          <span className="teams-agent-text">
            <span className="teams-agent-name">
              {row.name}
              {row.isDefault && <span className="teams-agent-tag is-default">Default</span>}
              {option.active && <span className="teams-agent-tag is-live">Live</span>}
              {option.state === 'not_live' && <span className="teams-agent-tag is-not-live">Not live yet</span>}
              {option.state === 'removed' && <span className="teams-agent-tag is-removed">Removed</span>}
              {row.missing && <span className="teams-agent-tag is-missing">Missing from catalog</span>}
            </span>
            <span className="teams-agent-meta">{row.meta}</span>
            {option.state === 'removed' && <span className="teams-agent-reason">{REMOVED_NOTE}</span>}
            {option.holdText !== null && <span className="teams-agent-hold">{option.holdText}</span>}
            {reason !== null && <span className="teams-agent-reason" id={reasonId}>{reason}</span>}
          </span>
          <span className="teams-agent-actions">
            {option.active && <span className="teams-agent-active"><Icon name="check" size={14} />Active</span>}
            {!option.active && <button
              type="button"
              className="teams-agent-switch"
              aria-label={`Switch live agent to ${row.name}`}
              aria-describedby={reason !== null ? reasonId : undefined}
              disabled={!option.canSwitch || switchDisabled}
              onClick={event => props.onSwitch(option.id, row.name, event.currentTarget)}
            >Switch</button>}
            {option.holdText !== null && <button
              type="button"
              className="teams-agent-resume"
              aria-label={`Resume agent ${row.name}`}
              disabled={!option.canResume || switchDisabled}
              onClick={() => props.onResume(option.id, row.name)}
            >Resume</button>}
          </span>
        </li>
      );
    })}</ol>
    : null;

  const savedList = saved.length === 0
    ? null
    : <ol className="teams-agents-list" aria-label="Saved agent options">{saved.map(row => (
      <li key={row.id} className="teams-agent-row">
        <span className="teams-agent-mark" aria-hidden="true">{row.mark}</span>
        <span className="teams-agent-text">
          <span className="teams-agent-name">
            {row.name}
            {row.isDefault && <span className="teams-agent-tag is-default">Default</span>}
            {row.missing && <span className="teams-agent-tag is-missing">Missing from catalog</span>}
          </span>
          <span className="teams-agent-meta">{row.meta}</span>
        </span>
      </li>
    ))}</ol>;

  return <>
    <SectionCard
      title="Agents"
      subtitle={`The agent working as ${name} now, and the options offered at team start.`}
      action={editable ? {
        label: 'Edit options',
        ariaLabel: 'Edit agent options',
        disabled: props.pending,
        onClick: () => setDialogOpen(true),
      } : undefined}
      className="teams-agents-card"
    >
      {inline ? <>
        <ol className="teams-agents-list" aria-label="Inline agent">
          <li className="teams-agent-row">
            <span className="teams-agent-mark" aria-hidden="true">{inlineAgent.mark}</span>
            <span className="teams-agent-text">
              <span className="teams-agent-name">{inlineAgent.name}</span>
              <span className="teams-agent-meta">{inlineAgent.meta}</span>
            </span>
          </li>
        </ol>
        <p className="teams-agents-note">{INLINE_AGENT_EXPLANATION}</p>
      </> : !runtimeVisible ? <>
        {savedList ?? <p className="teams-agents-empty">{NO_SAVED_OPTIONS_NOTE}</p>}
        <p className="teams-agents-note">{NO_RUNTIME_NOTE}</p>
      </> : <>
        {rows}
        {options.length === 0 && <>
          {savedList}
          <p className="teams-agents-empty">{view.notice ?? NO_SAVED_OPTIONS_NOTE}</p>
        </>}
        {inFlight && !polling && <p className="teams-agents-status" role={props.announce === false ? undefined : 'status'}>Requesting…</p>}
      </>}
      {runtimeVisible && liveDiffersFromDefault(member) && <div className="teams-agents-diff">
        <Icon name="warning" size={14} />
        <span>{AGENT_DIFFERS_NOTE}</span>
      </div>}
    </SectionCard>
    {dialogOpen && <AgentOptionsDialog
      team={team}
      member={member}
      catalog={catalog}
      pending={props.pending}
      readOnly={props.readOnly}
      writes={props.writes}
      onManageAgents={props.onManageAgents}
      onClose={() => setDialogOpen(false)}
      onSaved={() => setDialogOpen(false)}
    />}
  </>;
}
