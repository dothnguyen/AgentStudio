import { describe, expect, it } from 'vitest';
import { MANAGEMENT_CHANNELS, MANAGEMENT_SPECS, isPlainObject } from '../src/main/managementSpecs';

const byLabel = (m: string) => MANAGEMENT_SPECS.find((s) => s.label === `management.${m}`)!;
const parse = (m: string, req: Record<string, unknown>) => byLabel(m).parse(req);

describe('managementSpecs', () => {
  it('has one spec per channel; only board control and member switch/resume are mutating', () => {
    expect(MANAGEMENT_SPECS).toHaveLength(24);
    expect(MANAGEMENT_SPECS.map((s) => s.channel).sort()).toEqual(Object.values(MANAGEMENT_CHANNELS).sort());
    expect(MANAGEMENT_SPECS.filter((s) => s.mutating).map((s) => s.label).sort()).toEqual(['management.resumeMemberAgent', 'management.runBoard', 'management.stopBoard', 'management.switchMemberAgent']);
  });

  it('isPlainObject accepts plain and null-prototype objects only', () => {
    class K {}
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
    for (const v of [null, undefined, [], 'x', 1, new K(), new Date(), new Map()]) expect(isPlainObject(v)).toBe(false);
  });

  it('undefined values count as absent', () => {
    expect(parse('createTeam', { name: 'Core', teamDefId: undefined })).toEqual({ name: 'Core' });
    expect(parse('addMember', { teamDefId: 'core', member: { role: 'Dev', agent: undefined } })).toEqual({ teamDefId: 'core', role: 'Dev' });
    expect(parse('renameTeam', { teamDefId: 'core', name: undefined })).toBe('management.renameTeam: name is required.');
  });

  it('addMember rejects null, wrong types and unknown member keys', () => {
    const msg = (member: unknown) => parse('addMember', { teamDefId: 'core', member: member as never });
    expect(msg({ model: null })).toBe('management.addMember: member.model must be a non-empty string.');
    expect(msg({ canAddTickets: null })).toBe('management.addMember: member.canAddTickets must be a boolean.');
    expect(msg({ role: ' ' })).toBe('management.addMember: member.role must be a non-empty string.');
    expect(msg({ memberId: 'A B' })).toContain('member.memberId must be a slug');
    expect(msg({ id: 'x', workspace: '/' })).toBe('management.addMember: unknown field(s): member.id, member.workspace.');
    expect(msg('x')).toBe('management.addMember: member must be an object.');
  });

  it('updateMember requires a non-empty change set and allows null for nullable fields', () => {
    expect(parse('updateMember', { teamDefId: 'core', memberId: 'm1', changes: {} })).toBe('management.updateMember: changes must have at least one field.');
    expect(parse('updateMember', { teamDefId: 'core', memberId: 'm1', changes: { model: null, reasoning: null, canAddTickets: null } })).toEqual({
      teamDefId: 'core', memberId: 'm1', model: null, reasoning: null, canAddTickets: null,
    });
    expect(parse('updateMember', { teamDefId: 'core', memberId: 'm1', changes: { role: null } })).toBe('management.updateMember: changes.role must be a non-empty string.');
    expect(parse('updateMember', { teamDefId: 'core', memberId: 'm1' })).toBe('management.updateMember: changes is required.');
  });

  it('createAgent and updateAgent type checks', () => {
    expect(parse('createAgent', { agent: { name: 1 } })).toBe('management.createAgent: agent.name must be a string.');
    expect(parse('createAgent', { agent: { id: 'Bad' } })).toContain('agent.id must be a slug');
    expect(parse('createAgent', {})).toBe('management.createAgent: agent is required.');
    expect(parse('updateAgent', { agentDefId: 'ada', changes: { name: null } })).toBe('management.updateAgent: changes.name must be a string.');
    expect(parse('updateAgent', { agentDefId: 'ada', changes: { description: 5 } })).toBe('management.updateAgent: changes.description must be a string or null.');
  });

  it('board settings checks', () => {
    expect(parse('updateBoardSettings', { changes: {} })).toBe('management.updateBoardSettings: changes must have at least one field.');
    expect(parse('updateBoardSettings', { changes: { rules: [{ a: 1 }], baseBranch: null } })).toEqual({ changes: { rules: [{ a: 1 }], baseBranch: null } });
    expect(parse('updateBoardSettings', {})).toBe('management.updateBoardSettings: changes is required.');
  });

  const SHA = 'a'.repeat(64);
  const SHA2 = 'b'.repeat(64);

  it('maps every role method to one fixed backend command', () => {
    const rows: Array<[string, Record<string, unknown>, string, Record<string, unknown>]> = [
      ['roles', {}, 'role.list', {}],
      ['createRole', { input: { name: 'N' }, expectedRolesSha256: null }, 'role.create', { name: 'N', expectedSha256: null }],
      ['updateRole', { roleId: 'R', changes: { name: 'N' }, expectedRolesSha256: SHA }, 'role.update', { role: 'R', name: 'N', expectedSha256: SHA }],
      ['updateRoleInstructions', { roleId: 'R', text: '', expectedRolesSha256: SHA, expectedInstructionsSha256: null }, 'role.instructions.update', { role: 'R', text: '', expectedRolesSha256: SHA, expectedInstructionsSha256: null }],
      ['deleteRole', { roleId: 'R', confirmation: { expectedRolesSha256: SHA, expectedInstructionsSha256: SHA2 } }, 'role.delete', { role: 'R', expectedRolesSha256: SHA, expectedInstructionsSha256: SHA2 }],
    ];
    for (const [m, req, command, args] of rows) {
      expect(byLabel(m).command).toBe(command);
      expect(byLabel(m).mutating).toBe(false);
      expect(parse(m, req)).toEqual(args);
    }
  });

  it('accepts create fields and preserves ordered unique skills', () => {
    const skills = ['z-skill', 'a.b_c-1'];
    const out = parse('createRole', { input: { id: 'qa-lead', name: ' QA ', description: '', skills }, expectedRolesSha256: SHA }) as Record<string, unknown>;
    expect(out).toEqual({ id: 'qa-lead', name: ' QA ', description: '', skills: ['z-skill', 'a.b_c-1'], expectedSha256: SHA });
    expect(out.skills).not.toBe(skills);
    expect((parse('createRole', { input: { name: 'N', skills: [] }, expectedRolesSha256: null }) as Record<string, unknown>).skills).toEqual([]);
  });

  it('requires a non-empty update change set', () => {
    const u = (changes: unknown) => parse('updateRole', { roleId: 'R', changes: changes as never, expectedRolesSha256: SHA });
    expect(u({})).toBe('management.updateRole: changes must have at least one field.');
    expect(parse('updateRole', { roleId: 'R', expectedRolesSha256: SHA })).toBe('management.updateRole: changes is required.');
    expect(u({ description: null })).toEqual({ role: 'R', description: null, expectedSha256: SHA });
    expect(u({ description: '' })).toEqual({ role: 'R', description: '', expectedSha256: SHA });
    expect(u({ skills: [] })).toEqual({ role: 'R', skills: [], expectedSha256: SHA });
    expect(u({ id: 'x' })).toBe('management.updateRole: unknown field(s): changes.id.');
  });

  it('rejects invalid ids names oversized description and instruction bytes', () => {
    const create = (input: Record<string, unknown>) => parse('createRole', { input, expectedRolesSha256: null });
    expect(create({})).toBe('management.createRole: input.name is required.');
    expect(create({ name: 'N', id: 'Bad' })).toBe("management.createRole: input.id must be a slug (lowercase letters, digits, '-'; at most 64 characters).");
    expect(create({ name: '  ' })).toContain('input.name must be a non-empty string');
    expect(create({ name: 'n'.repeat(129) })).toContain('input.name');
    expect(create({ name: 'n'.repeat(128) })).toEqual({ name: 'n'.repeat(128), expectedSha256: null });
    expect(create({ name: 'N', description: 'd'.repeat(2001) })).toContain('input.description');
    expect(create({ name: 'N', description: 'd'.repeat(2000) })).not.toBeTypeOf('string');
    const upd = (roleId: unknown) => parse('updateRole', { roleId: roleId as never, changes: { name: 'N' }, expectedRolesSha256: SHA });
    expect(upd(null)).toContain('roleId');
    expect(upd('  ')).toContain('roleId');
    expect(upd('R'.repeat(65))).toContain('roleId');
    expect(upd('Legacy_Mixed Case')).not.toBeTypeOf('string');
    expect(parse('updateRole', { roleId: 'R', changes: { name: null as never }, expectedRolesSha256: SHA })).toContain('changes.name');
    const text = (t: unknown) => parse('updateRoleInstructions', { roleId: 'R', text: t as never, expectedRolesSha256: SHA, expectedInstructionsSha256: null });
    expect(text('é'.repeat(8192))).not.toBeTypeOf('string');
    expect(text('é'.repeat(8193))).toBe('management.updateRoleInstructions: text must be at most 16384 UTF-8 bytes.');
    expect(text('\ud800')).toContain('unpaired surrogates');
    expect(text('😀')).not.toBeTypeOf('string');
    expect(text(5)).toContain('text must be a string');
  });

  it('rejects duplicate malformed or non-array skills', () => {
    const c = (skills: unknown) => parse('createRole', { input: { name: 'N', skills: skills as never }, expectedRolesSha256: null });
    expect(c(['a', 'a'])).toBe('management.createRole: input.skills must not contain duplicates.');
    expect(c('a')).toContain('input.skills must be an array');
    expect(c(['Bad'])).toContain('input.skills[0]');
    expect(c(['ok', 1])).toContain('input.skills[1]');
    expect(c(['-a'])).toContain('input.skills[0]');
    expect(c(['a'.repeat(65)])).toContain('input.skills[0]');
    expect(parse('updateRole', { roleId: 'R', changes: { skills: ['a', 'a'] }, expectedRolesSha256: SHA })).toBe('management.updateRole: changes.skills must not contain duplicates.');
  });

  it('requires exact role and instruction sha tokens', () => {
    expect(parse('updateRole', { roleId: 'R', changes: { name: 'N' }, expectedRolesSha256: 'A'.repeat(64) })).toBe('management.updateRole: expectedRolesSha256 must be a lowercase hex sha256.');
    expect(parse('updateRole', { roleId: 'R', changes: { name: 'N' } })).toBe('management.updateRole: expectedRolesSha256 is required.');
    expect(parse('updateRole', { roleId: 'R', changes: { name: 'N' }, expectedRolesSha256: null as never })).toContain('lowercase hex sha256');
    expect(parse('createRole', { input: { name: 'N' } })).toBe('management.createRole: expectedRolesSha256 is required.');
    expect(parse('createRole', { input: { name: 'N' }, expectedRolesSha256: 'a'.repeat(63) })).toBe('management.createRole: expectedRolesSha256 must be a lowercase hex sha256 or null.');
    const i = (extra: Record<string, unknown>) => parse('updateRoleInstructions', { roleId: 'R', text: 't', expectedRolesSha256: SHA, ...extra });
    expect(i({})).toBe('management.updateRoleInstructions: expectedInstructionsSha256 is required.');
    expect(i({ expectedInstructionsSha256: 'x' })).toBe('management.updateRoleInstructions: expectedInstructionsSha256 must be a lowercase hex sha256 or null.');
    expect(i({ expectedInstructionsSha256: undefined })).toContain('is required');
    expect(i({ expectedInstructionsSha256: null, extra: 1 })).toBe('management.updateRoleInstructions: unknown field(s): extra.');
  });

  it('rejects partial extra or malformed delete confirmation', () => {
    const d = (confirmation: unknown) => parse('deleteRole', { roleId: 'R', confirmation: confirmation as never });
    expect(parse('deleteRole', { roleId: 'R' })).toBe('management.deleteRole: confirmation is required.');
    expect(d('x')).toBe('management.deleteRole: confirmation must be an object.');
    expect(d({})).toBe('management.deleteRole: confirmation.expectedRolesSha256 is required.');
    expect(d({ expectedRolesSha256: SHA })).toBe('management.deleteRole: confirmation.expectedInstructionsSha256 is required.');
    expect(d({ expectedRolesSha256: SHA, expectedInstructionsSha256: null, usage: {} })).toBe('management.deleteRole: unknown field(s): confirmation.usage.');
    expect(d({ expectedRolesSha256: null, expectedInstructionsSha256: null })).toContain('confirmation.expectedRolesSha256 must be a lowercase hex sha256');
    expect(parse('deleteRole', { roleId: 'R', confirmation: { expectedRolesSha256: SHA, expectedInstructionsSha256: null }, count: 0 })).toBe('management.deleteRole: unknown field(s): count.');
  });

  it('identifier boundaries: slug length and UUID version', () => {
    expect(parse('team', { teamDefId: 'a'.repeat(64) })).toEqual({ teamDefId: 'a'.repeat(64) });
    expect(parse('team', { teamDefId: 'a'.repeat(65) })).toContain('teamDefId must be a slug');
    expect(parse('team', { teamDefId: '-a' })).toContain('teamDefId must be a slug');
    expect(parse('team', {})).toBe('management.team: teamDefId is required.');
    expect(parse('runBoard', { teamId: '123e4567-e89b-12d3-a456-426614174000' })).toBe('management.runBoard: teamId must be a lowercase UUID v4.');
    expect(parse('runBoard', { teamId: '123E4567-E89B-42D3-A456-426614174000' })).toBe('management.runBoard: teamId must be a lowercase UUID v4.');
    expect(parse('runBoard', {})).toBe('management.runBoard: teamId is required.');
  });

  it('unknown keys are reported before other errors', () => {
    expect(parse('renameTeam', { teamDefId: '../x', name: '', extra: 1 })).toBe('management.renameTeam: unknown field(s): extra.');
  });
  it('validates ordered agents and exact switch confirmation', () => {
    const agents = ['z', 'a'];
    const parsed = parse('addMember', { teamDefId: 'core', member: { agents } });
    expect(parsed).toEqual({ teamDefId: 'core', agents });
    expect((parsed as Record<string, unknown>).agents).not.toBe(agents);
    expect(parse('updateMember', { teamDefId: 'core', memberId: 'm', changes: { agents: [] } })).toBe('management.updateMember: changes.agents must be a non-empty array of slugs.');
    expect(parse('addMember', { teamDefId: 'core', member: { agents: ['a', 'a'] } })).toBe('management.addMember: member.agents must not contain duplicates.');
    const base = { teamDefId: 'core', memberId: 'm', agent: 'a' };
    const assignmentId = '123e4567-e89b-42d3-a456-426614174000';
    expect(parse('switchMemberAgent', { ...base, confirmation: { cancelActive: true, assignmentId } })).toEqual({ ...base, cancelActive: true, assignmentId });
    expect(parse('switchMemberAgent', { ...base, confirmation: { cancelActive: false, assignmentId } })).toBe('management.switchMemberAgent: confirmation.cancelActive must be true.');
    expect(parse('switchMemberAgent', { ...base, confirmation: { cancelActive: true, assignmentId: 'bad' } })).toBe('management.switchMemberAgent: confirmation.assignmentId must be a lowercase UUID v4.');
    expect(parse('switchMemberAgent', { ...base, confirmation: { extra: 1 } })).toBe('management.switchMemberAgent: unknown field(s): confirmation.extra.');
    expect(parse('switchMemberAgent', { ...base, extra: 1, confirmation: {} })).toBe('management.switchMemberAgent: unknown field(s): extra.');
  });

});
