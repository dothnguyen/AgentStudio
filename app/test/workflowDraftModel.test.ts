import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { addStep, draftFromWorkflow, draftToSave, emptyDraft, moveStep, promptOptions, removeStep, renameStep, setRetry, setTarget, statusOptions, targetStatusOptions, validateDraft } from '../src/renderer/workflow/workflowDraftModel';
import type { BoardWorkflowDetail, BoardWorkflowSummary, BoardStatuses } from '../src/renderer/api';

const status = (id: string): BoardStatuses['statuses'][number] => ({ id, name: id, kind: null, type: 'unused', usedBy: [], ticketCount: 0 });
const statuses = [status('ready'), status('running'), status('qa')];
const workflow = { name: 'qa', title: 'QA', startsAt: 'qa', whileRunning: 'qa-running', role: 'QA', steps: [], end: {}, limits: {} } satisfies BoardWorkflowSummary;
const show = (name: string, stages: unknown[]): BoardWorkflowDetail => ({ name, text: '', sha256: 'sha', problems: [], start: { allowed: true, default: false }, definition: { name, version: 2, title: name, sourceSha256: 'sha', warnings: [], compiledSteps: true, startsAt: 'ready', whileRunning: 'running', role: 'Developer', end: { pass: 'qa', fail: 'ready' }, stages } });
const agent = (id: string, pass: string, visits = 1) => ({ id, type: 'agent', promptSource: `workflows/prompts/${id}.md`, permission: 'workspace_write', maxVisits: visits, next: { pass, fail: '$fail' } });
const check = (fail: string, visits = 1) => ({ id: 'tests', type: 'validation', checks: 'code', maxVisits: visits, next: { pass: '$succeed', fail } });
describe('workflow draft', () => {
  it('preserves overlapping retry limits from the original JSON', () => {
    const original = [{ id: 'a', action: 'merge' }, { id: 'b', action: 'merge', onFail: { retry: 'a', max: 2, then: 'end-fail' } }, { id: 'c', action: 'merge', onFail: { retry: 'a', max: 4, then: 'end-fail' } }];
    const detail = show('develop', []); detail.text = JSON.stringify({ version: 2, steps: original });
    expect(draftToSave(draftFromWorkflow(detail)).definition.steps).toEqual(original);
  });
  it('converts Develop and QA compiled steps into save definitions', () => {
    const develop = draftToSave(draftFromWorkflow(show('Develop', [agent('implement', 'tests', 4), check('implement', 4)]), 'board-sha'));
    expect(develop.definition.steps).toEqual([{ id: 'implement', agent: { prompt: 'implement.md', access: 'write' }, onPass: 'tests', onFail: 'end-fail' }, { id: 'tests', check: { checks: 'code' }, onPass: 'end-pass', onFail: { retry: 'implement', max: 3, then: 'end-fail' } }]);
    expect(develop).toMatchObject({ name: 'Develop', expectedSha256: 'sha', expectedBoardSha256: 'board-sha', start: { allowed: true, default: false } });
    const qa = draftToSave(draftFromWorkflow(show('QA', [agent('qa_tests', 'tests'), { ...check('qa'), next: { pass: 'qa', fail: 'qa' } }, { ...agent('qa', '$succeed'), passRequires: ['tests'] }])));
    expect(qa.definition.steps[1].onFail).toBe('qa'); expect(qa.definition.steps[2].passRequires).toEqual(['tests']);
  });
  it('adds, moves, renames, routes, retries and removes steps without mutation', () => {
    let d = emptyDraft(); for (const kind of ['agent', 'check', 'merge', 'approval'] as const) d = addStep(d, kind);
    expect(d.definition.steps.map(s => s.id)).toEqual(['agent', 'check', 'merge', 'approval']);
    d = setTarget(d, 1, 'pass', 'agent'); d = setRetry(d, 1, 'agent', 3); const before = d;
    d = renameStep(d, 0, 'work'); expect(before.definition.steps[0].id).toBe('agent'); expect(d.definition.steps[1]).toMatchObject({ onPass: 'work', onFail: { retry: 'work' } });
    d = moveStep(d, 3, 'up'); d = moveStep(d, 2, 'down'); expect(d.definition.steps[3].id).toBe('approval');
    d = removeStep(d, 0); expect(d.definition.steps[0]).toMatchObject({ onPass: 'end-fail', onFail: 'end-fail' });
    d = setTarget(d, 0, 'pass', undefined); expect(d.definition.steps[0].onPass).toBeUndefined();
  });
  it('reports local and backend problems by path', () => {
    let d = addStep(addStep(emptyDraft(), 'agent'), 'check'); d.definition.steps[1].id = 'agent'; d = setRetry(d, 0, 'agent', 0); d.definition.startsAt = 'qa'; d.definition.whileRunning = 'qa';
    const issues = validateDraft(d, statuses, [workflow], [{ path: 'end.fail', message: 'backend error' }]);
    for (const path of ['steps[0].agent.prompt', 'steps[1].id', 'steps[1].check', 'steps[0].onFail.retry', 'steps[0].onFail.max', 'role', 'startsAt', 'whileRunning', 'end.fail']) expect(issues.some(p => p.path === path)).toBe(true);
    d.definition.steps[0].id = 'Bad-id'; expect(validateDraft(d, statuses, []).some(p => p.path === 'steps[0].id')).toBe(true);
    expect(validateDraft(emptyDraft(), statuses, []).some(p => p.path === 'steps')).toBe(true);
  });
  it('provides free statuses, destination labels, and prompt creation', () => {
    expect(statusOptions(statuses, [workflow], '').map(o => o.value)).toEqual(['ready', 'running']);
    expect(targetStatusOptions(statuses, [workflow])[2].label).toBe('qa (starts QA)');
    expect(promptOptions([{ name: 'work', text: '', words: 0, sha256: '', users: [] }])).toEqual([{ value: 'work.md', label: 'work.md' }, { value: '', label: '+ New prompt…' }]);
  });
  it('covers defaults, boundaries, explicit targets and individual validation messages', () => {
    let d = emptyDraft();
    expect(validateDraft(d, statuses, [])).toEqual(expect.arrayContaining([{ path: 'steps', message: 'steps must contain 1-20 items' }, { path: 'startsAt', message: 'Choose a status.' }, { path: 'whileRunning', message: 'Choose a status.' }]));
    for (const kind of ['agent', 'check', 'merge', 'approval', 'agent'] as const) d = addStep(d, kind);
    expect(d.definition.steps).toEqual([{ id: 'agent', agent: { prompt: '', access: 'write' } }, { id: 'check', check: { checks: '' } }, { id: 'merge', action: 'merge' }, { id: 'approval', approval: { ask: '' } }, { id: 'agent_2', agent: { prompt: '', access: 'write' } }]);
    expect(moveStep(d, 0, 'up')).toEqual(d); expect(moveStep(d, 4, 'down')).toEqual(d); expect(removeStep(d, 9)).toEqual(d);
    d = setTarget(d, 0, 'fail', 'end-pass'); d = setTarget(d, 0, 'pass', 'end-fail'); expect(d.definition.steps[0]).toMatchObject({ onFail: 'end-pass', onPass: 'end-fail' });
    d.definition.startsAt = 'bad'; d.definition.whileRunning = 'ready'; d.definition.steps[1].id = 'Bad'; d = setRetry(d, 1, 'agent', 0);
    expect(validateDraft(d, statuses, [])).toEqual(expect.arrayContaining([{ path: 'startsAt', message: 'Choose a valid status with no kind.' }, { path: 'steps[1].id', message: 'id must match [a-z][a-z0-9_]{0,31}' }, { path: 'steps[1].onFail.max', message: 'max must be a positive integer' }, { path: 'steps[3].approval', message: 'requires non-empty text' }]));
    d.definition.startsAt = 'ready'; expect(validateDraft(d, statuses, [])).toContainEqual({ path: 'whileRunning', message: 'Status is also a workflow start status.' });
    expect(statusOptions(statuses, [workflow], 'qa').map(o => o.value)).toEqual(['ready', 'running', 'qa']);
  });
});


