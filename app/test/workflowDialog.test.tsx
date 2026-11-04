// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowDialog } from '../src/renderer/workflow/WorkflowDialog';
import { draftFromWorkflow, emptyDraft, type WorkflowDraft } from '../src/renderer/workflow/workflowDraftModel';
import type { BoardSettings, BoardStatuses, BoardWorkflowDetail, BoardWorkflows, CheckSetList, PromptList, Workspace } from '../src/renderer/api';
import { boardSettingsFixture, fakeManagement } from './teamsFixtures';

afterEach(() => cleanup());
afterEach(() => vi.restoreAllMocks());

const workspace: Workspace = { id: 'ws', name: 'Workspace', path: '/ws', exists: true, missing: false };
const status = (id: string, name = id, ticketCount = 0): BoardStatuses['statuses'][number] => ({ id, name, kind: null, type: 'unused', usedBy: [], ticketCount });
const statuses = (ticketsInDeving = 0): BoardStatuses => ({ sha256: 'status-sha', statuses: [
  status('refine-ready', 'Refine ready'), status('refining', 'Refining'), status('dev-ready', 'Dev ready'),
  status('deving', 'Developing', ticketsInDeving), status('qa-ready', 'QA ready'), status('qa-ing', 'QA-ing'),
  status('need-escalate', 'Needs escalation'), status('done', 'Done', 0),
] });
const workflows: BoardWorkflows = { problems: [], workflows: [
  { name: 'board-refine', title: 'Refine', startsAt: 'refine-ready', whileRunning: 'refining', role: 'TeamLead', steps: [], end: { pass: 'dev-ready', fail: 'refine-ready' }, limits: {} },
  { name: 'board-develop', title: 'Develop', startsAt: 'dev-ready', whileRunning: 'deving', role: 'Developer', workspace: 'worktree', syncBase: true, waitForDependencies: true, steps: [{ id: 'implement', kind: 'agent' }, { id: 'tests', kind: 'check' }], end: { pass: 'qa-ready', fail: 'dev-ready', blocked: { status: 'need-escalate', returnTo: 'dev-ready' } }, limits: { maxRuns: 6, failuresInARow: { count: 3, status: 'need-escalate' }, onFailPriority: 0 }, createdTickets: 'dev-ready' },
  { name: 'board-qa', title: 'QA', startsAt: 'qa-ready', whileRunning: 'qa-ing', role: 'QA', steps: [], end: { pass: 'done', fail: 'dev-ready' }, limits: {} },
] };
const prompts: PromptList = { prompts: [
  { name: 'board-develop', text: 'Implement {{task}}', words: 2, sha256: 'prompt-sha', users: [{ workflow: 'board-develop', step: 'implement' }, { workflow: 'board-qa', step: 'qa' }] },
  { name: 'board-qa-tests', text: 'Copy {{task}}', words: 2, sha256: 'qa-prompt-sha', users: [] },
] };
const checkSets: CheckSetList = {
  checkSets: [{ id: 'code', run: [{ command: 'test-ui', when: ['app/**', 'scripts/**'] }, { command: 'test-backend', when: ['backend/**', 'tests/**'] }], otherwise: 'test-unit', reuseIfTested: true }],
  commands: [{ id: 'test-unit', description: 'Unit tests' }, { id: 'test-touched', description: 'Touched tests' }, { id: 'app-deps-install', description: 'Install app dependencies' }],
  problems: [],
};
const detail: BoardWorkflowDetail = {
  name: 'board-develop', text: '', sha256: 'workflow-sha', problems: [], start: { allowed: true, default: true },
  definition: {
    version: 2, title: 'Develop', startsAt: 'dev-ready', whileRunning: 'deving', role: 'Developer', workspace: 'worktree',
    syncBase: true, waitForDependencies: true, createdTickets: 'dev-ready',
    end: { pass: { status: 'qa-ready', releaseCreatedTickets: { from: 'dev-ready', to: 'qa-ready' } }, fail: 'dev-ready', blocked: { status: 'need-escalate', returnTo: 'dev-ready' } },
    limits: { maxRuns: 6, failuresInARow: { count: 3, status: 'need-escalate' }, onFailPriority: 0 },
    steps: [
      { id: 'implement', agent: { prompt: 'board-develop.md', access: 'write', delegates: ['test-unit'] } },
      { id: 'tests', check: { checks: 'code' }, onFail: { retry: 'implement', max: 3, then: 'end-fail' } },
    ],
  },
};
const allKinds: BoardWorkflowDetail = {
  ...detail,
  definition: {
    ...detail.definition,
    steps: [
      { id: 'implement', agent: { prompt: 'board-develop.md', access: 'write', delegates: ['test-unit'] } },
      { id: 'tests', check: { checks: 'code' }, onFail: { retry: 'implement', max: 3, then: 'end-fail' } },
      { id: 'merge', action: 'merge' },
      { id: 'approve', approval: { ask: 'Publish this post?' } },
    ],
  },
};

