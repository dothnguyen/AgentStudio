// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionStatus, ManagementResult, SkillDetail, SkillItem, Workspace } from '../src/renderer/api';
import { SKILL_CONTENT_GENERIC_ERROR, skillContentLimitMessage, skillContentRoleNote } from '../src/renderer/skills/SkillContentDialog';
import { SkillsScreen } from '../src/renderer/skills/SkillsScreen';
import { connectionFixture, deferred, fakeManagement } from './teamsFixtures';
import { SKILL_LIMITS, SKILL_TEXT, sha256Hex, skillCatalog, skillDetail, skillItem } from './skillFixtures';

afterEach(cleanup);

const workspace: Workspace = { id: 'a', name: 'A', path: '/a', exists: true, missing: false };

function setup(
  calls?: Parameters<typeof fakeManagement>[0]['calls'],
  connection: ConnectionStatus = connectionFixture('connected'),
) {
  const fake = fakeManagement(calls === undefined ? {} : { calls });
  const view = render(<main>
    <SkillsScreen workspace={workspace} management={fake.api} connection={connection} />
  </main>);
  return { fake, view };
}

const list = (view: ReturnType<typeof render>) => view.getByRole('list', { name: 'Saved skills' });
const row = (view: ReturnType<typeof render>, id: string) =>
  within(list(view)).getAllByRole('button').find(button => button.getAttribute('data-skill-id') === id)!;

async function openSkill(view: ReturnType<typeof render>, id = 'code-search') {
  await view.findByRole('list', { name: 'Saved skills' });
  fireEvent.click(row(view, id));
  await view.findByRole('region', { name: 'Skill details' });
}

const editButton = (view: ReturnType<typeof render>) => view.getByRole('button', { name: 'Edit skill content' }) as HTMLButtonElement;

function editReason(view: ReturnType<typeof render>): string | null {
  const id = editButton(view).getAttribute('aria-describedby');
  return id === null ? null : document.getElementById(id)?.textContent ?? null;
}

async function openEditor(view: ReturnType<typeof render>, id = 'code-search') {
  await openSkill(view, id);
  await waitFor(() => expect(editButton(view).disabled).toBe(false));
  editButton(view).focus();
  fireEvent.click(editButton(view));
  return view.getByRole('dialog', { name: `Edit ${id}` });
}

function reopenEditor(view: ReturnType<typeof render>, id = 'code-search') {
  editButton(view).focus();
  fireEvent.click(editButton(view));
  return view.getByRole('dialog', { name: `Edit ${id}` });
}

const textarea = (dialog: HTMLElement) => within(dialog).getByLabelText('Content (markdown)') as HTMLTextAreaElement;
const saveButton = (dialog: HTMLElement) => within(dialog).getByRole('button', { name: /^(Save to file|Saving\.\.\.)$/ }) as HTMLButtonElement;

function customCatalog(skill: SkillItem, text: string | null = '# Custom\n', limits = SKILL_LIMITS) {
  const data = skillCatalog({ skills: [skill], problems: [], limits });
  return {
    skills: vi.fn(async () => ({ ok: true as const, data })),
    skill: vi.fn(async (): Promise<ManagementResult<SkillDetail>> => ({ ok: true, data: { workspace: '/a', skill, text } })),
  };
}

async function statusText(view: ReturnType<typeof render>): Promise<string[]> {
  return view.getAllByRole('status').map(node => node.textContent ?? '');
}

