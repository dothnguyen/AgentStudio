import { describe, expect, it } from 'vitest';
import { MANAGEMENT_CHANNELS, MANAGEMENT_SPECS, isPlainObject } from '../src/main/managementSpecs';

const byLabel = (m: string) => MANAGEMENT_SPECS.find((s) => s.label === `management.${m}`)!;
const parse = (m: string, req: Record<string, unknown>) => byLabel(m).parse(req);

describe('managementSpecs', () => {
  it('has one spec per channel; only runBoard and stopBoard are mutating', () => {
    expect(MANAGEMENT_SPECS).toHaveLength(20);
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

  it('updateRole and board settings checks', () => {
    expect(parse('updateRole', { role: 'TeamLead', description: 5 })).toBe('management.updateRole: description must be a string or null.');
    expect(parse('updateRole', { role: '', description: null })).toBe('management.updateRole: role must be a non-empty string.');
    expect(parse('updateRole', { role: 'R', description: null, expectedSha256: 'a'.repeat(63) })).toBe('management.updateRole: expectedSha256 must be a lowercase hex sha256.');
    expect(parse('updateBoardSettings', { changes: {} })).toBe('management.updateBoardSettings: changes must have at least one field.');
    expect(parse('updateBoardSettings', { changes: { rules: [{ a: 1 }], baseBranch: null } })).toEqual({ changes: { rules: [{ a: 1 }], baseBranch: null } });
    expect(parse('updateBoardSettings', {})).toBe('management.updateBoardSettings: changes is required.');
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
