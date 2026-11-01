// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ManagementApi, ManagementError, RoleCatalogItem, RoleCatalogList } from '../src/renderer/api';
import { RoleCreateDialog } from '../src/renderer/roles/RoleCreateDialog';
import { CONFLICT_MESSAGE, VERIFY_MESSAGE } from '../src/renderer/roles/roleSave';
import { deferred, fakeManagement } from './teamsFixtures';
import { roleItem, rolesFixture } from './rolesFixtures';

afterEach(cleanup);
const SHA = 'c'.repeat(64);
const NEXT_SHA = '1'.repeat(64);
const FINAL_SHA = '2'.repeat(64);

function existing(over: Record<string, unknown> = {}): RoleCatalogItem {
  return roleItem('Developer', { name: 'Developer', description: 'Implements stories', ...over });
}
function catalog(items: RoleCatalogItem[] = [existing()], over: Partial<RoleCatalogList> = {}): RoleCatalogList {
  return rolesFixture({ items, availableSkills: ['python-testing'], ...over });
}
const ok = <T,>(data: T) => ({ ok: true as const, data });
const fail = (code: string, message = 'failed', extra: Partial<ManagementError> = {}) => ({ ok: false as const, error: { code, message, retryable: false, ...extra } });
const created = (over: Record<string, unknown> = {}) => roleItem('qa-lead', { name: 'QA Lead', ...over });
const mutation = (role: RoleCatalogItem, sha = NEXT_SHA) => ok({ workspace: '/w', sha256: sha, role, warnings: [], appliesToNewAssignments: true as const });

function Harness(props: {
  initialCatalog?: RoleCatalogList;
  createRole?: ReturnType<typeof vi.fn>;
  updateRole?: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  onCreated?: (role: RoleCatalogItem) => void;
}) {
  const [open, setOpen] = useState(false);
  const [catalogNow, setCatalogNow] = useState(props.initialCatalog ?? catalog());
  const createRole = props.createRole ?? vi.fn(async () => mutation(created()));
  const updateRole = props.updateRole ?? vi.fn();
  const fake = fakeManagement({ calls: { createRole, updateRole } });
  const reload = vi.fn(async () => {
    const result = await props.reload();
    if (result.ok) setCatalogNow(result.data);
    return result;
  });
  return <>
    <button type="button" onClick={() => setOpen(true)}>Open new role</button>
    {open && <RoleCreateDialog
      catalog={catalogNow}
      catalogSha={catalogNow.sha256}
      management={fake.api as ManagementApi}
      workspaceId="a"
      reload={reload}
      onCreated={role => { setOpen(false); props.onCreated?.(role); }}
      onCancel={() => setOpen(false)}
    />}
  </>;
}

const dialog = () => document.querySelector('.role-create-dialog') as HTMLElement;
const field = (label: string) => within(dialog()).getByLabelText(label === 'Description' ? /^Description/ : label) as HTMLInputElement | HTMLTextAreaElement;
const createButton = () => within(dialog()).getByRole('button', { name: /^(Create role|Creating…)$/ }) as HTMLButtonElement;

