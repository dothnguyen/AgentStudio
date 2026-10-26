import type { DashboardTeams } from '../api';
import type { DashboardSectionController } from './useDashboardSection';

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
            <ul className="team-list">
              {section.data.teams.map((team) => (
                <li key={team.id} className="team-row">
                  <div className="team-heading">
                    <strong>{team.name ?? team.id}</strong>
                    <span className="status-badge">{team.runtime?.status ?? 'stopped'}</span>
                  </div>
                  <div className="team-metadata">
                    <span>{team.members} {team.members === 1 ? 'member' : 'members'}</span>
                    {team.runtime !== null && Object.entries(team.runtime.availability).map(([availability, count]) => (
                      <span key={availability} className="team-availability status-badge">{availability}: {count}</span>
                    ))}
                    <span>{team.runtime?.activeAssignments ?? 0} {(team.runtime?.activeAssignments ?? 0) === 1 ? 'active assignment' : 'active assignments'}</span>
                    {team.problems !== undefined && team.problems.length > 0 && <span>Definition has problems</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {section.data.truncated && <p className="panel-note">Showing the first 50 teams.</p>}
          <button type="button" onClick={() => props.onNavigate('teams')}>View teams</button>
        </>
      )}
    </section>
  );
}
