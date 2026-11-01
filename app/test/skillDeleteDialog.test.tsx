// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ConnectionStatus,
  ManagementApi,
  ManagementError,
  ManagementResult,
  SkillCatalogList,
  SkillDetail,
  SkillItem,
  Workspace,
} from '../src/renderer/api';
import { SkillsScreen } from '../src/renderer/skills/SkillsScreen';
import {
  SKILL_DELETE_CONFLICT,
  SKILL_DELETE_GENERIC,
  SKILL_DELETE_REFRESH_FAILED,
  skillDeleteActionState,
  skillDeleteAnnouncement,
  skillDeleteDescription,
  skillDeleteDescriptionParts,
  skillDeleteErrorMessage,
} from '../src/renderer/skills/SkillDeleteDialog';
import { roleCatalogFixture } from './roleFixtures';
import { connectionFixture, deferred } from './teamsFixtures';
import {
  SKILLS_SHA,
  SKILL_TEXT,
  fakeSkillManagement,
  sha256Hex,
  skillCatalog,
  skillItem,
  type FakeSkillInitial,
} from './skillFixtures';

afterEach(cleanup);

const workspace: Workspace = { id: 'a', name: 'A', path: '/a', exists: true, missing: false };
const ok = <T,>(data: T): ManagementResult<T> => ({ ok: true as const, data });
const fail = <T = never,>(code: string, message: string, data?: unknown): ManagementResult<T> => ({
  ok: false as const,
  error: { code, message, retryable: false, ...(data === undefined ? {} : { data }) },
});

function setup(
  initial: FakeSkillInitial = {},
  options: {
    connection?: ConnectionStatus;
    overrides?: Record<string, unknown>;
  } = {},
) {
  const fake = fakeSkillManagement(initial);
  const skills = vi.fn((id: string) => fake.skills(id));
  const roles = vi.fn((id: string) => fake.roles(id));
  const api = { ...fake, skills, roles, ...options.overrides } as unknown as ManagementApi;
  const view = render(<main>
    <SkillsScreen workspace={workspace} management={api} connection={options.connection} />
  </main>);
  return { fake, api, skills, roles, view };
}

const list = (view: ReturnType<typeof render>) => view.getByRole('list', { name: 'Saved skills' });
const row = (view: ReturnType<typeof render>, id: string) =>
  within(list(view)).getAllByRole('button').find(button => button.getAttribute('data-skill-id') === id)!;
const page = (view: ReturnType<typeof render>) => within(view.getByRole('region', { name: 'Skill details' }));
const deleteButton = (view: ReturnType<typeof render>) =>
  page(view).getByRole('button', { name: 'Delete skill' }) as HTMLButtonElement;
const reasonFor = (button: HTMLButtonElement): string | null => {
  const id = button.getAttribute('aria-describedby');
  return id === null ? null : document.getElementById(id)?.textContent ?? null;
};

async function openSkill(view: ReturnType<typeof render>, id = 'ts-testing') {
  await view.findByRole('list', { name: 'Saved skills' });
  fireEvent.click(row(view, id));
  await view.findByRole('region', { name: 'Skill details' });
}

async function openDelete(view: ReturnType<typeof render>, id = 'ts-testing'): Promise<HTMLElement> {
  await openSkill(view, id);
  const button = deleteButton(view);
  await waitFor(() => expect(button.disabled).toBe(false));
  button.focus();
  fireEvent.click(button);
  return view.findByRole('alertdialog', { name: `Delete ${id}?` });
}

const confirm = (dialog: HTMLElement) =>
  within(dialog).getByRole('button', { name: /^(Delete skill|Deleting…)$/ }) as HTMLButtonElement;
const statusFor = (view: ReturnType<typeof render>, text: string) =>
  view.getAllByRole('status').filter(node => node.textContent?.includes(text));

function customScreen(skill: SkillItem, overrides: Record<string, unknown> = {}) {
  const fake = fakeSkillManagement({ roles: [] });
  const data = skillCatalog({ skills: [skill], problems: [] });
  const skills = vi.fn(async () => ok(data));
  const detail = vi.fn(async () => ok<SkillDetail>({ workspace: '/a', skill, text: null }));
  const roles = vi.fn((id: string) => fake.roles(id));
  const api = { ...fake, skills, skill: detail, roles, ...overrides } as unknown as ManagementApi;
  const view = render(<main><SkillsScreen workspace={workspace} management={api} /></main>);
  return { view, skills, detail, roles, fake };
}

