import type { BoardColumn, BoardSettings, BoardTicketSummary } from '../api';
import { humanizeStatusId, type BoardStatusInfo } from './boardLaneModel';

/** The five Kanban columns are fixed by the backend board model. */
const COLUMN_LABELS: Record<BoardColumn, string> = {
  backlog: 'Backlog',
  todo: 'Todo',
  'in-progress': 'In Progress',
  done: 'Done',
  closed: 'Closed',
};

export interface MoveStatusOption {
  id: string;
  name: string;
}

export interface MoveDestination {
  column: BoardColumn;
  label: string;
  /** The workflow statuses the backend accepts for this column. */
  statuses: MoveStatusOption[];
  defaultStatus: string | null;
  disabled: boolean;
  /** Why the column cannot be chosen, for a disabled option. */
  reason: string | null;
  /** A finished ticket has to be reopened explicitly when it moves. */
  force: boolean;
}

export interface MoveTicketRequest {
  key: string;
  to: BoardColumn;
  workflowStatus?: string;
  force?: boolean;
}

type TicketForMove = Pick<BoardTicketSummary, 'key' | 'status' | 'workflowStatus'>;

/** board.settings normally supplies workflowStatuses; older fixtures only supply statuses. */
function statusCatalog(settings: BoardSettings): BoardStatusInfo[] {
  return settings.workflowStatuses.length > 0 ? settings.workflowStatuses : settings.statuses;
}

function statusOptions(ids: readonly string[], catalog: readonly BoardStatusInfo[]): MoveStatusOption[] {
  const seen = new Set<string>();
  const options: MoveStatusOption[] = [];
  for (const id of ids) {
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    const known = catalog.find((status) => status.id === id);
    const name = known?.name?.trim() ?? '';
    options.push({ id, name: name === '' || name === id ? humanizeStatusId(id) : name });
  }
  return options;
}

function emptyReason(column: BoardColumn): string {
  switch (column) {
    case 'backlog':
      return 'No initial backlog status is configured.';
    case 'todo':
      return 'No workflow status is configured for Todo.';
    case 'in-progress':
      return 'No workflow rule is configured for In Progress.';
    case 'done':
      return 'No done status is configured.';
    case 'closed':
      return 'No closed status is configured.';
  }
}

/**
 * The columns and workflow statuses this ticket may move to, derived from the active
 * board settings. Invalid choices are disabled with a reason; finished tickets only
 * offer the reopen paths the backend accepts.
 */
export function buildMoveDestinations(ticket: TicketForMove, settings: BoardSettings): MoveDestination[] {
  const catalog = statusCatalog(settings);
  const initial = catalog.find((status) => status.kind === 'initial');
  const done = catalog.filter((status) => status.kind === 'done').map((status) => status.id);
  const closed = catalog.find((status) => status.kind === 'closed');
  const during = new Set(settings.rules.map((rule) => rule.during).filter((value): value is string => typeof value === 'string' && value !== ''));
  const ruleStatuses = settings.rules
    .map((rule) => rule.status)
    .filter((status) => status !== '' && !during.has(status));
  const finished = ticket.status === 'done' || ticket.status === 'closed';

  const definitions: Array<{ column: BoardColumn; ids: string[]; defaultStatus: string | null }> = [
    { column: 'backlog', ids: initial === undefined ? [] : [initial.id], defaultStatus: initial?.id ?? null },
    {
      column: 'todo',
      ids: settings.todoEntry,
      defaultStatus: settings.todoDefault !== null && settings.todoEntry.includes(settings.todoDefault)
        ? settings.todoDefault
        : settings.todoEntry[0] ?? null,
    },
    { column: 'in-progress', ids: ruleStatuses, defaultStatus: ruleStatuses[0] ?? null },
    { column: 'done', ids: done, defaultStatus: done[0] ?? null },
    { column: 'closed', ids: closed === undefined ? [] : [closed.id], defaultStatus: closed?.id ?? null },
  ];
  // The backend only accepts Backlog or Todo when a finished ticket is forced back onto the board.
  const visible = finished ? definitions.filter((definition) => definition.column === 'backlog' || definition.column === 'todo') : definitions;

  return visible.map((definition) => {
    const statuses = statusOptions(definition.ids, catalog);
    const label = COLUMN_LABELS[definition.column];
    if (statuses.length === 0) {
      return {
        column: definition.column,
        label,
        statuses,
        defaultStatus: null,
        disabled: true,
        reason: emptyReason(definition.column),
        force: finished,
      };
    }
    if (definition.column === ticket.status) {
      return {
        column: definition.column,
        label,
        statuses,
        defaultStatus: definition.defaultStatus,
        disabled: true,
        reason: `This ticket is already in ${label}.`,
        force: finished,
      };
    }
    return {
      column: definition.column,
      label,
      statuses,
      defaultStatus: definition.defaultStatus,
      disabled: false,
      reason: null,
      force: finished,
    };
  });
}

/** The first usable destination, or the first destination when none can be used. */
export function defaultDestination(destinations: readonly MoveDestination[]): MoveDestination | null {
  return destinations.find((destination) => !destination.disabled) ?? destinations[0] ?? null;
}

/** The backend request for a destination and its selected workflow status. */
export function moveRequestFor(
  ticket: Pick<TicketForMove, 'key' | 'status'>,
  destination: MoveDestination,
  workflowStatus: string | null,
): MoveTicketRequest {
  return {
    key: ticket.key,
    to: destination.column,
    ...(workflowStatus === null || workflowStatus === '' ? {} : { workflowStatus }),
    ...(destination.force ? { force: true } : {}),
  };
}
