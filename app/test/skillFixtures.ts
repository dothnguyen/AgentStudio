import { createHash } from 'node:crypto';
import type {
  ManagementApi,
  ManagementResult,
  Problem,
  RoleCatalogList,
  SkillCatalogList,
  SkillDeleteResult,
  SkillDetail,
  SkillItem,
  SkillRoleRef,
  SkillRolesResult,
  SkillState,
} from '../src/renderer/api';

export const SKILLS_SHA = 'c'.repeat(64);
export const SKILL_LIMITS = { skillBytes: 32768, roleContextBytes: 98304 };

/** The design's sample contents, byte for byte. */
export const SKILL_TEXT: Record<string, string> = {
  'code-search': '# Searching the code cheaply\n\nPrefer these over reading whole files (they cost far fewer tokens). Read a file only after you know which lines matter.\n\n- Text search: `rg -n "pattern" backend tests` (add `-g \'*.py\'`, `-l` for file names only, `-C 2` for context, `-m 5` to cap hits per file). Use it instead of the Grep tool for big trees.\n- Where is a function or class defined: `rg -n "^(def|class) NAME\\b" backend`, or look it up in the symbol index when it exists.\n- Outline of one file without reading it: `ctags -f - --fields=+nS --sort=no path/to/file.py`.\n- Then read only the range you need with the Read tool (offset and limit).\n- The symbol index `.agent-studio/cache/tags` is built by the operator (`team index`); it can be slightly stale, so confirm with `rg` before editing.\n\nDo not run `ctags -R` yourself (it writes a file).',
  'python-testing': '# Testing Python code\n\nRun the narrowest test first, then the module, then ask for the suite.\n\n- Unit tests live under tests/unit, integration tests under tests/integration.\n- Use the existing helpers in tests/helpers.py instead of writing new fixtures.\n- A test names the behaviour it proves, not the function it calls.',
  'story-format': '# Story format\n\nEvery story file has: a goal, numbered steps, "Done when" items that can each be tested, dependencies, and a Status line.\n\nKeep a story small enough for one developer session.',
  'ts-testing': '# Testing the app (TypeScript)\n\nApp tests live under app/test and use the harness in teamsHarness.tsx.\n\nPrefer role and label queries over test ids.',
};

export const SAMPLE_SKILL_IDS = ['code-search', 'python-testing', 'story-format', 'ts-testing', 'legacy-notes'];

interface SampleRole {
  id: string;
  name: string;
  contextBaseBytes: number;
  skills: string[];
}

export const SAMPLE_ROLES: SampleRole[] = [
  { id: 'TeamLead', name: 'TeamLead', contextBaseBytes: 4800, skills: ['story-format', 'code-search'] },
  { id: 'Developer', name: 'Developer', contextBaseBytes: 5600, skills: ['story-format', 'python-testing', 'code-search'] },
  { id: 'SeniorDeveloper', name: 'SeniorDeveloper', contextBaseBytes: 3100, skills: ['story-format', 'python-testing', 'legacy-notes'] },
  { id: 'QA', name: 'QA', contextBaseBytes: 2700, skills: ['code-search'] },
  { id: 'Reviewer', name: 'Reviewer', contextBaseBytes: 2200, skills: ['code-search'] },
  { id: 'ProductOwner', name: 'ProductOwner', contextBaseBytes: 3900, skills: ['story-format'] },
];

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

