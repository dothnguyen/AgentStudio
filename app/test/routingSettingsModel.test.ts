import { describe, expect, it } from 'vitest';
import { boardSettingsChanges, createRoutingDraft, errorProblems, failureLimitOf, removeFailureLimit, setFailureLimit, updateFailureLimit, updateRuleField, validateRoutingDraft } from '../src/renderer/teams/routingSettingsModel';
import { escalationSettingsFixture, routingSettingsFixture } from './teamsFixtures';

describe('routing settings model', () => {
  it('clones and preserves raw nested properties and optional fields', () => {
    const s = routingSettingsFixture(); const d = createRoutingDraft(s)!;
    (d.rules[0].onPassCreatedTickets as { status: string }).status = 'changed';
    expect((s.board.config!.rules as typeof d.rules)[0].onPassCreatedTickets).toEqual({ status: 'backlog' });
    const changed = updateRuleField(updateRuleField(createRoutingDraft(s)!, 0, 'workspace', ''), 0, 'onBlocked', '');
    expect(changed.rules[0]).not.toHaveProperty('workspace'); expect(changed.rules[0]).not.toHaveProperty('onBlocked');
    expect(changed.rules[0].maxRounds).toBe(3); expect(changed.rules[0].onPassCreatedTickets).toEqual({ status: 'backlog' });
  });
  it('returns only changed keys', () => {
    const s = routingSettingsFixture(); const d = createRoutingDraft(s)!;
    expect(boardSettingsChanges(d, s)).toBeNull(); expect(boardSettingsChanges({ ...d, baseBranch: 'other' }, s)).toEqual({ baseBranch: 'other' });
    const changed = updateRuleField(d, 0, 'workspace', 'main'); expect(Object.keys(boardSettingsChanges(changed, s)!)).toEqual(['rules']);
    expect(Object.keys(boardSettingsChanges({ ...changed, baseBranch: 'other' }, s)!)).toEqual(['baseBranch', 'rules']);
  });
  it('validates choices, duplicates, reachability and protected roles', () => {
    const s = routingSettingsFixture(); const d = createRoutingDraft(s)!; expect(validateRoutingDraft(d, s)).toEqual([]);
    let changed = updateRuleField(d, 0, 'role', 'TeamLead'); changed = updateRuleField(changed, 1, 'status', 'backlog');
    const p = validateRoutingDraft(changed, s); expect(p).toContainEqual({ path: 'rules[0].workflow', message: 'The workflow must use role "TeamLead".' }); expect(p).toContainEqual({ path: 'rules[1].when.status', message: 'Only one rule can start from status "backlog".' }); expect(validateRoutingDraft(updateRuleField(d, 0, 'onPass', 'dev-ready'), s)).toContainEqual({ path: 'rules', message: 'No routing path reaches a done status.' });
    for (const i of [3, 4]) expect(validateRoutingDraft(updateRuleField(d, i, 'role', 'Developer'), s)).toContainEqual({ path: `rules[${i}].role`, message: 'This protected merge-conflict route must use TeamLead.' });
    expect(validateRoutingDraft(updateRuleField(d, 0, 'onPass', 'unknown'), s)).toContainEqual({ path: 'rules[0].onPass', message: 'Choose a status from this board.' });
  });
  it('ignores malformed error problems', () => { expect(errorProblems({ code: 'x', message: 'x', retryable: false, data: { problems: [null, { path: 1, message: 'x' }, { path: 'a', message: 'b', extra: 1 }] } })).toEqual([{ path: 'a', message: 'b' }]); });
});

it('rejects malformed snapshots and clones when objects independently', () => {
  const s = routingSettingsFixture();
  expect(createRoutingDraft({ ...s, board: { ...s.board, state: 'invalid' } })).toBeNull();
  expect(createRoutingDraft({ ...s, board: { ...s.board, config: { rules: [null] } } })).toBeNull();
  const draft = createRoutingDraft(s)!;
  (draft.rules[0].when as { status: string }).status = 'changed';
  expect(((s.board.config!.rules as typeof draft.rules)[0].when as { status: string }).status).toBe('backlog');
  expect(createRoutingDraft({ ...s, worktree: { ...s.worktree, baseBranch: null } })!.baseBranch).toBe('main');
});

