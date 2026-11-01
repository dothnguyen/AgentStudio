// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fakeManagement } from './teamsFixtures';
import { skillCatalog } from './skillFixtures';

describe('shared fakeManagement skill wiring', () => {
  it('serves the skill catalog through the same fake the harness hands to screens', async () => {
    const fake = fakeManagement();
    expect(await fake.api.skills('workspace-a')).toEqual({ ok: true, data: skillCatalog() });
    expect(await fake.api.createSkill('workspace-a', { id: 'harness-skill', text: '# Harness\n' }))
      .toMatchObject({ ok: true, data: { skill: { id: 'harness-skill', state: 'ok' } } });
    // State is shared: the returned fake is the one behind every skill method.
    expect(await fake.skillFake.skills('workspace-a')).toMatchObject({
      ok: true,
      data: { skills: expect.arrayContaining([expect.objectContaining({ id: 'harness-skill' })]) },
    });
    expect(fake.skillFake.calls.map((call) => call.method)).toEqual(['skills', 'createSkill', 'skills']);
  });

  it('keeps the fake behind a screen override of one skill call', async () => {
    const skill = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'OFFLINE', message: 'offline', retryable: true },
    }));
    const fake = fakeManagement({ calls: { skill } });
    expect(await fake.api.skill('workspace-a', 'code-search'))
      .toMatchObject({ ok: false, error: { code: 'OFFLINE' } });
    expect(skill).toHaveBeenCalledWith('workspace-a', 'code-search');
    expect(await fake.api.skills('workspace-a')).toEqual({ ok: true, data: skillCatalog() });
  });

  it('exposes every skill write on the shared API', () => {
    const api = fakeManagement().api;
    for (const method of ['skills', 'skill', 'createSkill', 'updateSkill', 'deleteSkill', 'updateSkillRoles'] as const) {
      expect(typeof api[method]).toBe('function');
    }
  });
});
