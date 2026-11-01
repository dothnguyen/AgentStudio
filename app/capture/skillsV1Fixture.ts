// Operator-only fixture for the Skills v1 capture page (npm run capture:skills).
// It mirrors the sample data in design/skills-v1/*.html and never changes the app.
import type {
  DashboardApi,
  ManagementApi,
  ManagementResult,
  RoleCatalogItem,
  RoleCatalogList,
  SkillCatalogList,
  SkillDetail,
  SkillItem,
} from '../src/renderer/api';
import { rolesCatalogV2 } from './rolesCatalogV2Fixture';
import { createTeamsOverviewV4Apis, TEAMS_V4_WORKSPACE } from './teamsOverviewV4Fixture';

export const SKILL_CAPTURE_LIMITS = { skillBytes: 32768, roleContextBytes: 98304 };

/** The design's sample contents, kept close to the static markup so the capture is comparable. */
export const SKILL_CAPTURE_TEXT: Record<string, string> = {
  'code-search': '# Searching the code cheaply\n\nPrefer these over reading whole files (they cost far fewer tokens). Read a file only after you know which lines matter.\n\n- Text search: `rg -n "pattern" backend tests` (add `-g \'*.py\'`, `-l` for file names only, `-C 2` for context, `-m 5` to cap hits per file). Use it instead of the Grep tool for big trees.\n- Where is a function or class defined: `rg -n "^(def|class) NAME\\b" backend`, or look it up in the symbol index when it exists.\n- Outline of one file without reading it: `ctags -f - --fields=+nS --sort=no path/to/file.py`.\n- Then read only the range you need with the Read tool (offset and limit).\n- The symbol index `.agent-studio/cache/tags` is built by the operator (`team index`); it can be slightly stale, so confirm with `rg` before editing.\n\nDo not run `ctags -R` yourself (it writes a file).',
  'python-testing': '# Testing Python code\n\nRun the narrowest test first, then the module, then ask for the suite.\n\n- Unit tests live under tests/unit, integration tests under tests/integration.\n- Use the existing helpers in tests/helpers.py instead of writing new fixtures.\n- A test names the behaviour it proves, not the function it calls.',
  'story-format': '# Story format\n\nEvery story file has: a goal, numbered steps, "Done when" items that can each be tested, dependencies, and a Status line.\n\nKeep a story small enough for one developer session.',
  'ts-testing': '# Testing the app (TypeScript)\n\nApp tests live under app/test and use the harness in teamsHarness.tsx.\n\nPrefer role and label queries over test ids.',
};

const SAMPLE_ROLES: Array<{ id: string; name: string; contextBytes: number; skills: string[] }> = [
  { id: 'TeamLead', name: 'TeamLead', contextBytes: 5836, skills: ['story-format', 'code-search'] },
  { id: 'Developer', name: 'Developer', contextBytes: 6963, skills: ['story-format', 'python-testing', 'code-search'] },
  { id: 'SeniorDeveloper', name: 'SeniorDeveloper', contextBytes: 3584, skills: ['story-format', 'python-testing', 'legacy-notes'] },
  { id: 'QA', name: 'QA', contextBytes: 3584, skills: ['code-search'] },
  { id: 'Reviewer', name: 'Reviewer', contextBytes: 3072, skills: ['code-search'] },
  { id: 'ProductOwner', name: 'ProductOwner', contextBytes: 3990, skills: ['story-format'] },
];

function bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

function titleOf(text: string): string | null {
  for (const line of text.split('\n')) if (line.trim() !== '') return line.replace(/^#+\s*/, '');
  return null;
}

function roleRefs(skillId: string): SkillItem['roles'] {
  return SAMPLE_ROLES
    .filter(role => role.skills.includes(skillId))
    .map(role => ({ id: role.id, name: role.name, contextBytes: role.contextBytes }));
}

function skill(id: string): SkillItem {
  const text = SKILL_CAPTURE_TEXT[id];
  if (text === undefined) {
    return {
      id,
      path: `skills/${id}/SKILL.md`,
      state: 'missing',
      title: null,
      bytes: null,
      sha256: null,
      roles: roleRefs(id),
    };
  }
  return {
    id,
    path: `skills/${id}/SKILL.md`,
    state: 'ok',
    title: titleOf(text),
    bytes: bytes(text),
    sha256: 'a'.repeat(64),
    roles: roleRefs(id),
  };
}

export function skillsV1Catalog(): SkillCatalogList {
  return {
    workspace: TEAMS_V4_WORKSPACE.path,
    rolesSha256: 'c'.repeat(64),
    limits: { ...SKILL_CAPTURE_LIMITS },
    skills: ['code-search', 'python-testing', 'story-format', 'ts-testing', 'legacy-notes'].map(skill),
    problems: [{ path: 'skills/legacy-notes/SKILL.md', message: "Skill 'legacy-notes' has no readable SKILL.md." }],
  };
}

export function skillsV1Detail(id: string): SkillDetail {
  const item = skillsV1Catalog().skills.find(entry => entry.id === id) ?? skill(id);
  const text = item.state === 'ok' ? SKILL_CAPTURE_TEXT[id] ?? null : null;
  return { workspace: TEAMS_V4_WORKSPACE.path, skill: item, text };
}

function skillsV1Roles(): RoleCatalogList {
  const base = rolesCatalogV2();
  const names = new Map(base.items.map(role => [role.id, role.name]));
  const items: RoleCatalogItem[] = SAMPLE_ROLES.map(role => ({
    id: role.id,
    name: names.get(role.id) ?? role.name,
    description: base.items.find(item => item.id === role.id)?.description ?? null,
    instructions: { state: 'none', path: null, text: null, sha256: null, bytes: null },
    skills: role.skills.map(id => ({ id, state: id === 'legacy-notes' ? 'missing' as const : 'ok' as const })),
    warnings: [],
    problems: [],
    usage: {
      members: [],
      boardRules: [],
      workflows: [],
      legacyRoster: [],
      liveRuntime: { state: 'connected', error: null } as never,
      count: 0,
      blocking: false,
      partial: false,
    },
  }));
  return { ...base, items, availableSkills: ['code-search', 'python-testing', 'story-format', 'ts-testing'] };
}

/** The real Teams v4 shell with the Skills v1 catalog and role sample data. */
export function createSkillsV1Apis(): { management: ManagementApi; dashboard: DashboardApi } {
  const base = createTeamsOverviewV4Apis();
  const ok = <T,>(data: T): Promise<ManagementResult<T>> => Promise.resolve({ ok: true, data });
  return {
    dashboard: base.dashboard,
    management: {
      ...base.management,
      skills: () => ok(skillsV1Catalog()),
      skill: (_workspaceId: string, skillId: string) => ok(skillsV1Detail(skillId)),
      roles: () => ok(skillsV1Roles()),
    },
  };
}
