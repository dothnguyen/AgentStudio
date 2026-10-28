import type {
  ManagementError,
  MemberChanges,
  MemberInput,
  OverviewMember,
  OverviewTeam,
  Problem,
  TeamOverview,
} from '../api';
import { plural } from './teamsModel';

export type WriteFeedback =
  | { kind: 'success'; text: string }
  | {
      kind: 'error';
      title: string;
      code: string;
      message: string;
      remediation: string | null;
      problems: string[];
      hint: string | null;
    };

export interface MemberFormValues {
  name: string;
  role: string;
  agents: string[];
  useCatalogAgents: boolean;
}

export function isLiveTeam(team: OverviewTeam): boolean {
  return team.runtime.state === 'running' || team.runtime.state === 'starting';
}

export function canEditTeam(team: OverviewTeam): boolean {
  return team.id !== null && (team.definition.state === 'valid' || team.definition.state === 'problems');
}

export function uneditableNote(team: OverviewTeam): string | null {
  if (canEditTeam(team)) return null;
  if (team.definition.state === 'unreadable' && team.id !== null) {
    return "This team's definition could not be read; fix the file before editing it here.";
  }
  return 'This team has no definition file; it cannot be edited here.';
}

export function liveNote(team: OverviewTeam): string | null {
  return isLiveTeam(team)
    ? 'This team is running. Stop it before deleting the team or removing members; other edits apply the next time it starts.'
    : null;
}

export function canEditMember(team: OverviewTeam, m: OverviewMember): boolean {
  return canEditTeam(team) && m.memberId !== null && m.source !== 'runtime';
}

export function knownRoles(o: TeamOverview | null): string[] {
  if (o === null) return [];
  const roles = new Set<string>();
  for (const t of o.teams) {
    for (const m of t.members) {
      if (m.roleState === 'defined' && m.role !== null) roles.add(m.role);
    }
  }
  return [...roles].sort((a, b) => a.localeCompare(b));
}

export function thrownError(reason: unknown): ManagementError {
  return {
    code: 'INTERNAL',
    message: reason instanceof Error ? reason.message : String(reason),
    retryable: false,
  };
}

function problemLines(data: unknown): string[] {
  if (typeof data !== 'object' || data === null) return [];
  const problems = (data as { problems?: unknown }).problems;
  if (!Array.isArray(problems)) return [];
  const lines: string[] = [];
  for (const p of problems) {
    if (typeof p !== 'object' || p === null) continue;
    const { path, message } = p as { path?: unknown; message?: unknown };
    if (typeof path === 'string' && typeof message === 'string') lines.push(`${path}: ${message}`);
  }
  return lines;
}

export function errorFeedback(title: string, error: ManagementError): WriteFeedback {
  return {
    kind: 'error',
    title,
    code: error.code,
    message: error.message,
    remediation: typeof error.remediation === 'string' && error.remediation !== '' ? error.remediation : null,
    problems: problemLines(error.data),
    hint: error.code === 'TEAM_ALREADY_RUNNING'
      ? 'Stop the team before deleting it or removing members.'
      : null,
  };
}

export function nextStartSuffix(applies: boolean | undefined): string {
  return applies === true ? ' Saved configuration applies on the next team start; the running member is unchanged.' : '';
}

export function problemsSuffix(problems: Problem[]): string {
  return problems.length === 0
    ? ''
    : ` The team still has ${plural(problems.length, 'problem', 'problems')}; see the team details.`;
}

export function addAgentOption(agents: readonly string[], agentId: string): string[] {
  return agentId.trim() === '' || agents.includes(agentId) ? [...agents] : [...agents, agentId];
}
export function removeAgentOption(agents: readonly string[], index: number): string[] {
  return agents.filter((_, i) => i !== index);
}
export function moveAgentOption(agents: readonly string[], index: number, delta: -1 | 1): string[] {
  const result = [...agents];
  const target = index + delta;
  if (index >= 0 && index < result.length && target >= 0 && target < result.length) {
    [result[index], result[target]] = [result[target]!, result[index]!];
  }
  return result;
}
export function validateAgentOptions(agents: readonly string[], missingAgentIds: ReadonlySet<string>): string | null {
  if (agents.length === 0) return 'Choose at least one agent.';
  if (new Set(agents).size !== agents.length) return 'Each agent can appear only once.';
  if (agents.some((id) => missingAgentIds.has(id))) return 'Remove or replace missing catalog agents before saving.';
  return null;
}
export function memberFormInitial(m: OverviewMember): MemberFormValues {
  const catalog = m.agentMode !== 'inline';
  const agents = m.agentOptions.map((o) => o.id);
  if (m.agentMode === 'single_catalog' && agents.length === 0 && m.defaultAgent !== null) agents.push(m.defaultAgent);
  return { name: m.name ?? '', role: m.role ?? '', agents: catalog ? agents : [], useCatalogAgents: catalog };
}
export function emptyMemberForm(): MemberFormValues {
  return { name: '', role: '', agents: [], useCatalogAgents: true };
}
export function validateMemberForm(v: MemberFormValues, mode: 'add' | 'edit', missingAgentIds: ReadonlySet<string>): Partial<Record<keyof MemberFormValues, string>> {
  const errors: Partial<Record<keyof MemberFormValues, string>> = {};
  if (mode === 'edit' && v.name.trim() === '') errors.name = 'Enter a name.';
  if (v.role.trim() === '') errors.role = 'Enter a role.';
  if (v.useCatalogAgents) {
    const error = validateAgentOptions(v.agents, missingAgentIds);
    if (error !== null) errors.agents = error;
  }
  return errors;
}
export function addMemberInput(v: MemberFormValues): MemberInput {
  const input: MemberInput = { role: v.role.trim(), agents: [...v.agents] };
  const name = v.name.trim();
  if (name !== '') input.name = name;
  return input;
}
export function memberChanges(initial: MemberFormValues, current: MemberFormValues): MemberChanges | null {
  const changes: MemberChanges = {};
  const name = current.name.trim();
  const role = current.role.trim();
  if (name !== initial.name) changes.name = name;
  if (role !== initial.role) changes.role = role;
  if (current.useCatalogAgents && (!initial.useCatalogAgents || current.agents.length !== initial.agents.length || current.agents.some((id, i) => id !== initial.agents[i]))) changes.agents = [...current.agents];
  return Object.keys(changes).length === 0 ? null : changes;
}