it('round trips the actual Develop and QA workflow source steps', () => {
  for (const name of ['board-develop', 'board-qa']) {
    const text = readFileSync(`../.agent-studio/workflows/${name}.yaml`, 'utf8');
    const detail = show(name, []); detail.text = text;
    const expected = name === 'board-develop' ? [
      { id: 'implement', agent: { prompt: 'board-develop.md', access: 'write' } },
      { id: 'tests', check: { checks: 'code' }, onFail: { retry: 'implement', max: 3, then: 'end-fail' } },
    ] : [
      { id: 'qa_tests', agent: { prompt: 'board-qa-tests.md', access: 'write' } },
      { id: 'tests', check: { checks: 'code' }, onFail: 'qa' },
      { id: 'qa', agent: { prompt: 'board-qa.md', access: 'read' }, passRequires: ['tests'] },
    ];
    expect(draftToSave(draftFromWorkflow(detail)).definition.steps).toEqual(expected);
  }
});

it('round trips the actual fixtures as complete save payloads', () => {
  const developDetail = show('board-develop', []);
  developDetail.definition = { name: 'board-develop', version: 2, title: 'board-develop', sourceSha256: 'sha', warnings: [], description: 'Board stage dev-ready. The Developer implements the ticket in its worktree; the coordinator then runs the check set for the change and sends a failure back to the Developer up to three times.', maxSteps: 10, startsAt: 'dev-ready', whileRunning: 'deving', role: 'Developer', workspace: 'worktree', syncBase: true, waitForDependencies: true, end: { pass: 'qa-ready', fail: 'dev-ready', blocked: { status: 'need-escalate', returnTo: 'dev-ready' } }, limits: { maxRuns: 6, failuresInARow: { count: 6, status: 'need-escalate' } }, steps: [] };
  developDetail.text = readFileSync('../.agent-studio/workflows/board-develop.yaml', 'utf8');
  const develop = draftToSave(draftFromWorkflow(developDetail, 'board-hash'));
  expect(develop).toEqual({
    name: 'board-develop',
    expectedSha256: 'sha', expectedBoardSha256: 'board-hash',
    start: { allowed: true, default: false },
    definition: {
      version: 2, title: 'board-develop', description: 'Board stage dev-ready. The Developer implements the ticket in its worktree; the coordinator then runs the check set for the change and sends a failure back to the Developer up to three times.',
      maxSteps: 10, startsAt: 'dev-ready', whileRunning: 'deving', role: 'Developer', workspace: 'worktree', syncBase: true, waitForDependencies: true,
      end: { pass: 'qa-ready', fail: 'dev-ready', blocked: { status: 'need-escalate', returnTo: 'dev-ready' } },
      limits: { maxRuns: 6, failuresInARow: { count: 6, status: 'need-escalate' } },
      steps: [
        { id: 'implement', agent: { prompt: 'board-develop.md', access: 'write' } },
        { id: 'tests', check: { checks: 'code' }, onFail: { retry: 'implement', max: 3, then: 'end-fail' } },
      ],
    },
  });
  const qaDetail = show('board-qa', []);
  qaDetail.definition = { name: 'board-qa', version: 2, title: 'board-qa', sourceSha256: 'sha', warnings: [], description: "Board stage qa-ready. QA adds tests for the ticket's acceptance criteria, the coordinator runs the check set for the change, and QA gives the verdict only after seeing that result.", maxSteps: 4, startsAt: 'qa-ready', whileRunning: 'qa-ing', role: 'QA', workspace: 'worktree', end: { pass: 'review-ready', fail: 'dev-ready' }, limits: { failuresInARow: { count: 3, status: 'need-escalate' }, onFailPriority: 0 }, steps: [] };
  qaDetail.text = readFileSync('../.agent-studio/workflows/board-qa.yaml', 'utf8');
  const qa = draftToSave(draftFromWorkflow(qaDetail));
  expect(qa.definition).toEqual({
    version: 2, title: 'board-qa', description: "Board stage qa-ready. QA adds tests for the ticket's acceptance criteria, the coordinator runs the check set for the change, and QA gives the verdict only after seeing that result.",
    maxSteps: 4, startsAt: 'qa-ready', whileRunning: 'qa-ing', role: 'QA', workspace: 'worktree',
    end: { pass: 'review-ready', fail: 'dev-ready' }, limits: { failuresInARow: { count: 3, status: 'need-escalate' }, onFailPriority: 0 },
    steps: [
      { id: 'qa_tests', agent: { prompt: 'board-qa-tests.md', access: 'write' } },
      { id: 'tests', check: { checks: 'code' }, onFail: 'qa' },
      { id: 'qa', agent: { prompt: 'board-qa.md', access: 'read' }, passRequires: ['tests'] },
    ],
  });
});