describe('skill delete model', () => {
  it('explains used, unused, pending, disconnected and unrefreshed states', () => {
    const used = skillItem({ id: 'used', roles: [{ id: 'Developer', name: 'Developer', contextBytes: 1 }] });
    const unused = skillItem({ id: 'unused', roles: [] });
    expect(skillDeleteActionState({ skill: used, connected: true, pending: false }))
      .toEqual({ disabled: true, text: 'Used by 1 role. Remove it from them before deleting it.', tone: 'warning' });
    expect(skillDeleteActionState({ skill: unused, connected: true, pending: false }))
      .toEqual({ disabled: false, text: 'No role uses this skill, so it can be deleted.', tone: 'muted' });
    expect(skillDeleteActionState({ skill: unused, connected: true, pending: true }))
      .toMatchObject({ disabled: true, tone: 'muted', text: /wait for it to finish/ });
    expect(skillDeleteActionState({ skill: unused, connected: false, pending: false }))
      .toMatchObject({ disabled: true, tone: 'muted', text: /Connect to the backend/ });
    expect(skillDeleteActionState({ skill: unused, connected: true, pending: false, refreshRequired: true }))
      .toMatchObject({ disabled: true, text: /reloaded/ });
    expect(skillDeleteActionState({ skill: used, connected: true, pending: false }).text)
      .toMatch(/^Used by 1 role\./);
  });

  it('describes the removed file, adds the unreadable caveat and names the folder outcome', () => {
    expect(skillDeleteDescription({ id: 'ts-testing', state: 'ok' }))
      .toBe('The folder skills/ts-testing and its SKILL.md will be removed. No role uses this skill.');
    expect(skillDeleteDescription({ id: 'broken', state: 'unreadable' }))
      .toContain('The file could not be read, so its content cannot be checked.');
    expect(skillDeleteDescription({ id: 'huge', state: 'truncated' }))
      .toContain('The file could not be read, so its content cannot be checked.');
    expect(skillDeleteDescription({ id: 'ts-testing', state: 'ok' }))
      .toBe([
        skillDeleteDescriptionParts({ id: 'ts-testing', state: 'ok' }).before,
        'skills/ts-testing',
        skillDeleteDescriptionParts({ id: 'ts-testing', state: 'ok' }).after,
      ].join(''));
    expect(skillDeleteAnnouncement({ deleted: { id: 'ts-testing', folder: 'removed' } }))
      .toBe('Deleted skill ts-testing.');
    expect(skillDeleteAnnouncement({ deleted: { id: 'ts-testing', folder: 'kept' } }))
      .toBe('Deleted skill ts-testing. The folder was kept because it contains other files.');
  });

  it('reads role labels from a SKILL_IN_USE error and ignores malformed data', () => {
    const error = (data: unknown): ManagementError => ({ code: 'SKILL_IN_USE', message: 'm', retryable: false, data });
    expect(skillDeleteErrorMessage(error({ roles: ['Developer', 'QA'] })))
      .toBe('Developer, QA still use this skill. Remove it from them first.');
    expect(skillDeleteErrorMessage(error({ roles: ['dev', 'qa'] }), { dev: 'Developer', qa: 'QA Engineer' }))
      .toBe('Developer, QA Engineer still use this skill. Remove it from them first.');
    expect(skillDeleteErrorMessage(error({ roles: [{ id: 'dev', name: 'Developer' }, { id: 'qa' }] })))
      .toBe('Developer, qa still use this skill. Remove it from them first.');
    expect(skillDeleteErrorMessage(error({ roles: [1, null, '  '] })))
      .toBe('Roles still use this skill. Remove it from them first.');
    expect(skillDeleteErrorMessage({ code: 'CONFIG_CHANGED', message: 'm', retryable: false }))
      .toBe(SKILL_DELETE_CONFLICT);
    expect(skillDeleteErrorMessage({ code: 'INTERNAL', message: 'm', retryable: false }))
      .toBe(SKILL_DELETE_GENERIC);
  });
});

