import { useEffect, useRef, type JSX } from 'react';
import type { BoardSettings, OverviewTeam, TeamOverview } from '../api';
import type { DashboardSectionController } from '../dashboard/useDashboardSection';
import { boardButtonAction, boardControlView, type BoardAction } from './boardControlModel';
import { runningTeamNotice, uneditableNote } from './teamEditModel';
import {
  RUNTIME_LABELS,
  availabilitySummary,
  definitionStateText,
  runtimeDetailText,
  runtimeTone,
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
  onOpenBoard?(): void;
}

export function BoardControl(props: BoardControlProps): JSX.Element {
  const { team, section, connected, action, pending, onRun, onStop } = props;
  const settings = section.data ?? props.lastSettings ?? null;
  const stale = settings !== null && (section.state !== 'ready' || section.data === null);
  const view = settings === null ? null : boardControlView(team, settings.runner, connected && !stale);
  const buttonAction = view === null ? null : boardButtonAction(view);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const hadFocus = useRef(false);
  useEffect(() => {
    if (!hadFocus.current) return;
    const a = document.activeElement;
    if (a !== null && a !== document.body && a !== buttonRef.current) { hadFocus.current = false; return; }
    if (buttonAction !== null) { buttonRef.current?.focus(); return; }
    // Wait out transient states (reload, write in flight, brief disconnect): the button may come back.
    if (section.state === 'loading' || action !== null || pending || !connected) return;
    hadFocus.current = false;
    document.getElementById('teams-board-title')?.focus();
  }, [buttonAction, section.state, action, pending, connected]);
  return (
    <section className="teams-board teams-summary-card" aria-labelledby="teams-board-title">
      <div className="teams-board-head">
        <h2 id="teams-board-title" className="teams-summary-label" tabIndex={-1}>Board</h2>
        {props.onOpenBoard && <button type="button" className="teams-summary-link" onClick={props.onOpenBoard}>Open board</button>}
      </div>
      {section.state === 'loading' && <p className="panel-loading" role={props.announce === false ? undefined : 'status'}>{stale ? 'Refreshing board state… Showing previously loaded data.' : 'Loading board state…'}</p>}
      {section.state === 'error' && <SectionError section={section} alert={props.alert} label="Board" stale={stale} retryId="teams-retry-board" onRetry={props.onRetry} />}
      {view !== null && (
        <>
          <p className={`teams-summary-value teams-tone-${view.tone}`}>
            <span className="status-dot" aria-hidden="true" />
            {view.status}
          </p>
          <div className="teams-board-foot">
            <div className="teams-board-text">
              {view.detail !== null && <p>{view.detail}</p>}
              {view.runHint !== null && <p>{view.runHint}</p>}
            </div>
            {buttonAction !== null && (
              <button
                type="button"
                ref={buttonRef}
                className="teams-board-button"
                disabled={pending}
                onFocus={() => { hadFocus.current = true; }}
                onBlur={() => { hadFocus.current = false; }}
                onClick={() => (buttonAction === 'stop' ? onStop(team) : onRun(team))}
              >
                {buttonAction === 'stop'
                  ? <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2" /></svg>
                  : <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5l12 7-12 7z" /></svg>}
                {buttonAction === 'stop' ? 'Stop board' : 'Run board'}
              </button>
            )}
          </div>
        </>
      )}
      {action !== null && (
        <p className="panel-loading" role={props.announce === false || section.state === 'loading' ? undefined : 'status'}>{action === 'run' ? 'Starting board…' : 'Stopping board…'}</p>
      )}
    </section>
  );
}

export function RuntimeSummary(props: { team: OverviewTeam; overview: TeamOverview; stale: boolean }): JSX.Element {
  const { team, overview } = props;
  return (
    <section className="teams-summary-card" aria-labelledby="teams-runtime-title">
      <h2 id="teams-runtime-title" className="teams-summary-label">Runtime</h2>
      <p className={`teams-summary-value teams-tone-${runtimeTone(team.runtime.state)}`}>
        <span className="status-dot" aria-hidden="true" />
        {RUNTIME_LABELS[team.runtime.state] ?? team.runtime.state}
      </p>
      <p className="teams-summary-detail">{runtimeDetailText(overview)}</p>
      {team.definition.state !== 'valid' && <p className="teams-summary-note">{`Definition: ${definitionStateText(team)}`}</p>}
      {props.stale && <p className="teams-summary-note">Team data is stale — showing previously loaded data.</p>}
      {overview.partial && <p className="teams-summary-note">Some team details could not be read.</p>}
      {team.definition.problems.length > 0 && (
        <ul className="teams-problems" aria-label="Definition problems">
          {team.definition.problems.map((p, i) => <li key={i}>{`${p.path}: ${p.message}`}</li>)}
        </ul>
      )}
    </section>
  );
}

export function MemberAvailabilityCard(props: { team: OverviewTeam }): JSX.Element {
  const { team } = props;
  const s = availabilitySummary(team);
  return (
    <section className="teams-summary-card" aria-labelledby="teams-availability-title">
      <h2 id="teams-availability-title" className="teams-summary-label">Availability</h2>
      <p className="teams-summary-value teams-availability-value"><span>{s.available}</span> <span className="teams-availability-total">{`/ ${s.totalText} available`}</span></p>
      <div className="teams-availability-bar" role="img" aria-label={s.barLabel}>
        <div className="teams-availability-fill" style={{ width: `${s.percent}%` }} />
      </div>
      {team.members.length === 0 ? <p className="teams-summary-detail">No members</p> : s.others !== null && <p className="teams-summary-detail">{s.others}</p>}
      {team.membersTruncated && (
        <p className="teams-summary-note">{`Counts cover the ${team.members.length} members shown; more members exist.`}</p>
      )}
    </section>
  );
}

function InfoBanner(props: { text: string }): JSX.Element {
  return (
    <p className="teams-info-banner">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#7fb2ff" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.5" /></svg>
      <span>{props.text}</span>
    </p>
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
  const runNotice = runningTeamNotice(team);
  return (
    <div className="teams-overview">
      <div className="teams-overview-summaries">
        <RuntimeSummary team={team} overview={overview} stale={props.stale} />
        <MemberAvailabilityCard team={team} />
        <BoardControl team={team} pending={pending} {...board} />
      </div>
      {unNote !== null && <InfoBanner text={unNote} />}
      {runNotice !== null && <InfoBanner text={runNotice} />}
    </div>
  );
}