it('preserves overlapping YAML retries, including flow collections', () => {
  const detail = show('develop', []);
  detail.text = `version: 2
steps:
  - id: a
    action: merge
  - id: b
    action: merge
    onFail: {retry: a, max: 2, then: end-fail}
  - id: c
    action: merge
    onFail:
      retry: a
      max: 4
      then: end-fail
`;
  expect(draftToSave(draftFromWorkflow(detail)).definition.steps).toEqual([
    { id: 'a', action: 'merge' },
    { id: 'b', action: 'merge', onFail: { retry: 'a', max: 2, then: 'end-fail' } },
    { id: 'c', action: 'merge', onFail: { retry: 'a', max: 4, then: 'end-fail' } },
  ]);
});

it('replaces an implicit route to a removed step', () => {
  const d = addStep(addStep(emptyDraft(), 'merge'), 'check');
  expect(removeStep(d, 1).definition.steps[0].onPass).toBe('end-fail');
});

it('reports each validation message at its path', () => {
  let d = addStep(addStep(addStep(emptyDraft(), 'agent'), 'check'), 'approval');
  d.definition.steps[1].id = 'agent'; d = setRetry(d, 0, 'missing', 0);
  d.definition.startsAt = 'qa'; d.definition.whileRunning = 'qa';
  expect(validateDraft(d, statuses, [workflow])).toEqual(expect.arrayContaining([
    { path: 'steps[0].agent.prompt', message: 'Choose a prompt.' },
    { path: 'steps[1].id', message: 'duplicate stage id "agent"' },
    { path: 'steps[1].check', message: 'check requires a non-empty checks value' },
    { path: 'steps[2].approval', message: 'requires non-empty text' },
    { path: 'steps[0].onFail.retry', message: 'retry must name an earlier step' },
    { path: 'steps[0].onFail.max', message: 'max must be a positive integer' },
    { path: 'role', message: 'A workflow with an agent step requires a role.' },
    { path: 'startsAt', message: "Status 'qa' is already used by another workflow." },
    { path: 'whileRunning', message: "Status 'qa' is already used by another workflow." },
    { path: 'whileRunning', message: 'Status is also a workflow start status.' },
  ]));
});