describe('Delete skill button', () => {
  it('disables the action for a used skill and explains why in amber', async () => {
    const { view } = setup();
    await openSkill(view, 'code-search');
    const button = deleteButton(view);
    expect(button.disabled).toBe(true);
    expect(reasonFor(button)).toBe('Used by 4 roles. Remove it from them before deleting it.');
    expect(document.getElementById(button.getAttribute('aria-describedby')!)?.className)
      .toContain('is-warning');
    expect(button.querySelector('svg')?.getAttribute('data-icon')).toBe('trash');
  });

  it('enables the action for an unused skill with the muted explanation', async () => {
    const { view } = setup();
    await openSkill(view, 'ts-testing');
    const button = deleteButton(view);
    expect(button.disabled).toBe(false);
    expect(reasonFor(button)).toBe('No role uses this skill, so it can be deleted.');
    expect(document.getElementById(button.getAttribute('aria-describedby')!)?.className)
      .toContain('is-muted');
  });

  it('hides the action for a missing skill', async () => {
    const { view } = setup();
    await openSkill(view, 'legacy-notes');
    expect(page(view).queryByRole('button', { name: 'Delete skill' })).toBeNull();
    expect(view.container.querySelector('#skills-delete-reason')).toBeNull();
  });

  it('disables the action while disconnected and names the connection', async () => {
    const { view } = setup({}, { connection: connectionFixture('lost') });
    await openSkill(view, 'ts-testing');
    const button = deleteButton(view);
    expect(button.disabled).toBe(true);
    expect(reasonFor(button)).toBe('Connect to the backend to delete this skill.');
  });

  it('disables the action while another skill write is pending', async () => {
    const gate = deferred<ManagementResult<SkillDetail>>();
    const updateSkill = vi.fn(() => gate.promise);
    const { view } = setup({}, { overrides: { updateSkill } });
    await openSkill(view, 'ts-testing');
    const user = userEvent.setup();
    await user.click(page(view).getByRole('button', { name: 'Edit skill content' }));
    const editor = view.getByRole('dialog', { name: 'Edit ts-testing' });
    fireEvent.change(within(editor).getByLabelText('Content (markdown)'), {
      target: { value: `${SKILL_TEXT['ts-testing']}\nDraft` },
    });
    fireEvent.click(within(editor).getByRole('button', { name: 'Save to file' }));
    await waitFor(() => expect(within(editor).getByRole('button', { name: 'Saving...' }).hasAttribute('disabled')).toBe(true));

    const button = deleteButton(view);
    expect(button.disabled).toBe(true);
    expect(reasonFor(button)).toBe('A skill change is in progress; wait for it to finish.');

    await act(async () => {
      gate.resolve({ ok: false, error: { code: 'INTERNAL', message: 'stop', retryable: false } });
    });
    await within(editor).findByRole('alert');
    expect(updateSkill).toHaveBeenCalledTimes(1);
  });
});