function titleOf(text: string): string | null {
  for (const line of text.split('\n')) if (line.trim() !== '') return line.replace(/^#+\s*/, '');
  return null;
}

function contextBytes(role: SampleRole, items: Map<string, string | null>): number {
  let total = role.contextBaseBytes;
  for (const skill of role.skills) {
    const text = items.get(skill);
    if (text !== null && text !== undefined) total += utf8Bytes(text);
  }
  return total;
}

function sampleRoleRefs(skillId: string, items: Map<string, string | null> = sampleItems()): SkillRoleRef[] {
  return SAMPLE_ROLES
    .filter((role) => role.skills.includes(skillId))
    .map((role) => ({ id: role.id, name: role.name, contextBytes: contextBytes(role, items) }));
}

function sampleItems(): Map<string, string | null> {
  const items = new Map<string, string | null>();
  for (const id of SAMPLE_SKILL_IDS) items.set(id, SKILL_TEXT[id] ?? null);
  return items;
}

export function skillItem(overrides: Partial<SkillItem> = {}): SkillItem {
  const id = overrides.id ?? 'code-search';
  const text = SKILL_TEXT[id];
  const state: SkillState = overrides.state ?? (text === undefined ? 'missing' : 'ok');
  const readable = (state === 'ok' || state === 'truncated') && text !== undefined;
  return {
    id,
    path: overrides.path ?? `skills/${id}/SKILL.md`,
    state,
    title: overrides.title !== undefined ? overrides.title : readable ? titleOf(text!) : null,
    bytes: overrides.bytes !== undefined ? overrides.bytes : readable ? utf8Bytes(text!) : null,
    sha256: overrides.sha256 !== undefined ? overrides.sha256 : readable ? sha256Hex(text!) : null,
    roles: overrides.roles ?? sampleRoleRefs(id),
  };
}

export function skillCatalog(overrides: Partial<SkillCatalogList> = {}): SkillCatalogList {
  return {
    workspace: '/work/a',
    rolesSha256: SKILLS_SHA,
    limits: { ...SKILL_LIMITS },
    skills: [...SAMPLE_SKILL_IDS].sort().map((id) => skillItem({ id })),
    problems: [{ path: 'skills/legacy-notes/SKILL.md', message: "Skill 'legacy-notes' has no readable SKILL.md." }],
    ...overrides,
  };
}

export function skillDetail(id = 'code-search', overrides: Partial<SkillDetail> = {}): SkillDetail {
  const catalog = skillCatalog();
  const skill = catalog.skills.find((entry) => entry.id === id) ?? skillItem({ id });
  const text = skill.state === 'ok' || skill.state === 'truncated' ? SKILL_TEXT[id] ?? '' : null;
  return { workspace: catalog.workspace, skill, text, ...overrides };
}

export type SkillMethod = 'skills' | 'skill' | 'createSkill' | 'updateSkill' | 'deleteSkill' | 'updateSkillRoles' | 'roles';
export interface SkillCall {
  method: SkillMethod;
  args: unknown[];
}

interface FakeSkill {
  id: string;
  text: string | null;
  folder: 'removed' | 'kept';
  /** Explicit catalog state; omitted means readable text is ok and null text is missing. */
  state?: SkillState;
}

interface FakeRole {
  id: string;
  name: string | null;
  contextBaseBytes: number;
  skills: Set<string>;
}

export interface FakeSkillInitial {
  workspace?: string;
  rolesSha256?: string | null;
  skills?: Array<{ id: string; text: string | null; folder?: 'removed' | 'kept'; state?: SkillState }>;
  roles?: Array<{ id: string; name?: string | null; contextBaseBytes?: number; skills?: string[] }>;
  problems?: Problem[];
}

export interface FakeSkillManagement extends Pick<ManagementApi, SkillMethod> {
  calls: SkillCall[];
}

const ok = <T>(data: T): ManagementResult<T> => ({ ok: true, data });
const fail = <T = never>(code: string, message: string, data?: unknown): ManagementResult<T> => ({
  ok: false,
  error: data === undefined ? { code, message, retryable: false } : { code, message, retryable: false, data },
});

export function fakeSkillManagement(initial: FakeSkillInitial = {}): FakeSkillManagement {
  const workspace = initial.workspace ?? '/work/a';
  const calls: SkillCall[] = [];
  const skills = new Map<string, FakeSkill>();
  for (const skill of initial.skills ?? SAMPLE_SKILL_IDS.map((id) => ({ id, text: SKILL_TEXT[id] ?? null }))) {
    skills.set(skill.id, { id: skill.id, text: skill.text, folder: skill.folder ?? 'removed', state: skill.state });
  }
  const roles = new Map<string, FakeRole>();
  for (const role of initial.roles ?? SAMPLE_ROLES) {
    roles.set(role.id, {
      id: role.id,
      name: role.name ?? role.id,
      contextBaseBytes: role.contextBaseBytes ?? 0,
      skills: new Set(role.skills ?? []),
    });
  }
  let rolesSha256 = initial.rolesSha256 !== undefined ? initial.rolesSha256 : SKILLS_SHA;
  const extraProblems = initial.problems ?? [];
  const log = (method: SkillMethod, args: unknown[]) => { calls.push({ method, args }); };

  const stateOf = (skill: FakeSkill): SkillState => skill.state ?? (skill.text !== null ? 'ok' : 'missing');

  const itemFor = (skill: FakeSkill): SkillItem => {
    const state = stateOf(skill);
    const readable = (state === 'ok' || state === 'truncated') && skill.text !== null;
    return {
      id: skill.id,
      path: `skills/${skill.id}/SKILL.md`,
      state,
      title: readable ? titleOf(skill.text!) : null,
      bytes: readable ? utf8Bytes(skill.text!) : null,
      sha256: readable ? sha256Hex(skill.text!) : null,
      roles: [...roles.values()]
        .filter((role) => role.skills.has(skill.id))
        .map((role) => ({ id: role.id, name: role.name, contextBytes: roleContext(role) })),
    };
  };

  const roleContext = (role: FakeRole): number => {
    let total = role.contextBaseBytes;
    for (const id of role.skills) {
      const text = skills.get(id)?.text;
      if (text !== null && text !== undefined) total += utf8Bytes(text);
    }
    return total;
  };

  const catalog = (): SkillCatalogList => {
    const listed = new Set<string>();
    for (const role of roles.values()) for (const id of role.skills) listed.add(id);
    const entries = new Map<string, FakeSkill>();
    for (const skill of skills.values()) entries.set(skill.id, skill);
    // A role can list an id that has no folder at all; the backend still shows it as missing.
    for (const id of listed) {
      if (!entries.has(id)) entries.set(id, { id, text: null, folder: 'removed' });
    }
    // A folder without SKILL.md that no role lists is not shown; an unreadable or
    // truncated folder still exists and stays in the catalog.
    const items = [...entries.values()]
      .filter((skill) => stateOf(skill) !== 'missing' || listed.has(skill.id))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(itemFor);
    const missing = items
      .filter((item) => item.state === 'missing')
      .map((item) => ({ path: item.path, message: `Skill '${item.id}' has no readable SKILL.md.` }));
    const unreadable = items
      .filter((item) => item.state === 'unreadable')
      .map((item) => ({ path: item.path, message: `Skill '${item.id}' could not be read as regular UTF-8 text.` }));
    const problems: Problem[] = [];
    const seen = new Set<string>();
    for (const problem of [...extraProblems, ...missing, ...unreadable]) {
      const key = `${problem.path}\n${problem.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      problems.push({ ...problem });
    }
    return { workspace, rolesSha256, limits: { ...SKILL_LIMITS }, skills: items, problems };
  };

  const detail = (skill: FakeSkill): SkillDetail => ({ workspace, skill: itemFor(skill), text: skill.text });

  // The write commands never read roles.json, so their result has no role refs.
  const writeDetail = (skill: FakeSkill): SkillDetail => ({
    workspace,
    skill: { ...itemFor(skill), roles: [] },
    text: skill.text,
  });

  const computeRolesSha = (): string => sha256Hex(JSON.stringify(
    [...roles.values()].map((role) => [role.id, [...role.skills].sort()]),
  ));

  const skillOrMissing = (id: string): FakeSkill | null => skills.get(id) ?? null;

  const skillsList = async (_workspaceId: string): Promise<ManagementResult<SkillCatalogList>> => {
    log('skills', [_workspaceId]);
    return ok(catalog());
  };

  const skillShow = async (_workspaceId: string, skillId: string): Promise<ManagementResult<SkillDetail>> => {
    log('skill', [_workspaceId, skillId]);
    const item = catalog().skills.find((entry) => entry.id === skillId);
    if (item === undefined) return fail('SKILL_NOT_FOUND', `Skill '${skillId}' was not found.`);
    const text = item.state === 'ok' || item.state === 'truncated' ? skills.get(skillId)?.text ?? null : null;
    return ok({ workspace, skill: item, text });
  };

  const createSkill = async (
    _workspaceId: string,
    input: { id: string; text: string },
  ): Promise<ManagementResult<SkillDetail>> => {
    log('createSkill', [_workspaceId, input]);
    const existing = skills.get(input.id);
    // Only an existing SKILL.md blocks a create; a folder a role lists without one is creatable.
    if (existing !== undefined && existing.text !== null) {
      return fail('SKILL_EXISTS', `Skill '${input.id}' already exists.`);
    }
    if (existing !== undefined) {
      existing.text = input.text;
      return ok(writeDetail(existing));
    }
    const skill: FakeSkill = { id: input.id, text: input.text, folder: 'removed' };
    skills.set(input.id, skill);
    return ok(writeDetail(skill));
  };

  const updateSkill = async (
    _workspaceId: string,
    skillId: string,
    text: string,
    expectedSha256: string,
  ): Promise<ManagementResult<SkillDetail>> => {
    log('updateSkill', [_workspaceId, skillId, text, expectedSha256]);
    const skill = skillOrMissing(skillId);
    if (skill === null || skill.text === null) return fail('SKILL_NOT_FOUND', `Skill '${skillId}' was not found.`);
    const current = sha256Hex(skill.text);
    if (current !== expectedSha256) {
      return fail('CONFIG_CHANGED', `Skill '${skillId}' changed since it was read; reload and retry.`, { skillSha256: current });
    }
    skill.text = text;
    return ok(writeDetail(skill));
  };

  const deleteSkill = async (
    _workspaceId: string,
    skillId: string,
    expectedRolesSha256: string | null,
    expectedSha256: string | null,
  ): Promise<ManagementResult<SkillDeleteResult>> => {
    log('deleteSkill', [_workspaceId, skillId, expectedRolesSha256, expectedSha256]);
    const skill = skillOrMissing(skillId);
    if (skill === null || stateOf(skill) === 'missing') {
      return fail('SKILL_NOT_FOUND', `Skill '${skillId}' has no skills/${skillId}/SKILL.md to delete; a missing skill has nothing to delete.`);
    }
    const state = stateOf(skill);
    const skillSha256 = skill.text === null ? null : sha256Hex(skill.text);
    if (rolesSha256 !== expectedRolesSha256) {
      return fail('CONFIG_CHANGED', '.agent-studio/roles.json changed since it was read; reload and retry.',
        { rolesSha256, skillSha256 });
    }
    // An unreadable or truncated file has no stable catalog token, so null skips
    // the content check; a readable file still has to match its full hash.
    if (expectedSha256 === null ? state === 'ok' : skillSha256 !== expectedSha256) {
      return fail('CONFIG_CHANGED', `Skill '${skillId}' changed since it was read; reload and retry.`,
        { rolesSha256, skillSha256 });
    }
    const usedBy = [...roles.values()].filter((role) => role.skills.has(skillId)).map((role) => role.id);
    if (usedBy.length > 0) {
      return fail('SKILL_IN_USE', `Skill '${skillId}' is still used by role(s) ${usedBy.join(', ')}.`, { roles: usedBy });
    }
    skills.delete(skillId);
    return ok({ workspace, deleted: { id: skillId, folder: skill.folder }, rolesSha256 });
  };

  const updateSkillRoles = async (
    _workspaceId: string,
    skillId: string,
    wanted: string[],
    expectedRolesSha256: string | null,
  ): Promise<ManagementResult<SkillRolesResult>> => {
    log('updateSkillRoles', [_workspaceId, skillId, wanted, expectedRolesSha256]);
    if (new Set(wanted).size !== wanted.length) {
      return fail('BAD_REQUEST', `Argument 'roles' contains role '${wanted.find((id, i) => wanted.indexOf(id) !== i)}' more than once.`);
    }
    if (rolesSha256 !== expectedRolesSha256) {
      return fail('CONFIG_CHANGED', '.agent-studio/roles.json changed since it was read; reload and retry.', { rolesSha256 });
    }
    for (const roleId of wanted) {
      if (!roles.has(roleId)) {
        return fail('ROLE_NOT_FOUND', `Role '${roleId}' is not defined in .agent-studio/roles.json.`);
      }
    }
    const wantedSet = new Set(wanted);
    const current = [...roles.values()].filter((role) => role.skills.has(skillId)).map((role) => role.id);
    const currentSet = new Set(current);
    const added = [...roles.values()].filter((role) => wantedSet.has(role.id) && !currentSet.has(role.id)).map((role) => role.id);
    const removed = [...roles.values()].filter((role) => currentSet.has(role.id) && !wantedSet.has(role.id)).map((role) => role.id);
    if (added.length > 0 && (skills.get(skillId)?.text ?? null) === null) {
      return fail('SKILL_NOT_FOUND', `Skill '${skillId}' has no .agent-studio/skills/${skillId}/SKILL.md; create it before adding it to a role.`);
    }
    if (added.length > 0 || removed.length > 0) {
      for (const role of roles.values()) {
        if (added.includes(role.id)) role.skills.add(skillId);
        if (removed.includes(role.id)) role.skills.delete(skillId);
      }
      rolesSha256 = computeRolesSha();
    }
    return ok({
      workspace,
      skill: skillId,
      roles: [...roles.values()].filter((role) => role.skills.has(skillId)).map((role) => role.id),
      added,
      removed,
      rolesSha256: rolesSha256 as string,
    });
  };

  const roleCatalog = async (_workspaceId: string): Promise<ManagementResult<RoleCatalogList>> => {
    log('roles', [_workspaceId]);
    const availableSkills = [...skills.values()]
      .filter((skill) => skill.text !== null)
      .map((skill) => skill.id)
      .sort();
    return ok({
      workspace,
      state: 'ok',
      sha256: rolesSha256,
      items: [...roles.values()].map((role) => ({
        id: role.id,
        name: role.name ?? role.id,
        description: null,
        instructions: { state: 'none' as const, path: null, text: null, sha256: null, bytes: null },
        skills: [...role.skills].sort().map((id) => ({
          id,
          state: (skills.get(id)?.text ?? null) === null ? 'missing' as const : 'ok' as const,
        })),
        warnings: [],
        problems: [],
        usage: {
          members: [], boardRules: [], workflows: [], legacyRoster: [], liveRuntime: [],
          count: 0, blocking: false, partial: false,
        },
      })),
      problems: [],
      availableSkills,
    });
  };

  return {
    calls,
    skills: skillsList,
    skill: skillShow,
    createSkill,
    updateSkill,
    deleteSkill,
    updateSkillRoles,
    roles: roleCatalog,
  };
}
