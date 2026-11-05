import type {
  BoardColumn,
  BoardSettings,
  BoardTicket,
  BoardTicketCreateInput,
  BoardTicketSummary,
} from '../api';
import { statusLabel, type BoardStatusInfo } from './boardLaneModel';

/** The five Kanban columns are fixed by the backend board model. */
const COLUMN_LABELS: Record<BoardColumn, string> = {
  backlog: 'Backlog',
  todo: 'Todo',
  'in-progress': 'In Progress',
  done: 'Done',
  closed: 'Closed',
};

export interface CreateStatusOption {
  id: string;
  name: string;
}

export interface CreateDestination {
  column: BoardColumn;
  label: string;
  /** The workflow statuses the backend accepts for a new ticket in this column. */
  statuses: CreateStatusOption[];
  defaultStatus: string | null;
  disabled: boolean;
  /** Why the column cannot be chosen, for a disabled option. */
  reason: string | null;
}

export interface CreatePhaseOption {
  slug: string;
  name: string;
  status: 'open' | 'closed';
  current?: boolean;
}

export interface CreateTicketFormValues {
  title: string;
  body: string;
  priority: string;
  phase: string;
  column: BoardColumn | null;
  workflowStatus: string;
}

/** board.settings normally supplies workflowStatuses; older fixtures only supply statuses. */
function statusCatalog(settings: BoardSettings): BoardStatusInfo[] {
  return settings.workflowStatuses.length > 0 ? settings.workflowStatuses : settings.statuses;
}

function statusOptions(ids: readonly string[], catalog: readonly BoardStatusInfo[]): CreateStatusOption[] {
  const seen = new Set<string>();
  const options: CreateStatusOption[] = [];
  for (const id of ids) {
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    const known = catalog.find((status) => status.id === id);
    options.push({ id, name: statusLabel(known ?? { id }) });
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
 * The columns and workflow statuses a new ticket may start in, derived from the active board settings.
 * Invalid pairs are never offered: each column only lists the statuses the backend accepts for it, and a
 * column with no usable status is disabled with an explanation.
 */
export function buildCreateDestinations(settings: BoardSettings): CreateDestination[] {
  const catalog = statusCatalog(settings);
  const initial = catalog.find((status) => status.kind === 'initial');
  const done = catalog.filter((status) => status.kind === 'done').map((status) => status.id);
  const closed = catalog.find((status) => status.kind === 'closed');
  const during = new Set(settings.rules.map((rule) => rule.during).filter((value): value is string => typeof value === 'string' && value !== ''));
  const ruleStatuses = settings.rules
    .map((rule) => rule.status)
    .filter((status) => status !== '' && !during.has(status));

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

  return definitions.map((definition) => {
    const statuses = statusOptions(definition.ids, catalog);
    return {
      column: definition.column,
      label: COLUMN_LABELS[definition.column],
      statuses,
      defaultStatus: statuses.some((status) => status.id === definition.defaultStatus)
        ? definition.defaultStatus
        : statuses[0]?.id ?? null,
      disabled: statuses.length === 0,
      reason: statuses.length === 0 ? emptyReason(definition.column) : null,
    };
  });
}

/** The first usable destination, or the first destination when none can be used. */
export function defaultCreateDestination(destinations: readonly CreateDestination[]): CreateDestination | null {
  return destinations.find((destination) => !destination.disabled) ?? destinations[0] ?? null;
}

/** Open phases only: the backend refuses to put a ticket in a closed phase. */
export function openPhaseOptions(phases: readonly CreatePhaseOption[]): CreatePhaseOption[] {
  return phases.filter((phase) => phase.status === 'open');
}

/** Prefer the requested phase, then the current phase, then the first open phase. */
export function defaultCreatePhase(phases: readonly CreatePhaseOption[], preferred?: string | null): string {
  const open = openPhaseOptions(phases);
  const match = open.find((phase) => phase.slug === preferred)
    ?? open.find((phase) => phase.current === true)
    ?? open[0];
  return match?.slug ?? '';
}

export interface CreateTicketValidation {
  title?: string;
  priority?: string;
  phase?: string;
  destination?: string;
}

export function validateCreateTicket(values: CreateTicketFormValues, destination: CreateDestination | null): CreateTicketValidation {
  const errors: CreateTicketValidation = {};
  if (values.title.trim() === '') errors.title = 'Title is required.';
  else if (values.title.length > 200) errors.title = 'Title must be at most 200 characters.';
  const priority = Number(values.priority);
  if (values.priority.trim() === '' || !Number.isInteger(priority) || priority < 0 || priority > 1000) {
    errors.priority = 'Priority must be a whole number from 0 to 1000.';
  }
  if (values.phase === '') errors.phase = 'Phase is required.';
  if (destination === null || destination.disabled) {
    errors.destination = destination?.reason ?? 'Choose a column with a configured workflow status.';
  } else if (!destination.statuses.some((status) => status.id === values.workflowStatus)) {
    errors.destination = 'Choose a workflow status for this column.';
  }
  return errors;
}

export function hasCreateErrors(errors: CreateTicketValidation): boolean {
  return Object.values(errors).some((message) => message !== undefined);
}

/** The backend request for a valid form; title and optional body are trimmed for entry. */
export function createTicketRequestFor(values: CreateTicketFormValues, destination: CreateDestination): BoardTicketCreateInput {
  return {
    title: values.title.trim(),
    ...(values.body.trim() === '' ? {} : { body: values.body }),
    priority: Number(values.priority),
    phase: values.phase,
    status: destination.column,
    workflowStatus: values.workflowStatus,
  };
}

/** ticket.add returns the full ticket; the board lists use summaries without the body. */
export function createdTicketSummary(ticket: BoardTicket): BoardTicketSummary {
  const { body: _body, ...rest } = ticket;
  return { ...(rest as Omit<BoardTicket, 'body'>), dependsOn: [], openDependsOn: [] };
}
