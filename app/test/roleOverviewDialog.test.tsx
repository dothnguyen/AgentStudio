// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ManagementApi, ManagementError, RoleCatalogItem, RoleCatalogList } from '../src/renderer/api';
import { RoleOverviewDialog } from '../src/renderer/roles/RoleOverviewDialog';
import { CONFLICT_MESSAGE, VERIFY_MESSAGE } from '../src/renderer/roles/roleSave';
import { deferred, fakeManagement } from './teamsFixtures';
import { roleItem, rolesFixture } from './rolesFixtures';

afterEach(cleanup);
const SHA = 'c'.repeat(64);
const DEV_SHA = 'd'.repeat(64);
const NEXT_SHA = '1'.repeat(64);
const FINAL_SHA = '2'.repeat(64);

const instr = (text: string | null, sha: string | null, state = 'ok') => ({ state, path: '.agent-studio/roles/Developer.md', text, sha256: sha, bytes: text?.length ?? null });
function developer(over: Record<string, unknown> = {}): RoleCatalogItem {
  return roleItem('Developer', {
    name: 'Developer',
    description: 'Implements stories',
    instructions: instr('Write tests.', DEV_SHA),
    skills: [{ id: 'python-testing', state: 'ok' }],
    ...over,
  });
}
const reviewer = () => roleItem('Reviewer', { name: 'Code Reviewer', description: 'Reviews' });
function catalog(items: RoleCatalogItem[] = [developer(), reviewer()], over: Partial<RoleCatalogList> = {}): RoleCatalogList {
  return rolesFixture({ items, availableSkills: ['python-testing', 'extra-skill'], ...over });
}
const ok = <T,>(data: T) => ({ ok: true as const, data });
const fail = (code: string, message = 'failed', extra: Partial<ManagementError> = {}) => ({ ok: false as const, error: { code, message, retryable: false, ...extra } });
const mutation = (role: RoleCatalogItem, sha = NEXT_SHA) => ok({ workspace: '/w', sha256: sha, role, warnings: [], appliesToNewAssignments: true as const });

function Harness(props: {
  initialRole?: RoleCatalogItem;
  initialCatalog?: RoleCatalogList;
  updateRole?: ReturnType<typeof vi.fn>;
  updateRoleInstructions?: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  onSaved?: (role: RoleCatalogItem) => void;
}) {
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState(props.initialRole ?? developer());
  const [catalogNow, setCatalogNow] = useState(props.initialCatalog ?? catalog());
  const updateRole = props.updateRole ?? vi.fn(async () => mutation(role));
  const updateRoleInstructions = props.updateRoleInstructions ?? vi.fn();
  const fake = fakeManagement({ calls: { updateRole, updateRoleInstructions } });
  const reload = vi.fn(async () => {
    const result = await props.reload();
    if (result.ok) {
      setCatalogNow(result.data);
      const fresh = result.data.items.find(item => item.id === 'Developer');
      if (fresh) setRole(fresh);
    }
    return result;
  });
  return <>
    <button type="button" onClick={() => setOpen(true)}>Open overview</button>
    {open && <RoleOverviewDialog
      role={role}
      catalog={catalogNow}
      catalogSha={catalogNow.sha256}
      management={fake.api as ManagementApi}
      workspaceId="a"
      reload={reload}
      onSaved={saved => { setOpen(false); props.onSaved?.(saved); }}
      onCancel={() => setOpen(false)}
    />}
  </>;
}

const dialog = () => document.querySelector('.role-overview-dialog') as HTMLElement;
const field = (label: string) => within(dialog()).getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement;
const saveButton = () => within(dialog()).getByRole('button', { name: /^(Save|Saving…)$/ }) as HTMLButtonElement;

