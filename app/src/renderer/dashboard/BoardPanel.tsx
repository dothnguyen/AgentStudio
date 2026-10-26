import type { JSX } from 'react';
import type { DashboardBoard } from '../api';
import type { DashboardSection } from './useDashboardSection';

export interface BoardPanelProps {
  section: DashboardSection<DashboardBoard>;
  onNavigate(sectionId: string): void;
}

export function BoardPanel(props: BoardPanelProps): JSX.Element {
  const { section } = props;

  return (
    <section className="dashboard-panel board-panel" aria-labelledby="dashboard-board-title">
      <h2 id="dashboard-board-title">Board</h2>
      {section.state === 'loading' && <p className="panel-loading" role="status">Loading board…</p>}
      {section.state === 'error' && section.error?.code === 'BOARD_CONFIG_INVALID' && (
        <p className="panel-empty" role="status">No board configured for this workspace</p>
      )}
      {section.state === 'error' && section.error !== null && section.error.code !== 'BOARD_CONFIG_INVALID' && (
        <div className="panel-error">
          <p role="alert">{section.error.message}</p>
          {typeof section.error.remediation === 'string' && section.error.remediation !== '' && (
            <p>{section.error.remediation}</p>
          )}
          <button type="button" onClick={section.reload}>Retry</button>
        </div>
      )}
      {section.state === 'ready' && section.data !== null && (
        <BoardReady data={section.data} onNavigate={props.onNavigate} />
      )}
    </section>
  );
}

function BoardReady(props: { data: DashboardBoard; onNavigate(sectionId: string): void }) {
  const { data } = props;
  const empty = data.columns.every((column) => column.count === 0)
    && data.tickets.length === 0;

  return (
    <>
      <p className="board-phase">
        <strong>{data.currentPhase.name}</strong>
        {' '}
        <span>{data.currentPhase.status}</span>
      </p>
      {empty ? (
        <p className="panel-empty">No tickets in the current phase.</p>
      ) : (
        <>
          <ul className="board-status-list" aria-label="Board status counts">
            {data.columns.map((column) => (
              <li key={column.status}>
                <span>{column.title}</span>
                <span>{column.count}</span>
                {column.kind !== null && <span className="status-badge">{column.kind}</span>}
              </li>
            ))}
          </ul>
          <dl className="board-totals" aria-label="Board totals">
            <div><dt>Active</dt><dd>{data.totals.active}</dd></div>
            <div><dt>Blocked</dt><dd>{data.totals.blocked}</dd></div>
            <div><dt>Done</dt><dd>{data.totals.done}</dd></div>
          </dl>
          {data.tickets.length === 0 ? (
            <p className="panel-empty">No active or blocked tickets.</p>
          ) : (
            <ul className="board-ticket-list" aria-label="High-priority tickets">
              {data.tickets.map((ticket) => (
                <li key={ticket.key}>
                  <span className="monospace">{ticket.key}</span>
                  <span>{ticket.title}</span>
                  <span>{ticket.status}</span>
                  <span>Priority {ticket.priority}</span>
                  <span>{ticket.activity.state}</span>
                  {ticket.activity.agent !== undefined && <span>Agent: {ticket.activity.agent}</span>}
                  {ticket.activity.role !== undefined && <span>Role: {ticket.activity.role}</span>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <button type="button" onClick={() => props.onNavigate('boards')}>View board</button>
    </>
  );
}
