import type { ConnectionStatus, DashboardApi, Workspace } from '../api';
import { CONNECTED_TEXT, CONNECTING_TEXT, LOST_TITLE } from '../StartupScreen';
import type { SectionId } from '../shell/navModel';
import { TeamsPanel } from './TeamsPanel';
import { useDashboardSection } from './useDashboardSection';

export function DashboardHome(props: {
  workspace: Workspace;
  dashboard: DashboardApi;
  connection: ConnectionStatus;
  onNavigate(sectionId: SectionId): void;
}) {
  const teams = useDashboardSection(props.dashboard.teams, props.workspace.id);
  const loading = teams.state === 'loading';
  const latest = teams.lastUpdatedAt;
  const connectionText = props.connection.state === 'connecting'
    ? CONNECTING_TEXT
    : props.connection.state === 'connected'
      ? CONNECTED_TEXT
      : LOST_TITLE;

  return (
    <div className="dashboard-home">
      <header className="dashboard-header">
        <div className="dashboard-title">
          <h1>{props.workspace.name}</h1>
          <code className="dashboard-path" title={props.workspace.path}>{props.workspace.path}</code>
        </div>
        <div className="dashboard-actions">
          <span className={`connection-badge connection-${props.connection.state}`}>{connectionText}</span>
          <button type="button" className="refresh-button" aria-busy={loading} disabled={loading} onClick={teams.reload}>
            Refresh
          </button>
          {latest !== null && (
            <time dateTime={new Date(latest).toISOString()}>Last updated {new Date(latest).toLocaleTimeString()}</time>
          )}
        </div>
      </header>
      <div className="dashboard-grid">
        <TeamsPanel section={teams} onNavigate={props.onNavigate} />
        <section className="dashboard-panel placeholder-panel" aria-labelledby="board-panel-title">
          <h2 id="board-panel-title">Board status</h2>
          <p>Not available yet.</p>
        </section>
        <section className="dashboard-panel placeholder-panel" aria-labelledby="activity-panel-title">
          <h2 id="activity-panel-title">Recent activity</h2>
          <p>Not available yet.</p>
        </section>
      </div>
    </div>
  );
}
