// Operator-only fixture for the Roles v2 capture page (npm run capture:roles).
// It mirrors the sample data in design/roles-catalog-v2/*.html and never changes the app.
import type { DashboardApi, ManagementApi, RoleCatalogItem, RoleCatalogList } from '../src/renderer/api';
import { createTeamsOverviewV4Apis, TEAMS_V4_WORKSPACE } from './teamsOverviewV4Fixture';

const ROLE_PATH: Record<string, string> = {
  TeamLead: 'roles/team-lead.md',
  Developer: 'roles/developer.md',
  SeniorDeveloper: 'roles/senior-developer.md',
  QA: 'roles/qa.md',
  Reviewer: 'roles/reviewer.md',
  ProductOwner: 'roles/product-owner.md',
};

const DESCRIPTION: Record<string, string> = {
  TeamLead: 'Team lead: unpacks features into phases, epics and stories; refines each story into a detailed technical plan before development and fixes it in place. Does not review code or merge.',
  Developer: 'Developer: implements one approved story at a time, with tests.',
  SeniorDeveloper: 'Senior developer: resolves escalated tickets and recurring QA failures.',
  QA: 'QA: checks every acceptance criterion against the code and tests and returns a verdict.',
  Reviewer: 'Reviewer: reads the ticket diff against the plan and the project conventions and returns a verdict with findings.',
  ProductOwner: 'Product owner: turns rough ideas into tickets with acceptance criteria and a priority.',
};

const SKILLS: Record<string, string[]> = {
  TeamLead: ['story-format', 'code-search'],
  Developer: ['story-format', 'python-testing', 'ts-testing'],
  SeniorDeveloper: ['story-format', 'python-testing', 'ts-testing'],
  QA: ['code-search'],
  Reviewer: ['code-search'],
  ProductOwner: ['story-format'],
};

export const TEAM_LEAD_PROMPT = `You are the team lead for Agent Studio (read PRD.md, ROADMAP.md and phases/ first; they are the source of truth).
You never edit code or tests. You edit planning documents only: story files, a phase README / design contract, and
briefs - and only when the task below says so.

When asked to UNPACK a feature:
- Restate the goal in two sentences, list open questions, and state the assumptions you will use if unanswered.
- Propose phases -> epics -> stories. Each story is small enough for one developer session and independently testable.
- Write the plan into the files the task names (usually phases/phase-NN/...), following the story-format skill.
- End with a short list of decisions the operator must make.

When asked to REVIEW A STORY BEFORE WORK:
- Check it has a clear goal, numbered steps, testable "Done when" items, dependencies, and no hidden scope.`;

function usageMember(running: boolean): Record<string, unknown> {
  return {
    teamDefId: 'dev-team',
    teamName: 'Agent Studio Dev Team',
    memberId: 'lead',
    memberName: 'lead',
    saved: { path: 'teams.json', memberIndex: 0 },
    live: running
      ? { availability: 'available', assignment: { id: 'assignment-1', status: 'running' } }
      : { availability: 'available', assignment: null },
  };
}

function role(id: string, running = false, used = true): RoleCatalogItem {
  const path = ROLE_PATH[id]!;
  const text = id === 'TeamLead' ? TEAM_LEAD_PROMPT : `${DESCRIPTION[id]}\n\nFollow the project conventions and the story format.`;
  return {
    id,
    name: id,
    description: DESCRIPTION[id]!,
    instructions: { state: 'ok', path, text, sha256: 'd'.repeat(64), bytes: new TextEncoder().encode(text).byteLength },
    skills: SKILLS[id]!.map(skill => ({ id: skill, state: 'ok' as const })),
    warnings: [],
    problems: [],
    usage: {
      members: used ? [usageMember(running)] as never : [],
      boardRules: [],
      workflows: [],
      liveRuntime: { state: 'connected', error: null } as never,
      count: used ? 1 : 0,
      blocking: used,
      partial: false,
    },
  };
}

export function rolesCatalogV2(): RoleCatalogList {
  return {
    workspace: TEAMS_V4_WORKSPACE.path,
    state: 'ok',
    sha256: 'c'.repeat(64),
    items: [
      role('TeamLead'),
      role('Developer', true),
      role('SeniorDeveloper'),
      role('QA'),
      role('Reviewer'),
      role('ProductOwner', false, false),
    ],
    problems: [],
    availableSkills: ['story-format', 'python-testing', 'code-search', 'ts-testing'],
  };
}

/** The real Teams v4 shell (workspace, sidebar team row and connection) with the Roles v2 catalog. */
export function createRolesCatalogV2Apis(): { management: ManagementApi; dashboard: DashboardApi } {
  const base = createTeamsOverviewV4Apis();
  return {
    dashboard: base.dashboard,
    management: {
      ...base.management,
      roles: () => Promise.resolve({ ok: true as const, data: rolesCatalogV2() }),
    },
  };
}
