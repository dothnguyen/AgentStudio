import type { JSX } from 'react';
import type { DashboardBoard } from '../api';
import type { DashboardSectionController } from './useDashboardSection';

export interface BoardPanelProps {
  section: DashboardSectionController<DashboardBoard>;
  onNavigate(sectionId: string): void;
}

export function BoardPanel(props: BoardPanelProps): JSX.Element {
  const { section } = props;

  return (
    <section className="dashboard-panel dashboard-panel-board board-panel" aria-labelledby="dashboard-board-title">
      <h2 id="dashboard-board-title">Board status</h2>
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
          <button type="button" onClick={() => { void section.reload(); }}>Retry</button>
        </div>
      )}
      {section.state === 'ready' && section.data !== null && (
        <BoardReady data={section.data} onNavigate={props.onNavigate} />
      )}
    </section>
  );
}

export interface BoardProgress {
  total: number;
  completed: number;
  open: number;
  percent: number | null;
}

export function boardProgress(columns: DashboardBoard['columns']): BoardProgress {
  let total = 0;
  let completed = 0;
  for (const column of columns) {
    total += column.count;
    if (column.kind === 'done' || column.kind === 'closed') completed += column.count;
  }
  return {
    total,
    completed,
    open: total - completed,
    percent: total === 0 ? null : Math.floor((completed * 100) / total),
  };
}

function BoardReady(props: { data: DashboardBoard; onNavigate(sectionId: string): void }) {
  const { data } = props;
  const progress = boardProgress(data.columns);

  return (
    <>
      <div className="board-phase">
        <p className="board-phase-label">Current phase</p>
        <p className="board-phase-title">
          <strong className="board-phase-name">{data.currentPhase.name}</strong>
          {' '}
          <span className="status-badge phase-status">{data.currentPhase.status}</span>
        </p>
      </div>
      {progress.total > 0 ? (
        <div className="board-progress">
          <p className="board-progress-summary" id="dashboard-board-progress-label">
            {`${progress.completed} of ${progress.total} completed (${progress.percent}%)`}
          </p>
          <progress
            className="board-progress-bar"
            max={progress.total}
            value={progress.completed}
            aria-labelledby="dashboard-board-progress-label"
          >
            {`${progress.percent}%`}
          </progress>
          <p className="board-progress-open">{`${progress.open} open`}</p>
        </div>
      ) : data.columns.length > 0 ? (
        <p className="panel-empty board-progress-empty">No tickets counted in the current phase.</p>
      ) : (
        <p className="panel-empty">No statuses configured for this board.</p>
      )}
      {data.columns.length > 0 && (
        <ul className="board-status-grid" aria-label="Board status counts">
          {data.columns.map((column) => (
            <li key={column.status} className="board-status-cell">
              <span className="board-status-name">{column.title}</span>
              <span className="board-status-count">{column.count}</span>
              {column.kind !== null && <span className="status-badge">{column.kind}</span>}
            </li>
          ))}
        </ul>
      )}
      {progress.total > 0 && (
        <dl className="board-totals" aria-label="Board totals">
          <div><dt>Active</dt><dd>{data.totals.active}</dd></div>
          <div><dt>Blocked</dt><dd>{data.totals.blocked}</dd></div>
        </dl>
      )}
      {data.tickets.length > 0 && (
        <>
          <p className="panel-note board-ticket-note">Highest-priority working or blocked tickets. Open the board to see every ticket.</p>
          <ul className="board-ticket-list" aria-label="High-priority tickets">
            {data.tickets.map((ticket) => (
              <li key={ticket.key}>
                <span className="ticket-key">{ticket.key}</span>
                <span className="board-ticket-title">{ticket.title}</span>
                <span className="status-badge">{ticket.status}</span>
                <span>Priority {ticket.priority}</span>
                <span className="status-badge">{ticket.activity.state}</span>
                {ticket.activity.agent !== undefined && <span>Agent: {ticket.activity.agent}</span>}
                {ticket.activity.role !== undefined && <span>Role: {ticket.activity.role}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      {data.tickets.length === 0 && progress.total > 0 && (
        <p className="panel-empty">No active or blocked tickets.</p>
      )}
      <button type="button" className="board-view-button" onClick={() => props.onNavigate('boards')}>View board</button>
    </>
  );
}
