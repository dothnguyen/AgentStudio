import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const appDir = resolve(__dirname, '..');
const appReadme = readFileSync(resolve(appDir, 'README.md'), 'utf8');
const backendReadme = readFileSync(resolve(appDir, '..', 'backend', 'README.md'), 'utf8');

/** Text of the README section that starts at `heading`, up to the next heading of the same level or higher. */
function section(readme: string, heading: string, level: number): string {
  const lines = readme.split('\n');
  const start = lines.indexOf(`${'#'.repeat(level)} ${heading}`);
  if (start < 0) return '';
  const nextHeading = new RegExp(`^#{1,${level}} `);
  let end = start + 1;
  while (end < lines.length && !nextHeading.test(lines[end]!)) end++;
  return lines.slice(start, end).join('\n');
}

describe('Skills documentation', () => {
  it('app_README_has_a_Skills_section_that_explains_what_a_skill_is_where_it_lives_and_the_limits', () => {
    const skills = section(appReadme, 'Skills', 3);
    expect(skills, 'app/README.md must have a "### Skills" section').not.toBe('');
    expect(skills).toContain('reusable instruction file');
    expect(skills).toContain('.agent-studio/skills/<id>/SKILL.md');
    expect(skills).toMatch(/32 KiB per skill/);
    expect(skills).toMatch(/96 KiB for a role/);
    // Roles use skills through roles.json and the ids they list.
    expect(skills).toContain('.agent-studio/roles.json');
    expect(skills).toMatch(/Roles list the ids they use/);
  });

  it('backend_README_documents_the_six_skill_commands_with_arguments_and_error_codes', () => {
    const skills = section(backendReadme, 'Skills', 2);
    expect(skills, 'backend/README.md must have a "## Skills" section').not.toBe('');
    for (const command of [
      'skill.list {workspace}',
      'skill.show {workspace, skill}',
      'skill.create {workspace, skill: {id, text}}',
      'skill.update {workspace, skill, text, expectedSha256}',
      'skill.delete {workspace, skill, expectedRolesSha256, expectedSha256}',
      'skill.roles.update {workspace, skill, roles, expectedRolesSha256}',
    ]) {
      expect(skills, `backend/README.md must document ${command}`).toContain(command);
    }
    expect(skills).toContain('^[a-z0-9][a-z0-9._-]{0,63}$');
    expect(skills).toMatch(/32 KiB per-skill/);
    expect(skills).toMatch(/96 KiB per-role/);
    for (const code of ['SKILL_NOT_FOUND', 'SKILL_EXISTS', 'SKILL_IN_USE', 'CONFIG_CHANGED']) {
      expect(skills, `backend/README.md must document ${code}`).toContain(code);
    }
  });
});
