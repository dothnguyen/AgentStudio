// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionStatus, ManagementError, Workspace } from '../src/renderer/api';
import { RolesScreen } from '../src/renderer/roles/RolesScreen';
import type { RoleCatalogItem, RoleCatalogList } from '../src/shared/management';
import { LONG_ID, roleItem, rolesFixture } from './rolesFixtures';
import { deferred, fakeManagement } from './teamsFixtures';

afterEach(cleanup);
const workspace: Workspace = { id: 'a', name: 'A', path: '/a', exists: true, missing: false };
const SHA = 'c'.repeat(64);
const DEV_SHA = 'd'.repeat(64);
const NEW_SHA = '1'.repeat(64);
const ASSIGN = 'Saved changes apply to new assignments; current assignments are unchanged.';
const instr = (state: string, path: string | null, text: string | null, sha: string | null) => ({ state, path, text, sha256: sha, bytes: text?.length ?? null });

function developer(over: Record<string, unknown> = {}): RoleCatalogItem {
  return roleItem('Developer', {
    name: 'Developer', description: 'Implements stories',
    instructions: instr('ok', '.agent-studio/custom/dev.md', 'Write tests.', DEV_SHA),
    skills: [{ id: 'python-testing', state: 'ok' }, { id: 'retired-skill', state: 'missing' }],
    ...over,
  });
}
const reviewer = () => roleItem('Reviewer', { name: 'Code Reviewer', description: 'Reviews', instructions: instr('missing', '.agent-studio/roles/Reviewer.md', null, null) });
const pathless = () => roleItem('pathless', { name: 'Pathless', instructions: instr('none', null, null, null) });
function catalogOf(items: RoleCatalogItem[] = [developer(), reviewer(), pathless()], over: Partial<RoleCatalogList> = {}): RoleCatalogList {
  return rolesFixture({ items, availableSkills: ['python-testing', 'extra-skill'], ...over });
}
const created = (text: string | null = null, sha: string | null = null) => roleItem('qa-lead', { name: 'QA Lead', instructions: instr(text === null ? 'none' : 'ok', text === null ? null : '.agent-studio/roles/qa-lead.md', text, sha) });
const ok = <T,>(data: T) => ({ ok: true as const, data });
const fail = (code: string, message: string, extra: Partial<ManagementError> = {}) => ({ ok: false as const, error: { code, message, retryable: false, ...extra } });
const mutation = (role: RoleCatalogItem, sha = NEW_SHA) => ok({ workspace: '/w', sha256: sha, role, warnings: [], appliesToNewAssignments: true as const });

type Step = unknown | (() => unknown);
function setup(rolesSteps: Step[] = [ok(catalogOf())], mutations: Record<string, Step[]> = {}, connection?: ConnectionStatus) {
  const queue = (steps: Step[]) => { let i = 0; return vi.fn(async (..._args: unknown[]) => { const step = steps[Math.min(i++, steps.length - 1)]; return typeof step === 'function' ? (step as () => unknown)() : step; }); };
  const roles = queue(rolesSteps);
  const createRole = queue(mutations.createRole ?? [fail('INTERNAL', 'unexpected')]);
  const updateRole = queue(mutations.updateRole ?? [fail('INTERNAL', 'unexpected')]);
  const updateRoleInstructions = queue(mutations.updateRoleInstructions ?? [fail('INTERNAL', 'unexpected')]);
  const fake = fakeManagement({ calls: { roles, createRole, updateRole, updateRoleInstructions } });
  const render1 = (ws = workspace, c = connection) => <main><RolesScreen workspace={ws} management={fake.api} connection={c} /></main>;
  const view = render(render1());
  return { view, roles, createRole, updateRole, updateRoleInstructions, fake, render1 };
}
type View = ReturnType<typeof setup>['view'];
const dialog = (view: View) => within(view.getByRole('dialog'));
const field = (view: View, label: string) => dialog(view).getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement;
const type = (view: View, label: string, value: string) => fireEvent.change(field(view, label), { target: { value } });
const pickRole = (view: View, id: string) => fireEvent.click([...within(view.getByRole('list', { name: 'Saved roles' })).getAllByRole('button')].find(b => b.lastElementChild!.textContent === id)!);
async function openEdit(view: View, id = 'Developer') {
  await view.findByRole('list', { name: 'Saved roles' });
  pickRole(view, id);
  fireEvent.click(view.getByRole('button', { name: 'Edit role' }));
  return view.getByRole('dialog');
}
async function openCreate(view: View) { fireEvent.click(await view.findByRole('button', { name: 'New role' })); return view.getByRole('dialog'); }
const submit = (view: View) => fireEvent.click(dialog(view).getByRole('button', { name: /^(Create role|Save changes)$/ }));
const selectedRow = (view: View) => within(view.getByRole('list', { name: 'Saved roles' })).getAllByRole('button').find(b => b.getAttribute('aria-current') === 'true')!;

