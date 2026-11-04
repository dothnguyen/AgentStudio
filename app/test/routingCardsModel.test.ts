import { describe, expect, it } from 'vitest';
import type { BoardStatuses, BoardWorkflows } from '../src/shared/management';
import { buildRoutingCards, filterRoutingCards } from '../src/renderer/workflow/routingCardsModel';

const statuses: BoardStatuses = { sha256: '', statuses: ['start', 'working', 'qa', 'done', 'detour', 'lost', 'blocked'].map(id => ({ id, name: ({ start: 'Dev ready', working: 'Developing', qa: 'QA ready' } as Record<string, string>)[id] ?? id, kind: null, type: 'unused', usedBy: [], ticketCount: 0 })) };
const board: BoardWorkflows = { problems: [], workflows: [
  { name: 'develop', title: 'Develop', startsAt: 'start', whileRunning: 'working', role: 'Developer', workspace: 'worktree', syncBase: true, waitForDependencies: true, steps: [{ id: 'implement', kind: 'work' }, { id: 'tests', kind: 'validation' }], end: { pass: 'qa', fail: 'detour', blocked: { status: 'blocked', returnTo: 'start' } }, limits: { maxRuns: 6, onFailPriority: 0 }, createdTickets: 'start' },
  { name: 'qa', title: 'QA', startsAt: 'qa', whileRunning: 'working', role: 'Tester', steps: [], end: { pass: 'done', fail: 'start' }, limits: {} },
  { name: 'detour', title: 'Resolve', startsAt: 'detour', whileRunning: 'working', role: null, steps: [{ id: 'merge', kind: 'action' }], end: { pass: { status: 'qa', releaseCreatedTickets: { from: 'start', to: 'qa' } }, fail: 'start' }, limits: {} },
  { name: 'lost', title: 'Fact check', startsAt: 'lost', whileRunning: 'working', role: 'Editor', steps: [], end: { pass: 'done', fail: 'lost' }, limits: {} },
] };
const details = [{ name: 'develop', definition: { steps: [{ id: 'implement', agent: { prompt: 'board-develop', access: 'write', delegates: ['test-unit'] } }, { id: 'tests', check: { checks: 'code' }, onFail: { retry: 'implement', max: 3, then: 'end-fail' } }] }, text: '', sha256: '', problems: [], start: { allowed: true, default: true } }];
const build = () => buildRoutingCards(board, statuses, { todoEntry: ['start'], todoDefault: 'start' }, details);
describe('routing cards', () => {
  it('classifies pass paths, fail detours and unreachable cycles', () => {
    const result = build();
    expect(result.cards.map(c => c.group)).toEqual(['main', 'main', 'detour', 'unreachable']);
    expect(result.cards.map(c => c.colour)).toEqual(['blue', 'blue', 'amber', 'grey']);
    expect(result.problems[0]?.workflow).toBe('lost');
    expect(result.problems[0]?.message).toBe('Fact check — lost cannot be reached from a start status, so it never runs.');
  });
  it('follows blocked return statuses only when finding detours', () => {
    const first = { ...board.workflows[0]!, end: { pass: { status: 'qa', returnTo: 'lost' }, fail: 'start', blocked: { status: 'blocked', returnTo: 'detour' } } };
    const result = buildRoutingCards({ ...board, workflows: [first, board.workflows[1]!, board.workflows[2]!, board.workflows[3]!] }, statuses, { todoEntry: ['start'], todoDefault: 'start' });
    expect(result.cards.map(c => c.group)).toEqual(['main', 'main', 'detour', 'unreachable']);
  });
  it('formats picks, steps, ends, limits and created tickets', () => {
    const [card, , detour] = build().cards;
    expect(card?.startTag).toBe('START HERE · DEFAULT');
    expect(card?.worksIn).toBe('Isolated worktree · sync base first · waits for dependencies');
    expect(card?.steps[0]?.detail).toBe('board-develop.md · edits files · may ask for test-unit');
    expect(card?.steps[0]?.pass).toBe('step 2 (tests)');
    expect(card?.steps[1]?.fail).toBe('back to step 1, up to 3 times, then end: fail');
    expect(card?.blocked).toBe('blocked, back to Dev ready');
    expect(card?.limits).toEqual(['Max 6 runs, then blocked', 'Priority 0 after a fail']);
    expect(card?.createdTickets).toBe('Tickets the agent creates wait in Dev ready.');
    expect(detour?.release).toBe('Then moves the tickets it created from Dev ready to QA ready.');
    expect(card?.summary).toBe('Dev ready → Developing · Developer · 2 steps · pass QA ready · fail detour');
  });
  it('filters case insensitively by title, status, role and prompt', () => {
    const cards = build().cards;
    for (const query of ['DEVELOP', 'dev ready', 'developer', 'board-develop.md']) expect(filterRoutingCards(cards, query)).toContain(cards[0]);
    expect(filterRoutingCards(cards, 'no match')).toEqual([]);
    expect(filterRoutingCards(cards, ' ')).toHaveLength(4);
  });
  it('filters by statuses used for limits and created ticket release', () => {
    const extraStatuses: BoardStatuses = { ...statuses, statuses: [...statuses.statuses, ...['threshold', 'holding', 'released'].map(id => ({ id, name: id, kind: null, type: 'unused', usedBy: [], ticketCount: 0 }))] };
    const wf = { ...board.workflows[0]!, limits: { failuresInARow: { count: 2, status: 'threshold' } }, createdTickets: 'holding', end: { pass: { status: 'qa', releaseCreatedTickets: { from: 'holding', to: 'released' } }, fail: 'start' } };
    const cards = buildRoutingCards({ ...board, workflows: [wf] }, extraStatuses, { todoEntry: ['start'], todoDefault: 'start' }).cards;
    for (const query of ['threshold', 'holding', 'released']) expect(filterRoutingCards(cards, query)).toEqual(cards);
  });
  it('uses available catalog information when workflow details are absent', () => {
    const [develop, , automatic] = buildRoutingCards(board, statuses, { todoEntry: ['start'], todoDefault: 'start' }).cards;
    expect(develop?.steps.map(step => step.kind)).toEqual(['agent', 'check']);
    expect(develop?.steps[1]?.detail).toBe('');
    expect(automatic).toMatchObject({ title: 'Resolve', file: 'detour.yaml', role: 'Automatic', colour: 'amber' });
    expect(automatic?.worksIn).toBe('Runs on the board, one ticket at a time');
  });
  it('does not count a returnTo on a pass end as an incoming route', () => {
    const first = { ...board.workflows[0]!, end: { pass: { status: 'qa', returnTo: 'lost' }, fail: 'start' } };
    const lost = { ...board.workflows[3]!, end: { pass: 'done', fail: 'start' } };
    const result = buildRoutingCards({ ...board, workflows: [first, lost] }, statuses, { todoEntry: ['start'], todoDefault: 'start' });
    expect(result.problems[0]?.message).toBe('Fact check — no workflow ends in lost and tickets cannot start there, so it never runs.');
  });
});

