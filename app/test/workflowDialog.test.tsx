// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowDialog } from '../src/renderer/workflow/WorkflowDialog';
import { draftFromWorkflow } from '../src/renderer/workflow/workflowDraftModel';
import type { BoardSettings, BoardStatuses, BoardWorkflowDetail, BoardWorkflows, Workspace } from '../src/renderer/api';
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
const detail: BoardWorkflowDetail = {
  name: 'board-develop', text: '', sha256: 'workflow-sha', problems: [], start: { allowed: true, default: true },
  definition: {
    version: 2, title: 'Develop', startsAt: 'dev-ready', whileRunning: 'deving', role: 'Developer', workspace: 'worktree',
    syncBase: true, waitForDependencies: true, createdTickets: 'dev-ready',
    end: { pass: { status: 'qa-ready', releaseCreatedTickets: { from: 'dev-ready', to: 'qa-ready' } }, fail: 'dev-ready', blocked: { status: 'need-escalate', returnTo: 'dev-ready' } },
    limits: { maxRuns: 6, failuresInARow: { count: 3, status: 'need-escalate' }, onFailPriority: 0 },
    steps: [
      { id: 'implement', agent: { prompt: 'board-develop.md', access: 'write' } },
      { id: 'tests', check: { checks: 'code' }, onFail: { retry: 'implement', max: 3, then: 'end-fail' } },
    ],
  },
};

function setup(overrides: { ticketsInDeving?: number; save?: ReturnType<typeof vi.fn>; remove?: ReturnType<typeof vi.fn>; onClose?: () => void } = {}) {
  const save = overrides.save ?? vi.fn(async () => ({ ok: true as const, data: detail }));
  const remove = overrides.remove ?? vi.fn(async () => ({ ok: true as const, data: { name: 'board-develop' } }));
  const board: BoardSettings = { ...boardSettingsFixture(), board: { state: 'ok', sha256: 'board-sha', message: null, problems: [], config: {} }, roles: { state: 'ok', sha256: null, message: null, items: [{ id: 'Developer', description: null }, { id: 'QA', description: null }, { id: 'TeamLead', description: null }] } };
  const fake = fakeManagement({
    boardSettings: [{ ok: true, data: board }],
    calls: {
      boardStatuses: async () => ({ ok: true, data: statuses(overrides.ticketsInDeving ?? 0) }),
      boardWorkflows: async () => ({ ok: true, data: workflows }),
      boardWorkflow: async () => ({ ok: true, data: detail }),
      saveBoardWorkflow: save,
      deleteBoardWorkflow: remove,
    },
  });
  const onClose = overrides.onClose ?? vi.fn();
  const view = render(<WorkflowDialog workspace={workspace} management={fake.api} draft={draftFromWorkflow(detail)} onClose={onClose} />);
  return { view, save, remove, onClose };
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
