import { describe, expect, it } from 'vitest';
import {
  buildRoleSavePlan, editRoleForm, emptyRoleForm, instructionBytes, moveRoleSkill, roleErrorProblems, suggestRoleId, validateRoleForm,
} from '../src/renderer/roles/roleEditModel';
import { roleItem, rolesFixture } from './rolesFixtures';

const catalog = rolesFixture();
const valid = { ...emptyRoleForm(), id: 'new-role', name: 'New Role' };
const SKILL_MSG = "Use 1–64 lowercase letters, digits, '.', '_' or '-', starting with a letter or digit.";

describe('roleEditModel', () => {
  it('suggests_slug_until_the_create_id_is_manually_edited', () => {
    expect(suggestRoleId('  Code  Reviewer!! ')).toBe('code-reviewer');
    expect(suggestRoleId('***')).toBe('');
    expect(suggestRoleId('a'.repeat(70))).toHaveLength(64);
    expect(suggestRoleId(`${'a'.repeat(63)} b`)).toBe('a'.repeat(63));
  });

  it('validates_create_id_name_description_instruction_bytes_and_skill_ids', () => {
    expect(validateRoleForm(valid, 'create', catalog)).toEqual({});
    const bad = 'Use 1–64 lowercase letters, digits, or hyphens, starting with a letter or digit.';
    expect(validateRoleForm({ ...valid, id: ' ' }, 'create', catalog).id).toBe('Enter a role id.');
    expect(validateRoleForm({ ...valid, id: 'Bad_Id' }, 'create', catalog).id).toBe(bad);
    expect(validateRoleForm({ ...valid, id: 'a'.repeat(65) }, 'create', catalog).id).toBe(bad);
    expect(validateRoleForm({ ...valid, id: 'Developer' }, 'create', catalog).id).toBe(bad);
    expect(validateRoleForm({ ...valid, id: 'Planner' }, 'create', rolesFixture({ items: [roleItem('Planner')] })).id).toBe(bad);
    expect(validateRoleForm({ ...valid, id: 'taken' }, 'create', rolesFixture({ items: [roleItem('taken')] })).id).toBe('That role id already exists.');
    expect(validateRoleForm({ ...valid, name: '  ' }, 'create', catalog).name).toBe('Enter a role name.');
    expect(validateRoleForm({ ...valid, name: 'n'.repeat(81) }, 'create', catalog).name).toBe('Use 80 characters or fewer.');
    expect(validateRoleForm({ ...valid, description: 'd'.repeat(2001) }, 'create', catalog).description).toBe('Use 2000 characters or fewer.');
    const ok = '€'.repeat(5461) + 'a'; // 16383 + 1 = 16384 bytes
    expect(instructionBytes(ok)).toBe(16384);
    expect(validateRoleForm({ ...valid, instructions: ok }, 'create', catalog).instructions).toBeUndefined();
    expect(validateRoleForm({ ...valid, instructions: `${ok}a` }, 'create', catalog).instructions).toBe('Use 16384 UTF-8 bytes or fewer.');
    expect(validateRoleForm({ ...valid, instructions: '€'.repeat(5462) }, 'create', catalog).instructions).toBe('Use 16384 UTF-8 bytes or fewer.');
    expect(validateRoleForm({ ...valid, skills: ['ok', '-bad'] }, 'create', catalog).skills).toBe(SKILL_MSG);
    expect(validateRoleForm({ ...valid, skills: ['ok', ''] }, 'create', catalog).skills).toBe(SKILL_MSG);
    expect(validateRoleForm({ ...valid, skills: ['a', 'b', ' A '] }, 'create', catalog).skills).toBe("Remove the duplicate skill id 'a'.");
  });

  it('checks_names_case_insensitively_but_excludes_the_edited_role', () => {
    expect(validateRoleForm({ ...valid, name: '  code REVIEWER ' }, 'create', catalog).name).toBe('That role name is already in use.');
    const reviewer = editRoleForm(catalog.items[1]!);
    expect(validateRoleForm({ ...reviewer, name: 'CODE reviewer' }, 'edit', catalog)).toEqual({});
    expect(validateRoleForm({ ...reviewer, name: 'developer' }, 'edit', catalog).name).toBe('That role name is already in use.');
    expect(validateRoleForm({ ...reviewer, id: 'ignored-in-edit' }, 'edit', catalog).id).toBeUndefined();
  });

  it('builds_create_input_and_sparse_normalized_metadata_changes', () => {
    expect(buildRoleSavePlan('create', null, { ...valid, name: ' New Role ', skills: ['a'] })).toEqual({ create: { id: 'new-role', name: 'New Role', skills: ['a'] }, metadata: null, instructionsChanged: false });
    expect(buildRoleSavePlan('create', null, { ...valid, description: ' hi ', instructions: 'x' }).create).toEqual({ id: 'new-role', name: 'New Role', description: 'hi', skills: [] });
    expect(buildRoleSavePlan('create', null, { ...valid, instructions: 'x' }).instructionsChanged).toBe(true);
    const dev = catalog.items[0]!;
    const form = editRoleForm(dev);
    expect(buildRoleSavePlan('edit', dev, form)).toEqual({ create: null, metadata: null, instructionsChanged: false });
    expect(buildRoleSavePlan('edit', dev, { ...form, name: ' Dev2 ', id: 'other' }).metadata).toEqual({ name: 'Dev2' });
    expect(buildRoleSavePlan('edit', dev, { ...form, description: '  ' }).metadata).toEqual({ description: null });
  });

  it('detects_instruction_and_skill_order_changes_without_normalizing_instruction_text', () => {
    const dev = catalog.items[0]!;
    const form = editRoleForm(dev);
    expect(buildRoleSavePlan('edit', dev, { ...form, instructions: `${form.instructions} ` })).toMatchObject({ instructionsChanged: true, metadata: null });
    expect(buildRoleSavePlan('edit', dev, { ...form, instructions: '' }).instructionsChanged).toBe(true);
    expect(buildRoleSavePlan('edit', dev, { ...form, skills: [...form.skills].reverse() }).metadata).toEqual({ skills: ['retired-skill', 'python-testing'] });
  });

  it('keeps_missing_skills_and_moves_only_one_position', () => {
    const list = ['a', 'missing', 'c'];
    expect(moveRoleSkill(list, 1, -1)).toEqual(['missing', 'a', 'c']);
    expect(moveRoleSkill(list, 1, 1)).toEqual(['a', 'c', 'missing']);
    expect(moveRoleSkill(list, 0, -1)).toEqual(list);
    expect(moveRoleSkill(list, 2, 1)).toEqual(list);
    expect(moveRoleSkill(list, 0, 1)).not.toBe(list);
    expect(editRoleForm(catalog.items[0]!).skills).toEqual(['python-testing', 'retired-skill']);
  });

  it('maps_backend_field_problems_and_preserves_unmatched_problems', () => {
    const error = { code: 'BAD_REQUEST', message: 'bad', retryable: false, data: { problems: [
      { path: 'roles.x.name', message: 'name bad' }, { path: 'role.skills[2]', message: 'skill bad' }, { path: 'id', message: 'id bad' },
      { path: 'roles.x.instructions', message: 'ins bad' }, { path: 'roles.x.description', message: 'desc bad' }, { path: 'roles.x.directTask', message: 'other' },
    ] } };
    expect(roleErrorProblems(error)).toEqual({
      fields: { name: 'name bad', skills: 'skill bad', id: 'id bad', instructions: 'ins bad', description: 'desc bad' },
      unmatched: ['roles.x.directTask: other'],
    });
    expect(roleErrorProblems({ code: 'X', message: 'm', retryable: false })).toEqual({ fields: {}, unmatched: [] });
  });
});