it('validates each configured choice and branch boundary', () => {
  const s = routingSettingsFixture(); const d = createRoutingDraft(s)!;
  for (const branch of ['', '-bad', 'Upper', 'a'.repeat(65)]) {
    expect(validateRoutingDraft({ ...d, baseBranch: branch }, s)).toContainEqual({ path: 'baseBranch', message: 'Use 1–64 lowercase letters, numbers, or hyphens, starting with a letter or number.' });
  }
  for (const field of ['status', 'onPass', 'onFail', 'onBlocked'] as const) {
    const path = field === 'status' ? 'when.status' : field;
    expect(validateRoutingDraft(updateRuleField(d, 0, field, 'unknown'), s)).toContainEqual({ path: `rules[0].${path}`, message: 'Choose a status from this board.' });
  }
  expect(validateRoutingDraft(updateRuleField(d, 0, 'role', 'unknown'), s)).toContainEqual({ path: 'rules[0].role', message: 'Choose a configured role.' });
  expect(validateRoutingDraft(updateRuleField(d, 0, 'workflow', 'unknown'), s)).toContainEqual({ path: 'rules[0].workflow', message: 'Choose a valid workflow.' });
  expect(validateRoutingDraft(updateRuleField(d, 0, 'workspace', 'elsewhere'), s)).toContainEqual({ path: 'rules[0].workspace', message: 'Choose Default, Main workspace, Isolated worktree, or No workspace.' });
  const invalidWorkflow = { ...s, workflows: s.workflows.map(w => w.name === 'board-develop' ? { ...w, errors: ['broken'] } : w) };
  expect(validateRoutingDraft(d, invalidWorkflow)).toContainEqual({ path: 'rules[0].workflow', message: 'Choose a valid workflow.' });
  const rules = d.rules.map((r, i) => i === 1 ? { ...r, action: 'delete' } : r);
  expect(validateRoutingDraft({ ...d, rules }, s)).toContainEqual({ path: 'rules[1].action', message: 'Only the configured merge action can be edited here.' });
});

it('protects conflict routes by status after rules are reordered', () => {
  const s = routingSettingsFixture(); const d = createRoutingDraft(s)!;
  const rules = [...d.rules].reverse();
  for (const status of ['merge-conflict', 'plan-merge-conflict']) {
    const i = rules.findIndex(r => (r.when as { status: string }).status === status);
    expect(validateRoutingDraft(updateRuleField({ ...d, rules }, i, 'role', 'Developer'), s)).toContainEqual({ path: `rules[${i}].role`, message: 'This protected merge-conflict route must use TeamLead.' });
  }
});

it('updates a rule without mutating the draft or other raw properties', () => {
  const draft = createRoutingDraft(routingSettingsFixture())!;
  const original = structuredClone(draft);
  const updated = updateRuleField(draft, 0, 'status', 'dev-ready');
  expect(draft).toEqual(original);
  expect(updated.rules[0]).toEqual({ ...original.rules[0], when: { ...(original.rules[0].when as object), status: 'dev-ready' } });
  expect(updated.rules.slice(1)).toEqual(original.rules.slice(1));
});

it.each(['onFail', 'onBlocked'] as const)('finds a done path through %s', edge => {
  const settings = routingSettingsFixture();
  const draft = createRoutingDraft(settings)!;
  let changed = updateRuleField(draft, 0, 'onPass', 'dev-ready');
  changed = updateRuleField(changed, 0, 'onFail', 'dev-ready');
  changed = updateRuleField(changed, 0, edge, 'merge-ready');
  expect(validateRoutingDraft(changed, settings)).not.toContainEqual({ path: 'rules', message: 'No routing path reaches a done status.' });
});

