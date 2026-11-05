import { describe, expect, it } from 'vitest';
import { MANAGEMENT_CHANNELS, MANAGEMENT_SPECS, isPlainObject } from '../src/main/managementSpecs';

const byLabel = (m: string) => MANAGEMENT_SPECS.find((s) => s.label === `management.${m}`)!;
const parse = (m: string, req: Record<string, unknown>) => byLabel(m).parse(req);

describe('managementSpecs', () => {
  it('has one spec per channel; only board control and member switch/resume are mutating', () => {
    expect(MANAGEMENT_SPECS).toHaveLength(64);
    expect(MANAGEMENT_SPECS.map((s) => s.channel).sort()).toEqual(Object.values(MANAGEMENT_CHANNELS).sort());
    expect(MANAGEMENT_SPECS.filter((s) => s.mutating).map((s) => s.label).sort()).toEqual([
      'management.answerAssignment', 'management.approveCommand', 'management.approveWorkflow', 'management.cancelCommand', 'management.cancelRun', 'management.createTicket', 'management.rejectCommand',
      'management.resetUsage', 'management.resumeMemberAgent', 'management.retryRun', 'management.retryTicket',
      'management.runBoard', 'management.startTeam', 'management.stopBoard', 'management.stopTeam',
      'management.switchMemberAgent', 'management.ticketMove', 'management.ticketPhase', 'management.ticketWorkflow', 'management.unblockTicket',
    ]);
  });


  it('validates workflow and column moves against the dispatch request shapes', () => {
    expect(parse('ticketMove', { key: 'T-100', to: 'todo' })).toEqual({ key: 'T-100', to: 'todo' });
    expect(parse('ticketPhase', { key: 'T-100', phase: 'phase-06' })).toEqual({ key: 'T-100', phase: 'phase-06' });
    expect(parse('ticketMove', { key: 'T-100', to: 'in-progress', workflowStatus: 'dev-ready', reason: '', force: false })).toEqual({ key: 'T-100', to: 'in-progress', workflowStatus: 'dev-ready', reason: '', force: false });
    expect(parse('ticketWorkflow', { key: 'T-100', to: 'qa-ready', reason: 'next' })).toEqual({ key: 'T-100', to: 'qa-ready', reason: 'next' });
    for (const request of [{ key: 'T-100', to: 'wrong' }, { key: 'T-100', to: 'todo', force: 'yes' }, { key: 'T-100', to: 'todo', workflowStatus: '' }, { key: 'T-100', to: 'todo', reason: 'x'.repeat(501) }, { key: 'T-100', to: 'todo', extra: true }]) expect(typeof parse('ticketMove', request)).toBe('string');
    for (const request of [{ key: 'T-100', to: '' }, { key: 'T-100', to: 'x'.repeat(65) }, { key: 'T-100', to: 'qa', force: true }, { key: 'bad', to: 'qa' }]) expect(typeof parse('ticketWorkflow', request)).toBe('string');
  });

  it.each<[string, string, Record<string, unknown>]>([
    ['boardWorkflows', 'board.workflows', {}],
    ['boardWorkflow', 'boardworkflow.show', { name: 'develop' }],
    ['prompts', 'prompt.list', {}],
    ['prompt', 'prompt.show', { name: 'develop' }],
    ['checkSets', 'checkset.list', {}],
    ['boardStatuses', 'board.statuses', {}],
  ])('parses %s with the exact backend arguments', (method, command, request) => {
    expect(byLabel(method).command).toBe(command);
    expect(byLabel(method).mutating).toBe(false);
    expect(parse(method, request)).toEqual(request);
    expect(parse(method, { ...request, workspace: '/other' })).toContain('unknown field');
  });

  it.each(['boardWorkflow', 'prompt'])('rejects invalid names for %s', (method) => {
    for (const name of [undefined, '', '../bad', 'UPPER', 'a'.repeat(65)])
      expect(typeof parse(method, { name })).toBe('string');
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

  it('maps the board reads to phase.list and ticket.list/show in summary mode', () => {
    const rows: Array<[string, Record<string, unknown>, string, Record<string, unknown>]> = [
      ['boardPhases', {}, 'phase.list', {}],
      ['boardTickets', {}, 'ticket.list', { summary: true }],
      ['boardTickets', { phase: 'phase-05' }, 'ticket.list', { summary: true, phase: 'phase-05' }],
      ['boardTickets', { unassigned: true }, 'ticket.list', { summary: true, unassigned: true }],
      ['boardTicket', { key: 'T-134' }, 'ticket.show', { key: 'T-134' }],
    ];
    for (const [method, request, command, args] of rows) {
      expect(byLabel(method).command).toBe(command);
      expect(byLabel(method).mutating).toBe(false);
      expect(parse(method, request)).toEqual(args);
    }
  });

  it('maps ticket creation to ticket.add with configured column fields', () => {
    expect(byLabel('createTicket').command).toBe('ticket.add');
    expect(byLabel('createTicket').mutating).toBe(true);
    expect(parse('createTicket', {
      title: 'Write it', body: 'Details', priority: 10, phase: 'phase-05', status: 'todo', workflowStatus: 'ready',
    })).toEqual({
      title: 'Write it', body: 'Details', priority: 10, phase: 'phase-05', status: 'todo', workflowStatus: 'ready',
    });
    expect(parse('createTicket', { title: 'Write it', priority: 100, phase: 'phase-05', status: 'todo', workflowStatus: 'ready' }))
      .toEqual({ title: 'Write it', priority: 100, phase: 'phase-05', status: 'todo', workflowStatus: 'ready' });
    for (const request of [
      { title: ' ', priority: 100, phase: 'phase-05', status: 'todo', workflowStatus: 'ready' },
      { title: 'Write it', priority: -1, phase: 'phase-05', status: 'todo', workflowStatus: 'ready' },
      { title: 'Write it', priority: 100, phase: 'Bad Phase', status: 'todo', workflowStatus: 'ready' },
      { title: 'Write it', priority: 100, phase: 'phase-05', status: 'nowhere', workflowStatus: 'ready' },
      { title: 'Write it', priority: 100, phase: 'phase-05', status: 'todo', workflowStatus: '' },
      { title: 'Write it', priority: 100, phase: 'phase-05', status: 'todo', workflowStatus: 'ready', extra: true },
    ]) expect(typeof parse('createTicket', request)).toBe('string');
  });

  it('rejects malformed board arguments, including a bad ticket key', () => {
    expect(parse('boardTicket', {})).toBe('management.boardTicket: key is required.');
    expect(parse('boardTicket', { key: 'T-12' })).toBe('management.boardTicket: key must be a ticket key (T- followed by at least three digits).');
    expect(parse('boardTicket', { key: 't-134' })).toContain('key must be a ticket key');
    expect(parse('boardTicket', { key: 'T-134', body: 'x' })).toBe('management.boardTicket: unknown field(s): body.');
    expect(parse('boardTickets', { phase: 'Bad Phase' })).toBe("management.boardTickets: phase must be a slug (lowercase letters, digits, '-'; at most 64 characters).");
    expect(parse('boardTickets', { phase: 'T-134' })).toContain('phase must be a slug');
    expect(parse('boardTickets', { status: 'done' })).toBe('management.boardTickets: unknown field(s): status.');
    expect(parse('boardPhases', { workspace: '/etc' })).toBe('management.boardPhases: unknown field(s): workspace.');
  });

  const SHA = 'a'.repeat(64);
  const SHA2 = 'b'.repeat(64);

  it('maps every role method to one fixed backend command', () => {
    const rows: Array<[string, Record<string, unknown>, string, Record<string, unknown>]> = [
      ['roles', {}, 'role.list', {}],
      ['createRole', { input: { name: 'N' }, expectedRolesSha256: null }, 'role.create', { role: { name: 'N' }, expectedSha256: null }],
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
    expect(out).toEqual({ role: { id: 'qa-lead', name: ' QA ', description: '', skills: ['z-skill', 'a.b_c-1'] }, expectedSha256: SHA });
    expect((out.role as Record<string, unknown>).skills).not.toBe(skills);
    expect((parse('createRole', { input: { name: 'N', skills: [] }, expectedRolesSha256: null }) as { role: { skills: unknown } }).role.skills).toEqual([]);
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
    expect(create({ name: 'n'.repeat(128) })).toEqual({ role: { name: 'n'.repeat(128) }, expectedSha256: null });
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
  it('exposes the team and member actions through fixed commands', () => {
    const uuid = '123e4567-e89b-42d3-a456-426614174000';
    const rows: Array<[string, Record<string, unknown>, string, Record<string, unknown>]> = [
      ['resetUsage', { teamDefId: 'core', provider: 'claude' }, 'team.usage.reset', { teamDefId: 'core', provider: 'claude' }],
      ['retryRun', { workflowRunId: uuid }, 'workflow.retry', { workflowRunId: uuid }],
      ['cancelRun', { workflowRunId: uuid }, 'workflow.cancel', { workflowRunId: uuid }],
      ['retryTicket', { key: 'T-100' }, 'ticket.retry', { key: 'T-100' }],
      ['unblockTicket', { key: 'T-100' }, 'ticket.unblock', { key: 'T-100' }],
      ['unblockTicket', { key: 'T-100', to: 'dev-ready' }, 'ticket.unblock', { key: 'T-100', to: 'dev-ready' }],
      ['approveCommand', { requestId: uuid }, 'command.approve', { requestId: uuid }],
      ['rejectCommand', { requestId: uuid }, 'command.reject', { requestId: uuid }],
      ['rejectCommand', { requestId: uuid, reason: 'not needed' }, 'command.reject', { requestId: uuid, reason: 'not needed' }],
      ['cancelCommand', { requestId: uuid }, 'command.cancel', { requestId: uuid }],
      ['cancelCommand', { requestId: uuid, reason: 'stale' }, 'command.cancel', { requestId: uuid, reason: 'stale' }],
      ['attachInfo', { teamId: uuid }, 'team.attach', { teamId: uuid }],
      ['startTeam', { teamDefId: 'core' }, 'team.start', { teamDefId: 'core' }],
      ['stopTeam', { teamId: uuid }, 'team.stop', { teamId: uuid }],
    ];
    for (const [method, request, command, args] of rows) {
      expect(byLabel(method).command).toBe(command);
      expect(parse(method, request)).toEqual(args);
    }
    expect(byLabel('attachInfo').mutating).toBe(false);
    expect(byLabel('startTeam').mutating).toBe(true);
    expect(byLabel('stopTeam').mutating).toBe(true);
  });

  it('rejects malformed action identifiers, ticket keys and reasons', () => {
    const uuid = '123e4567-e89b-42d3-a456-426614174000';
    expect(parse('retryTicket', { key: 't-100' })).toContain('key must be a ticket key');
    expect(parse('retryTicket', { key: 'T-12' })).toContain('key must be a ticket key');
    expect(parse('retryTicket', {})).toBe('management.retryTicket: key is required.');
    expect(parse('unblockTicket', { key: 'T-100', to: 'Bad Status' })).toContain('to must be a slug');
    expect(parse('unblockTicket', { key: 'T-100', status: 'x' })).toBe('management.unblockTicket: unknown field(s): status.');
    expect(parse('retryRun', { workflowRunId: 'abc' })).toBe('management.retryRun: workflowRunId must be a lowercase UUID v4.');
    expect(parse('cancelRun', {})).toBe('management.cancelRun: workflowRunId is required.');
    expect(parse('approveCommand', { requestId: 'ABC' })).toBe('management.approveCommand: requestId must be a lowercase UUID v4.');
    expect(parse('attachInfo', {})).toBe('management.attachInfo: teamId is required.');
    expect(parse('startTeam', { teamDefId: 'Bad Id' })).toBe("management.startTeam: teamDefId must be a slug (lowercase letters, digits, '-'; at most 64 characters).");
    expect(parse('startTeam', {})).toBe('management.startTeam: teamDefId is required.');
    expect(parse('startTeam', { teamDefId: 'core', roster: [] })).toBe('management.startTeam: unknown field(s): roster.');
    expect(parse('stopTeam', { teamId: 'abc' })).toBe('management.stopTeam: teamId must be a lowercase UUID v4.');
    expect(parse('stopTeam', {})).toBe('management.stopTeam: teamId is required.');
    expect(parse('stopTeam', { teamId: uuid, teamDefId: 'core' })).toBe('management.stopTeam: unknown field(s): teamDefId.');
    expect(parse('rejectCommand', { requestId: uuid, reason: 5 as never })).toBe('management.rejectCommand: reason must be a string.');
    expect(parse('rejectCommand', { requestId: uuid, reason: 'x'.repeat(501) })).toBe('management.rejectCommand: reason must be at most 500 characters.');
    expect(parse('rejectCommand', { requestId: uuid, reason: '\ud800' })).toContain('unpaired surrogates');
    expect(parse('cancelCommand', { requestId: uuid, reason: 'x'.repeat(500) })).toEqual({ requestId: uuid, reason: 'x'.repeat(500) });
    expect(parse('resetUsage', { teamDefId: 'core', provider: 'Bad Provider' })).toContain('provider must be a slug');
  });

  it('rejects missing and unknown fields for every new action', () => {
    const uuid = '123e4567-e89b-42d3-a456-426614174000';
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['resetUsage', { provider: 'claude' }, 'teamDefId is required.'],
      ['resetUsage', { teamDefId: 'core', provider: 'claude', extra: 1 }, 'unknown field(s): extra.'],
      ['resetUsage', { teamDefId: 'core' }, 'provider is required.'],
      ['retryRun', {}, 'workflowRunId is required.'],
      ['retryRun', { workflowRunId: uuid, extra: 1 }, 'unknown field(s): extra.'],
      ['cancelRun', {}, 'workflowRunId is required.'],
      ['cancelRun', { workflowRunId: uuid, extra: 1 }, 'unknown field(s): extra.'],
      ['cancelRun', { workflowRunId: 'abc' }, 'workflowRunId must be a lowercase UUID v4.'],
      ['retryTicket', {}, 'key is required.'],
      ['retryTicket', { key: 'T-100', extra: 1 }, 'unknown field(s): extra.'],
      ['unblockTicket', {}, 'key is required.'],
      ['approveCommand', {}, 'requestId is required.'],
      ['approveCommand', { requestId: uuid, extra: 1 }, 'unknown field(s): extra.'],
      ['rejectCommand', {}, 'requestId is required.'],
      ['rejectCommand', { requestId: uuid, extra: 1 }, 'unknown field(s): extra.'],
      ['cancelCommand', {}, 'requestId is required.'],
      ['cancelCommand', { requestId: uuid, extra: 1 }, 'unknown field(s): extra.'],
      ['cancelCommand', { requestId: uuid, reason: 'x'.repeat(501) }, 'reason must be at most 500 characters.'],
      ['attachInfo', {}, 'teamId is required.'],
      ['attachInfo', { teamId: uuid, extra: 1 }, 'unknown field(s): extra.'],
      ['attachInfo', { teamId: 'abc' }, 'teamId must be a lowercase UUID v4.'],
    ];
    for (const [method, request, suffix] of cases) {
      expect(parse(method, request)).toBe(`management.${method}: ${suffix}`);
    }
  });

  it('maps every skill method to one fixed backend command and keeps writes non-idempotent like role writes', () => {
    const rows: Array<[string, Record<string, unknown>, string, Record<string, unknown>]> = [
      ['skills', {}, 'skill.list', {}],
      ['skill', { skillId: 'python-testing' }, 'skill.show', { skill: 'python-testing' }],
      ['createSkill', { skill: { id: 'new-skill', text: '# New\n' } }, 'skill.create', { skill: { id: 'new-skill', text: '# New\n' } }],
      ['updateSkill', { skillId: 'python-testing', text: '', expectedSha256: SHA }, 'skill.update', { skill: 'python-testing', text: '', expectedSha256: SHA }],
      ['deleteSkill', { skillId: 'ts-testing', expectedRolesSha256: null, expectedSha256: SHA2 }, 'skill.delete', { skill: 'ts-testing', expectedRolesSha256: null, expectedSha256: SHA2 }],
      ['updateSkillRoles', { skillId: 'code-search', roles: ['Developer', 'TeamLead'], expectedRolesSha256: SHA }, 'skill.roles.update', { skill: 'code-search', roles: ['Developer', 'TeamLead'], expectedRolesSha256: SHA }],
    ];
    for (const [method, request, command, args] of rows) {
      expect(byLabel(method).command).toBe(command);
      expect(byLabel(method).mutating).toBe(false);
      expect(parse(method, request)).toEqual(args);
    }
  });

  it('validates skill ids and skill text in UTF-8 bytes, allowing empty text', () => {
    const id = (value: unknown, method = 'skill') => parse(method, { skillId: value, ...(method === 'skill' ? {} : { text: '', expectedSha256: SHA }) });
    expect(id('a')).not.toBeTypeOf('string');
    expect(id('a.b_c-1')).not.toBeTypeOf('string');
    expect(id('a'.repeat(64))).not.toBeTypeOf('string');
    expect(id('9lives')).toEqual({ skill: '9lives' });
    expect(id('a'.repeat(65))).toContain('skillId must be a skill id');
    expect(id('')).toContain('skillId must be a skill id');
    expect(id('-a')).toContain('skillId must be a skill id');
    expect(id('../etc')).toContain('skillId must be a skill id');
    expect(id('Upper')).toContain('skillId must be a skill id');
    expect(parse('skill', {})).toBe('management.skill: skillId is required.');
    expect(parse('skill', { skillId: 'ok', extra: 1 })).toBe('management.skill: unknown field(s): extra.');
    const text = (value: unknown) => parse('updateSkill', { skillId: 'ok', text: value as never, expectedSha256: SHA });
    expect(text('')).toEqual({ skill: 'ok', text: '', expectedSha256: SHA });
    expect(text('a'.repeat(32768))).not.toBeTypeOf('string');
    expect(text('a'.repeat(32769))).toBe('management.updateSkill: text must be at most 32768 UTF-8 bytes.');
    expect(text('é'.repeat(16384))).not.toBeTypeOf('string');
    expect(text('é'.repeat(16385))).toBe('management.updateSkill: text must be at most 32768 UTF-8 bytes.');
    expect(text('😀'.repeat(8192))).not.toBeTypeOf('string');
    expect(text('😀'.repeat(8193))).toBe('management.updateSkill: text must be at most 32768 UTF-8 bytes.');
    expect(text('\ud800')).toContain('unpaired surrogates');
    expect(text(5)).toBe('management.updateSkill: text must be a string.');
  });

  it('validates create skill nested fields and copies the text', () => {
    const create = (skill: unknown) => parse('createSkill', { skill });
    expect(create(undefined)).toBe('management.createSkill: skill is required.');
    expect(create('x')).toBe('management.createSkill: skill must be an object.');
    expect(create({})).toBe('management.createSkill: skill.id is required.');
    expect(create({ id: 'ok' })).toBe('management.createSkill: skill.text is required.');
    expect(create({ id: 'Bad', text: '' })).toContain('skill.id must be a skill id');
    expect(create({ id: 'ok', text: 1 })).toBe('management.createSkill: skill.text must be a string.');
    expect(create({ id: 'ok', text: 'x', path: '/etc' })).toBe('management.createSkill: unknown field(s): skill.path.');
    expect(create({ id: 'ok', text: 'a'.repeat(32768) })).not.toBeTypeOf('string');
    expect(create({ id: 'ok', text: 'a'.repeat(32769) })).toBe('management.createSkill: skill.text must be at most 32768 UTF-8 bytes.');
    expect(create({ id: 'ok', text: 'é'.repeat(16384) })).not.toBeTypeOf('string');
    expect(create({ id: 'ok', text: 'é'.repeat(16385) })).toBe('management.createSkill: skill.text must be at most 32768 UTF-8 bytes.');
    expect(create({ id: 'ok', text: '\ud800' })).toBe('management.createSkill: skill.text must not contain unpaired surrogates.');
    expect(create({ id: 'ok', text: '' })).toEqual({ skill: { id: 'ok', text: '' } });
    expect(create({ id: '9lives', text: '' })).toEqual({ skill: { id: '9lives', text: '' } });
  });

  it('requires exact update and delete concurrency tokens and copies roles', () => {
    expect(parse('updateSkill', { skillId: 'ok', text: '' })).toBe('management.updateSkill: expectedSha256 is required.');
    expect(parse('updateSkill', { skillId: 'ok', text: '', expectedSha256: 'A'.repeat(64) })).toBe('management.updateSkill: expectedSha256 must be a lowercase hex sha256.');
    expect(parse('deleteSkill', { skillId: 'ok', expectedSha256: SHA })).toBe('management.deleteSkill: expectedRolesSha256 is required.');
    expect(parse('deleteSkill', { skillId: 'ok', expectedRolesSha256: SHA, expectedSha256: null })).toEqual({ skill: 'ok', expectedRolesSha256: SHA, expectedSha256: null });
    expect(parse('deleteSkill', { skillId: 'ok', expectedRolesSha256: SHA, expectedSha256: 'ABC' })).toBe('management.deleteSkill: expectedSha256 must be a lowercase hex sha256 or null.');
    expect(parse('deleteSkill', { skillId: 'ok', expectedRolesSha256: 'x', expectedSha256: SHA })).toBe('management.deleteSkill: expectedRolesSha256 must be a lowercase hex sha256 or null.');
    expect(parse('deleteSkill', { skillId: 'ok', expectedRolesSha256: null, expectedSha256: SHA, count: 1 })).toBe('management.deleteSkill: unknown field(s): count.');
    const roles = ['Developer', 'TeamLead'];
    const out = parse('updateSkillRoles', { skillId: 'ok', roles, expectedRolesSha256: null }) as Record<string, unknown>;
    expect(out).toEqual({ skill: 'ok', roles, expectedRolesSha256: null });
    expect(out.roles).not.toBe(roles);
    expect(parse('updateSkillRoles', { skillId: 'ok', roles: [], expectedRolesSha256: null })).toEqual({ skill: 'ok', roles: [], expectedRolesSha256: null });
  });

  it('rejects invalid duplicate or oversized role lists', () => {
    const roles = (value: unknown) => parse('updateSkillRoles', { skillId: 'ok', roles: value, expectedRolesSha256: null });
    expect(roles('Developer')).toBe('management.updateSkillRoles: roles must be an array of role ids.');
    expect(roles(['Developer', 'Developer'])).toBe('management.updateSkillRoles: roles must not contain duplicates.');
    expect(roles(['Developer', 1])).toBe('management.updateSkillRoles: roles[1] must be a non-empty string of at most 64 characters.');
    expect(roles(['Developer', '  '])).toBe('management.updateSkillRoles: roles[1] must be a non-empty string of at most 64 characters.');
    expect(roles(['D'.repeat(65)])).toBe('management.updateSkillRoles: roles[0] must be a non-empty string of at most 64 characters.');
    expect(roles(Array.from({ length: 101 }, (_, i) => `r${i}`))).toBe('management.updateSkillRoles: roles must have at most 100 roles.');
    expect(roles(Array.from({ length: 100 }, (_, i) => `r${i}`))).not.toBeTypeOf('string');
  });

  it('rejects unknown skill fields before validation errors', () => {
    expect(parse('skills', { workspace: '/etc' })).toBe('management.skills: unknown field(s): workspace.');
    expect(parse('createSkill', { skill: { id: 'Bad', text: 1 }, extra: 1 })).toBe('management.createSkill: unknown field(s): extra.');
    expect(parse('updateSkill', { skillId: 'Bad', text: '', expectedSha256: SHA, role: 'x' })).toBe('management.updateSkill: unknown field(s): role.');
    expect(parse('updateSkillRoles', { skillId: 'ok', roles: ['a', 'a'], expectedRolesSha256: null, owner: 'x' })).toBe('management.updateSkillRoles: unknown field(s): owner.');
  });

});