describe('Skill content Edit entry point', () => {
  it('hides Edit for a missing skill', async () => {
    const { view } = setup();
    await openSkill(view, 'legacy-notes');
    expect(view.queryByRole('button', { name: 'Edit skill content' })).toBeNull();
  });

  it('disables Edit with the shorten reason for a truncated skill', async () => {
    const skill = skillItem({ id: 'huge-skill', state: 'truncated', title: 'Huge skill', bytes: 40960, sha256: 'b'.repeat(64), roles: [] });
    const { view } = setup(customCatalog(skill));
    await openSkill(view, 'huge-skill');
    const button = editButton(view);
    expect(button.disabled).toBe(true);
    const reason = document.getElementById(button.getAttribute('aria-describedby')!);
    expect(reason?.textContent).toBe('Shorten the file outside the app first.');
  });

  it('disables Edit with the shorten reason for an unreadable skill', async () => {
    const skill = skillItem({ id: 'broken-skill', state: 'unreadable', title: null, bytes: null, sha256: null, roles: [] });
    const { view } = setup(customCatalog(skill, null));
    await openSkill(view, 'broken-skill');
    const button = editButton(view);
    expect(button.disabled).toBe(true);
    expect(document.getElementById(button.getAttribute('aria-describedby')!)?.textContent)
      .toBe('Shorten the file outside the app first.');
  });

  it('disables Edit with a connection reason while disconnected', async () => {
    const { view } = setup(undefined, connectionFixture('lost'));
    await openSkill(view);
    await waitFor(() => expect(editButton(view).disabled).toBe(true));
    expect(document.getElementById(editButton(view).getAttribute('aria-describedby')!)?.textContent)
      .toBe('Connect to the backend to edit this skill.');
  });

  it('disables Edit while a save is pending', async () => {
    const gate = deferred<ManagementResult<SkillDetail>>();
    const { view } = setup({ updateSkill: vi.fn(() => gate.promise) });
    const dialog = await openEditor(view);
    fireEvent.change(textarea(dialog), { target: { value: `${SKILL_TEXT['code-search']}\nDraft` } });
    fireEvent.click(saveButton(dialog));

    await waitFor(() => expect(saveButton(dialog).textContent).toBe('Saving...'));
    expect(saveButton(dialog).disabled).toBe(true);
    expect(editButton(view).disabled).toBe(true);
    expect(document.getElementById(editButton(view).getAttribute('aria-describedby')!)?.textContent)
      .toBe('Saving the file; wait for it to finish.');

    gate.resolve({ ok: false, error: { code: 'INTERNAL', message: 'stop', retryable: false } });
    await within(dialog).findByRole('alert');
  });
});

