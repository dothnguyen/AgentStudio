import { describe, expect, it } from 'vitest';
import { boardSettingsChanges, createRoutingDraft, errorProblems, updateRuleField, validateRoutingDraft } from '../src/renderer/teams/routingSettingsModel';
import { routingSettingsFixture } from './teamsFixtures';

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
