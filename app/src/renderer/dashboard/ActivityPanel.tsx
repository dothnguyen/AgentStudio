import type { ApiError, DashboardActivity } from '../api';

export interface ActivityPanelProps {
  state: 'loading' | 'ready' | 'error';
  data: DashboardActivity | null;
  error: ApiError | null;
  onRetry(): void;
}

export function formatActivityTime(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : date.toLocaleString();
}

export function ActivityPanel(props: ActivityPanelProps) {
  return (
    <section className="dashboard-panel activity-panel" aria-labelledby="recent-activity-title">
      <h2 id="recent-activity-title">Recent activity</h2>
      {props.state === 'loading' && <p role="status">Loading recent activity…</p>}
      {props.state === 'error' && props.error !== null && (
        <div role="alert">
          <p>{props.error.code}: {props.error.message}</p>
          {typeof props.error.remediation === 'string' && props.error.remediation !== '' && (
            <p>{props.error.remediation}</p>
          )}
          <button type="button" onClick={props.onRetry}>Retry</button>
        </div>
      )}
      {props.state === 'ready' && props.data !== null && (
        props.data.entries.length === 0 ? (
          <p>No recent activity</p>
        ) : (
          <ol aria-label="Recent activity">
            {props.data.entries.slice(0, 15).map((entry) => (
              <li key={entry.id}>
                <span>{entry.summary}</span>
                {' '}
                <span>{entry.kind}</span>
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
