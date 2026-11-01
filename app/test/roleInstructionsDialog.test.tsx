// @vitest-environment jsdom
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ManagementApi, RoleCatalogItem, RoleCatalogList } from '../src/renderer/api';
import { CONFLICT_MESSAGE } from '../src/renderer/roles/roleSave';
import { INSTRUCTIONS_MESSAGE } from '../src/renderer/roles/roleSave';
import { TOKENS_MESSAGE } from '../src/renderer/roles/roleSave';
import { RoleInstructionsDialog } from '../src/renderer/roles/RoleInstructionsDialog';
import { RolePageInstructionsDialog } from '../src/renderer/roles/RolePageInstructionsDialog';
import { RoleInstructionsSection } from '../src/renderer/teams/RoleInstructionsSection';
import { deferred, fakeManagement, member } from './teamsFixtures';
import { roleItem, rolesFixture } from './rolesFixtures';

afterEach(cleanup);
const SHA = 'a'.repeat(64);
const DEV_SHA = 'b'.repeat(64);
const NEXT_SHA = 'c'.repeat(64);
const FINAL_SHA = 'd'.repeat(64);
const ANNOUNCEMENT = 'Saved role TeamLead. Saved changes apply to new assignments; current assignments are unchanged.';
const ok = <T,>(data: T) => ({ ok: true as const, data });
const fail = (code: string, message = 'failed') => ({ ok: false as const, error: { code, message, retryable: false } });
const mutation = (role: RoleCatalogItem, sha: string) => ok({ workspace: '/w', sha256: sha, role, warnings: [], appliesToNewAssignments: true as const });
const catalog = (role: RoleCatalogItem, sha = SHA): RoleCatalogList => rolesFixture({ sha256: sha, items: [role] });
type ReloadResult = { ok: true; data: RoleCatalogList } | { ok: false; error: { code: string; message: string; retryable: boolean } };

function role(over: Partial<RoleCatalogItem> = {}): RoleCatalogItem {
  return roleItem('TeamLead', {
    name: 'TeamLead',
    description: 'Old description',
    instructions: { state: 'ok', path: '.agent-studio/roles/team-lead.md', text: 'Old prompt', sha256: DEV_SHA, bytes: 10 },
    skills: [{ id: 'python-testing', state: 'ok' }],
    ...over,
  });
}

function Harness(props: {
  management: ManagementApi;
  initialRole?: RoleCatalogItem;
  reload(): Promise<ReloadResult>;
}) {
  const [items, setItems] = useState<RoleCatalogItem[]>([props.initialRole ?? role()]);
  const [sha, setSha] = useState(SHA);
  const reloadRoles = vi.fn(async () => {
    const result = await props.reload();
    if (result.ok) { setItems(result.data.items); setSha(result.data.sha256); }
    return result;
  });
  return <RoleInstructionsSection
    workspaceId="ws-a"
    management={props.management}
    member={member({ memberId: 'lead', name: 'lead', role: 'TeamLead', roleState: 'defined' })}
    roles={items}
    catalogSha={sha}
    roleCatalogMessage={null}
    pending={false}
    readOnly={false}
    reloadRoles={reloadRoles}
  />;
}

function setup(parts: { updateRole?: ReturnType<typeof vi.fn>; updateRoleInstructions?: ReturnType<typeof vi.fn>; reload: ReturnType<typeof vi.fn>; initialRole?: RoleCatalogItem }) {
  const updateRole = parts.updateRole ?? vi.fn(async () => mutation(role({ description: 'New description' }), NEXT_SHA));
  const updateRoleInstructions = parts.updateRoleInstructions ?? vi.fn(async () => mutation(role(), NEXT_SHA));
  const fake = fakeManagement({ calls: { updateRole, updateRoleInstructions } });
  const view = render(<Harness management={fake.api} reload={parts.reload} initialRole={parts.initialRole} />);
  return { view, updateRole, updateRoleInstructions };
}