describe('board fixtures', () => {
  it('groups the converted repository board according to the design starts', async () => {
    const fixture = (await import('./fixtures/convertedBoard.json')).default;
    expect(fixture.starts).toEqual({ todoEntry: ['dev-ready', 'refine-ready', 'unpack-ready'], todoDefault: 'dev-ready' });
    const actual = buildRoutingCards(fixture.board, fixture.statuses as BoardStatuses, fixture.starts, fixture.details);
    expect(actual.cards.filter(c => c.group === 'main')).toHaveLength(7);
    expect(actual.cards.filter(c => c.group === 'detour')).toHaveLength(3);
    for (const name of ['board-resolve-merge', 'board-resolve-merge-plan-merge-conflict', 'board-senior-develop']) {
      const card = actual.cards.find(c => c.name === name)!;
      expect(card.group).toBe('detour');
      expect(card.startTag).toBeNull();
    }
    expect(actual.cards.filter(c => c.startTag).map(c => c.name)).toEqual([
      'board-develop', 'board-refine', 'board-unpack',
    ]);
    const develop = actual.cards.find(c => c.name === 'board-develop')!;
    expect(develop.summary).toBe('Dev ready → deving · Developer · 2 steps · pass QA ready · fail Dev ready');
    expect(develop.steps.map(s => [s.kind, s.detail, s.pass, s.fail])).toEqual([
      ['agent', 'board-develop.md · edits files', 'step 2 (tests)', 'end: fail'],
      ['check', 'check set code', 'end: pass', 'back to step 1, up to 3 times, then end: fail'],
    ]);
    expect(actual.cards.find(c => c.name === 'merge-merge-ready')?.steps[0]).toMatchObject({ kind: 'action', detail: 'merge' });
    expect(actual.cards.find(c => c.name === 'board-develop')?.worksIn).toBe('Isolated worktree · sync base first · waits for dependencies');
    expect(actual.cards.find(c => c.name === 'board-develop')?.createdTickets).toBeNull();
  });
  it('identifies the unreachable fact check workflow on the content board', () => {
    const ids = ['to-draft', 'drafting', 'to-edit', 'editing', 'to-publish', 'publishing', 'published', 'to-fact-check', 'fact-checking'];
    const contentStatuses: BoardStatuses = { sha256: '', statuses: ids.map(id => ({ id, name: id.split('-').map((s, i) => i ? s : s[0]!.toUpperCase() + s.slice(1)).join(' '), kind: null, type: 'unused', usedBy: [], ticketCount: 0 })) };
    const workflow = (name: string, title: string, startsAt: string, whileRunning: string, role: string, pass: string, fail: string) => ({ name, title, startsAt, whileRunning, role, steps: [], end: { pass, fail }, limits: {} });
    const content: BoardWorkflows = { problems: [], workflows: [
      workflow('draft', 'Draft', 'to-draft', 'drafting', 'Writer', 'to-edit', 'to-draft'),
      workflow('edit', 'Edit', 'to-edit', 'editing', 'Editor', 'to-publish', 'to-draft'),
      workflow('publish', 'Publish', 'to-publish', 'publishing', 'Publisher', 'published', 'to-edit'),
      workflow('fact-check', 'Fact check', 'to-fact-check', 'fact-checking', 'Researcher', 'to-edit', 'to-draft'),
    ] };
    const result = buildRoutingCards(content, contentStatuses, { todoEntry: ['to-draft'], todoDefault: 'to-draft' });
    expect(result.cards.map(c => c.group)).toEqual(['main', 'main', 'main', 'unreachable']);
    expect(result.problems).toEqual([{ workflow: 'fact-check', message: 'Fact check — no workflow ends in To fact check and tickets cannot start there, so it never runs.' }]);
  });
});
