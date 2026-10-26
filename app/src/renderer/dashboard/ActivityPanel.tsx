import type { DashboardActivity } from '../api';
import { Icon } from '../icons/Icon';
import { activityIcon } from './dashboardIcons';
import type { DashboardSectionController } from './useDashboardSection';

export interface ActivityPanelProps {
  section: DashboardSectionController<DashboardActivity>;
}

export function formatActivityTime(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : date.toLocaleString();
}

export const ACTIVITY_DISPLAY_LIMIT = 15;

export function activityScopeText(shown: number, returned: number): string {
  if (shown < returned) return `Showing ${shown} of ${returned} returned events, newest first`;
  if (shown === 1) return '1 recent event, newest first';
  return `${shown} recent events, newest first`;
}

export function ActivityPanel(props: ActivityPanelProps) {
  const { section } = props;
  return (
    <section className="dashboard-panel dashboard-panel-activity activity-panel" aria-labelledby="recent-activity-title">
      <h2 id="recent-activity-title"><Icon name="clock" className="panel-title-icon" />Recent activity</h2>
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
          <p className="panel-empty">No recent activity</p>
        ) : (
          <>
            <p className="panel-note activity-scope">
              {activityScopeText(Math.min(section.data.entries.length, ACTIVITY_DISPLAY_LIMIT), section.data.entries.length)}
            </p>
            <table className="activity-table" aria-label="Recent activity">
              <thead>
                <tr>
                  <th scope="col" className="activity-col-event">Event</th>
                  <th scope="col" className="activity-col-type">Type</th>
                  <th scope="col" className="activity-col-time">Time</th>
                </tr>
              </thead>
              <tbody>
                {section.data.entries.slice(0, ACTIVITY_DISPLAY_LIMIT).map((entry) => {
                  const spec = activityIcon(entry);
                  return (
                  <tr key={entry.id}>
                    <td className="activity-event"><span className="activity-event-line"><Icon name={spec.name} tone={spec.tone} /><span className="activity-summary">{entry.summary}</span></span></td>
                    <td className="activity-type"><span className="status-badge">{entry.kind}</span></td>
                    <td className="activity-time"><time dateTime={entry.at}>{formatActivityTime(entry.at)}</time></td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )
      )}
    </section>
  );
}
