import type { AgentDef, ManagementError, OverviewMember, OverviewTeam, RuntimeSwitchState } from '../../shared/management';
import { delegationText } from './teamsModel';

export const SWITCH_REFRESH_LIMIT = 5;
export const SWITCH_REFRESH_INTERVAL_MS = 250;
export type MemberActionKind = 'switch' | 'resume';
export type MemberActionInFlight = { memberId: string; agentId: string; kind: MemberActionKind } | null;
export type AgentActionState = 'active' | 'switchable' | 'held' | 'missing_catalog' | 'pending' | 'pane_dead' | 'ineligible';
export interface AgentActionOption { id: string; label: string; active: boolean; state: AgentActionState; holdText: string | null; canSwitch: boolean; canResume: boolean; disabledReason: string | null }
export interface MemberAgentActionsView { visible: boolean; activeText: string; availabilityText: string; paneText: string; staleText: string | null; assignmentText: string; workText: string | null; pendingText: string | null; lastResultText: string | null; notice: string | null; allHeld: boolean; options: AgentActionOption[] }
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
function liveWorkText(work: OverviewMember['work']): string | null {
  if (work.state === 'none') return null;
  if (work.state === 'unavailable') return `Current work unavailable — ${work.reason}`;
  const waiting = delegationText(work);
  if (waiting !== null) return work.ticket !== null ? `${work.ticket.key} · ${work.ticket.title} · ${waiting}` : waiting;
  if (work.ticket !== null) return `${work.ticket.key} · ${work.ticket.title} · ${work.ticket.status}`;
  if (work.assignment !== null && work.assignment.goal.trim() !== '') return work.assignment.goal;
  return 'Working';
}
export function memberAgentActions(team: OverviewTeam, member: OverviewMember, catalog: AgentDef[] | null, connected: boolean, inFlight: MemberActionInFlight): MemberAgentActionsView {
  const r = member.runtime;
  if (!r) return { visible: false, activeText: '', availabilityText: '', paneText: '', staleText: null, assignmentText: '', workText: null, pendingText: null, lastResultText: null, notice: null, allHeld: false, options: [] };
  const inline = member.agentMode === 'inline' || member.source === 'inline';
  const unknownEligibility = r.configuredAgents === null;
  const frozen = [...new Set(r.configuredAgents ?? [])];
  const switchTargets = inline || unknownEligibility ? [] : frozen;
  const isHeld = (id: string) => Object.prototype.hasOwnProperty.call(r.quotaHolds, id);
  const label = (id: string) => catalog?.find(a => a.id === id)?.name || id;
  const base = !connected ? 'Backend disconnected; live actions are disabled.' : team.runtime.state !== 'running' ? 'The team is not running.' : r.stale ? 'Live member state is stale; refresh before switching or resuming.' : null;
  const paneAlive = r.paneState === 'alive';
  const locked = inFlight?.memberId === member.memberId;
  const ids = [...new Set([...switchTargets, ...Object.keys(r.quotaHolds)])];
  const options: AgentActionOption[] = ids.map(id => {
    const held = isHeld(id);
    const missing = catalog !== null && !catalog.some(a => a.id === id);
    const reason = base ?? (!paneAlive ? "The member's pane is not alive." : r.pendingAgent ? 'A switch is already pending for this member.' : locked ? 'Requesting…' : unknownEligibility ? 'Live agent eligibility is unavailable; switching is disabled.' : inline ? 'Live switching is unavailable for inline members.' : catalog === null ? 'Agent catalog unavailable; switching is disabled.' : missing ? `Agent '${id}' is missing from the catalog.` : held && frozen.includes(id) ? `Agent '${id}' is on quota hold.` : id === r.activeAgent && frozen.includes(id) ? 'That agent is already active.' : !frozen.includes(id) ? `Agent '${id}' is not configured for this member.` : !['idle', 'limit_reached'].includes(r.availability) && !r.assignment ? 'Member must be idle, quota-limited, or have an active assignment before switching.' : null);
    const active = id === r.activeAgent;
    const canSwitch = reason === null;
    const state: AgentActionState = active ? 'active' : r.pendingAgent === id ? 'pending' : held ? 'held' : missing ? 'missing_catalog' : !paneAlive ? 'pane_dead' : canSwitch ? 'switchable' : 'ineligible';
    return { id, label: label(id), active, state, holdText: held ? formatResetAt(r.quotaHolds[id]) : null, canSwitch, canResume: held && !base && paneAlive && !locked && !r.pendingAgent, disabledReason: reason };
  });
  const alternatives = switchTargets.filter(id => id !== r.activeAgent);
  const allHeld = alternatives.length > 0 && alternatives.every(isHeld);
  const s = r.lastSwitch;
  const result = s ? `Switch to ${label(s.requestedAgent)} ${s.state}${(s.code !== null || s.message !== null) ? ` — ${s.code ?? ''}${s.code !== null && s.message !== null ? ': ' : ''}${s.message ?? ''}` : s.state === 'completed' ? '.' : ''}` : null;
  const notice = base ?? (!paneAlive ? "The member's pane is not alive." : inline ? 'Live switching is unavailable for inline members.' : unknownEligibility ? 'Live agent eligibility is unavailable; switching is disabled. Recorded quota holds can still be resumed.' : allHeld ? 'All alternate agents are on quota hold.' : null);
  return { visible: true, activeText: [r.activeAgent ?? 'Unknown', r.provider, r.model, r.reasoning && `Reasoning: ${r.reasoning}`].filter(Boolean).join(' · '), availabilityText: r.availability === 'idle' ? 'Available' : r.availability, paneText: r.paneState ? `Pane: ${r.paneState}` : 'Pane state unavailable', staleText: r.stale ? 'Live state is stale.' : null, assignmentText: r.assignment ? `${r.assignment.id} · ${r.assignment.status} · ${r.assignment.taskId}` : 'No active assignment', workText: liveWorkText(member.work), pendingText: r.pendingAgent ? `Switch to ${label(r.pendingAgent)} pending.` : null, lastResultText: result, notice, allHeld, options };
}

export function memberActionKey(teamDefId: string, memberId: string): string { return JSON.stringify([teamDefId, memberId]); }