describe('failure escalation', () => {
  const policy = { count: 3, status: 'need-escalate' };
  const setup = () => { const s = escalationSettingsFixture(); return { s, d: createRoutingDraft(s)! }; };
  it('projects QA and review escalation and validates clean', () => {
    const { s, d } = setup();
    expect(s.rules[5].onFailureLimit).toEqual(policy); expect(s.rules[6].onFailureLimit).toEqual(policy);
    expect(s.rules[7].onFailureLimit).toBeNull(); expect(s.rules[7].role).toBe('SeniorDeveloper');
    expect(routingSettingsFixture().rules.every(r => r.onFailureLimit === null)).toBe(true);
    expect(failureLimitOf(d.rules[5])).toEqual(policy);
    expect(validateRoutingDraft(d, s)).toEqual([]);
  });
  it('adds a policy without touching other raw fields', () => {
    const s = routingSettingsFixture(); const d = createRoutingDraft(s)!; const before = structuredClone(d);
    const u = setFailureLimit(d, 0, { count: 2, status: 'dev-ready' });
    expect(d).toEqual(before);
    expect(u.rules[0]).toEqual({ ...before.rules[0], onFailureLimit: { count: 2, status: 'dev-ready' } });
    expect(u.rules.slice(1)).toEqual(before.rules.slice(1));
    expect(boardSettingsChanges(u, s)).toEqual({ rules: u.rules });
  });
  it('changes count and status independently', () => {
    const { d } = setup();
    expect(updateFailureLimit(d, 5, 'count', 5).rules[5].onFailureLimit).toEqual({ count: 5, status: 'need-escalate' });
    const st = updateFailureLimit(d, 5, 'status', 'dev-ready');
    expect(st.rules[5].onFailureLimit).toEqual({ count: 3, status: 'dev-ready' });
    expect(st.rules[5].onFailPriority).toBe(0); expect(st.rules[5].workspace).toBe('worktree');
    expect(updateFailureLimit(d, 0, 'count', 5)).toEqual(d);
  });
  it('preserves an invalid NaN count when another field is edited', () => {
    const { s, d } = setup();
    const invalid = updateFailureLimit(d, 5, 'count', Number.NaN);
    const updated = updateFailureLimit(invalid, 5, 'status', 'dev-ready');
    expect((updated.rules[5].onFailureLimit as { count: number }).count).toBeNaN();
    expect(validateRoutingDraft(updated, s)).toContainEqual({ path: 'rules[5].onFailureLimit.count', message: 'Use a whole number of at least 1.' });
    expect((updateRuleField(invalid, 5, 'onPass', 'dev-ready').rules[5].onFailureLimit as { count: number }).count).toBeNaN();
  });
  it('removes only onFailureLimit', () => {
    const { d } = setup(); const r = removeFailureLimit(d, 5);
    const { onFailureLimit: _omit, ...rest } = d.rules[5];
    expect(r.rules[5]).not.toHaveProperty('onFailureLimit'); expect(r.rules[5]).toEqual(rest);
    expect(r.rules[6].onFailureLimit).toEqual(policy);
    expect(removeFailureLimit(d, 0)).toEqual(d);
  });
  it('detects no-op edits', () => {
    const { s, d } = setup();
    expect(boardSettingsChanges(setFailureLimit(d, 5, { ...policy }), s)).toBeNull();
    const base = routingSettingsFixture();
    expect(boardSettingsChanges(removeFailureLimit(setFailureLimit(createRoutingDraft(base)!, 0, { count: 2, status: 'dev-ready' }), 0), base)).toBeNull();
    expect(setFailureLimit(d, 99, { ...policy })).toEqual(d);
  });
  it.each([0, -1, 1.5, Number.NaN])('rejects count %s', (c) => {
    const { s, d } = setup();
    expect(validateRoutingDraft(updateFailureLimit(d, 5, 'count', c), s)).toContainEqual({ path: 'rules[5].onFailureLimit.count', message: 'Use a whole number of at least 1.' });
  });
  it('rejects a string count', () => {
    const { s, d } = setup(); const rules = structuredClone(d.rules);
    rules[5].onFailureLimit = { count: '3', status: 'need-escalate' };
    expect(validateRoutingDraft({ ...d, rules }, s)).toContainEqual({ path: 'rules[5].onFailureLimit.count', message: 'Use a whole number of at least 1.' });
  });
  it('rejects unknown or empty target status', () => {
    const { s, d } = setup();
    for (const v of ['unknown', '']) expect(validateRoutingDraft(updateFailureLimit(d, 5, 'status', v), s)).toContainEqual({ path: 'rules[5].onFailureLimit.status', message: 'Choose a status from this board.' });
  });
  it('rejects malformed policies', () => {
    const { s, d } = setup();
    for (const bad of [null, { count: 3 }, { count: 3, status: 'need-escalate', extra: 1 }]) {
      const rules = structuredClone(d.rules); rules[5].onFailureLimit = bad;
      expect(validateRoutingDraft({ ...d, rules }, s)).toContainEqual({ path: 'rules[5].onFailureLimit', message: 'Failure escalation needs a count and a target status.' });
    }
  });
  it('rejects a policy on an action rule', () => {
    const s = routingSettingsFixture(); const d = setFailureLimit(createRoutingDraft(s)!, 1, { count: 2, status: 'done' });
    expect(validateRoutingDraft(d, s)).toContainEqual({ path: 'rules[1].onFailureLimit', message: 'Failure escalation is only available on agent rules.' });
  });
  it('reaches done only through the escalation target', () => {
    const { s, d } = setup(); const none = { path: 'rules', message: 'No routing path reaches a done status.' };
    let x = updateRuleField(d, 0, 'onPass', 'qa-ready'); x = updateRuleField(x, 0, 'onFail', 'qa-ready');
    x = updateRuleField(x, 5, 'onPass', 'dev-ready'); x = updateRuleField(x, 5, 'onFail', 'dev-ready'); x = updateRuleField(x, 7, 'onPass', 'merge-ready');
    expect(validateRoutingDraft(x, s)).not.toContainEqual(none);
    expect(validateRoutingDraft(removeFailureLimit(x, 5), s)).toContainEqual(none);
  });
  it('keeps unknown rule fields through every helper', () => {
    const { d } = setup(); const rules = structuredClone(d.rules); rules[5].futureKey = { a: 1 };
    const x = { ...d, rules };
    for (const out of [setFailureLimit(x, 5, { count: 9, status: 'dev-ready' }), updateFailureLimit(x, 5, 'count', 4), removeFailureLimit(x, 5)]) expect(out.rules[5].futureKey).toEqual({ a: 1 });
  });
  it('reads only object policies with numeric count and string status and returns a copy', () => {
    expect(failureLimitOf(undefined)).toBeNull();
    for (const value of [null, [], 'policy', { count: '3', status: 'need-escalate' }, { count: 3, status: 1 }]) {
      expect(failureLimitOf({ onFailureLimit: value })).toBeNull();
    }
    const original = { count: 3, status: 'need-escalate', extra: true };
    const result = failureLimitOf({ onFailureLimit: original });
    expect(result).toEqual(policy); expect(result).not.toBe(original);
  });
  it('preserves policy key order on no-op and update, and replaces changed policies exactly', () => {
    const { d } = setup(); const rules = structuredClone(d.rules);
    rules[5].onFailureLimit = { status: 'need-escalate', count: 3, extra: 1 };
    const input = { ...d, rules }; const before = structuredClone(input);
    const unchanged = setFailureLimit(input, 5, policy);
    expect(JSON.stringify(unchanged)).toBe(JSON.stringify(input));
    const updated = updateFailureLimit(input, 5, 'count', 4);
    expect(Object.keys(updated.rules[5].onFailureLimit as object)).toEqual(['status', 'count', 'extra']);
    expect(updated.rules[5].onFailureLimit).toEqual({ status: 'need-escalate', count: 4, extra: 1 });
    const replaced = setFailureLimit(input, 5, { count: 4, status: 'dev-ready' });
    expect(Object.keys(replaced.rules[5].onFailureLimit as object)).toEqual(['count', 'status']);
    expect(input).toEqual(before);
    removeFailureLimit(input, 5); expect(input).toEqual(before);
  });
  it('returns cloned unchanged rules for out-of-range helper calls', () => {
    const { d } = setup();
    for (const result of [setFailureLimit(d, 99, policy), updateFailureLimit(d, 99, 'count', 2), removeFailureLimit(d, 99)]) {
      expect(result).toEqual(d); expect(result.rules).not.toBe(d.rules);
    }
  });
  it('reports both invalid count and non-string status independently', () => {
    const { s, d } = setup(); const rules = structuredClone(d.rules);
    rules[5].onFailureLimit = { count: true, status: 42 };
    const problems = validateRoutingDraft({ ...d, rules }, s);
    expect(problems).toContainEqual({ path: 'rules[5].onFailureLimit.count', message: 'Use a whole number of at least 1.' });
    expect(problems).toContainEqual({ path: 'rules[5].onFailureLimit.status', message: 'Choose a status from this board.' });
  });
  it('rejects array and string policies and uses action presence for action rules', () => {
    const { s, d } = setup();
    for (const value of [[], 'policy']) {
      const rules = structuredClone(d.rules); rules[5].onFailureLimit = value;
      expect(validateRoutingDraft({ ...d, rules }, s)).toContainEqual({ path: 'rules[5].onFailureLimit', message: 'Failure escalation needs a count and a target status.' });
    }
    const rules = structuredClone(d.rules); rules[5].action = 'merge';
    expect(validateRoutingDraft({ ...d, rules }, s)).toContainEqual({ path: 'rules[5].onFailureLimit', message: 'Failure escalation is only available on agent rules.' });
  });
  it('does not create a policy when updating a non-object value', () => {
    const { d } = setup();
    for (const value of [null, [], 'policy']) {
      const rules = structuredClone(d.rules); rules[5].onFailureLimit = value;
      const input = { ...d, rules };
      expect(updateFailureLimit(input, 5, 'count', 4)).toEqual(input);
    }
  });
  it('preserves backend failure escalation problem paths', () => {
    const problems = ['rules[5].onFailureLimit', 'rules[5].onFailureLimit.count', 'rules[5].onFailureLimit.status']
      .map(path => ({ path, message: 'Invalid policy' }));
    expect(errorProblems({ code: 'BOARD_CONFIG_INVALID', message: 'Invalid board', retryable: false, data: { problems } })).toEqual(problems);
  });
});