it('reports required, malformed, and backend validation messages without duplicates', () => {
  const d = emptyDraft();
  d.name = 'develop';
  d.definition.steps = [
    { id: 'Bad-id', agent: { prompt: '  ', access: 'write' } },
    { id: 'later', check: { checks: '  ' }, onFail: { retry: 'later', max: 1, then: 'end-fail' } },
  ];
  d.definition.startsAt = '';
  d.definition.whileRunning = 'absent';
  const issues = validateDraft(d, statuses, [], [
    { path: 'steps[0].id', message: 'id must match [a-z][a-z0-9_]{0,31}' },
    { path: 'steps[0].id', message: 'id must match [a-z][a-z0-9_]{0,31}' },
  ]);
  expect(issues).toEqual(expect.arrayContaining([
    { path: 'steps[0].id', message: 'id must match [a-z][a-z0-9_]{0,31}' },
    { path: 'steps[0].agent.prompt', message: 'Choose a prompt.' },
    { path: 'steps[1].check', message: 'check requires a non-empty checks value' },
    { path: 'steps[1].onFail.retry', message: 'retry must name an earlier step' },
    { path: 'startsAt', message: 'Choose a status.' },
    { path: 'whileRunning', message: 'Choose a valid status with no kind.' },
    { path: 'steps[0].id', message: 'id must match [a-z][a-z0-9_]{0,31}' },
  ]));
  expect(issues.filter(p => p.path === 'steps[0].id' && p.message === 'id must match [a-z][a-z0-9_]{0,31}')).toHaveLength(2);
});

