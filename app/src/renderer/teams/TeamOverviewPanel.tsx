import type { JSX } from 'react';
import type { BoardSettings, OverviewTeam, TeamOverview } from '../api';
import type { DashboardSectionController } from '../dashboard/useDashboardSection';
import { boardControlView, type BoardAction } from './boardControlModel';
import { liveNote, uneditableNote } from './teamEditModel';
import {
  RUNTIME_LABELS,
  availabilityCounts,
  coordinatorText,
  definitionStateText,
  liveStateText,
  memberCountText,
  runtimeTone,
  teamLabel,
} from './teamsModel';
import { SectionError } from './SectionError';

export interface BoardControlProps {
  team: OverviewTeam;
  section: DashboardSectionController<BoardSettings>;
  connected: boolean;
  action: BoardAction | null;
  pending: boolean;
  lastSettings?: BoardSettings | null;
  alert?: boolean;
  /** False when another live region already announces pending state. */
  announce?: boolean;
  onRetry?(): void;
  onRun(team: OverviewTeam): void;
  onStop(team: OverviewTeam): void;
}

export function BoardControl(props: BoardControlProps): JSX.Element {
  const { team, section, connected, action, pending, onRun, onStop } = props;
  const settings = section.data ?? props.lastSettings ?? null;
  const stale = settings !== null && (section.state !== 'ready' || section.data === null);
  const view = settings === null ? null : boardControlView(team, settings.runner, connected && !stale);
  return (
    <section className="teams-board" aria-labelledby="teams-board-title">
      <h2 id="teams-board-title" tabIndex={-1}>Board</h2>
      {section.state === 'loading' && <p className="panel-loading" role={props.announce === false ? undefined : 'status'}>{stale ? 'Refreshing board state… Showing previously loaded data.' : 'Loading board state…'}</p>}
      {section.state === 'error' && <SectionError section={section} alert={props.alert} label="Board" stale={stale} retryId="teams-retry-board" onRetry={props.onRetry} />}
      {view !== null && (
        <>
          <p className={`status-badge teams-board-status teams-tone-${view.tone}`}>
            <span className="status-dot" aria-hidden="true" />
            {view.status}
          </p>
          {view.detail !== null && <p className="panel-note">{view.detail}</p>}
          {view.runHint !== null && <p className="panel-note">{view.runHint}</p>}
          <div className="teams-board-actions">
            <button type="button" disabled={pending || !view.canRun} onClick={() => onRun(team)}>Run board</button>
            <button type="button" disabled={pending || !view.canStop} onClick={() => onStop(team)}>Stop board</button>
          </div>
        </>
      )}
      {action !== null && (
        <p className="panel-loading" role={props.announce === false || section.state === 'loading' ? undefined : 'status'}>{action === 'run' ? 'Starting board…' : 'Stopping board…'}</p>
      )}
    </section>
  );
}


export function TeamStatusSummary(props: { team: OverviewTeam; overview: TeamOverview; stale: boolean }): JSX.Element {
  const { team, overview } = props;
  const coordinator = coordinatorText(overview);
  const live = liveStateText(overview);
  return (
    <section className="teams-summary-card" aria-labelledby="teams-status-title">
      <h2 id="teams-status-title">Team status</h2>
      <p className="teams-summary-name">{teamLabel(team)}</p>
      <p className={`status-badge teams-runtime teams-tone-${runtimeTone(team.runtime.state)}`}>
        <span className="status-dot" aria-hidden="true" />
        {RUNTIME_LABELS[team.runtime.state] ?? team.runtime.state}
      </p>
      <ul className="teams-summary-list">
        <li>{`Definition: ${definitionStateText(team)}`}</li>
        <li>{`Coordinator: ${coordinator.text}`}</li>
        <li>{`Live state: ${live.text}`}</li>
      </ul>
      {props.stale && <p className="panel-note">Team data is stale — showing previously loaded data.</p>}
      {overview.partial && <p className="panel-note">Some team details could not be read.</p>}
      {team.definition.problems.length > 0 && (
        <ul className="teams-problems" aria-label="Definition problems">
          {team.definition.problems.map((p, i) => <li key={i}>{`${p.path}: ${p.message}`}</li>)}
        </ul>
      )}
    </section>
  );
}

export function MemberAvailabilitySummary(props: { team: OverviewTeam }): JSX.Element {
  const { team } = props;
  return (
    <section className="teams-summary-card" aria-labelledby="teams-availability-title">
      <h2 id="teams-availability-title">Member availability</h2>
      <p>{memberCountText(team)}</p>
      {team.members.length === 0 ? <p>No members</p> : (
        <ul className="teams-overview-availability" aria-label="Member availability counts">
          {availabilityCounts(team.members).map((c) => (
            <li key={c.presence}>
              <span className={`status-badge teams-presence teams-tone-${c.tone}`}>
                <span className="status-dot" aria-hidden="true" />
                {`${c.count} ${c.label}`}
              </span>
            </li>
          ))}
        </ul>
      )}
      {team.membersTruncated && (
        <p className="teams-cell-note">{`Counts cover the ${team.members.length} members shown; more members exist.`}</p>
      )}
    </section>
  );
}

export interface TeamOverviewPanelProps {
  team: OverviewTeam;
  overview: TeamOverview;
  pending: boolean;
  stale: boolean;
  board: Omit<BoardControlProps, 'team' | 'pending'>;
}

export function TeamOverviewPanel(props: TeamOverviewPanelProps): JSX.Element {
  const { team, overview, pending, board } = props;
  const unNote = uneditableNote(team);
  const runNote = liveNote(team);
  return (
    <div className="teams-overview">
      <div className="teams-overview-summaries">
        <TeamStatusSummary team={team} overview={overview} stale={props.stale} />
        <BoardControl team={team} pending={pending} {...board} />
        <MemberAvailabilitySummary team={team} />
      </div>
      {unNote !== null && <p className="panel-note">{unNote}</p>}
      {runNote !== null && <p className="panel-note">{runNote}</p>}
    </div>
  );
}
