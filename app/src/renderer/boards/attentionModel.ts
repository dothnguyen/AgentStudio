import type {
  AttentionRun,
  BoardTicketSummary,
  TeamOverview,
} from '../api';
import { blockedReasonLine } from './ticketCardModel';

/** How many rows the Needs attention card shows before its "Show N more" button. */
export const ATTENTION_ROW_LIMIT = 4;

export type AttentionSource = 'blocked' | 'command' | 'run';

export interface AttentionRow {
  /** A stable list key; two sources can name the same ticket. */
  id: string;
  source: AttentionSource;
  /** The ticket key, or the run id when it has no ticket. */
  key: string;
  title: string;
  reason: string;
  /** The ticket page to open, or null when the source has no ticket. */
  ticketKey: string | null;
}

const BLOCKED_FALLBACK = 'Blocked. Unblock it to continue.';

function line(value: string | null | undefined): string | null {
  return blockedReasonLine(value ?? null);
}

function findRun(overview: TeamOverview, workflowRunId: string): AttentionRun | null {
  for (const team of overview.teams) {
    const run = team.attention.runs.find((candidate) => candidate.workflowRunId === workflowRunId);
    if (run !== undefined) return run;
  }
  return null;
}

function roleFor(overview: TeamOverview, memberId: string | null): string {
  if (memberId === null) return 'a team member';
  for (const team of overview.teams) {
    const member = team.members.find((candidate) => candidate.memberId === memberId);
    if (member === undefined) continue;
    const role = member.role?.trim() ?? '';
    if (role !== '') return role;
    const name = member.name?.trim() ?? '';
    if (name !== '') return name;
    return memberId;
  }
  return memberId;
}

function blockedRows(
  overview: TeamOverview,
  boardTickets: readonly BoardTicketSummary[],
): AttentionRow[] {
  const rows: AttentionRow[] = [];
  const seen = new Set<string>();

  for (const ticket of overview.blockedTickets) {
    const key = ticket.key.trim();
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    rows.push({
      id: `blocked-${key}`,
      source: 'blocked',
      key,
      title: ticket.title,
      reason: line(ticket.reason) ?? BLOCKED_FALLBACK,
      ticketKey: key,
    });
  }

  // The overview is the primary source, but a blocked ticket on the board is still attention
  // even when the overview read is partial or truncated.
  for (const ticket of boardTickets) {
    if (ticket.workflowStatus !== 'blocked') continue;
    const key = ticket.key.trim();
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    rows.push({
      id: `blocked-${key}`,
      source: 'blocked',
      key,
      title: ticket.title,
      reason: line(ticket.blockedReason) ?? line(ticket.activity.note) ?? BLOCKED_FALLBACK,
      ticketKey: key,
    });
  }

  return rows;
}

function commandRows(overview: TeamOverview): AttentionRow[] {
  const rows: AttentionRow[] = [];
  for (const team of overview.teams) {
    for (const request of team.attention.commandRequests) {
      if (request.status !== 'requested') continue;
      const run = findRun(overview, request.workflowRunId);
      const ticketKey = run?.ticketKey?.trim() || null;
      rows.push({
        id: `command-${request.id}`,
        source: 'command',
        key: ticketKey ?? request.workflowRunId,
        title: `A delegated command waits for approval: ${request.command}`,
        reason: `Requested by ${roleFor(overview, request.memberId)}. It needs a human to approve it before the ticket can continue.`,
        ticketKey,
      });
    }
  }
  return rows;
}

/** A paused run, or a run the coordinator attached a diagnostic code to, needs a human. */
function needsAttention(run: AttentionRun): boolean {
  return run.status === 'paused' || (run.diagnosticCode?.trim() ?? '') !== '';
}

function runRows(overview: TeamOverview): AttentionRow[] {
  const rows: AttentionRow[] = [];
  for (const team of overview.teams) {
    for (const run of team.attention.runs) {
      if (!needsAttention(run)) continue;
      const ticketKey = run.ticketKey?.trim() || null;
      const stage = run.stage?.trim() ?? '';
      const diagnostic = run.diagnosticCode?.trim() ?? '';
      rows.push({
        id: `run-${run.workflowRunId}`,
        source: 'run',
        key: ticketKey ?? run.workflowRunId,
        title: run.status === 'paused' ? 'A workflow run is paused' : 'A workflow run needs attention',
        reason: diagnostic !== ''
          ? `The run reported ${diagnostic}.`
          : stage !== ''
            ? `Paused at stage ${stage}.`
            : 'The run needs a human to retry or cancel it.',
        ticketKey,
      });
    }
  }
  return rows;
}

/**
 * The Needs attention rows in design order: blocked tickets, delegated commands waiting for
 * approval, then paused or failing runs. Each source keeps the overview's order.
 */
export function buildAttentionRows(
  overview: TeamOverview,
  boardTickets: readonly BoardTicketSummary[] = [],
): AttentionRow[] {
  return [
    ...blockedRows(overview, boardTickets),
    ...commandRows(overview),
    ...runRows(overview),
  ];
}
