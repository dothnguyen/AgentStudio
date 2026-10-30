import { useState, type JSX } from 'react';
import type { BoardSettings, OverviewTeam, TeamOverview } from '../api';
import type { DashboardSectionController } from '../dashboard/useDashboardSection';
import { boardControlView, type BoardAction } from './boardControlModel';
import { TeamNameForm } from './TeamEditForms';
import { canEditTeam, liveNote, uneditableNote } from './teamEditModel';
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
import type { TeamWrites } from './TeamsScreen';

export interface BoardControlProps {
  team: OverviewTeam;
  section: DashboardSectionController<BoardSettings>;
  connected: boolean;
  action: BoardAction | null;
  pending: boolean;
  onRun(team: OverviewTeam): void;
  onStop(team: OverviewTeam): void;
}

export function BoardControl(props: BoardControlProps): JSX.Element {
  const { team, section, connected, action, pending, onRun, onStop } = props;
  const settings = section.state === 'ready' ? section.data : null;
  const view = settings === null ? null : boardControlView(team, settings.runner, connected);
  return (
    <section className="teams-board" aria-labelledby="teams-board-title">
      <h3 id="teams-board-title">Board control</h3>
      {section.state === 'loading' && <p className="panel-loading">Loading board state…</p>}
      {section.state === 'error' && <SectionError section={section} />}
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
        <p className="panel-loading" role="status">{action === 'run' ? 'Starting board…' : 'Stopping board…'}</p>
      )}
    </section>
  );
}


export interface TeamOverviewPanelProps {
  team: OverviewTeam;
  overview: TeamOverview;
  writes: Pick<TeamWrites, 'rename' | 'deleteTeam'>;
  pending: boolean;
  board: Omit<BoardControlProps, 'team' | 'pending'>;
}

export function TeamOverviewPanel(props: TeamOverviewPanelProps): JSX.Element {
  const { team, overview, writes, pending, board } = props;
  const [teamForm, setTeamForm] = useState<'rename' | 'delete' | null>(null);
  const unNote = uneditableNote(team);
  const runNote = liveNote(team);
  const coordinator = coordinatorText(overview);
  const live = liveStateText(overview);
  const badge = (tone: string, text: string): JSX.Element => (
    <span className={`status-badge teams-tone-${tone}`}>
      <span className="status-dot" aria-hidden="true" />
      {text}
    </span>
  );
  return (
    <div className="teams-overview">
      <dl className="teams-overview-facts" aria-label="Team summary">
        <div><dt>Name</dt><dd>{teamLabel(team)}</dd></div>
        <div>
          <dt>Team id</dt>
          <dd>{team.id !== null ? <code className="entity-id">{team.id}</code> : 'None (runtime only)'}</dd>
        </div>
        <div><dt>Definition</dt><dd>{definitionStateText(team)}</dd></div>
        <div>
          <dt>Runtime</dt>
          <dd>
            <span className={`status-badge teams-runtime teams-tone-${runtimeTone(team.runtime.state)}`}>
              <span className="status-dot" aria-hidden="true" />
              {RUNTIME_LABELS[team.runtime.state] ?? team.runtime.state}
            </span>
            {' '}
            {team.runtime.teamId !== null ? <code className="entity-id">{team.runtime.teamId}</code> : <span>No runtime id</span>}
          </dd>
        </div>
        <div><dt>Members</dt><dd>{memberCountText(team)}</dd></div>
        <div>
          <dt>Availability</dt>
          <dd>
            {team.members.length === 0 ? 'No members' : (
              <>
                <ul className="teams-overview-availability" aria-label="Member availability">
                  {availabilityCounts(team.members).map((c) => (
                    <li key={c.presence}>
                      <span className={`status-badge teams-presence teams-tone-${c.tone}`}>
                        <span className="status-dot" aria-hidden="true" />
                        {`${c.count} ${c.label}`}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {team.membersTruncated && (
              <p className="teams-cell-note">{`Counts cover the ${team.members.length} members shown; more members exist.`}</p>
            )}
          </dd>
        </div>
        <div><dt>Coordinator</dt><dd>{badge(coordinator.tone, coordinator.text)}</dd></div>
        <div><dt>Live state</dt><dd>{badge(live.tone, live.text)}</dd></div>
      </dl>
      {team.definition.problems.length > 0 && (
        <ul className="teams-problems" aria-label="Definition problems">
          {team.definition.problems.map((p, i) => <li key={i}>{`${p.path}: ${p.message}`}</li>)}
        </ul>
      )}
      <BoardControl team={team} pending={pending} {...board} />
      <section className="teams-overview-actions" aria-labelledby="teams-overview-actions-title">
        <h3 id="teams-overview-actions-title">Team actions</h3>
        {unNote !== null && <p className="panel-note">{unNote}</p>}
        {runNote !== null && <p className="panel-note">{runNote}</p>}
        {canEditTeam(team) && (
          <div className="teams-team-actions">
            <button type="button" disabled={pending} onClick={() => setTeamForm('rename')}>Rename team</button>
            <button type="button" disabled={pending} onClick={() => setTeamForm('delete')}>Delete team</button>
          </div>
        )}
        {teamForm === 'rename' && (
          <TeamNameForm
            heading="Rename team"
            submitLabel="Save name"
            initialName={team.name ?? ''}
            pending={pending}
            onSubmit={(name) => { void writes.rename(team, name).then((ok) => { if (ok) setTeamForm(null); }); }}
            onCancel={() => setTeamForm(null)}
          />
        )}
        {teamForm === 'delete' && (
          <div className="teams-confirm" role="group" aria-label="Confirm team deletion">
            <p>{`Delete team "${teamLabel(team)}"? Its definition file is removed.`}</p>
            <button
              type="button"
              disabled={pending}
              onClick={() => { void writes.deleteTeam(team).then((ok) => { if (ok) setTeamForm(null); }); }}
            >
              Confirm delete
            </button>
            <button type="button" onClick={() => setTeamForm(null)}>Cancel</button>
          </div>
        )}
      </section>
    </div>
  );
}
