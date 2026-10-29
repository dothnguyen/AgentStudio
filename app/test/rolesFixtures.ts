import type { RoleCatalogItem, RoleCatalogList } from '../src/shared/management';

export const LONG_ID = `very-long-role-id-${'x'.repeat(120)}`;
export const LONG_PATH = `.agent-studio/roles/${'nested/'.repeat(12)}${LONG_ID}.md`;
export const LONG_TEXT = `Line one\n  indented line\n${'unbroken'.repeat(40)}`;

type Loose = Record<string, unknown>;

export function roleItem(id: string, over: Loose = {}): RoleCatalogItem {
  return {
    id,
    name: id,
    description: null,
    instructions: { state: 'none', path: null, text: null, sha256: null, bytes: null },
    skills: [],
    warnings: [],
    problems: [],
    usage: { members: [], boardRules: [], workflows: [], legacyRoster: [], liveRuntime: { state: 'connected', error: null }, problems: [], count: 0, blocking: false, partial: false },
    ...over,
  } as unknown as RoleCatalogItem;
}

export function usageOf(over: Loose = {}, members: Loose[] = []): RoleCatalogItem['usage'] {
  return { ...(roleItem('x').usage as unknown as Loose), members, count: members.length, ...over } as unknown as RoleCatalogItem['usage'];
}

// Two teams; duplicate member labels with distinct ids; saved-only, live-only and combined rows.
export const MEMBERS: Loose[] = [
  { teamDefId: 'core', teamName: 'Core', memberId: 'dev-1', memberName: 'Dev', saved: { path: 'teams.json', memberIndex: 0 }, live: { availability: 'available', assignment: { id: 'a-1', status: 'running' } } },
  { teamDefId: 'core', teamName: 'Core', memberId: 'dev-2', memberName: 'Dev', saved: { path: 'teams.json', memberIndex: 1 }, live: null },
  { teamDefId: 'ops', teamName: 'Ops', memberId: 'dev-3', memberName: 'Dev', saved: null, live: { availability: 'busy', assignment: null } },
  { teamDefId: null, teamName: null, memberId: null, memberName: null, saved: { path: 'teams.json', memberIndex: 2 }, live: null },
];

export function rolesFixture(over: Partial<RoleCatalogList> = {}): RoleCatalogList {
  return {
    workspace: '/work/a',
    state: 'ok',
    sha256: 'c'.repeat(64),
    items: [
      roleItem('Developer', {
        name: 'Developer', description: 'Implements stories',
        instructions: { state: 'ok', path: '.agent-studio/roles/Developer.md', text: 'Write tests.\nKeep it small.', sha256: 'd'.repeat(64), bytes: 26 },
        skills: [{ id: 'python-testing', state: 'ok' }, { id: 'retired-skill', state: 'missing' }],
        warnings: ['Skill retired-skill is missing'],
        problems: [{ path: 'roles.Developer', message: 'role problem text' }],
        usage: usageOf({ problems: [{ source: 'teams', path: 'teams.json', message: 'source problem text' }] }, MEMBERS),
      }),
      roleItem('Reviewer', { name: 'Code Reviewer', description: 'Reviews changes', instructions: { state: 'missing', path: '.agent-studio/roles/Reviewer.md', text: null, sha256: null, bytes: null } }),
      roleItem('Planner', { name: '  ', description: null, instructions: { state: 'invalid', path: null, text: null, sha256: null, bytes: null } }),
      roleItem('Writer', { description: 'Long text', instructions: { state: 'truncated', path: '.agent-studio/roles/Writer.md', text: 'partial body', sha256: 'e'.repeat(64), bytes: 99999 } }),
      roleItem(LONG_ID, { instructions: { state: 'ok', path: LONG_PATH, text: LONG_TEXT, sha256: 'f'.repeat(64), bytes: 200 } }),
    ],
    problems: [],
    availableSkills: [],
    ...over,
  };
}
