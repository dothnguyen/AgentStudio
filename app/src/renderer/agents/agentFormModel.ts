import type { AgentDef, AgentDefInput, AgentDefChanges, AgentEditorProviderOption, ManagementError } from '../../shared/management';
export type AgentFormMode = 'create' | 'edit' | 'duplicate';
export interface AgentFormValues { id: string; name: string; provider: string; model: string; reasoning: string; description: string }
export type AgentFormErrors = Partial<Record<keyof AgentFormValues, string>>;
export type AgentFormRequest = { kind: 'create'; input: AgentDefInput } | { kind: 'update'; agentId: string; changes: AgentDefChanges };
const clean = (s: unknown): string => typeof s === 'string' ? s.trim() : '';
export function emptyAgentForm(providers: readonly AgentEditorProviderOption[]): AgentFormValues { return { id: '', name: '', provider: providers[0]?.id ?? '', model: '', reasoning: '', description: '' }; }
export function editAgentForm(agent: AgentDef): AgentFormValues { return { id: clean(agent.id), name: clean(agent.name), provider: clean(agent.provider), model: clean(agent.model), reasoning: clean(agent.reasoning), description: clean(agent.description) }; }
export function duplicateAgentId(sourceId: string, existingIds: readonly string[]): string {
  for (let i = 1; ; i++) { const suffix = i === 1 ? '-copy' : `-copy-${i}`; const prefix = sourceId.slice(0, 64 - suffix.length).replace(/-+$/, ''); const id = prefix + suffix; if (!existingIds.includes(id)) return id; }
}
export function duplicateAgentForm(agent: AgentDef, existingIds: readonly string[]): AgentFormValues { const values = editAgentForm(agent); return { ...values, id: duplicateAgentId(values.id, existingIds), name: `${values.name.slice(0, 75).trimEnd()} copy` }; }
export function validateAgentForm(values: AgentFormValues, mode: AgentFormMode, existingIds: readonly string[], providers: readonly AgentEditorProviderOption[]): AgentFormErrors {
  const { id, name, provider, model, reasoning, description } = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, clean(v)])) as unknown as AgentFormValues;
  const errors: AgentFormErrors = {};
  if (!id) errors.id = 'Enter an agent id.'; else if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) errors.id = 'Use 1–64 lowercase letters, digits, or hyphens, starting with a letter or digit.'; else if (mode !== 'edit' && existingIds.includes(id)) errors.id = 'That agent id already exists.';
  if (!name) errors.name = 'Enter an agent name.'; else if (name.length > 80) errors.name = 'Use 80 characters or fewer.';
  if (description.length > 4000) errors.description = 'Use 4000 characters or fewer.';
  const option = providers.find(p => p.id === provider);
  if (!provider) errors.provider = 'Choose a provider.'; else if (!option) errors.provider = 'Choose a provider supplied by the backend.';
  if (model && option && !option.modelSelectable) errors.model = 'This provider does not support choosing a model.'; else if (model && !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/.test(model)) errors.model = 'Use 1–128 letters, digits, or . _ : / @ + - characters, starting with a letter or digit.';
  if (reasoning && option && !option.reasoningLevels.includes(reasoning)) errors.reasoning = 'Choose a reasoning level supplied for this provider.';
  return errors;
}
export function agentInput(values: AgentFormValues): AgentDefInput { const input: AgentDefInput = { id: clean(values.id), name: clean(values.name), provider: clean(values.provider) }; for (const field of ['description', 'model', 'reasoning'] as const) { const v = clean(values[field]); if (v) input[field] = v; } return input; }
export function agentChanges(original: AgentDef, values: AgentFormValues): AgentDefChanges | null { const saved = editAgentForm(original); const changes: AgentDefChanges = {}; for (const field of ['name', 'provider'] as const) if (clean(values[field]) !== saved[field]) changes[field] = clean(values[field]); for (const field of ['description', 'model', 'reasoning'] as const) if (clean(values[field]) !== saved[field]) changes[field] = clean(values[field]) || null; return Object.keys(changes).length ? changes : null; }
export function agentErrorProblems(error: ManagementError): { fields: AgentFormErrors; unmatched: string[] } { const fields: AgentFormErrors = {}; const unmatched: string[] = []; const data = error.data as { problems?: unknown } | null; if (!Array.isArray(data?.problems)) return { fields, unmatched }; for (const item of data.problems) { if (!item || typeof item.path !== 'string' || typeof item.message !== 'string') continue; const match = /(?:^|\.)(id|name|provider|model|reasoning|description)$/.exec(item.path); if (match) fields[match[1] as keyof AgentFormValues] = item.message; else unmatched.push(`${item.path}: ${item.message}`); } return { fields, unmatched }; }