describe('Delete skill dialog', () => {
  it('uses an alertdialog with the design copy, 480 px width, focus on Cancel and a red Delete skill action', async () => {
    const { view } = setup();
    const dialog = await openDelete(view);
    expect(dialog.getAttribute('style')).toContain('width: min(480px, 100%)');
    expect(within(dialog).getByRole('heading', { name: 'Delete ts-testing?' })).toBeTruthy();
    const body = document.getElementById(dialog.getAttribute('aria-describedby')!);
    expect(body?.textContent).toBe('The folder skills/ts-testing and its SKILL.md will be removed. No role uses this skill.');
    expect(body?.querySelector('code')?.textContent).toBe('skills/ts-testing');
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement;
    expect(cancel.className).toContain('dialog-action-secondary');
    expect(confirm(dialog).className).toContain('dialog-action-danger');
    expect(document.activeElement).toBe(cancel);
  });

  it('sends the roles and file tokens once and ignores a repeated submit', async () => {
    const { view, fake } = setup();
    const dialog = await openDelete(view);
    const button = confirm(dialog);
    fireEvent.click(button);
    fireEvent.click(button);
    await view.findByRole('list', { name: 'Saved skills' });
    const calls = fake.calls.filter(call => call.method === 'deleteSkill');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(['a', 'ts-testing', SKILLS_SHA, sha256Hex(SKILL_TEXT['ts-testing']!)]);
  });

  it('cancels with the button and Escape without calling the backend and restores focus', async () => {
    const { view, fake } = setup();
    await openSkill(view, 'ts-testing');
    const button = deleteButton(view);
    button.focus();
    fireEvent.click(button);
    let dialog = await view.findByRole('alertdialog', { name: 'Delete ts-testing?' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(view.queryByRole('alertdialog')).toBeNull());
    expect(fake.calls.some(call => call.method === 'deleteSkill')).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(button));

    fireEvent.click(button);
    dialog = await view.findByRole('alertdialog', { name: 'Delete ts-testing?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(view.queryByRole('alertdialog')).toBeNull());
    expect(fake.calls.some(call => call.method === 'deleteSkill')).toBe(false);
  });

  it('ignores Escape while deleting and shows the busy action', async () => {
    const gate = deferred<ManagementResult<{ workspace: string; deleted: { id: string; folder: 'removed' | 'kept' }; rolesSha256: string | null }>>();
    const deleteSkill = vi.fn(() => gate.promise);
    const { view } = setup({}, { overrides: { deleteSkill } });
    const dialog = await openDelete(view);
    fireEvent.click(confirm(dialog));
    await waitFor(() => expect(confirm(dialog).textContent).toBe('Deleting…'));
    expect((within(dialog).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(view.getByRole('alertdialog', { name: 'Delete ts-testing?' })).toBeTruthy();
    expect(deleteSkill).toHaveBeenCalledTimes(1);
    await act(async () => {
      gate.resolve({ ok: true, data: { workspace: '/a', deleted: { id: 'ts-testing', folder: 'removed' }, rolesSha256: SKILLS_SHA } });
    });
    await view.findByRole('list', { name: 'Saved skills' });
  });
});

describe('Delete skill success and refresh', () => {
  it('returns to the list, reloads skills and roles, focuses the catalog heading and announces once', async () => {
    const { view, skills, roles } = setup();
    await openDelete(view);
    fireEvent.click(confirm(view.getByRole('alertdialog', { name: 'Delete ts-testing?' })));
    await view.findByRole('list', { name: 'Saved skills' });

    expect(await view.findByText('Deleted skill ts-testing.')).toBeTruthy();
    expect(statusFor(view, 'Deleted skill ts-testing.')).toHaveLength(1);
    expect(view.container.querySelector('.skills-announcement')?.textContent).toBe('Deleted skill ts-testing.');
    expect(skills.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(roles.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(row(view, 'ts-testing')).toBeUndefined();
    await waitFor(() => expect(document.activeElement).toBe(view.getByRole('heading', { name: 'Skill catalog' })));
  });

  it('reports that the folder was kept because it contains other files', async () => {
    const { view } = setup({
      skills: [{ id: 'ts-testing', text: SKILL_TEXT['ts-testing']!, folder: 'kept' }],
      roles: [],
    });
    await openDelete(view);
    fireEvent.click(confirm(view.getByRole('alertdialog', { name: 'Delete ts-testing?' })));
    const kept = 'Deleted skill ts-testing. The folder was kept because it contains other files.';
    expect(await view.findByText(kept)).toBeTruthy();
    // The announcement doubles as the green status chip on the list.
    const chips = statusFor(view, kept);
    expect(chips).toHaveLength(1);
    expect(chips[0]!.className).toBe('skills-announcement');
  });

  it('treats SKILL_NOT_FOUND as already deleted and returns to the refreshed list', async () => {
    const deleteSkill = vi.fn(async () => fail('SKILL_NOT_FOUND', 'Skill ts-testing has no file to delete.'));
    const { view, skills, roles } = setup({}, { overrides: { deleteSkill } });
    await openDelete(view);
    fireEvent.click(confirm(view.getByRole('alertdialog', { name: 'Delete ts-testing?' })));
    await view.findByRole('list', { name: 'Saved skills' });
    expect(await view.findByText('ts-testing was already deleted.')).toBeTruthy();
    expect(view.queryByText('Deleted skill ts-testing.')).toBeNull();
    await waitFor(() => expect(skills.mock.calls.length).toBeGreaterThanOrEqual(2));
    // The roles catalog can change independently, so it is reloaded too.
    expect(roles.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('shows the refresh failure alert and retries the delete refresh', async () => {
    const first = skillCatalog();
    const afterDelete = skillCatalog({ skills: first.skills.filter(skill => skill.id !== 'ts-testing') });
    const skills = vi.fn()
      .mockResolvedValueOnce(ok(first))
      .mockResolvedValueOnce(fail('BACKEND_UNAVAILABLE', 'the backend is down'))
      .mockResolvedValueOnce(ok(afterDelete));
    const { view } = setup({}, { overrides: { skills } });
    await openDelete(view);
    fireEvent.click(confirm(view.getByRole('alertdialog', { name: 'Delete ts-testing?' })));

    expect(await view.findByText(SKILL_DELETE_REFRESH_FAILED)).toBeTruthy();
    // The stale list stays visible so the person is not dropped into a blank screen.
    expect(row(view, 'ts-testing')).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: 'Retry loading skills' }));

    await view.findByRole('list', { name: 'Saved skills' });
    expect(await view.findByText('Deleted skill ts-testing.')).toBeTruthy();
    expect(view.queryByText(SKILL_DELETE_REFRESH_FAILED)).toBeNull();
    expect(row(view, 'ts-testing')).toBeUndefined();
    expect(skills).toHaveBeenCalledTimes(3);
  });

  it('shows the refresh failure alert when the roles catalog cannot reload after the delete', async () => {
    const before = skillCatalog();
    const afterDelete = skillCatalog({ skills: before.skills.filter(skill => skill.id !== 'ts-testing') });
    const skills = vi.fn()
      .mockResolvedValueOnce(ok(before))
      .mockResolvedValueOnce(ok(afterDelete))
      .mockResolvedValueOnce(ok(afterDelete));
    const roles = vi.fn()
      .mockResolvedValueOnce(ok(roleCatalogFixture()))
      .mockResolvedValueOnce(fail('BACKEND_UNAVAILABLE', 'the roles catalog is down'))
      .mockResolvedValueOnce(ok(roleCatalogFixture()));
    const { view } = setup({}, { overrides: { skills, roles } });
    await openDelete(view);
    fireEvent.click(confirm(view.getByRole('alertdialog', { name: 'Delete ts-testing?' })));

    // Both catalogs were reloaded, but the roles reload failed, so the delete is
    // not fully refreshed and must not be announced as complete.
    expect(await view.findByText(SKILL_DELETE_REFRESH_FAILED)).toBeTruthy();
    expect(view.queryByText('Deleted skill ts-testing.')).toBeNull();
    expect(roles).toHaveBeenCalledTimes(2);

    // The roles alert retries the whole delete refresh, not just the roles catalog.
    fireEvent.click(view.getByRole('button', { name: 'Retry loading roles' }));
    await view.findByRole('list', { name: 'Saved skills' });
    expect(await view.findByText('Deleted skill ts-testing.')).toBeTruthy();
    expect(view.queryByText(SKILL_DELETE_REFRESH_FAILED)).toBeNull();
    expect(skills).toHaveBeenCalledTimes(3);
    expect(roles).toHaveBeenCalledTimes(3);
    expect(row(view, 'ts-testing')).toBeUndefined();
  });

  it('focuses the Skills heading when the deleted skill was the last row', async () => {
    const { view } = setup({ skills: [{ id: 'only-skill', text: '# Only\n' }], roles: [] });
    const dialog = await openDelete(view, 'only-skill');
    fireEvent.click(confirm(dialog));

    expect(await view.findByText('Deleted skill only-skill.')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(view.getByRole('heading', { name: 'Skills' })));
  });
});

describe('Delete skill failures', () => {
  it('keeps SKILL_IN_USE in the dialog with the role names and opens the roles dialog', async () => {
    const deleteSkill = vi.fn(async () => fail('SKILL_IN_USE', 'still used', { roles: ['dev', 'qa'] }));
    const { view } = setup({
      roles: [
        { id: 'dev', name: 'Developer', skills: [] },
        { id: 'qa', name: 'QA Engineer', skills: [] },
      ],
    }, { overrides: { deleteSkill } });
    const dialog = await openDelete(view);
    fireEvent.click(confirm(dialog));

    const alert = await within(dialog).findByRole('alert');
    // The backend names role ids; the dialog shows the catalog's display names.
    expect(alert.querySelector('p')?.textContent).toBe('Developer, QA Engineer still use this skill. Remove it from them first.');
    await waitFor(() => expect(document.activeElement).toBe(alert));
    const user = userEvent.setup();
    await user.click(within(alert).getByRole('button', { name: 'Edit roles' }));
    expect(view.queryByRole('alertdialog', { name: 'Delete ts-testing?' })).toBeNull();
    const rolesDialog = await view.findByRole('dialog', { name: 'Roles that use ts-testing' });
    expect(within(rolesDialog).getAllByRole('checkbox').length).toBeGreaterThan(0);
    expect(deleteSkill).toHaveBeenCalledTimes(1);
  });

  it('reports CONFIG_CHANGED in place and reloads both catalogs from Reload latest', async () => {
    const deleteSkill = vi.fn(async () => fail('CONFIG_CHANGED', 'changed'));
    const { view, skills, roles } = setup({}, { overrides: { deleteSkill } });
    const dialog = await openDelete(view);
    const skillsCalls = skills.mock.calls.length;
    const rolesCalls = roles.mock.calls.length;
    fireEvent.click(confirm(dialog));

    const alert = await within(dialog).findByRole('alert');
    expect(alert.querySelector('p')?.textContent).toBe(SKILL_DELETE_CONFLICT);
    await waitFor(() => expect(document.activeElement).toBe(alert));
    const user = userEvent.setup();
    await user.click(within(alert).getByRole('button', { name: 'Reload latest' }));
    await waitFor(() => expect(skills.mock.calls.length).toBe(skillsCalls + 1));
    expect(roles.mock.calls.length).toBe(rolesCalls + 1);
    await waitFor(() => expect(within(dialog).queryByRole('alert')).toBeNull());
    expect(view.getByRole('alertdialog', { name: 'Delete ts-testing?' })).toBeTruthy();
  });

  it('keeps the dialog informed when Reload latest cannot reload the skill list', async () => {
    const deleteSkill = vi.fn(async () => fail('CONFIG_CHANGED', 'changed'));
    const before = skillCatalog();
    const skills = vi.fn()
      .mockResolvedValueOnce(ok(before))
      .mockResolvedValueOnce(fail('BACKEND_UNAVAILABLE', 'the backend is down'));
    const { view } = setup({}, { overrides: { deleteSkill, skills } });
    const dialog = await openDelete(view);
    fireEvent.click(confirm(dialog));

    const conflict = await within(dialog).findByRole('alert');
    expect(conflict.querySelector('p')?.textContent).toBe(SKILL_DELETE_CONFLICT);
    const user = userEvent.setup();
    await user.click(within(conflict).getByRole('button', { name: 'Reload latest' }));

    const reloadFailure = await within(dialog).findByRole('alert');
    expect(reloadFailure.textContent).toContain('Could not reload the skills list');
    expect(within(reloadFailure).getByRole('button', { name: 'Retry reload latest' })).toBeTruthy();
    expect(view.getByRole('alertdialog', { name: 'Delete ts-testing?' })).toBeTruthy();
  });

  it('keeps the dialog informed when Reload latest cannot reload the roles catalog', async () => {
    const deleteSkill = vi.fn(async () => fail('CONFIG_CHANGED', 'changed'));
    const roles = vi.fn()
      .mockResolvedValueOnce(ok(roleCatalogFixture()))
      .mockResolvedValueOnce(fail('BACKEND_UNAVAILABLE', 'the roles catalog is down'));
    const { view } = setup({}, { overrides: { deleteSkill, roles } });
    const dialog = await openDelete(view);
    fireEvent.click(confirm(dialog));

    const conflict = await within(dialog).findByRole('alert');
    expect(conflict.querySelector('p')?.textContent).toBe(SKILL_DELETE_CONFLICT);
    const user = userEvent.setup();
    await user.click(within(conflict).getByRole('button', { name: 'Reload latest' }));

    const reloadFailure = await within(dialog).findByRole('alert');
    expect(reloadFailure.textContent).toContain('Could not reload the roles catalog');
    expect(within(reloadFailure).getByRole('button', { name: 'Retry reload latest' })).toBeTruthy();
    expect(view.getByRole('alertdialog', { name: 'Delete ts-testing?' })).toBeTruthy();
  });

  it('reports a generic failure with Retry and completes on the retry', async () => {
    const fake = fakeSkillManagement();
    const deleteSkill = vi.fn()
      .mockResolvedValueOnce(fail('INTERNAL', 'socket closed'))
      .mockImplementation((...args: Parameters<ManagementApi['deleteSkill']>) => fake.deleteSkill(...args));
    const skills = vi.fn((id: string) => fake.skills(id));
    const roles = vi.fn((id: string) => fake.roles(id));
    const api = { ...fake, skills, roles, deleteSkill } as unknown as ManagementApi;
    const view = render(<main><SkillsScreen workspace={workspace} management={api} /></main>);
    const dialog = await openDelete(view);
    fireEvent.click(confirm(dialog));

    const alert = await within(dialog).findByRole('alert');
    expect(alert.querySelector('p')?.textContent).toBe(SKILL_DELETE_GENERIC);
    await waitFor(() => expect(document.activeElement).toBe(alert));
    const user = userEvent.setup();
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    await view.findByRole('list', { name: 'Saved skills' });
    expect(await view.findByText('Deleted skill ts-testing.')).toBeTruthy();
    expect(deleteSkill).toHaveBeenCalledTimes(2);
  });

  it('says a truncated or unreadable file cannot have its content checked but still allows deleting it', async () => {
    for (const state of ['unreadable', 'truncated'] as const) {
      cleanup();
      const skill = state === 'unreadable'
        ? skillItem({ id: 'broken', state, title: null, bytes: null, sha256: null, roles: [] })
        : skillItem({ id: 'broken', state, title: 'Huge', bytes: 40960, sha256: 'b'.repeat(64), roles: [] });
      const { view } = customScreen(skill);
      await openSkill(view, 'broken');
      expect(deleteButton(view).disabled).toBe(false);
      fireEvent.click(deleteButton(view));
      const dialog = await view.findByRole('alertdialog', { name: 'Delete broken?' });
      const body = document.getElementById(dialog.getAttribute('aria-describedby')!);
      expect(body?.textContent).toContain('The file could not be read, so its content cannot be checked.');
    }
  });

  it('deletes a truncated file with a null file token and announces the removal', async () => {
    const text = `# Huge\n${'x'.repeat(40000)}`;
    const { view, fake } = setup({
      skills: [{ id: 'huge', text, state: 'truncated' }],
      roles: [],
    });
    const dialog = await openDelete(view, 'huge');
    fireEvent.click(confirm(dialog));

    expect(await view.findByText('Deleted skill huge.')).toBeTruthy();
    expect(view.queryByRole('list', { name: 'Saved skills' })).toBeNull();
    const calls = fake.calls.filter(call => call.method === 'deleteSkill');
    expect(calls).toHaveLength(1);
    // A truncated file's catalog token covers only the start, so null is the
    // only token that stays stable between list and delete.
    expect(calls[0]!.args).toEqual(['a', 'huge', SKILLS_SHA, null]);
  });

  it('deletes an unreadable file with a null file token instead of an empty one', async () => {
    const { view, fake } = setup({
      skills: [{ id: 'broken', text: null, state: 'unreadable' }],
      roles: [],
    });
    const dialog = await openDelete(view, 'broken');
    fireEvent.click(confirm(dialog));

    expect(await view.findByText('Deleted skill broken.')).toBeTruthy();
    const calls = fake.calls.filter(call => call.method === 'deleteSkill');
    expect(calls).toHaveLength(1);
    // skill.delete accepts a null file token when there is no readable SHA to send;
    // an empty string is not a SHA and the backend rejects the request.
    expect(calls[0]!.args).toEqual(['a', 'broken', SKILLS_SHA, null]);
  });
});

describe('Skill page delete styles', () => {
  it('matches the design button, reason and compact dialog metrics', () => {
    const css = readFileSync(resolve(__dirname, '../src/renderer/styles.css'), 'utf8').replace(/\s+/g, ' ');
    expect(css).toMatch(/\.skills-screen \.skills-delete-button \{[^}]*border: 1px solid #4a2c2c;[^}]*color: #f0a3a3;/);
    expect(css).toMatch(/\.skills-screen \.skills-delete-button:disabled \{ opacity: 0\.45; cursor: default; \}/);
    expect(css).toMatch(/\.skills-delete-reason\.is-warning \{ color: var\(--warning\); \}/);
    expect(css).toMatch(/\.skills-delete-reason\.is-muted \{ color: #a3a9b2; \}/);
    expect(css).toMatch(/\.skills-announcement \{[^}]*background: rgba\(111, 211, 139, 0\.12\);[^}]*color: var\(--success\);/);
    expect(css).toMatch(/\.skill-delete-dialog \.dialog-header \{[^}]*padding: 20px 20px 0/);
    expect(css).toMatch(/\.skill-delete-dialog \.dialog-action-danger \{[^}]*background: #b4413b/);
  });
});