describe('Skill content dialog', () => {
  it('opens at 780px with the file text, a 16-row editor and focus in the textarea', async () => {
    const { view } = setup();
    const dialog = await openEditor(view);

    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const labelId = dialog.getAttribute('aria-labelledby')!;
    expect(document.getElementById(labelId)?.textContent).toBe('Edit code-search');
    expect(dialog.querySelector('.dialog-subtitle')?.textContent).toBe('Saved to skills/code-search/SKILL.md');
    expect(dialog.getAttribute('style')).toContain('width: min(780px, 100%)');
    const input = textarea(dialog);
    expect(input.value).toBe(SKILL_TEXT['code-search']);
    expect(input.rows).toBe(16);
    expect(document.activeElement).toBe(input);
    expect(within(dialog).getByText('11 lines · 839 / 32,768 bytes')).toBeTruthy();
    expect(within(dialog).getByText('Takes effect on the next assignment')).toBeTruthy();
  });

  it('counts UTF-8 bytes, not characters, and blocks one byte over the limit', async () => {
    const { view } = setup();
    const dialog = await openEditor(view);
    const input = textarea(dialog);

    fireEvent.change(input, { target: { value: 'é'.repeat(100) } });
    expect(within(dialog).getByText('1 lines · 200 / 32,768 bytes')).toBeTruthy();

    fireEvent.change(input, { target: { value: 'a'.repeat(SKILL_LIMITS.skillBytes) } });
    expect(within(dialog).getByText('1 lines · 32,768 / 32,768 bytes')).toBeTruthy();
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect(saveButton(dialog).disabled).toBe(false);

    fireEvent.change(input, { target: { value: 'a'.repeat(SKILL_LIMITS.skillBytes + 1) } });
    expect(within(dialog).getByText('1 lines · 32,769 / 32,768 bytes').classList.contains('is-error')).toBe(true);
    expect(within(dialog).getByRole('alert').textContent).toBe(skillContentLimitMessage(SKILL_LIMITS.skillBytes));
    expect(saveButton(dialog).disabled).toBe(true);
  });

  it('uses the catalog limit in the over-limit alert', async () => {
    const skill = skillItem({ id: 'small-skill', state: 'ok', title: 'Small skill', bytes: 6, sha256: 'e'.repeat(64), roles: [] });
    const { view } = setup(customCatalog(skill, '# Small\n', { skillBytes: 2048, roleContextBytes: 98304 }));
    const dialog = await openEditor(view, 'small-skill');

    fireEvent.change(textarea(dialog), { target: { value: 'a'.repeat(2049) } });
    expect(within(dialog).getByText('1 lines · 2,049 / 2,048 bytes').classList.contains('is-error')).toBe(true);
    expect(within(dialog).getByRole('alert').textContent).toBe('The skill is over the 2 KiB limit. Shorten it to save.');
    expect(saveButton(dialog).disabled).toBe(true);
  });

  it('keeps Save disabled until the text changes', async () => {
    const { view } = setup();
    const dialog = await openEditor(view);
    expect(saveButton(dialog).disabled).toBe(true);
    fireEvent.change(textarea(dialog), { target: { value: `${SKILL_TEXT['code-search']}\n\nExtra` } });
    expect(saveButton(dialog).disabled).toBe(false);
  });

  it('sends the exact text and the sha it opened with', async () => {
    const { view, fake } = setup();
    const dialog = await openEditor(view);
    const next = `${SKILL_TEXT['code-search']}\n\n- Added by the test.`;
    fireEvent.change(textarea(dialog), { target: { value: next } });
    fireEvent.click(saveButton(dialog));

    await waitFor(() => expect(view.queryByRole('dialog')).toBeNull());
    const write = fake.skillFake.calls.find(call => call.method === 'updateSkill');
    expect(write?.args).toEqual(['a', 'code-search', next, sha256Hex(SKILL_TEXT['code-search'])]);
  });

  it('disables the editor while saving so text typed after Save cannot be lost', async () => {
    const gate = deferred<ManagementResult<SkillDetail>>();
    const updateSkill = vi.fn(() => gate.promise);
    const { view } = setup({ updateSkill });
    const dialog = await openEditor(view);
    const input = textarea(dialog);
    const draft = `${SKILL_TEXT['code-search']}\n\n- Saved draft.`;
    fireEvent.change(input, { target: { value: draft } });
    fireEvent.click(saveButton(dialog));

    await waitFor(() => expect(saveButton(dialog).textContent).toBe('Saving...'));
    expect(input.disabled).toBe(true);
    // Even a programmatic change while the write is in flight must not replace
    // the text that is actually being saved.
    fireEvent.change(input, { target: { value: `${draft}\n\n- Too late.` } });
    expect(input.value).toBe(draft);

    gate.resolve({ ok: true, data: skillDetail('code-search') });
    await waitFor(() => expect(view.queryByRole('dialog')).toBeNull());
    expect(updateSkill).toHaveBeenCalledWith('a', 'code-search', draft, sha256Hex(SKILL_TEXT['code-search']));
  });

  it('ignores Escape, the close button and Cancel while saving', async () => {
    const gate = deferred<ManagementResult<SkillDetail>>();
    const { view } = setup({ updateSkill: vi.fn(() => gate.promise) });
    const dialog = await openEditor(view);
    fireEvent.change(textarea(dialog), { target: { value: `${SKILL_TEXT['code-search']}\nDraft` } });
    fireEvent.click(saveButton(dialog));
    await waitFor(() => expect(saveButton(dialog).textContent).toBe('Saving...'));

    await userEvent.setup().keyboard('{Escape}');
    expect(view.getByRole('dialog', { name: 'Edit code-search' })).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(view.getByRole('dialog', { name: 'Edit code-search' })).toBeTruthy();

    gate.resolve({ ok: false, error: { code: 'INTERNAL', message: 'stop', retryable: false } });
    await within(dialog).findByRole('alert');
  });

  it('closes, refocuses Edit, refreshes the preview, size and used-by context, and announces once', async () => {
    const { view, fake } = setup();
    const dialog = await openEditor(view);
    const next = `${SKILL_TEXT['code-search']}\n\n- A longer line that changes the role context sizes.`;
    fireEvent.change(textarea(dialog), { target: { value: next } });
    fireEvent.click(saveButton(dialog));

    await waitFor(() => expect(view.queryByRole('dialog')).toBeNull());
    const content = view.container.querySelector('.skills-content-card') as HTMLElement;
    await waitFor(() => expect(content.querySelector('pre')?.textContent).toBe(next));

    const after = await fake.api.skills('a');
    const item = after.ok ? after.data.skills.find(skill => skill.id === 'code-search')! : null;
    expect(item).not.toBeNull();
    await waitFor(() => expect(within(content).getByText(`${item!.bytes!.toLocaleString('en-US')} / 32,768 bytes`, { exact: false })).toBeTruthy());
    expect(within(view.container.querySelector('.skills-details-card') as HTMLElement)
      .getByText(`${item!.bytes! < 1024 ? `${item!.bytes} B` : `${(item!.bytes! / 1024).toFixed(1)} KB`} of 32 KiB`)).toBeTruthy();

    const expectedContexts = item!.roles.map(role => `Context ${(role.contextBytes / 1024).toFixed(1)} KB of 96 KiB`);
    expect([...view.container.querySelectorAll('.skills-usedby-context')].map(node => node.textContent)).toEqual(expectedContexts);

    await waitFor(() => expect(document.activeElement).toBe(editButton(view)));
    const chip = view.container.querySelector('.skills-page-saved');
    expect(chip?.textContent).toBe('Saved skills/code-search/SKILL.md.');
    const statuses = await statusText(view);
    expect(statuses).toEqual(['Saved skills/code-search/SKILL.md.']);
  });

  it('returns focus to Edit after the refreshed detail is ready', async () => {
    const gate = deferred<ManagementResult<SkillDetail>>();
    const detail = skillDetail('code-search');
    const skill = vi.fn()
      .mockResolvedValueOnce({ ok: true as const, data: detail })
      .mockImplementationOnce(() => gate.promise)
      .mockResolvedValue({ ok: true as const, data: detail });
    const { view } = setup({
      skill,
      updateSkill: vi.fn(async () => ({ ok: true as const, data: detail })),
    });
    const dialog = await openEditor(view);
    fireEvent.change(textarea(dialog), { target: { value: `${SKILL_TEXT['code-search']}\nRefresh` } });
    fireEvent.click(saveButton(dialog));

    await waitFor(() => expect(view.queryByRole('dialog')).toBeNull());
    // The refreshed detail is still loading, so Edit is disabled and cannot hold focus.
    await waitFor(() => expect(editButton(view).disabled).toBe(true));

    gate.resolve({ ok: true, data: detail });
    await waitFor(() => expect(editButton(view).disabled).toBe(false));
    await waitFor(() => expect(document.activeElement).toBe(editButton(view)));
  });

  it('disables Edit with a loading reason until the file text arrives', async () => {
    const gate = deferred<ManagementResult<SkillDetail>>();
    const { view } = setup({ skill: vi.fn(() => gate.promise) });
    await openSkill(view);

    await waitFor(() => expect(editButton(view).disabled).toBe(true));
    expect(editReason(view)).toBe('The content is still loading.');
    fireEvent.click(editButton(view));
    expect(view.queryByRole('dialog')).toBeNull();

    gate.resolve({ ok: true, data: skillDetail('code-search') });
    await waitFor(() => expect(editButton(view).disabled).toBe(false));
    expect(editReason(view)).toBeNull();
  });

  it('disables Edit with a reason when the file text could not be loaded', async () => {
    const { view } = setup({
      skill: vi.fn(async () => ({
        ok: false as const,
        error: { code: 'OFFLINE', message: 'cannot read the file', retryable: true },
      })),
    });
    await openSkill(view);

    await waitFor(() => expect(editButton(view).disabled).toBe(true));
    expect(editReason(view)).toBe('The content could not be loaded.');
    fireEvent.click(editButton(view));
    expect(view.queryByRole('dialog')).toBeNull();
  });

  it('reports CONFIG_CHANGED, reloads the latest text and keeps the draft available to copy', async () => {
    const { view, fake } = setup();
    const dialog = await openEditor(view);
    const external = `${SKILL_TEXT['code-search']}\n\n- Changed outside the app.`;
    const updated = await fake.skillFake.updateSkill('a', 'code-search', external, sha256Hex(SKILL_TEXT['code-search']));
    expect(updated.ok).toBe(true);

    const draft = `${SKILL_TEXT['code-search']}\n\n- My draft.`;
    fireEvent.change(textarea(dialog), { target: { value: draft } });
    fireEvent.click(saveButton(dialog));

    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('skills/code-search/SKILL.md changed since you opened it. Reload to see the latest version.');
    expect(within(dialog).getByRole('button', { name: 'Reload latest' })).toBeTruthy();
    expect(textarea(dialog).value).toBe(draft);
    expect(document.activeElement).toBe(alert);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Reload latest' }));
    await waitFor(() => expect(textarea(dialog).value).toBe(external));
    expect((within(dialog).getByLabelText('Your changes') as HTMLTextAreaElement).value).toBe(draft);
    expect(within(dialog).getByText('Copy anything you still need into the current file before saving again.')).toBeTruthy();
    expect(saveButton(dialog).disabled).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(textarea(dialog)));
  });

  it('saves with the reloaded sha after a conflict is resolved', async () => {
    const { view, fake } = setup();
    const dialog = await openEditor(view);
    const external = `${SKILL_TEXT['code-search']}\n\n- Changed outside the app.`;
    const updated = await fake.skillFake.updateSkill('a', 'code-search', external, sha256Hex(SKILL_TEXT['code-search']));
    expect(updated.ok).toBe(true);

    fireEvent.change(textarea(dialog), { target: { value: `${SKILL_TEXT['code-search']}\n\n- My draft.` } });
    fireEvent.click(saveButton(dialog));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Reload latest' }));
    await waitFor(() => expect(textarea(dialog).value).toBe(external));

    const next = `${external}\n\n- Added after reloading.`;
    fireEvent.change(textarea(dialog), { target: { value: next } });
    fireEvent.click(saveButton(dialog));

    await waitFor(() => expect(view.queryByRole('dialog')).toBeNull());
    const writes = fake.skillFake.calls.filter(call => call.method === 'updateSkill');
    expect(writes[writes.length - 1]?.args).toEqual(['a', 'code-search', next, sha256Hex(external)]);
  });

  it('keeps the draft and offers a retry when Reload latest fails', async () => {
    const detail = skillDetail('code-search');
    const skill = vi.fn()
      .mockResolvedValueOnce({ ok: true as const, data: detail })
      .mockRejectedValueOnce(new Error('socket closed'));
    const { view } = setup({
      skill,
      updateSkill: vi.fn(async () => ({
        ok: false as const,
        error: { code: 'CONFIG_CHANGED', message: 'changed outside the app', retryable: false },
      })),
    });
    const dialog = await openEditor(view);
    const draft = `${SKILL_TEXT['code-search']}\n\n- My draft.`;
    fireEvent.change(textarea(dialog), { target: { value: draft } });
    fireEvent.click(saveButton(dialog));

    fireEvent.click(await within(dialog).findByRole('button', { name: 'Reload latest' }));

    await waitFor(() => expect(within(dialog).getByText(/^Could not reload /)).toBeTruthy());
    const alert = within(dialog).getByRole('alert');
    expect(alert.textContent).toContain('Could not reload skills/code-search/SKILL.md: socket closed');
    expect(within(dialog).getByRole('button', { name: 'Retry reload latest' })).toBeTruthy();
    expect(textarea(dialog).value).toBe(draft);
    expect(view.getByRole('dialog', { name: 'Edit code-search' })).toBeTruthy();
    expect(document.activeElement).toBe(alert);
  });

  it('disables the editor and Save while Reload latest is in flight', async () => {
    const gate = deferred<ManagementResult<SkillDetail>>();
    const skill = vi.fn()
      .mockResolvedValueOnce({ ok: true as const, data: skillDetail('code-search') })
      .mockImplementationOnce(() => gate.promise);
    const { view } = setup({
      skill,
      updateSkill: vi.fn(async () => ({
        ok: false as const,
        error: { code: 'CONFIG_CHANGED', message: 'changed outside the app', retryable: false },
      })),
    });
    const dialog = await openEditor(view);
    const draft = `${SKILL_TEXT['code-search']}\n\n- My draft.`;
    fireEvent.change(textarea(dialog), { target: { value: draft } });
    fireEvent.click(saveButton(dialog));

    fireEvent.click(await within(dialog).findByRole('button', { name: 'Reload latest' }));
    await waitFor(() => expect(textarea(dialog).disabled).toBe(true));
    expect((within(dialog).getByRole('button', { name: 'Reload latest' }) as HTMLButtonElement).disabled).toBe(true);
    expect(saveButton(dialog).disabled).toBe(true);
    expect(textarea(dialog).value).toBe(draft);

    gate.resolve({ ok: true, data: { workspace: '/a', skill: skillItem({ id: 'code-search' }), text: '# Latest\n' } });
    await waitFor(() => expect(textarea(dialog).value).toBe('# Latest\n'));
    expect(textarea(dialog).disabled).toBe(false);
    expect((within(dialog).getByLabelText('Your changes') as HTMLTextAreaElement).value).toBe(draft);
  });

  it('reports a reloaded truncated file as too large instead of missing', async () => {
    const truncated = skillItem({
      id: 'code-search', state: 'truncated', title: 'Partial', bytes: 40960, sha256: 'b'.repeat(64), roles: [],
    });
    const skill = vi.fn()
      .mockResolvedValueOnce({ ok: true as const, data: skillDetail('code-search') })
      .mockResolvedValue({ ok: true as const, data: { workspace: '/a', skill: truncated, text: '# Partial\n' } });
    const { view } = setup({
      skill,
      updateSkill: vi.fn(async () => ({
        ok: false as const,
        error: { code: 'CONFIG_CHANGED', message: 'changed outside the app', retryable: false },
      })),
    });
    const dialog = await openEditor(view);
    const draft = `${SKILL_TEXT['code-search']}\n\n- My draft.`;
    fireEvent.change(textarea(dialog), { target: { value: draft } });
    fireEvent.click(saveButton(dialog));

    fireEvent.click(await within(dialog).findByRole('button', { name: 'Reload latest' }));

    await waitFor(() => expect(within(dialog).getByRole('alert').textContent)
      .toBe('The file is larger than 32 KiB, so it cannot be edited. Shorten it outside the app first.'));
    expect(within(dialog).queryByRole('button', { name: 'Reload latest' })).toBeNull();
    expect(textarea(dialog).value).toBe(draft);
  });

  it('reports a reloaded deleted file as no longer existing', async () => {
    const missing = skillItem({
      id: 'code-search', state: 'missing', title: null, bytes: null, sha256: null, roles: [],
    });
    const skill = vi.fn()
      .mockResolvedValueOnce({ ok: true as const, data: skillDetail('code-search') })
      .mockResolvedValue({ ok: true as const, data: { workspace: '/a', skill: missing, text: null } });
    const { view } = setup({
      skill,
      updateSkill: vi.fn(async () => ({
        ok: false as const,
        error: { code: 'CONFIG_CHANGED', message: 'changed outside the app', retryable: false },
      })),
    });
    const dialog = await openEditor(view);
    const draft = `${SKILL_TEXT['code-search']}\n\n- My draft.`;
    fireEvent.change(textarea(dialog), { target: { value: draft } });
    fireEvent.click(saveButton(dialog));

    fireEvent.click(await within(dialog).findByRole('button', { name: 'Reload latest' }));

    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toBe('The file no longer exists.'));
    expect(within(dialog).queryByRole('button', { name: 'Reload latest' })).toBeNull();
    expect(textarea(dialog).value).toBe(draft);
  });

  it('shows the generic error when the write rejects and keeps the draft', async () => {
    const updateSkill = vi.fn()
      .mockRejectedValueOnce(new Error('socket closed'))
      .mockResolvedValueOnce({ ok: true as const, data: skillDetail('code-search') });
    const { view } = setup({ updateSkill });
    const dialog = await openEditor(view);
    const draft = `${SKILL_TEXT['code-search']}\n\n- My draft.`;
    fireEvent.change(textarea(dialog), { target: { value: draft } });
    fireEvent.click(saveButton(dialog));

    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain(SKILL_CONTENT_GENERIC_ERROR);
    expect(textarea(dialog).value).toBe(draft);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(view.queryByRole('dialog')).toBeNull());
    expect(updateSkill).toHaveBeenLastCalledWith('a', 'code-search', draft, sha256Hex(SKILL_TEXT['code-search']));
  });

  it('reports a missing file without a reload action', async () => {
    const { view } = setup({
      updateSkill: vi.fn(async () => ({ ok: false as const, error: { code: 'SKILL_NOT_FOUND', message: 'gone', retryable: false } })),
    });
    const dialog = await openEditor(view);
    fireEvent.change(textarea(dialog), { target: { value: `${SKILL_TEXT['code-search']}\nDraft` } });
    fireEvent.click(saveButton(dialog));

    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toBe('The file no longer exists.');
    expect(within(dialog).queryByRole('button', { name: 'Reload latest' })).toBeNull();
    expect(document.activeElement).toBe(alert);
  });

  it('does not report a reloaded unreadable file as missing', async () => {
    const initial = skillDetail('code-search');
    const unreadable = skillItem({
      id: 'code-search', state: 'unreadable', title: null, bytes: null, sha256: null, roles: [],
    });
    const skill = vi.fn()
      .mockResolvedValueOnce({ ok: true as const, data: initial })
      .mockResolvedValue({ ok: true as const, data: { workspace: '/a', skill: unreadable, text: null } });
    const { view } = setup({
      skill,
      updateSkill: vi.fn(async () => ({
        ok: false as const,
        error: { code: 'CONFIG_CHANGED', message: 'changed outside the app', retryable: false },
      })),
    });
    const dialog = await openEditor(view);
    fireEvent.change(textarea(dialog), { target: { value: `${SKILL_TEXT['code-search']}\nDraft` } });
    fireEvent.click(saveButton(dialog));

    await within(dialog).findByRole('button', { name: 'Reload latest' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reload latest' }));

    await waitFor(() => expect(within(dialog).getByRole('alert').textContent)
      .toBe('The file cannot be read. Reload or fix the file outside the app.'));
    expect(within(dialog).getByRole('alert').textContent).not.toContain('no longer exists');
  });

  it('shows a backend validation message unchanged', async () => {
    const message = "Skill 'code-search' is larger than 32768 bytes; shorten it outside the app first.";
    const { view } = setup({
      updateSkill: vi.fn(async () => ({ ok: false as const, error: { code: 'BAD_REQUEST', message, retryable: false } })),
    });
    const dialog = await openEditor(view);
    fireEvent.change(textarea(dialog), { target: { value: `${SKILL_TEXT['code-search']}\nDraft` } });
    fireEvent.click(saveButton(dialog));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(message);
  });

  it('shows the generic error and retries the save', async () => {
    const updateSkill = vi.fn(async (): Promise<ManagementResult<SkillDetail>> => ({
      ok: false,
      error: { code: 'INTERNAL', message: 'socket closed', retryable: true },
    }));
    const { view } = setup({ updateSkill });
    const dialog = await openEditor(view);
    const draft = `${SKILL_TEXT['code-search']}\nDraft`;
    fireEvent.change(textarea(dialog), { target: { value: draft } });
    fireEvent.click(saveButton(dialog));

    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain(SKILL_CONTENT_GENERIC_ERROR);
    await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(updateSkill).toHaveBeenCalledTimes(2));
    expect(updateSkill).toHaveBeenLastCalledWith('a', 'code-search', draft, sha256Hex(SKILL_TEXT['code-search']));
  });

  it('discards the draft on Cancel and Escape and opens the saved text again', async () => {
    const user = userEvent.setup();
    const { view } = setup();
    const dialog = await openEditor(view);
    fireEvent.change(textarea(dialog), { target: { value: 'discarded draft' } });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(view.queryByRole('dialog')).toBeNull();

    const reopened = reopenEditor(view);
    expect(textarea(reopened).value).toBe(SKILL_TEXT['code-search']);
    fireEvent.change(textarea(reopened), { target: { value: 'another draft' } });
    await user.keyboard('{Escape}');
    expect(view.queryByRole('dialog')).toBeNull();

    const again = reopenEditor(view);
    expect(textarea(again).value).toBe(SKILL_TEXT['code-search']);
  });

  it('traps Tab inside the dialog', async () => {
    const { view } = setup();
    const dialog = await openEditor(view);
    const user = userEvent.setup();
    for (let index = 0; index < 12; index += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });
});