describe('Role overview dialog', () => {
  it('opens_at_560px_with_focus_on_name_a_locked_id_and_the_roles_json_note', async () => {
    const user = userEvent.setup();
    render(<Harness reload={vi.fn(async () => ok(catalog()))} />);
    await user.click(document.querySelector('button')!);
    const d = dialog();
    expect(d.getAttribute('style')).toContain('width: min(560px, 100%)');
    expect(within(d).getByRole('heading', { name: 'Edit overview' })).toBeTruthy();
    expect(document.activeElement).toBe(field('Name'));
    expect(d.querySelector('.role-dialog-locked-id')?.textContent).toBe('Developer');
    expect(d.querySelector('.role-dialog-locked-id svg')).toBeTruthy();
    expect(within(d).getByText('Members refer to the role by this id, so it cannot change.')).toBeTruthy();
    expect(d.querySelector('.dialog-footer-note')!.textContent).toBe('Saved to roles.json');
    expect(saveButton().disabled).toBe(true);
  });

  it('sends_only_changed_fields_and_returns_focus_to_the_card_edit_button', async () => {
    const user = userEvent.setup();
    const updated = developer({ name: 'Lead Dev', description: null });
    const updateRole = vi.fn(async () => mutation(updated));
    const updateRoleInstructions = vi.fn();
    const onSaved = vi.fn();
    render(<Harness updateRole={updateRole} updateRoleInstructions={updateRoleInstructions} reload={vi.fn(async () => ok(catalog([updated, reviewer()]))) } onSaved={onSaved} />);
    const opener = document.querySelector('button')!;
    opener.focus();
    await user.click(opener);
    await user.clear(field('Name'));
    await user.type(field('Name'), ' Lead Dev ');
    await user.clear(field('Description'));
    await user.click(saveButton());
    await waitFor(() => expect(dialog()).toBeNull());
    expect(updateRole).toHaveBeenCalledWith('a', 'Developer', { name: 'Lead Dev', description: null }, SHA);
    expect(updateRoleInstructions).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledWith(updated);
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('sends_only_the_description_when_only_the_description_changes', async () => {
    const user = userEvent.setup();
    const updated = developer({ description: 'New description' });
    const updateRole = vi.fn(async () => mutation(updated));
    render(<Harness updateRole={updateRole} reload={vi.fn(async () => ok(catalog([updated, reviewer()])))} />);
    await user.click(document.querySelector('button')!);
    await user.clear(field('Description'));
    await user.type(field('Description'), 'New description');
    await user.click(saveButton());
    await waitFor(() => expect(updateRole).toHaveBeenCalledTimes(1));
    expect(updateRole).toHaveBeenCalledWith('a', 'Developer', { description: 'New description' }, SHA);
  });

  it('disables_save_when_nothing_changed_or_the_name_is_invalid', async () => {
    const user = userEvent.setup();
    render(<Harness reload={vi.fn(async () => ok(catalog()))} />);
    await user.click(document.querySelector('button')!);
    expect(saveButton().disabled).toBe(true);
    await user.clear(field('Name'));
    expect(saveButton().disabled).toBe(true);
    expect(within(dialog()).getByText('Enter a role name.')).toBeTruthy();
    await user.type(field('Name'), 'Code Reviewer');
    expect(saveButton().disabled).toBe(true);
    expect(within(dialog()).getByText('That role name is already in use.')).toBeTruthy();
    expect(field('Name').getAttribute('aria-invalid')).toBe('true');
  });

  it('disables_save_again_when_the_draft_returns_to_the_saved_values', async () => {
    const user = userEvent.setup();
    render(<Harness reload={vi.fn(async () => ok(catalog()))} />);
    await user.click(document.querySelector('button')!);
    await user.clear(field('Name'));
    await user.type(field('Name'), 'Renamed');
    expect(saveButton().disabled).toBe(false);
    await user.clear(field('Name'));
    await user.type(field('Name'), '  Developer  ');
    expect(saveButton().disabled).toBe(true);
    await user.clear(field('Description'));
    await user.type(field('Description'), 'Changed');
    expect(saveButton().disabled).toBe(false);
    await user.clear(field('Description'));
    await user.type(field('Description'), 'Implements stories');
    expect(saveButton().disabled).toBe(true);
  });

  it('disables_save_and_explains_a_description_over_the_limit', async () => {
    render(<Harness reload={vi.fn(async () => ok(catalog()))} />);
    fireEvent.click(document.querySelector('button')!);
    fireEvent.change(field('Description'), { target: { value: 'd'.repeat(2001) } });
    expect(within(dialog()).getByText('Use 2000 characters or fewer.')).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
  });

  it('keeps_the_draft_open_and_focuses_the_error_when_the_write_fails', async () => {
    const user = userEvent.setup();
    const error = fail('BAD_REQUEST', 'Role update is invalid', { data: { problems: [{ path: 'roles.Developer.directTask', message: 'odd field' }] }, remediation: 'Fix and retry.' });
    const updateRole = vi.fn(async () => error);
    render(<Harness updateRole={updateRole} reload={vi.fn(async () => ok(catalog()))} />);
    await user.click(document.querySelector('button')!);
    await user.clear(field('Name'));
    await user.type(field('Name'), 'Renamed');
    await user.click(saveButton());
    await waitFor(() => expect(within(dialog()).getByRole('alert')).toBeTruthy());
    const alert = within(dialog()).getByRole('alert');
    expect(alert.textContent).toContain('BAD_REQUEST: Role update is invalid');
    expect(alert.textContent).toContain('Fix and retry.');
    expect(alert.textContent).toContain('roles.Developer.directTask: odd field');
    expect(document.activeElement).toBe(alert);
    expect(field('Name').value).toBe('Renamed');
  });

  it('dismisses_a_rejected_write_when_the_person_edits_the_draft_again', async () => {
    const user = userEvent.setup();
    const updateRole = vi.fn(async () => fail('BAD_REQUEST', 'Role update is invalid'));
    render(<Harness updateRole={updateRole} reload={vi.fn(async () => ok(catalog()))} />);
    await user.click(document.querySelector('button')!);
    await user.clear(field('Name'));
    await user.type(field('Name'), 'Renamed');
    await user.click(saveButton());
    await waitFor(() => expect(within(dialog()).getByRole('alert')).toBeTruthy());
    await user.type(field('Name'), ' again');
    expect(within(dialog()).queryByRole('alert')).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });

  it('reports_a_verify_failure_as_a_partial_save_without_closing', async () => {
    const user = userEvent.setup();
    const renamed = developer({ name: 'Renamed' });
    render(<Harness updateRole={vi.fn(async () => mutation(renamed))} reload={vi.fn(async () => fail('INTERNAL', 'offline'))} />);
    await user.click(document.querySelector('button')!);
    await user.clear(field('Name'));
    await user.type(field('Name'), 'Renamed');
    await user.click(saveButton());
    await waitFor(() => expect(within(dialog()).getByRole('alert').textContent).toContain(VERIFY_MESSAGE));
    expect(field('Name').value).toBe('Renamed');
  });

  it('keeps_the_draft_across_a_conflict_reload_and_retries_with_the_new_token', async () => {
    const user = userEvent.setup();
    const server = developer({ name: 'Server Name' });
    const updateRole = vi.fn()
      .mockResolvedValueOnce(fail('CONFIG_CHANGED', 'changed'))
      .mockResolvedValueOnce(mutation(developer({ name: 'My Name' }), FINAL_SHA));
    const reload = vi.fn()
      .mockResolvedValueOnce(ok(catalog([server, reviewer()], { sha256: NEXT_SHA })))
      .mockResolvedValueOnce(ok(catalog([developer({ name: 'My Name' }), reviewer()], { sha256: FINAL_SHA })));
    render(<Harness updateRole={updateRole} reload={reload} />);
    await user.click(document.querySelector('button')!);
    await user.clear(field('Name'));
    await user.type(field('Name'), 'My Name');
    await user.click(saveButton());
    await waitFor(() => expect(within(dialog()).getByRole('alert').textContent).toContain(CONFLICT_MESSAGE));
    await user.click(within(dialog()).getByRole('button', { name: 'Reload and review' }));
    await waitFor(() => expect(within(dialog()).getByText('Current role values were reloaded. Review the draft, then save again.')).toBeTruthy());
    expect(field('Name').value).toBe('My Name');
    await user.click(saveButton());
    await waitFor(() => expect(updateRole).toHaveBeenCalledTimes(2));
    expect(updateRole).toHaveBeenLastCalledWith('a', 'Developer', { name: 'My Name' }, NEXT_SHA);
  });

  it('discards_the_draft_on_cancel_and_escape', async () => {
    const user = userEvent.setup();
    render(<Harness reload={vi.fn(async () => ok(catalog()))} />);
    const opener = document.querySelector('button')!;
    await user.click(opener);
    await user.clear(field('Description'));
    await user.type(field('Description'), 'Discard me');
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(dialog()).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(opener));
    await user.click(opener);
    expect(field('Description').value).toBe('Implements stories');
    await user.clear(field('Description'));
    await user.type(field('Description'), 'Escape me');
    await user.keyboard('{Escape}');
    expect(dialog()).toBeNull();
  });

  it('stays_busy_with_disabled_fields_while_the_write_is_pending', async () => {
    const user = userEvent.setup();
    const gate = deferred<ReturnType<typeof mutation>>();
    render(<Harness updateRole={vi.fn(() => gate.promise)} reload={vi.fn(async () => ok(catalog()))} />);
    await user.click(document.querySelector('button')!);
    await user.clear(field('Description'));
    await user.type(field('Description'), 'New description');
    await user.click(saveButton());
    await waitFor(() => expect(within(dialog()).getByRole('button', { name: 'Saving…' })).toBeTruthy());
    expect(saveButton().disabled).toBe(true);
    expect((field('Name') as HTMLInputElement).disabled).toBe(true);
    expect((within(dialog()).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