describe('Role create and edit', () => {
  it('creates_role_then_selects_returned_id_after_verified_reload', async () => {
    const after = catalogOf([developer(), reviewer(), pathless(), created()], { sha256: NEW_SHA });
    const s = setup([ok(catalogOf()), ok(after)], { createRole: [mutation(created())] });
    await openCreate(s.view);
    expect(document.activeElement).toBe(field(s.view, 'Name'));
    type(s.view, 'Name', 'QA Lead');
    expect(field(s.view, 'Role id').value).toBe('qa-lead');
    type(s.view, 'Description', ' ');
    submit(s.view);
    await waitFor(() => expect(s.view.queryByRole('dialog')).toBeNull());
    expect(s.createRole).toHaveBeenCalledTimes(1);
    expect(s.createRole).toHaveBeenCalledWith('a', { id: 'qa-lead', name: 'QA Lead', skills: [] }, SHA);
    expect(s.updateRoleInstructions).not.toHaveBeenCalled();
    expect(s.roles).toHaveBeenCalledTimes(2);
    expect(s.view.getByRole('status').textContent).toBe(`Created role "QA Lead" (qa-lead). ${ASSIGN}`);
    await waitFor(() => expect(selectedRow(s.view).lastElementChild!.textContent).toBe('qa-lead'));
    expect(document.activeElement).toBe(selectedRow(s.view));
  });

  it('creates_role_then_saves_nonblank_instructions_with_fresh_tokens', async () => {
    const order: string[] = [];
    const mid = catalogOf([developer(), reviewer(), pathless(), created()], { sha256: '2'.repeat(64) });
    const final = catalogOf([developer(), reviewer(), pathless(), created('Hello €', '3'.repeat(64))], { sha256: '4'.repeat(64) });
    const s = setup(
      [ok(catalogOf()), () => { order.push('reload1'); return ok(mid); }, () => { order.push('verify'); return ok(final); }],
      { createRole: [() => { order.push('create'); return mutation(created()); }], updateRoleInstructions: [() => { order.push('instructions'); return mutation(created('Hello €', '3'.repeat(64)), '4'.repeat(64)); }] },
    );
    await openCreate(s.view);
    type(s.view, 'Name', 'QA Lead');
    type(s.view, 'Shared instructions', 'Hello €');
    expect(dialog(s.view).getByText('9 / 16384 UTF-8 bytes')).toBeTruthy();
    submit(s.view);
    await waitFor(() => expect(s.view.queryByRole('dialog')).toBeNull());
    expect(order).toEqual(['create', 'reload1', 'instructions', 'verify']);
    expect(s.updateRoleInstructions).toHaveBeenCalledWith('a', 'qa-lead', 'Hello €', '2'.repeat(64), null);
    expect(s.view.getByRole('status').textContent).toContain('Created role "QA Lead" (qa-lead).');
  });

  it('promotes_successful_create_to_edit_when_instruction_save_fails', async () => {
    const mid = catalogOf([developer(), reviewer(), pathless(), created()], { sha256: '2'.repeat(64) });
    const final = catalogOf([developer(), reviewer(), pathless(), created('Hi', '3'.repeat(64))], { sha256: '4'.repeat(64) });
    const s = setup([ok(catalogOf()), ok(mid), ok(final)], {
      createRole: [mutation(created())],
      updateRoleInstructions: [fail('BAD_REQUEST', 'Instructions rejected', { data: { problems: [{ path: 'qa-lead.instructions', message: 'Cannot write file' }] } }), mutation(created('Hi', '3'.repeat(64)), '4'.repeat(64))],
    });
    await openCreate(s.view);
    type(s.view, 'Name', 'QA Lead');
    type(s.view, 'Shared instructions', 'Hi');
    submit(s.view);
    await dialog(s.view).findByText('Metadata and skills were saved; shared instructions were not saved.');
    expect(dialog(s.view).getByRole('heading', { name: 'Edit QA Lead' })).toBeTruthy();
    expect(field(s.view, 'Role id').readOnly).toBe(true);
    expect(field(s.view, 'Shared instructions').value).toBe('Hi');
    expect(dialog(s.view).getByText('Cannot write file')).toBeTruthy();
    expect(s.view.queryByText(/Created role/)).toBeNull();
    submit(s.view);
    await waitFor(() => expect(s.view.queryByRole('dialog')).toBeNull());
    expect(s.createRole).toHaveBeenCalledTimes(1);
    expect(s.updateRole).not.toHaveBeenCalled();
    expect(s.updateRoleInstructions).toHaveBeenCalledTimes(2);
    expect(s.updateRoleInstructions).toHaveBeenLastCalledWith('a', 'qa-lead', 'Hi', '2'.repeat(64), null);
  });

  it('edits_name_description_and_ordered_skills_without_sending_id_or_unknown_fields', async () => {
    const edited = developer({ name: 'Lead Dev', description: null, skills: [{ id: 'retired-skill', state: 'missing' }, { id: 'python-testing', state: 'ok' }] });
    const s = setup([ok(catalogOf()), ok(catalogOf([edited, reviewer(), pathless()], { sha256: NEW_SHA }))], { updateRole: [mutation(edited)] });
    await openEdit(s.view);
    expect(document.activeElement).toBe(field(s.view, 'Name'));
    expect(field(s.view, 'Role id').readOnly).toBe(true);
    expect(dialog(s.view).getByText('The stable id cannot be renamed. Changing Name is a safe display-label rename.')).toBeTruthy();
    type(s.view, 'Name', ' Lead Dev ');
    type(s.view, 'Description', '');
    fireEvent.click(dialog(s.view).getByRole('button', { name: 'Move retired-skill up' }));
    submit(s.view);
    await waitFor(() => expect(s.view.queryByRole('dialog')).toBeNull());
    expect(s.updateRole).toHaveBeenCalledWith('a', 'Developer', { name: 'Lead Dev', description: null, skills: ['retired-skill', 'python-testing'] }, SHA);
    expect(s.updateRoleInstructions).not.toHaveBeenCalled();
    expect(s.view.getByRole('status').textContent).toBe(`Saved role "Lead Dev" (Developer). ${ASSIGN}`);
  });

  it('saves_instructions_only_with_exact_bytes_and_existing_tokens', async () => {
    const text = '  trailing € \n\n';
    const saved = developer({ instructions: instr('ok', '.agent-studio/custom/dev.md', text, '5'.repeat(64)) });
    const s = setup([ok(catalogOf()), ok(catalogOf([saved, reviewer(), pathless()]))], { updateRoleInstructions: [mutation(saved)] });
    await openEdit(s.view);
    type(s.view, 'Shared instructions', text);
    submit(s.view);
    await waitFor(() => expect(s.view.queryByRole('dialog')).toBeNull());
    expect(s.updateRole).not.toHaveBeenCalled();
    expect(s.updateRoleInstructions).toHaveBeenCalledTimes(1);
    expect(s.updateRoleInstructions).toHaveBeenCalledWith('a', 'Developer', text, SHA, DEV_SHA);
    expect(s.roles).toHaveBeenCalledTimes(2);
  });

  it('sends_empty_text_and_null_token_for_pathless_or_missing_instruction_files', async () => {
    const s = setup([ok(catalogOf()), ok(catalogOf())], { updateRoleInstructions: [mutation(pathless())] });
    await openEdit(s.view, 'pathless');
    type(s.view, 'Shared instructions', 'x');
    type(s.view, 'Shared instructions', '');
    submit(s.view); // draft equals the saved (none) text: nothing to write
    await waitFor(() => expect(s.view.queryByRole('dialog')).toBeNull());
    expect(s.updateRoleInstructions).not.toHaveBeenCalled();
    await openEdit(s.view, 'Developer');
    type(s.view, 'Shared instructions', '');
    submit(s.view);
    await waitFor(() => expect(s.updateRoleInstructions).toHaveBeenCalledWith('a', 'Developer', '', SHA, DEV_SHA));
  });

  it('keeps_missing_skills_visible_addable_reorderable_and_removable_by_keyboard', async () => {
    const s = setup();
    const user = userEvent.setup();
    await openEdit(s.view);
    const d = dialog(s.view);
    const list = d.getByRole('list', { name: 'Configured skills in order' });
    expect(within(list).getAllByRole('listitem').map(li => li.querySelector('code')!.textContent)).toEqual(['python-testing', 'retired-skill']);
    expect(within(list).getAllByText('Missing skill file')).toHaveLength(1);
    expect((d.getByRole('button', { name: 'Move python-testing up' }) as HTMLButtonElement).disabled).toBe(true);
    expect((d.getByRole('button', { name: 'Move retired-skill down' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(d.getByLabelText('Skill id to add'));
    await user.keyboard('brand-new{Enter}');
    expect(within(d.getByRole('list', { name: 'Configured skills in order' })).getAllByText('Missing skill file')).toHaveLength(2);
    expect(s.view.getByRole('dialog')).toBeTruthy(); // Enter in the manual input never submits the form
    await user.selectOptions(d.getByLabelText('Available skill'), 'extra-skill');
    await user.click(d.getByRole('button', { name: 'Add selected skill' }));
    const ids = () => within(d.getByRole('list', { name: 'Configured skills in order' })).getAllByRole('listitem').map(li => li.querySelector('code')!.textContent);
    expect(ids()).toEqual(['python-testing', 'retired-skill', 'brand-new', 'extra-skill']);
    d.getByRole('button', { name: 'Move extra-skill up' }).focus();
    await user.keyboard('{Enter}');
    expect(ids()).toEqual(['python-testing', 'retired-skill', 'extra-skill', 'brand-new']);
    await user.click(d.getByRole('button', { name: 'Remove retired-skill' }));
    expect(ids()).toEqual(['python-testing', 'extra-skill', 'brand-new']);
    await user.type(d.getByLabelText('Skill id to add'), 'extra-skill{Enter}');
    expect((d.getByLabelText('Skill id to add') as HTMLInputElement).value).toBe('extra-skill');
    expect(d.getByText("Remove the duplicate skill id 'extra-skill'.")).toBeTruthy();
    expect(s.updateRole).not.toHaveBeenCalled();
  });

  it('rejects_duplicate_name_bad_slug_duplicate_skill_and_oversized_unicode_before_api_calls', async () => {
    const s = setup();
    await openCreate(s.view);
    type(s.view, 'Name', 'developer');
    type(s.view, 'Role id', 'Bad Id');
    type(s.view, 'Shared instructions', '€'.repeat(5462));
    fireEvent.change(dialog(s.view).getByLabelText('Skill id to add'), { target: { value: 'x' } });
    fireEvent.click(dialog(s.view).getByRole('button', { name: 'Add skill' }));
    submit(s.view);
    const d = dialog(s.view);
    expect(d.getAllByRole('alert')).toHaveLength(1);
    expect(d.getByText('That role name is already in use.')).toBeTruthy();
    expect(d.getByText('Use 1–64 lowercase letters, digits, or hyphens, starting with a letter or digit.')).toBeTruthy();
    expect(d.getByText('Use 16384 UTF-8 bytes or fewer.')).toBeTruthy();
    for (const label of ['Name', 'Role id', 'Shared instructions']) {
      const el = field(s.view, label);
      expect(el.getAttribute('aria-invalid')).toBe('true');
      expect(document.getElementById(el.getAttribute('aria-describedby')!.split(' ').find(id => id.endsWith('-error'))!)).toBeTruthy();
    }
    await waitFor(() => expect(document.activeElement).toBe(field(s.view, 'Role id')));
    type(s.view, 'Role id', 'Developer');
    submit(s.view);
    expect(d.getByText('Use 1–64 lowercase letters, digits, or hyphens, starting with a letter or digit.')).toBeTruthy();
    expect(s.createRole).not.toHaveBeenCalled();
    cleanup();
    const t = setup();
    await openEdit(t.view);
    fireEvent.change(dialog(t.view).getByLabelText('Skill id to add'), { target: { value: 'python-testing' } });
    fireEvent.click(dialog(t.view).getByRole('button', { name: 'Add skill' }));
    expect(dialog(t.view).getByText("Remove the duplicate skill id 'python-testing'.")).toBeTruthy();
    expect(t.updateRole).not.toHaveBeenCalled();
  });

  it('retains_draft_when_metadata_write_fails_and_reports_structured_fields', async () => {
    const error = { data: { problems: [{ path: 'roles.Developer.name', message: 'Name rejected' }, { path: 'roles.Developer.directTask', message: 'odd field' }] }, remediation: 'Fix and retry.' };
    const s = setup([ok(catalogOf())], { updateRole: [fail('BAD_REQUEST', 'Role update is invalid', error), () => { throw new Error('boom'); }] });
    await openEdit(s.view);
    type(s.view, 'Name', 'Renamed');
    type(s.view, 'Shared instructions', 'keep me');
    submit(s.view);
    await dialog(s.view).findByText(/Role update is invalid/);
    const d = dialog(s.view);
    expect(d.getAllByRole('alert')).toHaveLength(1);
    expect(d.getByText('BAD_REQUEST', { selector: 'code' })).toBeTruthy();
    expect(d.getByText('Fix and retry.')).toBeTruthy();
    expect(d.getByText('roles.Developer.directTask: odd field')).toBeTruthy();
    expect(d.getByText('Name rejected')).toBeTruthy();
    expect(field(s.view, 'Name').getAttribute('aria-invalid')).toBe('true');
    expect(field(s.view, 'Name').value).toBe('Renamed');
    expect(field(s.view, 'Shared instructions').value).toBe('keep me');
    expect(document.activeElement).toBe(d.getByRole('button', { name: 'Save changes' }));
    expect(s.updateRoleInstructions).not.toHaveBeenCalled();
    submit(s.view);
    await d.findByText(/boom/);
    expect(d.getByText('INTERNAL', { selector: 'code' })).toBeTruthy();
    expect(field(s.view, 'Name').value).toBe('Renamed');
    expect(s.view.queryByRole('status')).toBeNull();
  });

  it('retains_draft_and_reports_partial_success_when_token_reload_or_instruction_write_fails', async () => {
    const renamed = developer({ name: 'Renamed' });
    const s = setup([ok(catalogOf()), fail('INTERNAL', 'offline'), ok(catalogOf([renamed, reviewer(), pathless()], { sha256: '2'.repeat(64) })), ok(catalogOf([renamed, reviewer(), pathless()]))], {
      updateRole: [mutation(renamed, '9'.repeat(64))],
      updateRoleInstructions: [fail('BAD_REQUEST', 'Instructions rejected'), mutation(renamed)],
    });
    await openEdit(s.view);
    type(s.view, 'Name', 'Renamed');
    type(s.view, 'Shared instructions', 'new text');
    submit(s.view);
    await dialog(s.view).findByText('Metadata and skills were saved, but current instruction tokens could not be loaded. Reload and review before saving instructions.');
    expect(s.updateRoleInstructions).not.toHaveBeenCalled();
    expect(field(s.view, 'Shared instructions').value).toBe('new text');
    expect(dialog(s.view).getByRole('heading', { name: 'Edit Renamed' })).toBeTruthy();
    submit(s.view);
    await dialog(s.view).findByText(/Instructions rejected/);
    expect(dialog(s.view).getByText('Metadata and skills were saved; shared instructions were not saved.')).toBeTruthy();
    expect(s.updateRole).toHaveBeenCalledTimes(1);
    expect(s.updateRoleInstructions).toHaveBeenCalledTimes(1);
    expect(s.view.queryByRole('status')).toBeNull();
    submit(s.view);
    await waitFor(() => expect(s.view.queryByRole('dialog')).toBeNull());
    expect(s.updateRole).toHaveBeenCalledTimes(1);
    expect(s.updateRoleInstructions).toHaveBeenCalledTimes(2);
  });

  it('does_not_close_or_announce_success_when_final_verification_reload_fails', async () => {
    const renamed = developer({ name: 'Renamed' });
    const s = setup([ok(catalogOf()), fail('INTERNAL', 'offline')], { updateRole: [mutation(renamed)] });
    await openEdit(s.view);
    type(s.view, 'Name', 'Renamed');
    submit(s.view);
    await dialog(s.view).findByText('The save completed, but the catalog could not be reloaded to verify it. Reload and review.');
    expect(s.view.getByRole('dialog')).toBeTruthy();
    expect(s.view.queryByText(/Saved role/)).toBeNull();
    expect(s.view.queryByRole('status')).toBeNull();
    expect(field(s.view, 'Name').value).toBe('Renamed');
  });

  it('requires_reload_review_and_explicit_keep_draft_after_config_changed', async () => {
    const server = developer({ name: 'Server Name', description: 'Server desc', instructions: instr('ok', '.agent-studio/custom/dev.md', 'Server text', '6'.repeat(64)) });
    const changed = catalogOf([server, reviewer(), pathless()], { sha256: '7'.repeat(64) });
    const s = setup([ok(catalogOf()), fail('INTERNAL', 'offline'), ok(changed), ok(changed)], {
      updateRole: [fail('CONFIG_CHANGED', 'changed', { data: { sha256: '7'.repeat(64) } }), mutation(developer({ name: 'My Name' }), '8'.repeat(64))],
    });
    await openEdit(s.view);
    type(s.view, 'Name', 'My Name');
    type(s.view, 'Shared instructions', 'My text');
    submit(s.view);
    const d = dialog(s.view);
    await d.findByText(/Another edit was saved first\. Reload current values and review the differences; nothing was overwritten\./);
    expect((d.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true);
    expect(s.updateRole).toHaveBeenCalledTimes(1);
    fireEvent.click(d.getByRole('button', { name: 'Reload and review' }));
    await waitFor(() => expect(s.roles).toHaveBeenCalledTimes(2));
    await d.findByRole('button', { name: 'Reload and review' }); // failed reload keeps the draft and a retry action
    expect(field(s.view, 'Name').value).toBe('My Name');
    fireEvent.click(d.getByRole('button', { name: 'Reload and review' }));
    await d.findByText('Server: Server Name');
    expect(d.getByText('Your draft: My Name')).toBeTruthy();
    expect(d.getByText('Server: Server desc')).toBeTruthy();
    expect(d.getByText(/content differs/)).toBeTruthy();
    expect(field(s.view, 'Shared instructions').value).toBe('My text');
    expect((d.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true);
    expect(s.updateRole).toHaveBeenCalledTimes(1);
    fireEvent.click(d.getByRole('button', { name: 'Keep my draft' }));
    expect((d.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(false);
    submit(s.view);
    await waitFor(() => expect(s.updateRole).toHaveBeenCalledTimes(2));
    expect(s.updateRole).toHaveBeenLastCalledWith('a', 'Developer', { name: 'My Name', description: 'Implements stories' }, '7'.repeat(64));
  });

  it('use_server_values_resets_the_draft_after_config_changed', async () => {
    const server = developer({ name: 'Server Name' });
    const changed = catalogOf([server, reviewer(), pathless()], { sha256: '7'.repeat(64) });
    const s = setup([ok(catalogOf()), ok(changed)], { updateRole: [fail('CONFIG_CHANGED', 'changed')] });
    await openEdit(s.view);
    type(s.view, 'Name', 'My Name');
    submit(s.view);
    await dialog(s.view).findByRole('button', { name: 'Reload and review' });
    fireEvent.click(dialog(s.view).getByRole('button', { name: 'Reload and review' }));
    await dialog(s.view).findByRole('button', { name: 'Use server values' });
    fireEvent.click(dialog(s.view).getByRole('button', { name: 'Use server values' }));
    expect(field(s.view, 'Name').value).toBe('Server Name');
    expect(dialog(s.view).queryByRole('button', { name: 'Keep my draft' })).toBeNull();
    fireEvent.click(dialog(s.view).getByRole('button', { name: 'Cancel' })); // clean: closes without a prompt
    expect(s.view.queryByRole('dialog')).toBeNull();
    expect(s.updateRole).toHaveBeenCalledTimes(1);
  });

  it('revalidates_create_id_and_name_against_the_reloaded_catalog_after_config_changed', async () => {
    const changed = catalogOf([developer(), reviewer(), pathless(), created()], { sha256: '7'.repeat(64) });
    const s = setup([ok(catalogOf()), ok(changed)], { createRole: [fail('CONFIG_CHANGED', 'changed')] });
    await openCreate(s.view);
    type(s.view, 'Name', 'QA Lead');
    submit(s.view);
    await dialog(s.view).findByRole('button', { name: 'Reload and review' });
    fireEvent.click(dialog(s.view).getByRole('button', { name: 'Reload and review' }));
    await dialog(s.view).findByText(/Current roles were reloaded/);
    submit(s.view);
    expect(dialog(s.view).getByText('That role id already exists.')).toBeTruthy();
    expect(dialog(s.view).getByText('That role name is already in use.')).toBeTruthy();
    expect(s.createRole).toHaveBeenCalledTimes(1);
  });

  it('rejects_double_submit_and_ignores_superseded_or_previous_workspace_results', async () => {
    const gate = deferred<unknown>();
    const s = setup([ok(catalogOf())], { updateRole: [() => gate.promise] });
    await openEdit(s.view);
    type(s.view, 'Name', 'Renamed');
    const form = s.view.getByRole('dialog');
    fireEvent.submit(form);
    fireEvent.submit(form);
    fireEvent.click(dialog(s.view).getByRole('button', { name: 'Saving metadata…' }));
    expect(s.updateRole).toHaveBeenCalledTimes(1);
    expect((dialog(s.view).getByRole('button', { name: 'Saving metadata…' }) as HTMLButtonElement).disabled).toBe(true);
    expect((field(s.view, 'Name') as HTMLInputElement).disabled).toBe(true);
    s.view.rerender(s.render1({ ...workspace, id: 'b' }));
    await s.view.findByRole('list', { name: 'Saved roles' });
    expect(s.view.queryByRole('dialog')).toBeNull();
    const rolesCalls = s.roles.mock.calls.length;
    await act(async () => { gate.resolve(mutation(developer({ name: 'Renamed' }))); await Promise.resolve(); });
    expect(s.roles.mock.calls.length).toBe(rolesCalls);
    expect(s.roles).toHaveBeenLastCalledWith('b');
    expect(s.view.queryByRole('status')).toBeNull();
    expect(s.updateRoleInstructions).not.toHaveBeenCalled();
  });

  it('confirms_dirty_cancel_but_closes_clean_cancel_and_restores_opener_focus', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    const s = setup();
    const user = userEvent.setup();
    await s.view.findByRole('list', { name: 'Saved roles' });
    pickRole(s.view, 'Developer');
    const opener = s.view.getByRole('button', { name: 'Edit role' });
    opener.focus();
    await user.click(opener);
    fireEvent.click(dialog(s.view).getByRole('button', { name: 'Cancel' }));
    expect(s.view.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(opener));
    await user.click(opener);
    type(s.view, 'Description', 'changed');
    await user.click(dialog(s.view).getByRole('button', { name: 'Cancel' }));
    expect(dialog(s.view).getByText('Discard unsaved changes?')).toBeTruthy();
    expect(document.activeElement).toBe(dialog(s.view).getByRole('button', { name: 'Keep editing' }));
    expect(dialog(s.view).queryByRole('button', { name: 'Save changes' })).toBeNull();
    await user.click(dialog(s.view).getByRole('button', { name: 'Keep editing' }));
    expect(field(s.view, 'Description').value).toBe('changed');
    await user.click(dialog(s.view).getByRole('button', { name: 'Cancel' }));
    await user.click(dialog(s.view).getByRole('button', { name: 'Discard changes' }));
    expect(s.view.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(confirm).not.toHaveBeenCalled();
    expect(s.updateRole).not.toHaveBeenCalled();
  });

  it('traps_focus_and_supports_escape_without_discarding_a_dirty_draft', async () => {
    const s = setup();
    const user = userEvent.setup();
    await openEdit(s.view);
    const d = dialog(s.view);
    const controls = () => [...s.view.getByRole('dialog').querySelectorAll<HTMLElement>('input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled)')];
    controls().at(-1)!.focus();
    await user.tab();
    expect(document.activeElement).toBe(controls()[0]);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(controls().at(-1));
    type(s.view, 'Description', 'dirty');
    field(s.view, 'Name').focus();
    await user.keyboard('{Escape}');
    expect(d.getByText('Discard unsaved changes?')).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(s.view.getByRole('dialog')).toBeTruthy();
    expect(d.queryByText('Discard unsaved changes?')).toBeNull();
    expect(field(s.view, 'Description').value).toBe('dirty');
    type(s.view, 'Description', 'Implements stories');
    await user.keyboard('{Escape}');
    expect(s.view.queryByRole('dialog')).toBeNull();
  });

  it('renders_shared_assignment_timing_copy_and_no_permission_or_agent_controls', async () => {
    const s = setup();
    await openEdit(s.view);
    const d = dialog(s.view);
    expect(d.getByText('Shared by all members assigned this role.')).toBeTruthy();
    expect(d.getByText('Saved changes apply to new assignments; current assignments keep their frozen instructions.')).toBeTruthy();
    const names = [...s.view.getByRole('dialog').querySelectorAll('input, select, textarea, button')].map(el => `${el.getAttribute('aria-label') ?? ''} ${el.closest('label')?.textContent ?? ''} ${el.textContent ?? ''}`);
    expect(names.filter(n => /permission|agent|provider|model/i.test(n))).toEqual([]);
    expect(s.view.getByRole('dialog').querySelector('input[type="checkbox"], input[type="radio"]')).toBeNull();
    expect(Object.keys(s.fake.api).filter(k => /file|path|command/i.test(k))).toEqual([]);
  });

  it('disables_save_for_unreadable_instructions_and_mutations_for_catalog_problems_or_disconnects', async () => {
    const writer = roleItem('Writer', { name: 'Writer', instructions: instr('truncated', '.agent-studio/roles/Writer.md', 'partial', 'e'.repeat(64)) });
    const s = setup([ok(catalogOf([developer(), writer]))]);
    await openEdit(s.view, 'Writer');
    expect((dialog(s.view).getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(dialog(s.view).getByRole('button', { name: 'Cancel' }));
    cleanup();
    const p = setup([ok(catalogOf(undefined, { problems: [{ path: 'roles', message: 'bad' }] }))]);
    await p.view.findByRole('list', { name: 'Saved roles' });
    expect((p.view.getByRole('button', { name: 'New role' }) as HTMLButtonElement).disabled).toBe(true);
    expect((p.view.getByRole('button', { name: 'Edit role' }) as HTMLButtonElement).disabled).toBe(true);
    expect(p.view.getByText(/Role changes are unavailable/)).toBeTruthy();
    cleanup();
    const lost = setup([ok(catalogOf())], {}, { state: 'lost', error: null, distro: null, command: null } as ConnectionStatus);
    await lost.view.findByRole('list', { name: 'Saved roles' });
    expect((lost.view.getByRole('button', { name: 'New role' }) as HTMLButtonElement).disabled).toBe(true);
    pickRole(lost.view, 'Reviewer');
    expect(lost.view.getByRole('heading', { level: 3, name: 'Code Reviewer' })).toBeTruthy();
  });

  it('fits_narrow_layout_and_wraps_long_ids_errors_and_skill_rows', async () => {
    const longRole = roleItem(LONG_ID, { name: 'Long', skills: [{ id: 'long-skill-'.repeat(5), state: 'missing' }], instructions: instr('none', null, null, null) });
    const s = setup([ok(catalogOf([longRole]))]);
    await openEdit(s.view, LONG_ID);
    expect(field(s.view, 'Role id').value).toBe(LONG_ID);
    const css = readFileSync(resolve(__dirname, '../src/renderer/styles.css'), 'utf8').replace(/\s+/g, ' ');
    expect(css).toMatch(/\.roles-form \{[^}]*width: min\(640px, 100%\)[^}]*overflow-wrap: anywhere/);
    expect(css).toMatch(/\.roles-field, [^{]*\.roles-conflict-field \{[^}]*min-width: 0; max-width: 100%/);
    expect(css).toMatch(/\.roles-form :is\(input, textarea, select\) \{[^}]*min-width: 0; max-width: 100%/);
    expect(css).toMatch(/\.roles-skill-row \{[^}]*flex-wrap: wrap[^}]*overflow-wrap: anywhere/);
    expect(css).toMatch(/\.roles-field-error \{[^}]*overflow-wrap: anywhere/);
    expect(css).toMatch(/@media \(max-width: 560px\) \{ \.roles-form \{ padding: 12px; \} \.roles-form-actions, \.roles-skill-add, \.roles-skill-actions \{ display: grid; grid-template-columns: minmax\(0, 1fr\); \} \}/);
    expect(css).toMatch(/\.roles-form button \{ min-height: 36px; \}/);
    expect(css).toMatch(/\.roles-form :is\(button, input, select, textarea\):focus-visible \{ outline: 2px solid/);
    const form = s.view.getByRole('dialog');
    for (const cls of ['roles-form', 'roles-skill-row', 'roles-form-actions']) expect(form.classList.contains(cls) || form.querySelector(`.${cls}`)).toBeTruthy();
    const roleCss = css.slice(css.indexOf('.roles-toolbar'));
    expect(roleCss).not.toMatch(/overflow-x: ?scroll/);
    expect(roleCss).not.toMatch(/(?<!max-)width: ?\d{3,}px/);
  });

  it('uses_one_dialog_name_associated_errors_restrained_live_regions_and_keyboard_skill_controls', async () => {
    const s = setup([ok(catalogOf())], { updateRole: [fail('BAD_REQUEST', 'nope')] });
    await openEdit(s.view);
    expect(s.view.getAllByRole('dialog')).toHaveLength(1);
    const form = s.view.getByRole('dialog');
    expect(form.tagName).toBe('FORM');
    expect(form.getAttribute('aria-modal')).toBe('true');
    expect(within(form).getByRole('heading', { name: 'Edit Developer' }).id).toBe(form.getAttribute('aria-labelledby'));
    expect(within(form).queryAllByRole('alert')).toHaveLength(0);
    expect(within(form).queryAllByRole('status')).toHaveLength(0);
    for (const label of ['Role id', 'Name', 'Description', 'Shared instructions', 'Available skill', 'Skill id to add']) expect(within(form).getByLabelText(label)).toBeTruthy();
    expect(within(form).getByRole('group', { name: 'Configured skills' })).toBeTruthy();
    for (const b of within(form).getAllByRole('button', { name: /^(Move|Remove) / })) expect(b.tagName).toBe('BUTTON');
    type(s.view, 'Name', '');
    submit(s.view);
    expect(within(form).getAllByRole('alert')).toHaveLength(1);
    expect(field(s.view, 'Name').getAttribute('aria-describedby')).toContain('-name-error');
    type(s.view, 'Name', 'Fine');
    submit(s.view);
    await within(form).findByText(/nope/);
    expect(within(form).getAllByRole('alert')).toHaveLength(1);
    expect(within(form).queryAllByRole('status')).toHaveLength(0);
  });
});