describe('New role dialog', () => {
  it('opens_at_560px_with_focus_on_name_a_derived_id_and_the_creation_note', async () => {
    const user = userEvent.setup();
    render(<Harness reload={vi.fn(async () => ok(catalog()))} />);
    await user.click(document.querySelector('button')!);
    const d = dialog();
    expect(d.getAttribute('style')).toContain('width: min(560px, 100%)');
    expect(within(d).getByRole('heading', { name: 'New role' })).toBeTruthy();
    expect(document.activeElement).toBe(field('Name'));
    expect(d.querySelector('.dialog-footer-note')!.textContent).toBe('Add the instructions after creating it');
    await user.type(field('Name'), 'QA Lead!!');
    expect(field('Role id').value).toBe('qa-lead');
    expect(within(d).getByText(/roles\/qa-lead\.md/)).toBeTruthy();
    expect(createButton().disabled).toBe(false);
  });

  it('stops_deriving_the_id_once_the_person_edits_it', async () => {
    const user = userEvent.setup();
    render(<Harness reload={vi.fn(async () => ok(catalog()))} />);
    await user.click(document.querySelector('button')!);
    await user.type(field('Name'), 'QA Lead');
    await user.clear(field('Role id'));
    await user.type(field('Role id'), 'quality');
    await user.type(field('Name'), ' Lead');
    expect(field('Role id').value).toBe('quality');
  });

  it('creates_only_the_role_metadata_without_skills_or_instructions', async () => {
    const user = userEvent.setup();
    const role = created();
    const createRole = vi.fn(async () => mutation(role));
    const updateRole = vi.fn();
    const onCreated = vi.fn();
    render(<Harness createRole={createRole} updateRole={updateRole} reload={vi.fn(async () => ok(catalog([existing(), role], { sha256: FINAL_SHA })))} onCreated={onCreated} />);
    const opener = document.querySelector('button')!;
    opener.focus();
    await user.click(opener);
    await user.type(field('Name'), 'QA Lead');
    await user.type(field('Description'), ' Keeps quality high ');
    await user.click(createButton());
    await waitFor(() => expect(dialog()).toBeNull());
    expect(createRole).toHaveBeenCalledWith('a', { id: 'qa-lead', name: 'QA Lead', description: 'Keeps quality high', skills: [] }, SHA);
    expect(updateRole).not.toHaveBeenCalled();
    expect(onCreated).toHaveBeenCalledWith(role);
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('disables_create_and_explains_a_duplicate_id_or_name', async () => {
    const user = userEvent.setup();
    const duplicate = roleItem('taken', { name: 'Existing Name' });
    render(<Harness initialCatalog={catalog([existing(), duplicate])} reload={vi.fn(async () => ok(catalog([existing(), duplicate])))} />);
    await user.click(document.querySelector('button')!);
    await user.type(field('Name'), 'Taken Name');
    expect(field('Role id').value).toBe('taken-name');
    expect(createButton().disabled).toBe(false);
    await user.clear(field('Role id'));
    await user.type(field('Role id'), 'taken');
    expect(createButton().disabled).toBe(true);
    expect(within(dialog()).getByText('That role id already exists.')).toBeTruthy();
    await user.clear(field('Role id'));
    await user.type(field('Role id'), 'fresh-id');
    await user.clear(field('Name'));
    await user.type(field('Name'), 'Existing Name');
    expect(createButton().disabled).toBe(true);
    expect(within(dialog()).getByText('That role name is already in use.')).toBeTruthy();
  });

  it('validates_the_name_id_and_description_before_calling_create', async () => {
    const user = userEvent.setup();
    const createRole = vi.fn();
    render(<Harness createRole={createRole} reload={vi.fn(async () => ok(catalog()))} />);
    await user.click(document.querySelector('button')!);
    expect(createButton().disabled).toBe(true);
    await user.type(field('Role id'), 'Bad Id');
    expect(createButton().disabled).toBe(true);
    expect(within(dialog()).getByText('Use 1–64 lowercase letters, digits, or hyphens, starting with a letter or digit.')).toBeTruthy();
    await user.type(field('Name'), 'New Role');
    fireEvent.change(field('Description'), { target: { value: 'd'.repeat(2001) } });
    expect(within(dialog()).getByText('Use 2000 characters or fewer.')).toBeTruthy();
    expect(createButton().disabled).toBe(true);
    expect(createRole).not.toHaveBeenCalled();
  });

  it('revalidates_against_the_reloaded_catalog_after_a_conflict', async () => {
    const user = userEvent.setup();
    const changed = catalog([existing(), created()], { sha256: NEXT_SHA });
    const createRole = vi.fn(async () => fail('CONFIG_CHANGED', 'changed'));
    const reload = vi.fn(async () => ok(changed));
    render(<Harness createRole={createRole} reload={reload} />);
    await user.click(document.querySelector('button')!);
    await user.type(field('Name'), 'QA Lead');
    await user.click(createButton());
    await waitFor(() => expect(within(dialog()).getByRole('alert').textContent).toContain(CONFLICT_MESSAGE));
    await user.click(within(dialog()).getByRole('button', { name: 'Reload and review' }));
    await waitFor(() => expect(within(dialog()).getByText('Current role values were reloaded. Review the draft, then save again.')).toBeTruthy());
    expect(within(dialog()).getByText('That role id already exists.')).toBeTruthy();
    expect(within(dialog()).getByText('That role name is already in use.')).toBeTruthy();
    expect(createButton().disabled).toBe(true);
  });

  it('reports_a_verify_failure_after_create_as_a_partial_save_without_closing', async () => {
    const user = userEvent.setup();
    const createRole = vi.fn(async () => mutation(created()));
    const updateRole = vi.fn();
    render(<Harness createRole={createRole} updateRole={updateRole} reload={vi.fn(async () => fail('INTERNAL', 'offline'))} />);
    await user.click(document.querySelector('button')!);
    await user.type(field('Name'), 'QA Lead');
    await user.click(createButton());
    await waitFor(() => expect(within(dialog()).getByRole('alert').textContent).toContain(VERIFY_MESSAGE));
    expect(within(dialog()).getByRole('alert').textContent).toContain('INTERNAL: offline');
    expect(field('Name').value).toBe('QA Lead');
    expect(document.activeElement).toBe(within(dialog()).getByRole('alert'));
    expect(createRole).toHaveBeenCalledTimes(1);
    expect(updateRole).not.toHaveBeenCalled();
  });

  it('retries_verification_after_create_without_creating_again', async () => {
    const user = userEvent.setup();
    const role = created();
    const createRole = vi.fn(async () => mutation(role));
    const updateRole = vi.fn();
    const reload = vi.fn()
      .mockResolvedValueOnce(fail('INTERNAL', 'offline'))
      .mockResolvedValueOnce(ok(catalog([existing(), role], { sha256: FINAL_SHA })));
    const onCreated = vi.fn();
    render(<Harness createRole={createRole} updateRole={updateRole} reload={reload} onCreated={onCreated} />);
    await user.click(document.querySelector('button')!);
    await user.type(field('Name'), 'QA Lead');
    await user.click(createButton());
    await waitFor(() => expect(within(dialog()).getByRole('alert').textContent).toContain(VERIFY_MESSAGE));
    const retry = within(dialog()).getByRole('button', { name: 'Retry' }) as HTMLButtonElement;
    expect(retry.disabled).toBe(false);
    expect((field('Role id') as HTMLInputElement).disabled).toBe(true);
    await user.click(retry);
    await waitFor(() => expect(dialog()).toBeNull());
    expect(createRole).toHaveBeenCalledTimes(1);
    expect(updateRole).not.toHaveBeenCalled();
    expect(onCreated).toHaveBeenCalledWith(role);
  });

  it('shows_the_creation_error_and_keeps_the_draft', async () => {
    const user = userEvent.setup();
    const createRole = vi.fn(async () => fail('BAD_REQUEST', 'Role rejected'));
    render(<Harness createRole={createRole} reload={vi.fn(async () => ok(catalog()))} />);
    await user.click(document.querySelector('button')!);
    await user.type(field('Name'), 'QA Lead');
    await user.click(createButton());
    await waitFor(() => expect(within(dialog()).getByRole('alert').textContent).toContain('BAD_REQUEST: Role rejected'));
    expect(field('Name').value).toBe('QA Lead');
    expect(document.activeElement).toBe(within(dialog()).getByRole('alert'));
  });

  it('discards_the_draft_on_cancel_and_escape', async () => {
    const user = userEvent.setup();
    render(<Harness reload={vi.fn(async () => ok(catalog()))} />);
    const opener = document.querySelector('button')!;
    await user.click(opener);
    await user.type(field('Name'), 'Discard me');
    await user.keyboard('{Escape}');
    expect(dialog()).toBeNull();
    await user.click(opener);
    expect((field('Name') as HTMLInputElement).value).toBe('');
    await user.type(field('Name'), 'Escape me');
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(dialog()).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('stays_busy_with_a_disabled_create_action_while_saving', async () => {
    const user = userEvent.setup();
    const gate = deferred<ReturnType<typeof mutation>>();
    render(<Harness createRole={vi.fn(() => gate.promise)} reload={vi.fn(async () => ok(catalog()))} />);
    await user.click(document.querySelector('button')!);
    await user.type(field('Name'), 'QA Lead');
    await user.click(createButton());
    await waitFor(() => expect(within(dialog()).getByRole('button', { name: 'Creating…' })).toBeTruthy());
    expect(createButton().disabled).toBe(true);
    expect((field('Name') as HTMLInputElement).disabled).toBe(true);
  });
});