function setup(overrides: {
  ticketsInDeving?: number;
  save?: ReturnType<typeof vi.fn>;
  savePrompt?: ReturnType<typeof vi.fn>;
  remove?: ReturnType<typeof vi.fn>;
  onClose?: () => void;
  onOpenPrompt?: (name: string) => void;
  draft?: WorkflowDraft;
  workflowList?: BoardWorkflows;
  promptList?: PromptList;
} = {}) {
  const save = overrides.save ?? vi.fn(async () => ({ ok: true as const, data: detail }));
  const savePrompt = overrides.savePrompt ?? vi.fn(async (_ws: string, input: { name: string; text: string; expectedSha256: string | null }) => ({ ok: true as const, data: { name: input.name, text: input.text, words: 1, sha256: 'new-sha', users: [] } }));
  const remove = overrides.remove ?? vi.fn(async () => ({ ok: true as const, data: { name: 'board-develop' } }));
  const board: BoardSettings = { ...boardSettingsFixture(), board: { state: 'ok', sha256: 'board-sha', message: null, problems: [], config: {} }, roles: { state: 'ok', sha256: null, message: null, items: [{ id: 'Developer', description: null }, { id: 'QA', description: null }, { id: 'TeamLead', description: null }] } };
  const fake = fakeManagement({
    boardSettings: [{ ok: true, data: board }],
    calls: {
      boardStatuses: async () => ({ ok: true, data: statuses(overrides.ticketsInDeving ?? 0) }),
      boardWorkflows: async () => ({ ok: true, data: overrides.workflowList ?? workflows }),
      boardWorkflow: async () => ({ ok: true, data: detail }),
      prompts: async () => ({ ok: true, data: overrides.promptList ?? prompts }),
      checkSets: async () => ({ ok: true, data: checkSets }),
      saveBoardWorkflow: save,
      savePrompt,
      deleteBoardWorkflow: remove,
    },
  });
  const onClose = overrides.onClose ?? vi.fn();
  const view = render(<WorkflowDialog workspace={workspace} management={fake.api} draft={overrides.draft ?? draftFromWorkflow(detail)} onClose={onClose} onOpenPrompt={overrides.onOpenPrompt} />);
  return { view, save, savePrompt, remove, onClose };
}

