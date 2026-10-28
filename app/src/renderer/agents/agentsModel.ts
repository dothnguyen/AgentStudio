import type { AgentDef, TeamOverview } from '../api';

export interface AgentCatalogRow { key: string; catalogIndex: number; agent: AgentDef }
export interface AgentFilterOptions { providers: string[]; reasoningLevels: string[] }
export interface AgentUsageReference { teamId: string | null; teamLabel: string; memberId: string | null; memberLabel: string; role: string | null }
export type AgentUsage =
  | { state: 'unavailable'; memberCount: null; teamCount: null; references: []; summary: 'Usage unavailable' }
  | { state: 'complete' | 'truncated'; memberCount: number; teamCount: number; references: AgentUsageReference[]; summary: string };

export function value(v: unknown): string | null { return typeof v === 'string' && v.trim() ? v.trim() : null; }
export function catalogRows(agents: readonly AgentDef[]): AgentCatalogRow[] {
  return agents.map((agent, catalogIndex) => ({ key: `catalog:${catalogIndex}`, catalogIndex, agent }));
}
export function agentFilterOptions(rows: readonly AgentCatalogRow[]): AgentFilterOptions {
  const providers = new Set<string>(); const reasoningLevels = new Set<string>();
  for (const { agent } of rows) { const p = value(agent.provider); const r = value(agent.reasoning); if (p) providers.add(p); if (r) reasoningLevels.add(r); }
  return { providers: [...providers], reasoningLevels: [...reasoningLevels] };
}
export function filterAgentRows(rows: readonly AgentCatalogRow[], query: string, provider: string, reasoning: string): AgentCatalogRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter(({ agent }) => (!q || [agent.name, agent.id, agent.description].some(v => value(v)?.toLowerCase().includes(q))) && (!provider || value(agent.provider) === provider) && (!reasoning || value(agent.reasoning) === reasoning));
}
export function selectedAgentKey(rows: readonly AgentCatalogRow[], currentKey: string | null): string | null {
  return rows.some(row => row.key === currentKey) ? currentKey : rows[0]?.key ?? null;
}
export function agentUsage(overview: TeamOverview | null, agentId: string | null): AgentUsage {
  if (!overview || !value(agentId)) return { state: 'unavailable', memberCount: null, teamCount: null, references: [], summary: 'Usage unavailable' };
  const references: AgentUsageReference[] = []; let teamCount = 0;
  for (const team of overview.teams) {
    let used = false;
    for (const member of team.members) {
      if (!member.agentOptions.some(option => option.id === agentId)) continue;
      used = true;
      references.push({ teamId: value(team.id), teamLabel: value(team.name) ?? value(team.id) ?? value(team.runtime.teamId) ?? 'Unnamed team', memberId: value(member.memberId), memberLabel: value(member.name) ?? value(member.memberId) ?? 'Unnamed member', role: value(member.role) });
    }
    if (used) teamCount++;
  }
  const memberCount = references.length;
  const truncated = overview.truncated || overview.teams.some(team => team.membersTruncated);
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  const summary = memberCount === 0 ? (truncated ? 'Usage incomplete — no saved references are visible in the loaded teams.' : 'Not used by any saved team member') : `Used by ${truncated ? 'at least ' : ''}${count(memberCount, 'member')} in ${truncated ? 'at least ' : ''}${count(teamCount, 'team')}`;
  return { state: truncated ? 'truncated' : 'complete', memberCount, teamCount, references, summary };
}
