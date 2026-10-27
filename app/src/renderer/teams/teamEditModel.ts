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
  agent: string;
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
  return applies === true ? ' Changes apply the next time the team starts.' : '';
}

export function problemsSuffix(problems: Problem[]): string {
  return problems.length === 0
    ? ''
    : ` The team still has ${plural(problems.length, 'problem', 'problems')}; see the team details.`;
}

export function memberFormInitial(m: OverviewMember): MemberFormValues {
  return {
    name: m.name ?? '',
    role: m.role ?? '',
    agent: m.source === 'catalog' ? (m.agentDefId ?? '') : '',
  };
}

export function emptyMemberForm(): MemberFormValues {
  return { name: '', role: '', agent: '' };
}

export function validateMemberForm(
  v: MemberFormValues,
  mode: 'add' | 'edit',
): Partial<Record<keyof MemberFormValues, string>> {
  const errors: Partial<Record<keyof MemberFormValues, string>> = {};
  if (mode === 'add') {
    if (v.agent === '') errors.agent = 'Choose an agent.';
  } else if (v.name.trim() === '') {
    errors.name = 'Enter a name.';
  }
  if (v.role.trim() === '') errors.role = 'Enter a role.';
  return errors;
}

export function addMemberInput(v: MemberFormValues): MemberInput {
  const input: MemberInput = { role: v.role.trim(), agent: v.agent };
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
  if (current.agent !== '' && current.agent !== initial.agent) changes.agent = current.agent;
  return Object.keys(changes).length === 0 ? null : changes;
}