it('validates the maximum step count and rejects statuses with a kind', () => {
  let d = emptyDraft();
  for (let i = 0; i < 21; i++) d = addStep(d, 'merge');
  d.definition.startsAt = 'in-progress';
  d.definition.whileRunning = 'ready';
  const typedStatus = { ...status('in-progress'), kind: 'active' } as BoardStatuses['statuses'][number];
  const issues = validateDraft(d, [typedStatus, ...statuses], []);
  expect(issues).toContainEqual({ path: 'steps', message: 'steps must contain 1-20 items' });
  expect(issues).toContainEqual({ path: 'startsAt', message: 'Choose a valid status with no kind.' });
});

it('flags statuses used by another workflow and excludes typed statuses from options', () => {
  const other: BoardWorkflowSummary = { ...workflow, name: 'other', startsAt: 'ready', whileRunning: 'running' };
  const d = emptyDraft();
  d.definition.steps = [{ id: 'merge', action: 'merge' }];
  d.definition.startsAt = 'ready';
  d.definition.whileRunning = 'running';
  const typedStatus = { ...status('typed'), kind: 'done' } as BoardStatuses['statuses'][number];
  const choices = [ ...statuses, typedStatus ];
  const issues = validateDraft(d, choices, [other]);
  expect(issues).toContainEqual({ path: 'startsAt', message: "Status 'ready' is already used by another workflow." });
  expect(issues).toContainEqual({ path: 'whileRunning', message: "Status 'running' is already used by another workflow." });
  expect(statusOptions(choices, [other], 'new').map(option => option.value)).toEqual(['qa']);
});

it('refuses to reconstruct compiled steps when source YAML cannot be read', () => {
  const detail = show('develop', []); detail.text = 'steps: [invalid';
  expect(() => draftFromWorkflow(detail)).toThrow('Cannot safely read workflow source steps.');
});

it('reports invalid step kinds and retry shapes at backend paths', () => {
  const d = emptyDraft();
  d.definition.steps = [
    { id: 'first', action: 'merge' },
    { id: 'both', agent: { prompt: 'work.md', access: 'write' }, check: { checks: 'code' }, onFail: { retry: 'first', max: 1, then: 'end-pass' } },
    { id: 'none', onFail: { retry: 'first', max: 1 } },
    { id: 'extra', action: 'merge', onFail: { retry: 'first', max: 1, then: 'end-fail', extra: true } },
    { id: 'valid', action: 'merge', onFail: { retry: 'first', max: 1, then: 'end-fail' } },
  ] as unknown as typeof d.definition.steps;
  const issues = validateDraft(d, statuses, []);
  for (const path of ['steps[1]', 'steps[2]']) expect(issues).toContainEqual({ path, message: 'step needs exactly one kind' });
  for (const path of ['steps[1].onFail', 'steps[2].onFail', 'steps[3].onFail']) expect(issues).toContainEqual({ path, message: 'retry requires retry, max and then: end-fail' });
  expect(issues.some(p => p.path === 'steps[4]' || p.path === 'steps[4].onFail')).toBe(false);
});
