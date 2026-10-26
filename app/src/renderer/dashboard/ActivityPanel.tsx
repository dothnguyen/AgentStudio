import type { DashboardActivity } from '../api';
import type { DashboardSectionController } from './useDashboardSection';

export interface ActivityPanelProps {
  section: DashboardSectionController<DashboardActivity>;
}

export function formatActivityTime(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : date.toLocaleString();
}

export function ActivityPanel(props: ActivityPanelProps) {
  const { section } = props;
  return (
    <section className="dashboard-panel dashboard-panel-activity activity-panel" aria-labelledby="recent-activity-title">
      <h2 id="recent-activity-title">Recent activity</h2>
      {section.state === 'loading' && <p className="panel-loading" role="status">Loading recent activity…</p>}
      {section.state === 'error' && section.error !== null && (
        <div className="panel-error" role="alert">
          <p>{section.error.code}: {section.error.message}</p>
          {typeof section.error.remediation === 'string' && section.error.remediation !== '' && (
            <p>{section.error.remediation}</p>
          )}
          <button type="button" onClick={() => { void section.reload(); }}>Retry</button>
        </div>
      )}
      {section.state === 'ready' && section.data !== null && (
        section.data.entries.length === 0 ? (
          <p>No recent activity</p>
        ) : (
          <ol aria-label="Recent activity">
            {section.data.entries.slice(0, 15).map((entry) => (
              <li key={entry.id}>
                <span>{entry.summary}</span>
                {' '}
                <span className="status-badge">{entry.kind}</span>
                {' '}
                <time dateTime={entry.at}>{formatActivityTime(entry.at)}</time>
              </li>
            ))}
          </ol>
        )
      )}
    </section>
  );
}
