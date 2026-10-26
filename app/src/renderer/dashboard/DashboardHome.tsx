import { useRef, useState } from 'react';
import type {
  ConnectionStatus,
  DashboardActivity,
  DashboardApi,
  DashboardBoard,
  DashboardTeams,
  Workspace,
} from '../api';
import { CONNECTED_TEXT, CONNECTING_TEXT, LOST_TITLE } from '../StartupScreen';
import { ShellIcon } from '../shell/ShellIcon';
import type { SectionId } from '../shell/navModel';
import { ActivityPanel } from './ActivityPanel';
import { BoardPanel } from './BoardPanel';
import { SummaryMetrics } from './SummaryMetrics';
import { TeamsPanel } from './TeamsPanel';
import { useDashboardSection, type DashboardSection } from './useDashboardSection';

interface DashboardHomeProps {
  workspace: Workspace;
  dashboard: DashboardApi;
  connection: ConnectionStatus;
  onNavigate(sectionId: SectionId): void;
}

const SECTION_NAMES = { teams: 'Team status', board: 'Board status', activity: 'Recent activity' } as const;

export function isBoardNotConfigured(board: DashboardSection<DashboardBoard>): boolean {
  return board.state === 'error' && board.error?.code === 'BOARD_CONFIG_INVALID';
}

export function completeUpdateTime(
  teams: DashboardSection<DashboardTeams>,
  board: DashboardSection<DashboardBoard>,
  activity: DashboardSection<DashboardActivity>,
): number | null {
  if (teams.state !== 'ready' || activity.state !== 'ready') return null;
  if (board.state !== 'ready' && !isBoardNotConfigured(board)) return null;
  const times = [teams.lastUpdatedAt, activity.lastUpdatedAt];
  if (board.state === 'ready') times.push(board.lastUpdatedAt);
  if (times.some((time) => time === null)) return null;
  return Math.min(...(times as number[]));
}

export function unavailableSections(
  teams: DashboardSection<DashboardTeams>,
  board: DashboardSection<DashboardBoard>,
  activity: DashboardSection<DashboardActivity>,
): string[] {
  const names: string[] = [];
  if (teams.state === 'error') names.push(SECTION_NAMES.teams);
  if (board.state === 'error' && !isBoardNotConfigured(board)) names.push(SECTION_NAMES.board);
  if (activity.state === 'error') names.push(SECTION_NAMES.activity);
  return names;
}

export function DashboardHome(props: DashboardHomeProps) {
  return <DashboardOverview key={props.workspace.id} {...props} />;
}

function DashboardOverview(props: DashboardHomeProps) {
  const teams = useDashboardSection(props.dashboard.teams, props.workspace.id);
  const boardSection = useDashboardSection(props.dashboard.board, props.workspace.id);
  const activity = useDashboardSection(props.dashboard.activity, props.workspace.id);
  const refreshLock = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const busy = refreshing || teams.loading || boardSection.loading || activity.loading;
  const [lastCompleteAt, setLastCompleteAt] = useState<number | null>(null);
  const completeAt = completeUpdateTime(teams, boardSection, activity);
  if (completeAt !== null && completeAt !== lastCompleteAt) setLastCompleteAt(completeAt);
  const latest = completeAt ?? lastCompleteAt;
  const unavailable = unavailableSections(teams, boardSection, activity);
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
          <nav className="breadcrumb" aria-label="Breadcrumb">
            <ol>
              <li>Workspace</li>
              <li aria-current="page">Home</li>
            </ol>
          </nav>
          <h1>Workspace overview</h1>
          <p className="dashboard-workspace-name" title={props.workspace.name}>{props.workspace.name}</p>
          <code className="dashboard-path" title={props.workspace.path}>{props.workspace.path}</code>
        </div>
        <div className="dashboard-actions">
          <span className={`status-badge connection-badge connection-${props.connection.state}`}>
            <span className="status-dot" aria-hidden="true" />
            {connectionText}
          </span>
          <button
            type="button"
            className="refresh-button"
            aria-busy={busy}
            onClick={() => { void refreshAll(); }}
          >
            <ShellIcon name="refresh" />
            Refresh
          </button>
          {latest !== null && (
            <time dateTime={new Date(latest).toISOString()}>Last updated {new Date(latest).toLocaleTimeString()}</time>
          )}
          {unavailable.length > 0 && (
            <p className="dashboard-refresh-note">{`Not updated: ${unavailable.join(', ')}`}</p>
          )}
        </div>
      </header>
      <SummaryMetrics teams={teams} board={boardSection} />
      <div className="dashboard-grid">
        <BoardPanel section={boardSection} onNavigate={(sectionId) => props.onNavigate(sectionId as SectionId)} />
        <TeamsPanel section={teams} onNavigate={props.onNavigate} />
        <ActivityPanel section={activity} />
      </div>
    </div>
  );
}
