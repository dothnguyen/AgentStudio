import { useRef, useState } from 'react';
import type { ConnectionStatus, DashboardApi, Workspace } from '../api';
import { CONNECTED_TEXT, CONNECTING_TEXT, LOST_TITLE } from '../StartupScreen';
import type { SectionId } from '../shell/navModel';
import { ActivityPanel } from './ActivityPanel';
import { BoardPanel } from './BoardPanel';
import { TeamsPanel } from './TeamsPanel';
import { useDashboardSection } from './useDashboardSection';

export function DashboardHome(props: {
  workspace: Workspace;
  dashboard: DashboardApi;
  connection: ConnectionStatus;
  onNavigate(sectionId: SectionId): void;
}) {
  const teams = useDashboardSection(props.dashboard.teams, props.workspace.id);
  const boardSection = useDashboardSection(props.dashboard.board, props.workspace.id);
  const activity = useDashboardSection(props.dashboard.activity, props.workspace.id);
  const refreshLock = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const busy = refreshing || teams.loading || boardSection.loading || activity.loading;
  const latest = teams.lastUpdatedAt;
  const connectionText = props.connection.state === 'connecting'
    ? CONNECTING_TEXT
    : props.connection.state === 'connected'
      ? CONNECTED_TEXT
      : LOST_TITLE;

  async function refreshAll(): Promise<void> {
    if (refreshLock.current) return;
    refreshLock.current = true;
    setRefreshing(true);
    try {
      await Promise.all([teams.reload(), boardSection.reload(), activity.reload()]);
    } finally {
      refreshLock.current = false;
      setRefreshing(false);
    }
  }

  return (
    <div className="dashboard-home">
      <header className="dashboard-header">
        <div className="dashboard-title">
          <h1>{props.workspace.name}</h1>
          <code className="dashboard-path" title={props.workspace.path}>{props.workspace.path}</code>
        </div>
        <div className="dashboard-actions">
          <span className={`status-badge connection-badge connection-${props.connection.state}`}>{connectionText}</span>
          <button
            type="button"
            className="refresh-button"
            aria-busy={busy}
            onClick={() => { void refreshAll(); }}
          >
            Refresh
          </button>
          {latest !== null && (
            <time dateTime={new Date(latest).toISOString()}>Last updated {new Date(latest).toLocaleTimeString()}</time>
          )}
        </div>
      </header>
      <div className="dashboard-grid">
        <TeamsPanel section={teams} onNavigate={props.onNavigate} />
        <BoardPanel section={boardSection} onNavigate={(sectionId) => props.onNavigate(sectionId as SectionId)} />
        <ActivityPanel section={activity} />
      </div>
    </div>
  );
}