const card = () => screen.getByRole('region', { name: 'Role instructions' });
const editButton = () => within(card()).getByRole('button', { name: 'Edit role instructions' });
const field = (label: string) => within(screen.getByRole('dialog')).getByLabelText(label) as HTMLTextAreaElement;
const saveButton = () => within(screen.getByRole('dialog')).getByRole('button', { name: /^(Save to file|Saving\.\.\.)$/ }) as HTMLButtonElement;
const flush = async () => { await act(async () => {}); };

describe('Role instructions dialog', () => {
  it('opens at 780px with the path, focuses Description and keeps Save disabled until something changes', async () => {
    const user = userEvent.setup();
    const reload = vi.fn(async () => ok(catalog(role())));
    const { updateRole } = setup({ reload });
    await user.click(editButton());
    const dialog = screen.getByRole('dialog', { name: 'Edit TeamLead instructions' });
    expect(dialog.getAttribute('style')).toContain('width: min(780px, 100%)');
    expect(dialog.querySelector('.dialog-subtitle')!.textContent).toBe('Saved to .agent-studio/roles/team-lead.md');
    expect(document.activeElement).toBe(field('Description'));
    expect(field('Description').rows).toBe(3);
    expect(field('Prompt').rows).toBe(14);
    expect(saveButton().disabled).toBe(true);
    await user.type(field('Description'), ' updated');
    expect(saveButton().disabled).toBe(false);
    expect(updateRole).not.toHaveBeenCalled();
  });

  it('shows the shared-file note and the next-assignment footer', () => {
    const reload = vi.fn(async () => ok(catalog(role())));
    setup({ reload });
    fireEvent.click(editButton());
    const dialog = screen.getByRole('dialog', { name: 'Edit TeamLead instructions' });
    expect(dialog.textContent).toContain('Every member with the TeamLead role uses this file. Assignments already running keep the instructions they started with.');
    expect(dialog.querySelector('.dialog-footer-note')!.textContent).toBe('Takes effect on the next assignment');
  });

  it('disables Save again when the draft is reverted to the catalog values', async () => {
    const user = userEvent.setup();
    const reload = vi.fn(async () => ok(catalog(role())));
    setup({ reload });
    await user.click(editButton());
    await user.clear(field('Description'));
    await user.type(field('Description'), 'Changed');
    expect(saveButton().disabled).toBe(false);
    await user.clear(field('Description'));
    await user.type(field('Description'), 'Old description');
    expect(saveButton().disabled).toBe(true);
  });

  it('updates the line and character count and disables Save over the byte limit', () => {
    const reload = vi.fn(async () => ok(catalog(role())));
    setup({ reload });
    fireEvent.click(editButton());
    const prompt = field('Prompt');
    fireEvent.change(prompt, { target: { value: 'one\ntwo' } });
    expect(within(screen.getByRole('dialog')).getByText('2 lines · 7 characters')).toBeTruthy();
    fireEvent.change(prompt, { target: { value: '€'.repeat(5462) } });
    expect(within(screen.getByRole('dialog')).getByText('Too long: 16386 / 16384 UTF-8 bytes.')).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
  });

  it('validates the description length like the Roles screen', () => {
    const reload = vi.fn(async () => ok(catalog(role())));
    setup({ reload });
    fireEvent.click(editButton());
    fireEvent.change(field('Description'), { target: { value: 'x'.repeat(2001) } });
    const dialog = screen.getByRole('dialog', { name: 'Edit TeamLead instructions' });
    expect(within(dialog).getByRole('alert').textContent).toBe('Use 2000 characters or fewer.');
    expect(saveButton().disabled).toBe(true);
  });

  it('accepts a prompt at exactly the byte limit and rejects one byte over', () => {
    const reload = vi.fn(async () => ok(catalog(role())));
    setup({ reload });
    fireEvent.click(editButton());
    fireEvent.change(field('Prompt'), { target: { value: 'a'.repeat(16384) } });
    expect(within(screen.getByRole('dialog')).getByText('1 lines · 16384 characters')).toBeTruthy();
    expect(saveButton().disabled).toBe(false);
    fireEvent.change(field('Prompt'), { target: { value: 'a'.repeat(16385) } });
    expect(within(screen.getByRole('dialog')).getByText('Too long: 16385 / 16384 UTF-8 bytes.')).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
  });

  it('disables the fields and Save while the app is read-only', () => {
    const reloadRoles = vi.fn(async () => ok(catalog(role())));
    const fake = fakeManagement();
    const props = {
      workspaceId: 'ws-a',
      management: fake.api,
      member: member({ memberId: 'lead', name: 'lead', role: 'TeamLead', roleState: 'defined' }),
      roles: [role()],
      catalogSha: SHA,
      roleCatalogMessage: null,
      pending: false,
      readOnly: false,
      reloadRoles,
    };
    const view = render(<RoleInstructionsSection {...props} />);
    fireEvent.click(within(view.container).getByRole('button', { name: 'Edit role instructions' }));
    view.rerender(<RoleInstructionsSection {...props} readOnly />);
    expect(field('Description').disabled).toBe(true);
    expect(field('Prompt').disabled).toBe(true);
    expect(saveButton().disabled).toBe(true);
  });

  it('blocks saving when the shared instructions could not be read', () => {
    const broken = role({ instructions: { state: 'invalid', path: '.agent-studio/roles/team-lead.md', text: null, sha256: null, bytes: null } });
    const reload = vi.fn(async () => ok(catalog(broken)));
    setup({ reload, initialRole: broken });
    fireEvent.click(editButton());
    const dialog = screen.getByRole('dialog', { name: 'Edit TeamLead instructions' });
    expect(within(dialog).getByText('Shared instructions were not fully read, so this role cannot be saved here. Reload the catalog to try again.')).toBeTruthy();
    expect(field('Prompt').disabled).toBe(true);
    expect(field('Description').disabled).toBe(false);
    expect(saveButton().disabled).toBe(true);
  });

  it('saves the description then the prompt, closes, restores focus, refreshes the card and announces', async () => {
    const user = userEvent.setup();
    const described = role({ description: 'New description' });
    const final = role({ description: 'New description', instructions: { ...role().instructions, text: 'New prompt text', sha256: FINAL_SHA } });
    const updateRole = vi.fn(async () => mutation(described, NEXT_SHA));
    const updateRoleInstructions = vi.fn(async () => mutation(final, FINAL_SHA));
    const reload = vi.fn()
      .mockResolvedValueOnce(ok(catalog(described, NEXT_SHA)))
      .mockResolvedValueOnce(ok(catalog(final, FINAL_SHA)));
    const { updateRole: update } = setup({ updateRole, updateRoleInstructions, reload });
    await user.click(editButton());
    await user.clear(field('Description'));
    await user.type(field('Description'), 'New description');
    await user.clear(field('Prompt'));
    await user.type(field('Prompt'), 'New prompt text');
    await user.click(saveButton());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(update).toHaveBeenCalledWith('ws-a', 'TeamLead', { description: 'New description' }, SHA);
    expect(updateRoleInstructions).toHaveBeenCalledWith('ws-a', 'TeamLead', 'New prompt text', NEXT_SHA, DEV_SHA);
    expect(document.activeElement).toBe(editButton());
    expect(screen.getByRole('status').textContent).toBe(ANNOUNCEMENT);
    expect(card().textContent).toContain('New description');
    expect(card().textContent).toContain('New prompt text');
    expect(card().textContent).toContain('.agent-studio/roles/team-lead.md');
  });

  it('writes only the description when only the description changed', async () => {
    const user = userEvent.setup();
    const described = role({ description: 'New description' });
    const updateRole = vi.fn(async () => mutation(described, NEXT_SHA));
    const updateRoleInstructions = vi.fn();
    const reload = vi.fn(async () => ok(catalog(described, NEXT_SHA)));
    setup({ updateRole, updateRoleInstructions, reload });
    await user.click(editButton());
    await user.clear(field('Description'));
    await user.type(field('Description'), 'New description');
    await user.click(saveButton());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(updateRole).toHaveBeenCalledTimes(1);
    expect(updateRoleInstructions).not.toHaveBeenCalled();
    expect(card().textContent).toContain('New description');
  });

  it('writes only the prompt when only the prompt changed', async () => {
    const user = userEvent.setup();
    const final = role({ instructions: { ...role().instructions, text: 'New prompt', sha256: FINAL_SHA } });
    const updateRole = vi.fn();
    const updateRoleInstructions = vi.fn(async () => mutation(final, FINAL_SHA));
    const reload = vi.fn(async () => ok(catalog(final, FINAL_SHA)));
    setup({ updateRole, updateRoleInstructions, reload });
    await user.click(editButton());
    await user.clear(field('Prompt'));
    await user.type(field('Prompt'), 'New prompt');
    await user.click(saveButton());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(updateRole).not.toHaveBeenCalled();
    expect(updateRoleInstructions).toHaveBeenCalledWith('ws-a', 'TeamLead', 'New prompt', SHA, DEV_SHA);
    expect(card().textContent).toContain('New prompt');
  });

  it('keeps the dialog open on a partial failure and focuses the message', async () => {
    const user = userEvent.setup();
    const described = role({ description: 'New description' });
    const updateRole = vi.fn(async () => mutation(described, NEXT_SHA));
    const updateRoleInstructions = vi.fn(async () => fail('BAD_REQUEST', 'Instructions rejected'));
    const reload = vi.fn(async () => ok(catalog(described, NEXT_SHA)));
    setup({ updateRole, updateRoleInstructions, reload });
    await user.click(editButton());
    await user.clear(field('Description'));
    await user.type(field('Description'), 'New description');
    await user.clear(field('Prompt'));
    await user.type(field('Prompt'), 'New prompt');
    await user.click(saveButton());
    await flush();
    const dialog = screen.getByRole('dialog', { name: 'Edit TeamLead instructions' });
    const alert = within(dialog).getByRole('alert');
    expect(alert.textContent).toContain(INSTRUCTIONS_MESSAGE);
    expect(alert.textContent).toContain('BAD_REQUEST: Instructions rejected');
    expect(document.activeElement).toBe(alert);
    expect(field('Description').value).toBe('New description');
    expect(field('Prompt').value).toBe('New prompt');
  });

  it('reports the metadata-saved token reload failure and keeps the draft', async () => {
    const user = userEvent.setup();
    const described = role({ description: 'New description' });
    const updateRole = vi.fn(async () => mutation(described, NEXT_SHA));
    const updateRoleInstructions = vi.fn();
    const reload = vi.fn(async () => fail('INTERNAL', 'offline'));
    setup({ updateRole, updateRoleInstructions, reload });
    await user.click(editButton());
    await user.clear(field('Description'));
    await user.type(field('Description'), 'New description');
    await user.clear(field('Prompt'));
    await user.type(field('Prompt'), 'New prompt');
    await user.click(saveButton());
    await flush();
    const dialog = screen.getByRole('dialog', { name: 'Edit TeamLead instructions' });
    const alert = within(dialog).getByRole('alert');
    expect(alert.textContent).toContain(TOKENS_MESSAGE);
    expect(alert.textContent).toContain('INTERNAL: offline');
    expect(document.activeElement).toBe(alert);
    expect(updateRole).toHaveBeenCalledWith('ws-a', 'TeamLead', { description: 'New description' }, SHA);
    expect(updateRoleInstructions).not.toHaveBeenCalled();
    expect(field('Description').value).toBe('New description');
    expect(field('Prompt').value).toBe('New prompt');
  });

  it('keeps the dialog open with the error when the description write fails', async () => {
    const user = userEvent.setup();
    const updateRole = vi.fn(async () => fail('BAD_REQUEST', 'Description rejected'));
    const updateRoleInstructions = vi.fn();
    const reload = vi.fn(async () => ok(catalog(role())));
    setup({ updateRole, updateRoleInstructions, reload });
    await user.click(editButton());
    await user.clear(field('Description'));
    await user.type(field('Description'), 'New description');
    await user.click(saveButton());
    await flush();
    const dialog = screen.getByRole('dialog', { name: 'Edit TeamLead instructions' });
    const alert = within(dialog).getByRole('alert');
    expect(alert.textContent).toContain('BAD_REQUEST: Description rejected');
    expect(alert.textContent).not.toContain(INSTRUCTIONS_MESSAGE);
    expect(document.activeElement).toBe(alert);
    expect(field('Description').value).toBe('New description');
    expect(updateRoleInstructions).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('shows the existing conflict message and reloads current values while keeping the draft', async () => {
    const user = userEvent.setup();
    const server = role({ description: 'Server description', instructions: { ...role().instructions, text: 'Server prompt', sha256: FINAL_SHA } });
    const updateRole = vi.fn(async () => fail('CONFIG_CHANGED', 'changed'));
    const reload = vi.fn(async () => ok(catalog(server, NEXT_SHA)));
    setup({ updateRole, reload });
    await user.click(editButton());
    await user.clear(field('Description'));
    await user.type(field('Description'), 'My draft');
    await user.click(saveButton());
    await flush();
    const dialog = screen.getByRole('dialog', { name: 'Edit TeamLead instructions' });
    expect(dialog.textContent).toContain(CONFLICT_MESSAGE);
    await user.click(within(dialog).getByRole('button', { name: 'Reload and review' }));
    await waitFor(() => expect(within(dialog).getByText('Current role values were reloaded. Review the draft, then save again.')).toBeTruthy());
    expect(field('Description').value).toBe('My draft');
    expect(within(dialog).queryByRole('alert')).toBeNull();
  });

  it('shows the conflict message when only the prompt changed on disk', async () => {
    const user = userEvent.setup();
    const updateRoleInstructions = vi.fn(async () => fail('CONFIG_CHANGED', 'changed'));
    const updateRole = vi.fn();
    const reload = vi.fn(async () => ok(catalog(role())));
    setup({ updateRole, updateRoleInstructions, reload });
    await user.click(editButton());
    await user.clear(field('Prompt'));
    await user.type(field('Prompt'), 'My draft prompt');
    await user.click(saveButton());
    await flush();
    const dialog = screen.getByRole('dialog', { name: 'Edit TeamLead instructions' });
    expect(dialog.textContent).toContain(CONFLICT_MESSAGE);
    expect(within(dialog).getByRole('button', { name: 'Reload and review' })).toBeTruthy();
    expect(updateRole).not.toHaveBeenCalled();
    expect(field('Prompt').value).toBe('My draft prompt');
  });

  it('reports a failed catalog reload after a conflict and keeps the draft', async () => {
    const user = userEvent.setup();
    const updateRole = vi.fn(async () => fail('CONFIG_CHANGED', 'changed'));
    const reload = vi.fn(async () => fail('INTERNAL', 'offline'));
    setup({ updateRole, reload });
    await user.click(editButton());
    await user.clear(field('Description'));
    await user.type(field('Description'), 'My draft');
    await user.click(saveButton());
    await flush();
    const dialog = screen.getByRole('dialog', { name: 'Edit TeamLead instructions' });
    await user.click(within(dialog).getByRole('button', { name: 'Reload and review' }));
    await waitFor(() => expect(within(dialog).getByText('Reload failed: INTERNAL: offline')).toBeTruthy());
    expect(field('Description').value).toBe('My draft');
    expect(within(dialog).queryByText('Current role values were reloaded. Review the draft, then save again.')).toBeNull();
  });

  it('discards the draft on Cancel and Escape', async () => {
    const user = userEvent.setup();
    const updateRole = vi.fn();
    const reload = vi.fn(async () => ok(catalog(role())));
    setup({ updateRole, reload });
    await user.click(editButton());
    await user.clear(field('Description'));
    await user.type(field('Description'), 'Discard me');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(updateRole).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(editButton());
    await user.click(editButton());
    expect(field('Description').value).toBe('Old description');
    await user.clear(field('Description'));
    await user.type(field('Description'), 'Escape me');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(editButton());
    expect(updateRole).not.toHaveBeenCalled();
  });

  it('shows Saving... on the primary button and keeps the dialog busy', async () => {
    const user = userEvent.setup();
    const gate = deferred<ReturnType<typeof mutation>>();
    const updateRole = vi.fn(() => gate.promise);
    const described = role({ description: 'New description' });
    const reload = vi.fn(async () => ok(catalog(described, NEXT_SHA)));
    setup({ updateRole, reload });
    await user.click(editButton());
    await user.clear(field('Description'));
    await user.type(field('Description'), 'New description');
    await user.click(saveButton());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Saving...' })).toBeTruthy());
    expect((screen.getByRole('button', { name: 'Saving...' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { gate.resolve(mutation(described, NEXT_SHA)); });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('role_page_dialog_counts_utf8_bytes_against_the_16_kib_limit', () => {
    const r = role();
    const fake = fakeManagement();
    render(<RolePageInstructionsDialog
      role={r}
      catalogSha={SHA}
      management={fake.api}
      workspaceId="ws-a"
      reload={vi.fn(async () => ok(catalog(r)))}
      onSaved={vi.fn()}
      onCancel={vi.fn()}
    />);
    const dialog = screen.getByRole('dialog', { name: 'Edit TeamLead instructions' });
    expect(within(dialog).getByText('1 lines · 10 / 16,384 bytes')).toBeTruthy();
    const prompt = within(dialog).getByLabelText('Instructions') as HTMLTextAreaElement;
    fireEvent.change(prompt, { target: { value: '€'.repeat(5462) } });
    expect(within(dialog).getByText('Too long: 16,386 / 16,384 bytes.')).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'Save to file' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('role_page_mode_hides_the_description_and_uses_the_instructions_label', () => {
    const r = role();
    render(<RoleInstructionsDialog
      role={r}
      pending={false}
      error={null}
      partialNotice={null}
      showDescription={false}
      promptLabel="Instructions"
      promptRows={16}
      onSave={vi.fn()}
      onReload={vi.fn(async () => ok(catalog(r)))}
      onClearError={vi.fn()}
      onSaved={vi.fn()}
      onCancel={vi.fn()}
    />);
    const dialog = screen.getByRole('dialog', { name: 'Edit TeamLead instructions' });
    expect(within(dialog).queryByLabelText('Description')).toBeNull();
    expect((within(dialog).getByLabelText('Instructions') as HTMLTextAreaElement).rows).toBe(16);
    expect(document.activeElement).toBe(within(dialog).getByLabelText('Instructions'));
    expect(dialog.querySelector('.dialog-footer-note')!.textContent).toBe('Takes effect on the next assignment');
  });

  it('explains_a_missing_or_absent_file_and_refuses_to_save_over_a_truncated_file', () => {
    const missing = role({ instructions: { state: 'missing', path: '.agent-studio/roles/team-lead.md', text: null, sha256: null, bytes: null } });
    const view = render(<RoleInstructionsDialog
      role={missing}
      pending={false}
      error={null}
      partialNotice={null}
      showDescription={false}
      promptLabel="Instructions"
      onSave={vi.fn()}
      onReload={vi.fn(async () => ok(catalog(missing)))}
      onClearError={vi.fn()}
      onSaved={vi.fn()}
      onCancel={vi.fn()}
    />);
    expect(screen.getByText('The configured instruction file is missing. Saving instructions creates it again.')).toBeTruthy();
    expect((screen.getByLabelText('Instructions') as HTMLTextAreaElement).disabled).toBe(false);
    view.unmount();

    const truncated = role({ instructions: { state: 'truncated', path: '.agent-studio/roles/team-lead.md', text: 'partial', sha256: FINAL_SHA, bytes: 99999 } });
    render(<RoleInstructionsDialog
      role={truncated}
      pending={false}
      error={null}
      partialNotice={null}
      showDescription={false}
      promptLabel="Instructions"
      onSave={vi.fn()}
      onReload={vi.fn(async () => ok(catalog(truncated)))}
      onClearError={vi.fn()}
      onSaved={vi.fn()}
      onCancel={vi.fn()}
    />);
    expect(screen.getByText('Shared instructions were not fully read, so this role cannot be saved here. Reload the catalog to try again.')).toBeTruthy();
    expect((screen.getByLabelText('Instructions') as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Save to file' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
