import { describe, expect, it } from 'vitest';
import {
  SKILLS_SHA,
  SKILL_TEXT,
  fakeSkillManagement,
  sha256Hex,
  skillCatalog,
  skillDetail,
  skillItem,
} from './skillFixtures';

const CODE_SHA = sha256Hex(SKILL_TEXT['code-search']);
const TS_SHA = sha256Hex(SKILL_TEXT['ts-testing']);

describe('skillFixtures', () => {
  it('builds the design sample catalog with five skills including the missing one', () => {
    const catalog = skillCatalog();
    expect(catalog.skills.map((skill) => skill.id)).toEqual([
      'code-search', 'legacy-notes', 'python-testing', 'story-format', 'ts-testing',
    ]);
    expect(catalog.rolesSha256).toBe(SKILLS_SHA);
    expect(catalog.limits).toEqual({ skillBytes: 32768, roleContextBytes: 98304 });
    expect(catalog.skills.find((skill) => skill.id === 'code-search')).toEqual(skillItem({ id: 'code-search' }));
    expect(catalog.skills.find((skill) => skill.id === 'code-search')!.bytes).toBe(839);
    expect(catalog.skills.find((skill) => skill.id === 'legacy-notes')).toMatchObject({
      state: 'missing', title: null, bytes: null, sha256: null,
      roles: [{ id: 'SeniorDeveloper' }],
    });
    expect(catalog.problems).toEqual([
      { path: 'skills/legacy-notes/SKILL.md', message: "Skill 'legacy-notes' has no readable SKILL.md." },
    ]);
  });

  it('reads the catalog and one skill, with null text for a missing skill', async () => {
    const fake = fakeSkillManagement();
    const catalog = await fake.skills('ws');
    expect(catalog).toEqual({ ok: true, data: skillCatalog() });
    const detail = await fake.skill('ws', 'code-search');
    expect(detail).toEqual({ ok: true, data: { workspace: '/work/a', skill: skillItem({ id: 'code-search' }), text: SKILL_TEXT['code-search'] } });
    expect(await fake.skill('ws', 'legacy-notes')).toMatchObject({ ok: true, data: { text: null, skill: { state: 'missing' } } });
    expect(await fake.skill('ws', 'nope')).toEqual({ ok: false, error: { code: 'SKILL_NOT_FOUND', message: "Skill 'nope' was not found.", retryable: false } });
  });

  it('creates a skill once and returns SKILL_EXISTS for a duplicate', async () => {
    const fake = fakeSkillManagement();
    const created = await fake.createSkill('ws', { id: 'new-skill', text: '# New\n' });
    expect(created).toMatchObject({
      ok: true,
      data: {
        workspace: '/work/a',
        text: '# New\n',
        skill: { id: 'new-skill', path: 'skills/new-skill/SKILL.md', state: 'ok', title: 'New', bytes: 6, sha256: sha256Hex('# New\n'), roles: [] },
      },
    });
    expect(await fake.skills('ws')).toMatchObject({ ok: true, data: { skills: expect.arrayContaining([expect.objectContaining({ id: 'new-skill' })]) } });
    expect(await fake.createSkill('ws', { id: 'new-skill', text: '' })).toEqual({
      ok: false, error: { code: 'SKILL_EXISTS', message: "Skill 'new-skill' already exists.", retryable: false },
    });
  });

  it('creates a skill whose folder a role lists without SKILL.md, once', async () => {
    const fake = fakeSkillManagement();
    const text = '# Notes\n';
    const created = await fake.createSkill('ws', { id: 'legacy-notes', text });
    expect(created).toMatchObject({
      ok: true,
      data: {
        text,
        skill: { id: 'legacy-notes', state: 'ok', title: 'Notes', roles: [] },
      },
    });
    const catalog = await fake.skills('ws');
    expect(catalog).toMatchObject({
      ok: true,
      data: {
        skills: expect.arrayContaining([
          expect.objectContaining({
            id: 'legacy-notes',
            state: 'ok',
            roles: expect.arrayContaining([expect.objectContaining({ id: 'SeniorDeveloper' })]),
          }),
        ]),
        problems: [],
      },
    });
    expect(await fake.createSkill('ws', { id: 'legacy-notes', text: '' })).toEqual({
      ok: false, error: { code: 'SKILL_EXISTS', message: "Skill 'legacy-notes' already exists.", retryable: false },
    });
  });

  it('hides a missing folder no role lists but shows a role-listed missing skill', async () => {
    const fake = fakeSkillManagement({
      skills: [
        { id: 'orphan', text: null },
        { id: 'readable', text: '# Readable\n' },
      ],
      roles: [{ id: 'Developer', skills: ['readable', 'dangling'] }],
    });
    expect(await fake.skills('ws')).toMatchObject({
      ok: true,
      data: {
        skills: [
          expect.objectContaining({
            id: 'dangling',
            state: 'missing',
            roles: expect.arrayContaining([expect.objectContaining({ id: 'Developer' })]),
          }),
          expect.objectContaining({ id: 'readable', state: 'ok' }),
        ],
      },
    });
    const catalog = await fake.skills('ws');
    expect(catalog).toMatchObject({
      ok: true,
      data: { skills: expect.not.arrayContaining([expect.objectContaining({ id: 'orphan' })]) },
    });
    expect(await fake.skill('ws', 'orphan')).toEqual({
      ok: false, error: { code: 'SKILL_NOT_FOUND', message: "Skill 'orphan' was not found.", retryable: false },
    });
    expect(await fake.skill('ws', 'dangling')).toMatchObject({ ok: true, data: { text: null, skill: { state: 'missing' } } });
  });

  it('creates an unlisted missing folder and keeps it on delete when other files remain', async () => {
    const fake = fakeSkillManagement({
      skills: [{ id: 'orphan', text: null, folder: 'kept' }],
      roles: [],
    });
    expect(await fake.skills('ws')).toMatchObject({ ok: true, data: { skills: [] } });
    const text = '# Orphan\n';
    expect(await fake.createSkill('ws', { id: 'orphan', text })).toMatchObject({
      ok: true,
      data: { text, skill: { id: 'orphan', state: 'ok', roles: [] } },
    });
    expect(await fake.skills('ws')).toMatchObject({
      ok: true,
      data: { skills: [expect.objectContaining({ id: 'orphan', state: 'ok' })], problems: [] },
    });
    expect(await fake.deleteSkill('ws', 'orphan', SKILLS_SHA, sha256Hex(text))).toEqual({
      ok: true,
      data: { workspace: '/work/a', deleted: { id: 'orphan', folder: 'kept' }, rolesSha256: SKILLS_SHA },
    });
  });

  it('updates a skill only with the current sha and reports the stale sha on CONFIG_CHANGED', async () => {
    const fake = fakeSkillManagement();
    const stale = await fake.updateSkill('ws', 'python-testing', 'new', 'f'.repeat(64));
    expect(stale).toEqual({
      ok: false,
      error: {
        code: 'CONFIG_CHANGED',
        message: "Skill 'python-testing' changed since it was read; reload and retry.",
        retryable: false,
        data: { skillSha256: sha256Hex(SKILL_TEXT['python-testing']) },
      },
    });
    const updated = await fake.updateSkill('ws', 'python-testing', '# Changed\n\nBody', sha256Hex(SKILL_TEXT['python-testing']));
    expect(updated).toMatchObject({
      ok: true,
      data: {
        text: '# Changed\n\nBody',
        skill: { title: 'Changed', sha256: sha256Hex('# Changed\n\nBody'), roles: [] },
      },
    });
    const catalog = await fake.skills('ws');
    expect(catalog).toMatchObject({ ok: true, data: { skills: expect.arrayContaining([expect.objectContaining({ id: 'python-testing', sha256: sha256Hex('# Changed\n\nBody') })]) } });
    expect(await fake.updateSkill('ws', 'legacy-notes', 'x', 'f'.repeat(64))).toMatchObject({ ok: false, error: { code: 'SKILL_NOT_FOUND' } });
  });

  it('deletes an unused skill and refuses a stale token or a used skill', async () => {
    const fake = fakeSkillManagement();
    const staleRoles = await fake.deleteSkill('ws', 'ts-testing', 'f'.repeat(64), TS_SHA);
    expect(staleRoles).toEqual({
      ok: false,
      error: {
        code: 'CONFIG_CHANGED',
        message: '.agent-studio/roles.json changed since it was read; reload and retry.',
        retryable: false,
        data: { rolesSha256: SKILLS_SHA, skillSha256: TS_SHA },
      },
    });
    const staleSkill = await fake.deleteSkill('ws', 'ts-testing', SKILLS_SHA, 'f'.repeat(64));
    expect(staleSkill).toMatchObject({ ok: false, error: { code: 'CONFIG_CHANGED', data: { rolesSha256: SKILLS_SHA, skillSha256: TS_SHA } } });
    const inUse = await fake.deleteSkill('ws', 'code-search', SKILLS_SHA, CODE_SHA);
    expect(inUse).toMatchObject({ ok: false, error: { code: 'SKILL_IN_USE', data: { roles: ['TeamLead', 'Developer', 'QA', 'Reviewer'] } } });
    expect(await fake.deleteSkill('ws', 'ts-testing', SKILLS_SHA, TS_SHA)).toEqual({
      ok: true, data: { workspace: '/work/a', deleted: { id: 'ts-testing', folder: 'removed' }, rolesSha256: SKILLS_SHA },
    });
    expect(await fake.skills('ws')).toMatchObject({ ok: true, data: { skills: expect.not.arrayContaining([expect.objectContaining({ id: 'ts-testing' })]) } });
    expect(await fake.deleteSkill('ws', 'ts-testing', SKILLS_SHA, TS_SHA)).toMatchObject({ ok: false, error: { code: 'SKILL_NOT_FOUND' } });
  });

  it('updates the roles that list a skill in one write, including removing a missing skill', async () => {
    const fake = fakeSkillManagement();
    const added = await fake.updateSkillRoles('ws', 'ts-testing', ['Developer', 'QA'], SKILLS_SHA);
    expect(added).toMatchObject({
      ok: true,
      data: { workspace: '/work/a', skill: 'ts-testing', roles: ['Developer', 'QA'], added: ['Developer', 'QA'], removed: [] },
    });
    const rolesSha = (added as { ok: true; data: { rolesSha256: string } }).data.rolesSha256;
    expect(rolesSha).not.toBe(SKILLS_SHA);
    expect(await fake.skills('ws')).toMatchObject({ ok: true, data: { rolesSha256: rolesSha } });
    const noop = await fake.updateSkillRoles('ws', 'ts-testing', ['QA', 'Developer'], rolesSha);
    expect(noop).toMatchObject({ ok: true, data: { roles: ['Developer', 'QA'], added: [], removed: [], rolesSha256: rolesSha } });
    const removed = await fake.updateSkillRoles('ws', 'ts-testing', ['Developer'], rolesSha);
    expect(removed).toMatchObject({ ok: true, data: { roles: ['Developer'], added: [], removed: ['QA'] } });
    const removeMissing = await fake.updateSkillRoles('ws', 'legacy-notes', [], (removed as { ok: true; data: { rolesSha256: string } }).data.rolesSha256);
    expect(removeMissing).toMatchObject({ ok: true, data: { roles: [], removed: ['SeniorDeveloper'] } });
    expect(await fake.updateSkillRoles('ws', 'legacy-notes', ['Developer'], (removeMissing as { ok: true; data: { rolesSha256: string } }).data.rolesSha256))
      .toMatchObject({ ok: false, error: { code: 'SKILL_NOT_FOUND' } });
  });

  it('deletes a formerly missing skill once its role references are removed', async () => {
    const fake = fakeSkillManagement();
    const text = '# Notes\n';
    await fake.createSkill('ws', { id: 'legacy-notes', text });
    const cleared = await fake.updateSkillRoles('ws', 'legacy-notes', [], SKILLS_SHA);
    const rolesSha = (cleared as { ok: true; data: { rolesSha256: string } }).data.rolesSha256;
    expect(cleared).toMatchObject({ ok: true, data: { removed: ['SeniorDeveloper'], roles: [] } });
    expect(await fake.deleteSkill('ws', 'legacy-notes', rolesSha, sha256Hex(text))).toEqual({
      ok: true,
      data: { workspace: '/work/a', deleted: { id: 'legacy-notes', folder: 'removed' }, rolesSha256: rolesSha },
    });
    expect(await fake.skills('ws')).toMatchObject({
      ok: true,
      data: {
        skills: expect.not.arrayContaining([expect.objectContaining({ id: 'legacy-notes' })]),
        problems: [],
      },
    });
  });

  it('refuses to add a role to a skill with no folder but allows the empty no-op', async () => {
    const fake = fakeSkillManagement();
    expect(await fake.updateSkillRoles('ws', 'never-existed', ['Developer'], SKILLS_SHA)).toMatchObject({
      ok: false, error: { code: 'SKILL_NOT_FOUND' },
    });
    expect(await fake.skills('ws')).toMatchObject({ ok: true, data: { rolesSha256: SKILLS_SHA } });
    expect(await fake.updateSkillRoles('ws', 'never-existed', [], SKILLS_SHA)).toMatchObject({
      ok: true,
      data: { skill: 'never-existed', roles: [], added: [], removed: [], rolesSha256: SKILLS_SHA },
    });
  });

  it('rejects stale role tokens, unknown roles and duplicates in role updates', async () => {
    const fake = fakeSkillManagement();
    expect(await fake.updateSkillRoles('ws', 'ts-testing', [], 'f'.repeat(64))).toEqual({
      ok: false,
      error: {
        code: 'CONFIG_CHANGED',
        message: '.agent-studio/roles.json changed since it was read; reload and retry.',
        retryable: false,
        data: { rolesSha256: SKILLS_SHA },
      },
    });
    expect(await fake.updateSkillRoles('ws', 'ts-testing', ['Nope'], SKILLS_SHA))
      .toMatchObject({ ok: false, error: { code: 'ROLE_NOT_FOUND' } });
    expect(await fake.updateSkillRoles('ws', 'ts-testing', ['Developer', 'Developer'], SKILLS_SHA))
      .toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
  });

  it('builders keep their design defaults and apply every override', () => {
    const overridden = skillItem({
      id: 'code-search',
      state: 'truncated',
      title: null,
      bytes: 12,
      sha256: 'd'.repeat(64),
      roles: [{ id: 'QA', name: null, contextBytes: 7 }],
    });
    expect(overridden).toEqual({
      id: 'code-search',
      path: 'skills/code-search/SKILL.md',
      state: 'truncated',
      title: null,
      bytes: 12,
      sha256: 'd'.repeat(64),
      roles: [{ id: 'QA', name: null, contextBytes: 7 }],
    });
    expect(skillItem({ id: 'not-in-the-samples' })).toMatchObject({
      state: 'missing', title: null, bytes: null, sha256: null, roles: [],
    });
    expect(skillCatalog({ workspace: '/w', rolesSha256: null, skills: [], problems: [] })).toEqual({
      workspace: '/w',
      rolesSha256: null,
      limits: { skillBytes: 32768, roleContextBytes: 98304 },
      skills: [],
      problems: [],
    });
    expect(skillDetail('code-search', { workspace: '/w', text: 'custom' })).toMatchObject({
      workspace: '/w', text: 'custom', skill: { id: 'code-search', state: 'ok' },
    });
    expect(skillDetail('legacy-notes')).toMatchObject({ text: null, skill: { id: 'legacy-notes', state: 'missing' } });
    expect(skillDetail('never-listed')).toMatchObject({ text: null, skill: { id: 'never-listed', state: 'missing' } });
  });

  it('honours a custom initial workspace, roles sha, skills, roles and problems', async () => {
    const onlyText = '# Only\n';
    const fake = fakeSkillManagement({
      workspace: '/custom',
      rolesSha256: null,
      skills: [{ id: 'only-skill', text: onlyText }],
      roles: [{ id: 'Reviewer', name: 'Reviewer', contextBaseBytes: 10, skills: ['only-skill'] }],
      problems: [{ path: 'skills/only-skill/SKILL.md', message: 'custom problem' }],
    });
    expect(await fake.skills('ws')).toEqual({
      ok: true,
      data: {
        workspace: '/custom',
        rolesSha256: null,
        limits: { skillBytes: 32768, roleContextBytes: 98304 },
        skills: [{
          id: 'only-skill',
          path: 'skills/only-skill/SKILL.md',
          state: 'ok',
          title: 'Only',
          bytes: onlyText.length,
          sha256: sha256Hex(onlyText),
          roles: [{ id: 'Reviewer', name: 'Reviewer', contextBytes: 10 + onlyText.length }],
        }],
        problems: [{ path: 'skills/only-skill/SKILL.md', message: 'custom problem' }],
      },
    });
    expect(await fake.updateSkill('ws', 'only-skill', onlyText, sha256Hex(onlyText))).toMatchObject({ ok: true });
    expect(await fake.deleteSkill('ws', 'only-skill', null, sha256Hex(onlyText)))
      .toMatchObject({ ok: false, error: { code: 'SKILL_IN_USE', data: { roles: ['Reviewer'] } } });
  });

  it('deletes with a null roles token and keeps a folder that still has other files', async () => {
    const text = '# Kept\n';
    const fake = fakeSkillManagement({
      roles: [],
      rolesSha256: null,
      skills: [{ id: 'kept-skill', text, folder: 'kept' }],
    });
    expect(await fake.deleteSkill('ws', 'kept-skill', null, sha256Hex(text))).toEqual({
      ok: true,
      data: { workspace: '/work/a', deleted: { id: 'kept-skill', folder: 'kept' }, rolesSha256: null },
    });
    expect(await fake.skills('ws')).toMatchObject({ ok: true, data: { rolesSha256: null, skills: [] } });
  });

  it('logs every call with its arguments', async () => {
    const fake = fakeSkillManagement();
    await fake.skills('ws');
    await fake.skill('ws', 'ts-testing');
    await fake.createSkill('ws', { id: 'new-skill', text: '' });
    await fake.updateSkill('ws', 'new-skill', 'x', sha256Hex(''));
    await fake.updateSkillRoles('ws', 'new-skill', [], SKILLS_SHA);
    await fake.deleteSkill('ws', 'new-skill', SKILLS_SHA, sha256Hex('x'));
    expect(fake.calls.map((call) => call.method)).toEqual([
      'skills', 'skill', 'createSkill', 'updateSkill', 'updateSkillRoles', 'deleteSkill',
    ]);
    expect(fake.calls[1]).toEqual({ method: 'skill', args: ['ws', 'ts-testing'] });
    expect(fake.calls[2]).toEqual({ method: 'createSkill', args: ['ws', { id: 'new-skill', text: '' }] });
  });
});