describe('workflow dialog', () => {
  it('renders the non-step sections from the draft', async () => {
    const { view } = setup();
    await waitFor(() => expect(view.getAllByRole('option', { name: 'Dev ready' }).length).toBeGreaterThan(0));
    expect(view.getByRole('heading', { name: 'Edit workflow: Develop' })).toBeTruthy();
    expect(view.getByText((_, element) => element?.className === 'dialog-subtitle' && element.textContent?.includes('Refine → Develop → QA') === true)).toBeTruthy();
    expect(view.getByText('.agent-studio/workflows/board-develop.yaml')).toBeTruthy();
    for (const heading of ['1. Name and statuses', '2. Who and where', '3. Steps', '4. Where it ends', '5. Limits', '6. Starting here']) expect(view.getByRole('heading', { name: heading })).toBeTruthy();
    expect((view.getByLabelText('Name') as HTMLInputElement).value).toBe('Develop');
    expect((view.getByLabelText('Starts when a ticket is in') as HTMLSelectElement).value).toBe('dev-ready');
    expect((view.getByLabelText('Status while running') as HTMLSelectElement).value).toBe('deving');
    expect((view.getByLabelText('Role') as HTMLSelectElement).value).toBe('Developer');
    expect((view.getByLabelText('Works in') as HTMLSelectElement).value).toBe('worktree');
    expect((view.getByLabelText('Sync the base branch first') as HTMLInputElement).checked).toBe(true);
    expect((view.getByLabelText('Wait until its dependencies are done') as HTMLInputElement).checked).toBe(true);
    expect(view.getByRole('list', { name: 'Workflow steps' }).textContent).toContain('implement');
    expect(view.getByRole('list', { name: 'Workflow steps' }).textContent).toContain('tests');
    expect((view.getByLabelText('Passes → set status') as HTMLSelectElement).value).toBe('qa-ready');
    expect((view.getByLabelText('Fails → set status') as HTMLSelectElement).value).toBe('dev-ready');
    expect((view.getByLabelText('Return to') as HTMLSelectElement).value).toBe('dev-ready');
    fireEvent.click(view.getByText('Tickets this workflow creates'));
    expect((view.getByLabelText('New tickets the agent creates wait in') as HTMLSelectElement).value).toBe('dev-ready');
    expect((view.getByLabelText('Release from') as HTMLSelectElement).value).toBe('dev-ready');
    expect((view.getByLabelText('Release to') as HTMLSelectElement).value).toBe('qa-ready');
    expect((view.getByLabelText('Max runs per ticket') as HTMLInputElement).checked).toBe(true);
    expect((view.getByLabelText('Max runs') as HTMLInputElement).value).toBe('6');
    expect((view.getByLabelText('Escalate repeated fails') as HTMLInputElement).checked).toBe(true);
    expect((view.getByLabelText('Failures in a row') as HTMLInputElement).value).toBe('3');
    expect((view.getByLabelText('Failure status') as HTMLSelectElement).value).toBe('need-escalate');
    expect((view.getByLabelText('Raise priority after a fail') as HTMLInputElement).checked).toBe(true);
    expect((view.getByLabelText('Priority after a fail') as HTMLInputElement).value).toBe('0');
    expect((view.getByLabelText(/Tickets can start here/) as HTMLInputElement).checked).toBe(true);
    expect((view.getByLabelText(/Default start/) as HTMLInputElement).checked).toBe(true);
  });

  it('renders every step card field and its routing from the draft', async () => {
    const onOpenPrompt = vi.fn();
    const { view } = setup({ draft: draftFromWorkflow(allKinds), onOpenPrompt });
    await waitFor(() => expect(view.getByRole('option', { name: 'board-develop.md' })).toBeTruthy());
    const cards = within(view.getByRole('list', { name: 'Workflow steps' })).getAllByRole('listitem');
    expect(cards).toHaveLength(4);

    const agent = within(cards[0]!);
    expect((agent.getByLabelText('Step 1 id') as HTMLInputElement).value).toBe('implement');
    expect((agent.getByLabelText('Prompt') as HTMLSelectElement).value).toBe('board-develop.md');
    expect((agent.getByLabelText('The agent may') as HTMLSelectElement).value).toBe('write');
    expect(agent.getByText('Also used by QA: edits change both.')).toBeTruthy();
    expect(agent.getByText((_, element) => element?.className === 'workflow-command-chip' && element.textContent?.includes('test-unit') === true)).toBeTruthy();
    fireEvent.click(agent.getByRole('button', { name: 'Edit board-develop.md →' }));
    expect(onOpenPrompt).toHaveBeenCalledWith('board-develop');
    fireEvent.change(agent.getByLabelText('The agent may'), { target: { value: 'read' } });
    expect((agent.getByLabelText('The agent may') as HTMLSelectElement).value).toBe('read');
    expect((agent.getByLabelText('If it passes') as HTMLSelectElement).value).toBe('tests');
    expect((agent.getByLabelText('If it fails') as HTMLSelectElement).value).toBe('end-fail');

    const check = within(cards[1]!);
    expect((check.getByLabelText('Check set') as HTMLSelectElement).value).toBe('code');
    expect(check.getByText('test-ui')).toBeTruthy();
    expect(check.getByText('test-backend')).toBeTruthy();
    expect(check.getByText(/Skips a command that already passed/)).toBeTruthy();
    expect((check.getByLabelText('If it passes') as HTMLSelectElement).value).toBe('merge');
    expect((check.getByLabelText('If it fails') as HTMLSelectElement).value).toBe('__retry');
    expect((check.getByLabelText('Retry step') as HTMLSelectElement).value).toBe('implement');
    expect((check.getByLabelText('Retry times') as HTMLInputElement).value).toBe('3');

    const merge = within(cards[2]!);
    expect(merge.queryByLabelText('Prompt')).toBeNull();
    expect(merge.queryByLabelText('Check set')).toBeNull();
    expect((merge.getByLabelText('If it passes') as HTMLSelectElement).value).toBe('approve');
    expect((merge.getByLabelText('If it fails') as HTMLSelectElement).value).toBe('end-fail');

    const approval = within(cards[3]!);
    expect((approval.getByLabelText('Question for the operator') as HTMLInputElement).value).toBe('Publish this post?');
    expect((approval.getByLabelText('If approved') as HTMLSelectElement).value).toBe('end-pass');
    expect((approval.getByLabelText('If rejected') as HTMLSelectElement).value).toBe('end-fail');
  });

  it('adds each step kind from the Add step buttons', async () => {
    const { view } = setup({ draft: emptyDraft() });
    await waitFor(() => expect((view.getByRole('button', { name: 'Add workflow' }) as HTMLButtonElement).disabled).toBe(false));
    for (const label of ['+ Agent', '+ Check', '+ Merge', '+ Approval']) fireEvent.click(view.getByRole('button', { name: label }));
    const cards = within(view.getByRole('list', { name: 'Workflow steps' })).getAllByRole('listitem');
    expect(cards).toHaveLength(4);
    expect(view.getByRole('button', { name: 'Drag agent' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'Drag check' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'Drag merge' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'Drag approval' })).toBeTruthy();
  });

  it('creates a new prompt with prompt.save before saving the workflow', async () => {
    const savePrompt = vi.fn(async (_ws: string, input: { name: string; text: string; expectedSha256: string | null }) => ({ ok: true as const, data: { name: input.name, text: input.text, words: 1, sha256: 'new-sha', users: [] } }));
    const { view, save } = setup({ savePrompt });
    await waitFor(() => expect((view.getByRole('button', { name: 'Save workflow' }) as HTMLButtonElement).disabled).toBe(false));
    expect(view.getByRole('option', { name: 'board-develop.md' })).toBeTruthy();
    const card = within(view.getByRole('list', { name: 'Workflow steps' })).getAllByRole('listitem')[0]!;
    fireEvent.change(within(card).getByLabelText('Prompt'), { target: { value: '' } });
    fireEvent.change(within(card).getByLabelText('New prompt name'), { target: { value: 'publish-post' } });
    fireEvent.change(within(card).getByLabelText('Start from'), { target: { value: 'board-qa-tests' } });
    fireEvent.click(view.getByRole('button', { name: 'Save workflow' }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(savePrompt).toHaveBeenCalledWith('ws', { name: 'publish-post', text: 'Copy {{task}}', expectedSha256: null });
    expect(save).toHaveBeenCalledWith('ws', expect.objectContaining({
      name: 'board-develop',
      definition: expect.objectContaining({
        steps: [
          expect.objectContaining({ id: 'implement', agent: expect.objectContaining({ prompt: 'publish-post.md' }) }),
          expect.anything(),
        ],
      }),
    }));
  });

  it('warns when nothing sets the start status and tickets cannot start there', async () => {
    const draft = emptyDraft();
    draft.definition.title = 'Publish';
    draft.definition.startsAt = 'need-escalate';
    draft.definition.whileRunning = 'deving';
    draft.definition.steps = [{ id: 'approve', approval: { ask: 'Publish?' } }];
    const { view } = setup({ draft });
    await waitFor(() => expect(view.getByText(/Nothing sets Needs escalation yet/)).toBeTruthy());
    expect(view.getByText(/tickets cannot start here/)).toBeTruthy();
    fireEvent.click(view.getByLabelText(/Tickets can start here/));
    expect(view.queryByText(/Nothing sets Needs escalation yet/)).toBeNull();
  });

  it('saves the edited draft with both shas and the start flags', async () => {
    const { view, save, onClose } = setup();
    await waitFor(() => expect((view.getByRole('button', { name: 'Save workflow' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(view.getByLabelText('Name'), { target: { value: 'Develop v2' } });
    fireEvent.change(view.getByLabelText('Starts when a ticket is in'), { target: { value: 'dev-ready' } });
    fireEvent.click(view.getByRole('button', { name: 'Save workflow' }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save).toHaveBeenCalledWith('ws', expect.objectContaining({
      name: 'board-develop', expectedSha256: 'workflow-sha', expectedBoardSha256: 'board-sha',
      start: { allowed: true, default: true },
      definition: expect.objectContaining({ title: 'Develop v2', startsAt: 'dev-ready', whileRunning: 'deving', role: 'Developer', workspace: 'worktree' }),
    }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it('adds a new workflow with a name derived from its title', async () => {
    const draft = emptyDraft();
    draft.definition.title = 'Publish';
    draft.definition.startsAt = 'dev-ready';
    draft.definition.whileRunning = 'deving';
    const { view, save } = setup({ draft });
    await waitFor(() => expect((view.getByRole('button', { name: 'Add workflow' }) as HTMLButtonElement).disabled).toBe(false));
    expect(view.getByText('.agent-studio/workflows/publish.yaml')).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: 'Add workflow' }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save).toHaveBeenCalledWith('ws', expect.objectContaining({ name: 'publish', expectedSha256: null, expectedBoardSha256: 'board-sha' }));
  });

  it('places backend problems next to their paths and keeps the dialog open', async () => {
    const save = vi.fn(async () => ({ ok: false as const, error: { code: 'BOARD_WORKFLOW_INVALID', message: 'Invalid board workflow.', retryable: false, data: { problems: [
      { path: 'startsAt', message: 'Unknown status.' },
      { path: 'end.fail', message: 'Fail status is missing.' },
      { path: 'limits.maxRuns', message: 'Max runs must be at least 1.' },
      { path: 'other.path', message: 'Another problem.' },
    ] } } }));
    const { view } = setup({ save });
    await waitFor(() => expect((view.getByRole('button', { name: 'Save workflow' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(view.getByRole('button', { name: 'Save workflow' }));
    await waitFor(() => expect(view.getByText('Unknown status.')).toBeTruthy());
    expect(view.getByText('Unknown status.').closest('[data-field]')?.getAttribute('data-field')).toBe('startsAt');
    expect(view.getByText('Fail status is missing.').closest('[data-field]')?.getAttribute('data-field')).toBe('end.fail');
    expect(view.getByText('Max runs must be at least 1.').closest('[data-field]')?.getAttribute('data-field')).toBe('limits.maxRuns');
    expect(view.getByText(/other\.path/)).toBeTruthy();
    expect(view.getByRole('heading', { name: 'Edit workflow: Develop' })).toBeTruthy();
  });

  it('disables delete while tickets are in the running status and confirms otherwise', async () => {
    const first = setup({ ticketsInDeving: 2 });
    await waitFor(() => expect(first.view.getAllByRole('option', { name: 'Developing' }).length).toBeGreaterThan(0));
    const disabled = first.view.getByRole('button', { name: 'Delete workflow' }) as HTMLButtonElement;
    expect(disabled.disabled).toBe(true);
    expect(disabled.title).toContain('Tickets are in Developing');
    first.view.unmount();

    const second = setup();
    await waitFor(() => expect(second.view.getAllByRole('option', { name: 'Developing' }).length).toBeGreaterThan(0));
    const remove = second.remove;
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const enabled = second.view.getByRole('button', { name: 'Delete workflow' }) as HTMLButtonElement;
    expect(enabled.disabled).toBe(false);
    fireEvent.click(enabled);
    await waitFor(() => expect(remove).toHaveBeenCalledWith('ws', { name: 'board-develop', expectedSha256: 'workflow-sha' }));
    expect(confirm).toHaveBeenCalledWith('Delete workflow "Develop"?');
  });

  it('asks before discarding edits on cancel', async () => {
    const { view, onClose } = setup();
    await waitFor(() => expect(view.getByRole('heading', { name: 'Edit workflow: Develop' })).toBeTruthy());
    fireEvent.change(view.getByLabelText('Name'), { target: { value: 'Changed' } });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(view.getByRole('button', { name: 'Cancel' }));
    expect(onClose).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(view.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledWith('Discard unsaved workflow changes?');
  });
});
