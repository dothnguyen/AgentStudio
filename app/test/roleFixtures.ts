import type { RoleCatalogList } from '../src/shared/management';

export const ROLES_SHA = 'c'.repeat(64);
export const INSTRUCTIONS_SHA = 'd'.repeat(64);

export function roleCatalogFixture(overrides: Partial<RoleCatalogList> = {}): RoleCatalogList {
  return {
    workspace: '/work/a',
    state: 'ok',
    sha256: ROLES_SHA,
    items: [{
      id: 'Developer',
      name: 'Developer',
      description: 'Implements stories',
      instructions: { state: 'ok', path: '.agent-studio/roles/Developer.md', text: 'Write tests.', sha256: INSTRUCTIONS_SHA, bytes: 12 },
      skills: [{ id: 'python-testing', state: 'ok' }, { id: 'retired-skill', state: 'missing' }],
      warnings: [],
      problems: [],
      usage: {
        members: [{
          teamDefId: 'core', teamName: 'Core', memberId: 'dev-1', memberName: 'Dev One',
          saved: true, live: true, availability: 'available', assignment: { id: 'a-1', status: 'running' },
        }],
        boardRules: [],
        workflows: [],
        legacyRoster: [],
        liveRuntime: [],
        count: 1,
        blocking: true,
        partial: false,
      },
    }],
    problems: [],
    availableSkills: ['python-testing', 'story-format'],
    ...overrides,
  };
}
