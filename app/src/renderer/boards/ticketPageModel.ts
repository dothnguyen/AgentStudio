import type {
  BoardRuleView,
  BoardTicket,
  BoardTicketDetail,
  BoardTicketEvent,
  BoardTicketLink,
  BoardTicketSummary,
} from '../api';
import {
  statusLabel,
  statusTone,
  type BoardStatusInfo,
  type BoardStatusTone,
} from './boardLaneModel';

export interface TicketStatusChip {
  /** The status shown on the page; a blocked ticket shows the status it returns to. */
  id: string;
  label: string;
  tone: BoardStatusTone;
}

function statusInfo(id: string, statuses: readonly BoardStatusInfo[]): BoardStatusInfo {
  return statuses.find((status) => status.id === id) ?? { id, name: null, kind: null };
}

/** The visible status of a ticket: blocked tickets show the column they return to. */
export function ticketStatusId(ticket: Pick<BoardTicket, 'workflowStatus' | 'returnStatus'>): string {
  if (ticket.workflowStatus !== 'blocked') return ticket.workflowStatus;
  const returnStatus = ticket.returnStatus?.trim() ?? '';
  return returnStatus === '' ? ticket.workflowStatus : returnStatus;
}

/** The page's status chip. Board display names are honoured when the settings read succeeded. */
export function ticketStatusChip(
  ticket: Pick<BoardTicket, 'workflowStatus' | 'returnStatus'>,
  statuses: readonly BoardStatusInfo[] = [],
): TicketStatusChip {
  const id = ticketStatusId(ticket);
  const info = statusInfo(id, statuses);
  return { id, label: statusLabel(info), tone: statusTone(info) };
}

const FINISHED_STATUSES: readonly string[] = ['done', 'close'];

/** Open dependencies of a ticket detail, in the order the links read. */
export function openDependencyKeys(detail: BoardTicketDetail): string[] {
  return detail.links.dependsOn
    .filter((link) => link.status === null || !FINISHED_STATUSES.includes(link.status))
    .map((link) => link.key);
}

/**
 * The ticket page's ticket shape for the card activity mapping: the detail carries the dependency
 * links, while `ticket` itself only has the activity summary.
 */
export function ticketActivitySummary(detail: BoardTicketDetail): BoardTicketSummary {
  const { body: _body, ...ticket } = detail.ticket;
  return {
    ...ticket,
    dependsOn: detail.dependsOn,
    openDependsOn: openDependencyKeys(detail),
  };
}

/** The human name of the status a blocked ticket returns to, or null when it is unknown. */
export function blockedReturnLabel(
  ticket: Pick<BoardTicket, 'workflowStatus' | 'returnStatus'>,
  statuses: readonly BoardStatusInfo[] = [],
): string | null {
  const returnStatus = ticket.returnStatus?.trim() ?? '';
  if (ticket.workflowStatus !== 'blocked' || returnStatus === '') return null;
  return statusLabel(statusInfo(returnStatus, statuses));
}

