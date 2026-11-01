import type { AgentDef, OverviewMember, ResolvedAgentOption } from '../api';
import { providerModelText } from './teamsModel';

/** The live agent wording shown when the running agent is not the saved default. */
export const AGENT_DIFFERS_NOTE = 'The live agent differs from the saved default. It goes back to the default when the team restarts.';
/** Intro line of the Edit agent options dialog. */
export const AGENT_OPTIONS_INTRO = 'Offered in this order when the team starts. The first is the default.';
/** Footer note of the Edit agent options dialog. */
export const AGENT_OPTIONS_FOOTER = 'Applies on next team start';
/** The explanation shown for inline-agent members in the Agents card and dialog. */
export const INLINE_AGENT_EXPLANATION = 'This member uses inline provider settings, not an Agents catalog entry. They stay unchanged unless you choose Use catalog agents while editing.';
/** The existing sentence for members without a runtime record. */
export const NO_RUNTIME_NOTE = 'Live state is unavailable because this member has no running runtime record.';
/** No saved options were returned for a runtime-only member. */
export const NO_SAVED_OPTIONS_NOTE = 'No saved agent options were returned.';

/** Two-letter mark for an agent: "CL" for Claude Opus, "OC" for OpenCode DeepSeek. */
export function agentMark(name: string | null, id: string): string {
  const source = (name ?? '').trim() === '' ? id.trim() : name!.trim();
  if (source === '') return '?';
  const first = source.split(/[\s\-_.·]+/).filter((part) => part !== '')[0] ?? source;
  const mark = Array.from(first).slice(0, 2).join('').toUpperCase();
  return mark === '' ? '?' : mark;
}

/** `provider · model · Reasoning: reasoning`, the meta line the old detail shows. */
export function agentMeta(provider: string | null, model: string | null, reasoning: string | null): string {
  const base = providerModelText(provider, model);
  return reasoning === null || reasoning === '' ? base : `${base} · Reasoning: ${reasoning}`;
}

function catalogAgent(catalog: readonly AgentDef[] | null, id: string): AgentDef | undefined {
  return catalog?.find((agent) => agent.id === id);
}

function savedOption(member: OverviewMember, id: string): ResolvedAgentOption | undefined {
  return member.agentOptions.find((option) => option.id === id);
}

/**
 * The id of the saved default: the first saved option. Falls back to the
 * member's defaultAgent when an older read model has no options list.
 */
export function savedDefaultAgentId(member: OverviewMember): string | null {
  return member.agentOptions[0]?.id ?? member.defaultAgent ?? null;
}

export interface SavedAgentRow {
  id: string;
  name: string;
  meta: string;
  mark: string;
  isDefault: boolean;
  missing: boolean;
}

/** One draft id resolved for display: catalog first, then the saved option. */
export function agentOptionRow(id: string, member: OverviewMember, catalog: readonly AgentDef[] | null): Omit<SavedAgentRow, 'isDefault'> {
  const agent = catalogAgent(catalog, id);
  const saved = savedOption(member, id);
  const name = agent?.name ?? saved?.name ?? id;
  const provider = agent?.provider ?? (saved?.state === 'ok' ? saved.provider : null);
  const model = agent?.model ?? (saved?.state === 'ok' ? saved.model : null);
  const reasoning = agent?.reasoning ?? (saved?.state === 'ok' ? saved.reasoning : null);
  return {
    id,
    name,
    meta: agentMeta(provider, model, reasoning),
    mark: agentMark(name, id),
    missing: catalog === null ? saved?.state === 'missing' : agent === undefined,
  };
}

/** The saved id list a new dialog draft starts from, in saved order. */
export function initialAgentOptions(member: OverviewMember): string[] {
  const ids = member.agentOptions.map((option) => option.id);
  if (member.agentMode === 'single_catalog' && ids.length === 0 && member.defaultAgent !== null) ids.push(member.defaultAgent);
  return ids;
}

/** True when the member uses inline provider settings (the dialog offers the catalog instead). */
export function isInlineAgentMember(member: OverviewMember): boolean {
  return member.agentMode === 'inline' || member.source === 'inline';
}

/** The saved agent options as read-only rows (no runtime record, and the dialog's starting point). */
export function savedAgentRows(member: OverviewMember, catalog: readonly AgentDef[] | null): SavedAgentRow[] {
  return member.agentOptions.map((option, index) => ({
    ...agentOptionRow(option.id, member, catalog),
    isDefault: index === 0,
  }));
}

export interface LiveAgentRow {
  id: string;
  name: string;
  meta: string;
  mark: string;
  isDefault: boolean;
  missing: boolean;
}

/**
 * Display data for one live-agent option row. The active agent uses the
 * runtime's provider/model/reasoning because that is the live truth; the other
 * rows use the catalog entry, then the saved option.
 */
export function liveAgentRow(option: { id: string; label: string; active: boolean; state: string }, member: OverviewMember, catalog: readonly AgentDef[] | null): LiveAgentRow {
  const agent = catalogAgent(catalog, option.id);
  const saved = savedOption(member, option.id);
  const runtime = member.runtime;
  const active = option.active && runtime !== null;
  const provider = active ? runtime.provider ?? agent?.provider ?? saved?.provider ?? null : agent?.provider ?? saved?.provider ?? null;
  const model = active ? runtime.model ?? agent?.model ?? saved?.model ?? null : agent?.model ?? saved?.model ?? null;
  const reasoning = active ? runtime.reasoning ?? agent?.reasoning ?? saved?.reasoning ?? null : agent?.reasoning ?? saved?.reasoning ?? null;
  const name = agent?.name ?? saved?.name ?? option.label;
  return {
    id: option.id,
    name,
    meta: agentMeta(provider, model, reasoning),
    mark: agentMark(name, option.id),
    isDefault: option.id === savedDefaultAgentId(member),
    missing: option.state === 'missing_catalog',
  };
}

/** True when a runtime record exists and its active agent is not the saved default. */
export function liveDiffersFromDefault(member: OverviewMember): boolean {
  const runtime = member.runtime;
  if (runtime === null || member.agentMode === 'inline' || member.source === 'inline') return false;
  const active = runtime.activeAgent;
  const def = savedDefaultAgentId(member);
  return active !== null && def !== null && active !== def;
}

/** The inline provider summary, for the card and the dialog. */
export function inlineAgentSummary(member: OverviewMember): { name: string; meta: string; mark: string } {
  const provider = member.provider ?? member.model ?? 'Inline agent';
  return {
    name: 'Inline agent',
    meta: agentMeta(member.provider, member.model, member.reasoning),
    mark: agentMark(provider, provider),
  };
}

/** Agent ids in a draft that the catalog does not know. */
export function missingAgentIds(draft: readonly string[], catalog: readonly AgentDef[] | null): Set<string> {
  if (catalog === null) return new Set();
  return new Set(draft.filter((id) => !catalog.some((agent) => agent.id === id)));
}