describe('Skill content role note', () => {
  it('uses the singular, plural and unused wording', () => {
    expect(skillContentRoleNote(0, 98304)).toBe('No role uses this skill yet. Assignments already running keep the version they started with. A role\'s whole context (instructions and skills) is limited to 96 KiB; a skill that does not fit is skipped.');
    expect(skillContentRoleNote(1, 98304)).toBe('1 role loads this skill. Assignments already running keep the version they started with. A role\'s whole context (instructions and skills) is limited to 96 KiB; a skill that does not fit is skipped.');
    expect(skillContentRoleNote(4, 98304)).toBe('4 roles load this skill. Assignments already running keep the version they started with. A role\'s whole context (instructions and skills) is limited to 96 KiB; a skill that does not fit is skipped.');
  });

  it('shows the note in the dialog for zero and one role', async () => {
    const zero = await openEditor(setup().view, 'ts-testing');
    expect(within(zero).getByText(skillContentRoleNote(0, 98304))).toBeTruthy();
    cleanup();

    const solo = skillItem({
      id: 'solo', state: 'ok', title: 'Solo skill', bytes: 9, sha256: 'd'.repeat(64),
      roles: [{ id: 'alpha', name: 'Alpha', contextBytes: 1024 }],
    });
    const { view } = setup(customCatalog(solo, '# Solo\n'));
    const one = await openEditor(view, 'solo');
    expect(within(one).getByText(skillContentRoleNote(1, 98304))).toBeTruthy();
  });

  it('shows the plural note in the dialog for several roles', async () => {
    // The sample catalog has code-search loaded by four roles.
    const dialog = await openEditor(setup().view);
    expect(within(dialog).getByText(skillContentRoleNote(4, 98304))).toBeTruthy();
    expect(within(dialog).getByText(/^4 roles load this skill\./)).toBeTruthy();
  });
});

describe('Skill content dialog dialog and styles', () => {
  it('uses the design width, body spacing and a vertically resizable mono editor at least 320px tall', () => {
    const css = readFileSync(resolve(__dirname, '../src/renderer/styles.css'), 'utf8').replace(/\s+/g, ' ');
    expect(css).toContain('.skill-content-dialog .dialog-body { display: flex; flex-direction: column; gap: 14px; padding: 18px 20px; }');
    expect(css).toMatch(/\.skill-content-field \.skill-content-input \{ min-height: 320px; [^}]*font-family: var\(--font-mono\);[^}]*resize: vertical; \}/);
    expect(css).toContain('.skill-content-note { display: flex; align-items: flex-start; gap: 9px; padding: 10px 12px; border-radius: 8px; background: rgba(240, 180, 83, 0.07);');
  });
});