const WEEKDAYS: readonly string[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Sun 13:57" in the reader's local time zone; "—" for a missing or invalid timestamp. */
export function formatLocalTime(value: string | null | undefined): string {
  if (value === null || value === undefined || value.trim() === '') return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return `${WEEKDAYS[date.getDay()]} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** A run id shortened to its first and last four characters, as in the design ("9a77…c3d1"). */
export function shortenRunId(id: string | null | undefined): string | null {
  const value = id?.trim() ?? '';
  if (value === '') return null;
  if (value.length <= 9) return value;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export type TicketEventTone = 'green' | 'blue' | 'amber' | 'grey';

export interface TicketEventRow {
  id: number;
  title: string;
  detail: string | null;
  tone: TicketEventTone;
  time: string;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter((entry): entry is string => entry !== null) : [];
}

function durationLabel(ms: number | null): string | null {
  if (ms === null || ms < 0) return null;
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

function outcomeSummary(payload: Record<string, unknown>): string | null {
  const summary = text(payload.summary);
  if (summary !== null) return summary;
  const reason = text(payload.reason);
  if (reason !== null) return reason;
  const outcome = text(payload.outcome);
  const rounds = number(payload.rounds);
  if (outcome === 'pass') return rounds === null ? 'Passed' : `Round ${rounds} passed`;
  if (outcome === 'fail') return rounds === null ? 'Failed' : `Round ${rounds} failed`;
  if (outcome === 'blocked') return 'Blocked';
  return null;
}

/**
 * The Timeline rows: the API's events oldest first, each with the page's label, optional detail line
 * and dot colour. Unknown event names keep their raw name with separators turned into spaces.
 */
export function ticketEventRows(events: readonly BoardTicketEvent[]): TicketEventRow[] {
  const claimCounts = new Map<string, number>();
  return events.map((event) => {
    const payload = record(event.payload);
    const name = event.name.startsWith('ticket.') ? event.name.slice('ticket.'.length) : event.name;
    const base = { id: event.id, time: formatLocalTime(event.at) };

    switch (name) {
      case 'run_paused':
        return { ...base, title: 'Run paused', detail: text(payload.reason), tone: 'amber' };
      case 'run_cancelled':
        return { ...base, title: 'Run cancelled', detail: text(payload.reason), tone: 'grey' };
      case 'approval_decided':
        return { ...base, title: payload.outcome === 'pass' ? 'Approved' : 'Rejected', detail: text(payload.note), tone: payload.outcome === 'pass' ? 'green' : 'amber' };
      case 'created':
        return { ...base, title: 'Created', detail: null, tone: 'grey' };
      case 'depends': {
        const keys = textList(payload.on);
        return {
          ...base,
          title: keys.length === 0 ? 'Depends on' : `Depends on ${keys.join(', ')}`,
          detail: null,
          tone: 'grey',
        };
      }
      case 'workflow_changed':
      case 'migrated': {
        const from = text(event.from) ?? text(payload.from);
        const to = text(event.to) ?? text(payload.to);
        return { ...base, title: name === 'migrated' ? 'Workflow status migrated' : 'Workflow status changed', detail: from && to ? `${from} → ${to}` : to, tone: 'blue' };
      }
      case 'moved': {
        const to = text(event.to) ?? text(payload.to);
        const actor = text(event.actor);
        return {
          ...base,
          title: to === null ? 'Moved' : `Moved to ${to}`,
          detail: actor === null ? null : `Moved by ${actor}`,
          tone: 'blue',
        };
      }
      case 'claimed': {
        const agent = text(payload.agent) ?? text(payload.agentId) ?? text(event.actor) ?? 'an agent';
        const group = text(payload.rule) ?? text(event.to) ?? '';
        const current = claimCounts.get(group) ?? 0;
        const round = number(payload.round) ?? number(payload.rounds) ?? current + 1;
        claimCounts.set(group, round);
        return { ...base, title: `Claimed by ${agent}`, detail: `Round ${round}`, tone: 'green' };
      }
      case 'command_requested': {
        const command = text(payload.command);
        return {
          ...base,
          title: command === null ? 'Command requested' : `Command requested: ${command}`,
          detail: 'Waiting for the coordinator to run it',
          tone: 'amber',
        };
      }
      case 'command_finished': {
        const command = text(payload.command);
        const failed = text(payload.status) === 'failed' || payload.passed === false;
        const duration = durationLabel(number(payload.durationMs));
        const verb = failed ? 'Failed' : 'Passed';
        return {
          ...base,
          title: command === null ? 'Command finished' : `Command finished: ${command}`,
          detail: duration === null ? verb : `${verb} in ${duration}`,
          tone: failed ? 'amber' : 'green',
        };
      }
      case 'outcome_applied': {
        const target = text(event.to) ?? text(payload.to);
        const outcome = text(payload.outcome);
        return {
          ...base,
          title: target === null ? 'Outcome applied' : `Outcome applied: ${target}`,
          detail: outcomeSummary(payload),
          tone: outcome === 'pass' ? 'blue' : 'amber',
        };
      }
      case 'committed':
        return {
          ...base,
          title: 'Committed',
          detail: text(payload.message) ?? text(payload.summary),
          tone: 'green',
        };
      default:
        return {
          ...base,
          title: event.name.replace(/[._-]+/g, ' ').trim() || 'Event',
          detail: null,
          tone: 'grey',
        };
    }
  });
}

export function approvalRoute(context: BoardTicketDetail['attentionContext'], outcome: 'pass' | 'fail'): string {
  const target = context?.routes[outcome];
  if (!target) return 'route unavailable';
  if (target === '$succeed' || target === '$fail') {
    const end = context?.end[outcome];
    return `workflow ${target === '$succeed' ? 'succeeds' : 'fails'}${typeof end === 'string' ? `: ${end}` : ''}`;
  }
  return `step ${target}`;
}

export const NOBODY_WORKING = 'Nobody is working on this ticket';

export interface TicketWorkModel {
  owner: string;
  round: string;
  branch: string;
  run: string;
  /** The full run id, for the row's title attribute; null when there is no run. */
  runId: string | null;
}

function lastClaimAgent(events: readonly BoardTicketEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.name !== 'ticket.claimed') continue;
    const payload = record(event.payload);
    const agent = text(payload.agent) ?? text(payload.agentId);
    if (agent !== null) return agent;
  }
  return null;
}

function workRound(ticket: BoardTicket, rules: readonly BoardRuleView[]): string {
  if (ticket.activity.state !== 'working') return '—';
  const current = ticket.rounds?.[ticket.status];
  if (typeof current !== 'number' || !Number.isFinite(current)) return '—';
  const total = rules.find((rule) => rule.status === ticket.status)?.maxRounds;
  return typeof total === 'number' && Number.isFinite(total) && total > 0
    ? `${current} of ${total}`
    : String(current);
}

/** The Work card: the current owner and round, or the last claimant for a finished/blocked ticket. */
export function ticketWork(
  detail: BoardTicketDetail,
  rules: readonly BoardRuleView[] = [],
): TicketWorkModel {
  const ticket = detail.ticket;
  const owner = text(ticket.activity.agent) ?? lastClaimAgent(detail.events);
  const runId = text(ticket.activeRunId) ?? text(ticket.runId) ?? text(ticket.activity.run);
  return {
    owner: owner ?? NOBODY_WORKING,
    round: workRound(ticket, rules),
    branch: text(ticket.branch) ?? 'No branch yet',
    run: shortenRunId(runId) ?? '—',
    runId,
  };
}

export interface TicketDependencyRow {
  key: string;
  title: string | null;
  status: string | null;
  statusLabel: string;
  statusTone: BoardStatusTone;
}

function dependencyRows(
  links: readonly BoardTicketLink[],
  statuses: readonly BoardStatusInfo[],
): TicketDependencyRow[] {
  return links.map((link) => {
    const status = link.status?.trim() ?? '';
    if (status === '') {
      return { key: link.key, title: link.title, status: null, statusLabel: 'Unknown', statusTone: 'neutral' };
    }
    const info = statusInfo(status, statuses);
    return {
      key: link.key,
      title: link.title,
      status,
      statusLabel: statusLabel(info),
      statusTone: statusTone(info),
    };
  });
}

/** The "Waits for" list from links.dependsOn. */
export function waitsForRows(
  detail: BoardTicketDetail,
  statuses: readonly BoardStatusInfo[] = [],
): TicketDependencyRow[] {
  return dependencyRows(detail.links.dependsOn, statuses);
}

/** The "Blocks" list from links.dependents. */
export function blocksRows(
  detail: BoardTicketDetail,
  statuses: readonly BoardStatusInfo[] = [],
): TicketDependencyRow[] {
  return dependencyRows(detail.links.dependents, statuses);
}

export interface TicketDetailsModel {
  phase: string;
  priority: string;
  created: string;
  updated: string;
}

/** The Details card: phase, priority and the created/updated timestamps in local time. */
export function ticketDetails(detail: BoardTicketDetail): TicketDetailsModel {
  const ticket = detail.ticket;
  return {
    phase: text(ticket.phaseName) ?? text(ticket.phase) ?? '—',
    priority: String(ticket.priority),
    created: formatLocalTime(ticket.createdAt),
    updated: formatLocalTime(ticket.updatedAt),
  };
}
