import type { AgentDef, ManagementError, OverviewMember, OverviewTeam, RuntimeSwitchState } from '../../shared/management';

export const SWITCH_REFRESH_LIMIT = 5;
export const SWITCH_REFRESH_INTERVAL_MS = 250;
export type MemberActionKind = 'switch' | 'resume';
export type MemberActionInFlight = { memberId: string; agentId: string; kind: MemberActionKind } | null;
export interface AgentActionOption { id: string; label: string; active: boolean; holdText: string | null; canSwitch: boolean; canResume: boolean; disabledReason: string | null }
export interface MemberAgentActionsView { visible: boolean; activeText: string; availabilityText: string; assignmentText: string; pendingText: string | null; lastResultText: string | null; notice: string | null; allHeld: boolean; options: AgentActionOption[] }
export function formatResetAt(value: string | null): string {
  if (value === null || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return 'Reset time unknown';
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!parts) return 'Reset time unknown';
  const year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3]);
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]!) return 'Reset time unknown';
  if (Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6] ?? 0) > 59 || Number(parts[7] ?? 0) > 23 || Number(parts[8] ?? 0) > 59) return 'Reset time unknown';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Reset time unknown';
  return `Resets at ${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
export function lastSwitchSignature(value: RuntimeSwitchState | null): string | null {
  return value === null ? null : JSON.stringify([value.state, value.requestedAgent, value.assignmentId, value.code, value.message, value.at]);
}
export function matchingTerminalSwitch(member: OverviewMember, requestedAgent: string, previousSignature: string | null): 'completed' | 'failed' | null {
  const s = member.runtime?.lastSwitch;
  return s && s.requestedAgent === requestedAgent && (s.state === 'completed' || s.state === 'failed') && lastSwitchSignature(s) !== previousSignature ? s.state : null;
}
export function assignmentConfirmation(error: ManagementError): { assignmentId: string } | null {
  if (error.code !== 'BAD_REQUEST' || error.message !== 'Member has an active assignment; confirm cancellation of this assignment to switch.' || !error.data || typeof error.data !== 'object') return null;
  const id = (error.data as { assignmentId?: unknown }).assignmentId;
  return typeof id === 'string' && id.trim() !== '' ? { assignmentId: id } : null;
}
export function memberAgentActions(team: OverviewTeam, member: OverviewMember, catalog: AgentDef[] | null, connected: boolean, inFlight: MemberActionInFlight): MemberAgentActionsView {
  const r = member.runtime;
  const empty: MemberAgentActionsView = { visible: false, activeText: '', availabilityText: '', assignmentText: '', pendingText: null, lastResultText: null, notice: null, allHeld: false, options: [] };
  if (!r || member.agentMode === 'inline' || member.source === 'inline') return empty;
  const frozen = r.configuredAgents ?? [];
  const label = (id: string) => catalog?.find(a => a.id === id)?.name || id;
  const base = !connected ? 'Backend disconnected; live actions are disabled.' : team.runtime.state !== 'running' ? 'The team is not running.' : r.stale ? 'Live member state is stale; refresh before switching or resuming.' : null;
  const locked = inFlight?.memberId === member.memberId;
  const options = [...new Set([...frozen, ...Object.keys(r.quotaHolds)])].map(id => {
    const held = Object.prototype.hasOwnProperty.call(r.quotaHolds, id);
    const reason = base ?? (r.paneState !== 'alive' ? "The member's pane is not alive." : r.pendingAgent ? 'A switch is already pending for this member.' : locked ? 'Requesting…' : catalog === null ? 'Agent catalog unavailable; switching is disabled.' : !catalog.some(a => a.id === id) ? `Agent '${id}' is missing from the catalog.` : held ? `Agent '${id}' is on quota hold.` : id === r.activeAgent ? 'That agent is already active.' : !frozen.includes(id) ? `Agent '${id}' is not configured for this member.` : !['idle', 'limit_reached'].includes(r.availability) && !r.assignment ? 'Member must be idle, quota-limited, or have an active assignment before switching.' : null);
    return { id, label: label(id), active: id === r.activeAgent, holdText: held ? formatResetAt(r.quotaHolds[id]) : null, canSwitch: reason === null, canResume: held && !base && !locked && !r.pendingAgent, disabledReason: reason };
  });
  const alternatives = frozen.filter(id => id !== r.activeAgent);
  const allHeld = alternatives.length > 0 && alternatives.every(id => Object.prototype.hasOwnProperty.call(r.quotaHolds, id));
  const s = r.lastSwitch;
  const result = s ? `Switch to ${label(s.requestedAgent)} ${s.state}${(s.code !== null || s.message !== null) ? ` — ${s.code ?? ''}${s.code !== null && s.message !== null ? ': ' : ''}${s.message ?? ''}` : s.state === 'completed' ? '.' : ''}` : null;
  return { visible: true, activeText: [r.activeAgent ?? 'Unknown', r.provider, r.model, r.reasoning && `Reasoning: ${r.reasoning}`].filter(Boolean).join(' · '), availabilityText: r.availability === 'idle' ? 'Available' : r.availability, assignmentText: r.assignment ? `${r.assignment.id} · ${r.assignment.status} · ${r.assignment.taskId}` : 'No active assignment', pendingText: r.pendingAgent ? `Switch to ${label(r.pendingAgent)} pending.` : null, lastResultText: result, notice: base ?? (r.paneState !== 'alive' ? "The member's pane is not alive." : allHeld ? 'All alternate agents are on quota hold.' : null), allHeld, options };
}

export function memberActionKey(teamDefId: string, memberId: string): string { return JSON.stringify([teamDefId, memberId]); }
