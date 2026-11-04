// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { WorkspaceShell } from '../src/renderer/shell/WorkspaceShell';
import { fakeManagement } from './teamsFixtures';
import type { DashboardApi, PromptDetail, Workspace } from '../src/renderer/api';

afterEach(cleanup);
const workspace: Workspace = { id: 'a', name: 'A', path: '/a', exists: true, missing: false };
const dashboard = {} as DashboardApi;
const first: PromptDetail = { name: 'board-develop', text: 'Implement {{task}}', words: 2, sha256: 'p'.repeat(64), users: [] };
const second: PromptDetail = { name: 'board-qa', text: 'Check {{task}}', words: 2, sha256: 'q'.repeat(64), users: [] };

it('opens Workflow prompts with the step prompt selected', async () => {
  const fake = fakeManagement();
  fake.api.boardWorkflows = async () => ({ ok: true, data: { workflows: [{ name: 'develop', title: 'Develop', startsAt: 'ready', whileRunning: 'working', role: 'Developer', steps: [{ id: 'work', kind: 'agent' }], end: {}, limits: {} }], problems: [] } });
  fake.api.boardWorkflow = async () => ({ ok: true, data: { name: 'develop', definition: { version: 2, title: 'Develop', startsAt: 'ready', whileRunning: 'working', role: 'Developer', steps: [{ id: 'work', agent: { prompt: 'board-develop.md', access: 'write' } }] }, text: '', sha256: 'workflow-sha', problems: [], start: { allowed: false, default: false } } });
  fake.api.prompts = async () => ({ ok: true, data: { prompts: [second, first] } });
  fake.api.prompt = async (_workspace: string, name: string) => ({ ok: true, data: name === first.name ? first : second });
  const view = render(<WorkspaceShell workspace={workspace} dashboard={dashboard} management={fake.api} connection={{ state: 'connected', error: null, distro: null, command: 'serve' }} onSwitchWorkspace={() => {}} renderSection={id => id === 'home' ? <div>Home</div> : undefined} />);
  fireEvent.click(within(view.getByRole('navigation', { name: 'Workspace' })).getByRole('button', { name: 'Routing' }));
  await waitFor(() => expect(view.getByRole('button', { name: 'Edit Develop' })).toBeTruthy());
  fireEvent.click(view.getByRole('button', { name: 'Edit Develop' }));
  const link = await view.findByRole('button', { name: 'Edit board-develop.md →' });
  fireEvent.click(link);
  await waitFor(() => expect(view.getByRole('heading', { name: 'board-develop.md' })).toBeTruthy());
  expect((view.getByLabelText('Prompt text') as HTMLTextAreaElement).value).toBe('Implement {{task}}');
});
