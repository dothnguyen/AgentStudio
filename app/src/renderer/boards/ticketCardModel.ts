import type { BoardRuleView, BoardTicketSummary } from '../api';

/** The visual families of the activity chip; also drives the card's left edge. */
export type TicketActivityTone = 'working' | 'blocked' | 'waiting' | 'queued' | 'idle' | 'done';

export interface TicketActivityChip {
  tone: TicketActivityTone;
  label: string;
}

/** The CSS chip class for each activity tone; shared by board cards and the ticket page. */
export const TICKET_CHIP_TONE_CLASS: Record<TicketActivityTone, string> = {
  working: 'boards-ticket-chip-working',
  blocked: 'boards-ticket-chip-blocked',
  waiting: 'boards-ticket-chip-waiting',
  queued: 'boards-ticket-chip-queued',
  idle: 'boards-ticket-chip-idle',
  done: 'boards-ticket-chip-done',
};

/** The ticket statuses that mean the ticket is finished on the board. */
const FINISHED_STATUSES: readonly string[] = ['done', 'close'];

function isBlocked(ticket: BoardTicketSummary): boolean {
  return ticket.activity.state === 'blocked' || ticket.workflowStatus === 'blocked';
}

function isFinished(ticket: BoardTicketSummary): boolean {
  return ticket.activity.state === 'finished' || FINISHED_STATUSES.includes(ticket.status);
}

/** The first open dependency key, used by the "Waits for" chip. */
function firstWaitingKey(ticket: BoardTicketSummary): string | null {
  const key = (ticket.openDependsOn ?? []).map((entry) => entry.trim()).find((entry) => entry !== '');
  if (key !== undefined) return key;
  // The activity's waitingFor normally names a role, but tolerate a ticket key so the card still
  // renders a useful chip when the caller has only the activity summary.
  const waitingFor = (ticket.activity.waitingFor ?? '').trim();
  return /^T-\d{3,}$/.test(waitingFor) ? waitingFor : null;
}

/** "round 2/6" only when both the current round and the rule's limit are known. */
export function roundLabel(
  ticket: BoardTicketSummary,
  rules: readonly BoardRuleView[],
): string | null {
  if (ticket.activity.state !== 'working') return null;
  const current = ticket.rounds?.[ticket.status];
  const total = rules.find((rule) => rule.status === ticket.status)?.maxRounds ?? null;
  if (typeof current !== 'number' || typeof total !== 'number') return null;
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) return null;
  return `round ${current}/${total}`;
}

/**
 * The card's activity chip. Working and blocked win over the status; finished tickets are
 * "Merged" (or "Closed"); a not-started ticket waits for its open dependencies, then shows
 * "Ready, queued" when a worker rule owns its status, and "Not started" otherwise.
 */
export function ticketActivityChip(
  ticket: BoardTicketSummary,
  rules: readonly BoardRuleView[] = [],
): TicketActivityChip {
  if (ticket.activity.state === 'working' && !isBlocked(ticket)) {
    const round = roundLabel(ticket, rules);
    return { tone: 'working', label: round === null ? 'Working' : `Working · ${round}` };
  }
  if (isBlocked(ticket)) return { tone: 'blocked', label: 'Blocked' };
  if (isFinished(ticket)) {
    return { tone: 'done', label: (ticket.status as string) === 'close' ? 'Closed' : 'Merged' };
  }

  const waitingKey = firstWaitingKey(ticket);
  if (waitingKey !== null) {
    const extra = Math.max(0, (ticket.openDependsOn ?? []).filter((entry) => entry.trim() !== '').length - 1);
    return { tone: 'waiting', label: extra > 0 ? `Waits for ${waitingKey} +${extra}` : `Waits for ${waitingKey}` };
  }

  const rule = rules.find((candidate) => candidate.status === ticket.status);
  const waitingFor = (ticket.activity.waitingFor ?? '').trim();
  const workerStatus = rule === undefined ? waitingFor !== '' : rule.type === 'agent';
  return workerStatus
    ? { tone: 'queued', label: 'Ready, queued' }
    : { tone: 'idle', label: 'Not started' };
}

/** The first line of a blocked reason (the reason itself may be a paragraph). */
export function blockedReasonLine(reason: string | null): string | null {
  const line = (reason ?? '').split(/\r?\n/, 1)[0]?.trim() ?? '';
  return line === '' ? null : line;
}

/** "dev" -> "DE", "Senior Developer" -> "SD". */
export function agentInitials(agent: string): string {
  const words = agent.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]!.charAt(0)}${words[1]!.charAt(0)}`.toUpperCase();
}
