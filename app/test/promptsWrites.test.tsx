// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PromptsScreen } from '../src/renderer/workflow/PromptsScreen';
import type { ManagementApi, PromptDetail } from '../src/renderer/api';
import { workspaceA } from './dashboardFixtures';

const first: PromptDetail = { name: 'board-one', text: 'First {{task}}', words: 2, sha256: 'a'.repeat(64), users: [{ workflow: 'qa', step: 'review' }] };
const second: PromptDetail = { name: 'board-two', text: 'Second', words: 1, sha256: 'b'.repeat(64), users: [] };
const ok = <T,>(data: T) => ({ ok: true as const, data });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
async function setup() {
  const items = [first, second];
  const savePrompt = vi.fn(async (_ws: string, input: { name: string; text: string; expectedSha256: string | null }) => {
    const saved = { name: input.name, text: input.text, words: 1, sha256: 'c'.repeat(64), users: [] };
    const existing = items.findIndex(item => item.name === saved.name);
    if (existing >= 0) items[existing] = saved;
    else items.push(saved);
    return ok(saved);
  });
  const deletePrompt = vi.fn(async (_ws: string, input: { name: string; expectedSha256: string }) => ok({ name: input.name }));
  const prompt = vi.fn(async (_ws: string, name: string) => ok(items.find(p => p.name === name) ?? { ...second, name }));
  const management = { prompts: async () => ok({ prompts: items }), prompt, boardWorkflows: async () => ok({ workflows: [{ name: 'qa', title: 'QA' }] }), savePrompt, deletePrompt } as unknown as ManagementApi;
  const dirty = vi.fn();
  render(<PromptsScreen workspace={workspaceA} management={management} onDirtyChange={dirty} />);
  await act(async () => {});
  return { savePrompt, deletePrompt, prompt, dirty };
}

it('validates names and creates blank and copied prompts with null SHA', async () => {
  const { savePrompt } = await setup();
  fireEvent.click(screen.getByRole('button', { name: '+ New prompt' }));
  const dialog = screen.getByRole('dialog');
  const name = within(dialog).getByLabelText('Name');
  const create = within(dialog).getByRole('button', { name: 'Create and edit' }) as HTMLButtonElement;
  fireEvent.change(name, { target: { value: 'Bad_name' } });
  expect(create.disabled).toBe(true);
  fireEvent.change(name, { target: { value: 'board-one' } });
  expect(create.disabled).toBe(true);
  fireEvent.change(name, { target: { value: 'new-prompt' } });
  await act(async () => { fireEvent.click(create); });
  expect(savePrompt).toHaveBeenCalledWith('ws-a', { name: 'new-prompt', text: '{{task}}', expectedSha256: null });
  expect(screen.getByRole('heading', { name: 'new-prompt.md' })).toBeTruthy();
  expect((screen.getByLabelText('Prompt text') as HTMLTextAreaElement).value).toBe('{{task}}');
  fireEvent.click(screen.getByRole('button', { name: 'board-one.md 2 words QA · review' }));
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
  const copy = screen.getByRole('dialog');
  expect((within(copy).getByLabelText('Copy prompt') as HTMLSelectElement).value).toBe('board-one');
  fireEvent.change(within(copy).getByLabelText('Name'), { target: { value: 'copy' } });
  await act(async () => { fireEvent.click(within(copy).getByRole('button', { name: 'Create and edit' })); });
  expect(savePrompt).toHaveBeenLastCalledWith('ws-a', { name: 'copy', text: first.text, expectedSha256: null });
  expect(screen.getByRole('heading', { name: 'copy.md' })).toBeTruthy();
  expect((screen.getByLabelText('Prompt text') as HTMLTextAreaElement).value).toBe(first.text);
});

it('saves with the SHA, preserves a conflicting draft until reload, and reverts', async () => {
  const { savePrompt, prompt } = await setup();
  savePrompt.mockResolvedValueOnce({ ok: false, error: { code: 'CONFIG_CHANGED', message: 'changed', retryable: false } } as never);
  const editor = screen.getByLabelText('Prompt text') as HTMLTextAreaElement;
  fireEvent.change(editor, { target: { value: 'Draft' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save prompt' })); });
  expect(savePrompt).toHaveBeenCalledWith('ws-a', { name: first.name, text: 'Draft', expectedSha256: first.sha256 });
  expect(editor.value).toBe('Draft');
  expect(screen.getByRole('alert').textContent).toContain('Changed elsewhere - reload');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reload' })); });
  expect(prompt).toHaveBeenCalledTimes(2);
  expect(editor.value).toBe(first.text);
  fireEvent.change(editor, { target: { value: 'Another draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
  expect(editor.value).toBe(first.text);
});

it('blocks deletion of used prompts and confirms deletion of unused prompts', async () => {
  const { deletePrompt } = await setup();
  const used = screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement;
  expect(used.disabled).toBe(true);
  expect(used.parentElement?.title).toContain('QA · review');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /board-two\.md/ })); });
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  const dialog = screen.getByRole('alertdialog');
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Delete prompt' })); });
  expect(deletePrompt).toHaveBeenCalledWith('ws-a', { name: second.name, expectedSha256: second.sha256 });
});

it('asks before switching prompts and reports dirty state for screen navigation', async () => {
  const { dirty } = await setup();
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  fireEvent.change(screen.getByLabelText('Prompt text'), { target: { value: 'Draft' } });
  expect(dirty).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByRole('button', { name: /board-two\.md/ }));
  expect(confirm).toHaveBeenCalled();
  expect((screen.getByLabelText('Prompt text') as HTMLTextAreaElement).value).toBe('Draft');
  confirm.mockReturnValue(true);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /board-two\.md/ })); });
  expect((screen.getByLabelText('Prompt text') as HTMLTextAreaElement).value).toBe('Second');
});
