import type { DashboardAgentAvailability, DashboardTeamRuntime, DashboardTeams } from '../api';
import type { DashboardSectionController } from './useDashboardSection';

type DashboardTeam = DashboardTeams['teams'][number];

const AVAILABILITY_ORDER: DashboardAgentAvailability[] =
  ['busy', 'idle', 'waiting_input', 'starting', 'limit_reached', 'error', 'offline'];

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function orderTeams(teams: DashboardTeam[]): DashboardTeam[] {
  return [
    ...teams.filter((team) => team.runtime?.status === 'running'),
    ...teams.filter((team) => team.runtime?.status !== 'running'),
  ];
}

function overview(data: DashboardTeams): string {
  const running = data.teams.filter((team) => team.runtime?.status === 'running').length;
  const count = data.teams.length;
  return data.truncated
    ? `${count} teams shown · ${running} running`
    : `${plural(count, 'team', 'teams')} · ${running} running`;
}

function runtimeLabel(team: DashboardTeam): string {
  return team.runtime === null ? 'no runtime' : team.runtime.status;
}

function availabilityCount(runtime: DashboardTeamRuntime, state: DashboardAgentAvailability): number {
  const value = runtime.availability[state];
  return typeof value === 'number' ? value : 0;
}

function TeamPresence(props: { runtime: DashboardTeamRuntime | null }) {
  const { runtime } = props;
  if (runtime === null) {
    return <p className="team-presence team-presence-unknown">Availability unknown — no runtime</p>;
  }
  if (runtime.status === 'stopped') {
    return <p className="team-presence team-presence-stopped">Not available — team stopped</p>;
  }
  if (runtime.memberCount === 0) {
    return <p className="team-presence">No agents in runtime</p>;
  }
  return (
    <p className="team-presence">
      <span className="team-available">{`${availabilityCount(runtime, 'idle')} of ${runtime.memberCount} available`}</span>
      {AVAILABILITY_ORDER.filter((state) => availabilityCount(runtime, state) > 0).map((state) => (
        <span key={state} className="status-badge team-availability">{`${state}: ${availabilityCount(runtime, state)}`}</span>
      ))}
    </p>
  );
}

export function TeamsPanel(props: {
  section: DashboardSectionController<DashboardTeams>;
  onNavigate(sectionId: string): void;
}) {
  const { section } = props;
  return (
    <section className="dashboard-panel dashboard-panel-teams teams-panel" aria-labelledby="teams-panel-title">
      <h2 id="teams-panel-title">Team status</h2>
      {section.state === 'loading' && <p className="panel-loading" role="status">Loading team status…</p>}
      {section.state === 'error' && section.error !== null && (
        <div className="panel-error" role="alert">
          <p><code className="entity-id">{section.error.code}</code>: {section.error.message}</p>
          {typeof section.error.remediation === 'string' && section.error.remediation !== '' && (
            <p>{section.error.remediation}</p>
          )}
          <button type="button" onClick={() => { void section.reload(); }}>Retry</button>
        </div>
      )}
      {section.state === 'ready' && section.data !== null && (
        <>
          {section.data.teams.length === 0 ? (
            <p className="panel-empty">No teams defined</p>
          ) : (
            <>
              <p className="team-overview">{overview(section.data)}</p>
              <ul className="team-list">
                {orderTeams(section.data.teams).map((team) => (
                  <li key={team.id} className="team-row">
                    <div className="team-heading">
                      <h3 className="team-name">{team.name ?? team.id}</h3>
                      <span className={`status-badge team-status team-status-${team.runtime?.status ?? 'none'}`}>{runtimeLabel(team)}</span>
                      {team.problems !== undefined && team.problems.length > 0 && (
                        <span className="status-badge team-problem">Definition has problems</span>
                      )}
                    </div>
                    <p className="team-facts">
                      <span>{plural(team.members, 'member', 'members')}</span>
                      {team.runtime !== null && (
                        <span>{plural(team.runtime.activeAssignments, 'active assignment', 'active assignments')}</span>
                      )}
                    </p>
                    <TeamPresence runtime={team.runtime} />
                  </li>
                ))}
              </ul>
            </>
          )}
          {section.data.truncated && (
            <p className="panel-note">{`Showing the first ${section.data.teams.length} teams. More teams are defined in this workspace.`}</p>
          )}
          <button type="button" onClick={() => props.onNavigate('teams')}>View teams</button>
        </>
      )}
    </section>
  );
}
