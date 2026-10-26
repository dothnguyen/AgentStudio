import type { JSX } from 'react';
import type { DashboardBoard, DashboardTeams } from '../api';
import type { DashboardSectionController } from './useDashboardSection';

export type SummaryMetricId = 'running-teams' | 'active-assignments' | 'open-tickets' | 'completed-tickets';
export type SummaryTone = 'ready' | 'loading' | 'partial' | 'error';
export interface SummaryCard {
  id: SummaryMetricId;
  label: string;
  value: string | null;
  scope: string;
  status: string;
  tone: SummaryTone;
}

export function teamMetrics(data: DashboardTeams): { runningTeams: number; activeAssignments: number } {
  let runningTeams = 0;
  let activeAssignments = 0;
  for (const team of data.teams) {
    if (team.runtime === null) continue;
    if (team.runtime.status === 'running') runningTeams += 1;
    activeAssignments += team.runtime.activeAssignments;
  }
  return { runningTeams, activeAssignments };
}

export function boardMetrics(data: DashboardBoard): { open: number; completed: number } {
  let open = 0;
  let completed = 0;
  for (const column of data.columns) {
    if (column.kind === 'done' || column.kind === 'closed') completed += column.count;
    else open += column.count;
  }
  return { open, completed };
}

interface Shared {
  value: string | null;
  scope: string;
  status: string;
  tone: SummaryTone;
}

function teamShared(section: DashboardSectionController<DashboardTeams>, pick: (n: ReturnType<typeof teamMetrics>) => number): Shared {
  const { data } = section;
  if (section.state === 'error') {
    return { value: null, scope: 'All teams', status: 'Unavailable: team status could not be loaded', tone: 'error' };
  }
  if (data === null) return { value: null, scope: 'All teams', status: 'Loading…', tone: 'loading' };
  const n = pick(teamMetrics(data));
  const refreshing = section.state === 'loading';
  if (data.truncated) {
    return {
      value: `${n}+`,
      scope: 'First 50 teams',
      status: refreshing ? 'Refreshing…; partial: more than 50 teams' : 'Partial: more than 50 teams; showing a lower bound',
      tone: refreshing ? 'loading' : 'partial',
    };
  }
  const status = refreshing ? 'Refreshing…' : data.teams.length === 0 ? 'No teams defined' : 'Loaded';
  return { value: String(n), scope: 'All teams', status, tone: refreshing ? 'loading' : 'ready' };
}

function boardShared(section: DashboardSectionController<DashboardBoard>, pick: (n: ReturnType<typeof boardMetrics>) => number): Shared {
  const { data } = section;
  if (section.state === 'error') {
    const status = section.error?.code === 'BOARD_CONFIG_INVALID'
      ? 'Unavailable: no board configured'
      : 'Unavailable: board could not be loaded';
    return { value: null, scope: 'Current phase', status, tone: 'error' };
  }
  if (data === null) return { value: null, scope: 'Current phase', status: 'Loading…', tone: 'loading' };
  const refreshing = section.state === 'loading';
  const empty = data.columns.every((column) => column.count === 0);
  const status = refreshing ? 'Refreshing…' : empty ? 'No tickets in the current phase' : 'Loaded';
  return {
    value: String(pick(boardMetrics(data))),
    scope: `Current phase: ${data.currentPhase.name}`,
    status,
    tone: refreshing ? 'loading' : 'ready',
  };
}

export function summaryCards(
  teams: DashboardSectionController<DashboardTeams>,
  board: DashboardSectionController<DashboardBoard>,
): SummaryCard[] {
  return [
    { id: 'running-teams', label: 'Running teams', ...teamShared(teams, (m) => m.runningTeams) },
    { id: 'active-assignments', label: 'Active assignments', ...teamShared(teams, (m) => m.activeAssignments) },
    { id: 'open-tickets', label: 'Open tickets', ...boardShared(board, (m) => m.open) },
    { id: 'completed-tickets', label: 'Completed tickets', ...boardShared(board, (m) => m.completed) },
  ];
}

export function SummaryMetrics(props: {
  teams: DashboardSectionController<DashboardTeams>;
  board: DashboardSectionController<DashboardBoard>;
}): JSX.Element {
  const cards = summaryCards(props.teams, props.board);
  return (
    <section className="dashboard-summary" aria-label="Workspace summary">
      <ul className="summary-cards">
        {cards.map((card) => (
          <li key={card.id} className={`summary-card summary-card-${card.tone}`}>
            <div role="group" aria-labelledby={`summary-${card.id}-label`}>
              <p className="summary-label" id={`summary-${card.id}-label`}>{card.label}</p>
              {card.value === null
                ? <p className="summary-value summary-value-unavailable" aria-hidden="true">—</p>
                : <p className="summary-value">{card.value}</p>}
              <p className="summary-scope">{card.scope}</p>
              <p className="summary-status">{card.status}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
