// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ManagementError, Workspace } from '../src/renderer/api';
import { RoleDeleteDialog } from '../src/renderer/roles/RoleDeleteDialog';
import { RolesScreen } from '../src/renderer/roles/RolesScreen';
import { instructionDeleteDescription, roleDeleteDisabledReason, roleUsageFromDeleteError, roleUsageProblemsFromDeleteError, selectionAfterRoleDeletion } from '../src/renderer/roles/rolesModel';
import type { RoleCatalogItem, RoleCatalogList } from '../src/shared/management';
import { fakeManagement } from './teamsFixtures';
import { roleItem, rolesFixture, usageOf } from './rolesFixtures';

afterEach(cleanup);
const workspace: Workspace = { id: 'a', name: 'A', path: '/a', exists: true, missing: false };
const SHA = 'c'.repeat(64);
const ISHA = 'd'.repeat(64);
const REFRESH_FAILED = 'Role was deleted, but Roles could not be refreshed. Retry Roles before making another change.';

function role(id: string, over: Record<string, unknown> = {}): RoleCatalogItem {
  return roleItem(id, { name: id, instructions: { state: 'ok', path: `.agent-studio/roles/${id}.md`, text: 'x', sha256: ISHA, bytes: 1 }, ...over });
}
function catalog(items: RoleCatalogItem[], sha = SHA): RoleCatalogList {
  return rolesFixture({ items, sha256: sha });
}
const okDeleted = (instructions = 'deleted') => ({ ok: true as const, data: { workspace: '/work/a', sha256: SHA, deleted: { id: 'x', instructions } } });
const fail = (code: string, data?: unknown): { ok: false; error: ManagementError } => ({ ok: false, error: { code, message: `${code} message`, retryable: false, ...(data ? { data } : {}) } });

function setup(catalogs: Array<RoleCatalogList | ManagementError>, deleteRole = vi.fn(async () => okDeleted())) {
  let n = 0;
  const roles = vi.fn(async (_id: string) => {
    const next = catalogs[Math.min(n++, catalogs.length - 1)]!;
    return 'items' in next ? { ok: true as const, data: next } : { ok: false as const, error: next };
  });
  const fake = fakeManagement({ calls: { roles, deleteRole } });
  const view = render(<main><RolesScreen workspace={workspace} management={fake.api} /></main>);
  return { view, roles, deleteRole };
}
type View = ReturnType<typeof render>;
const trigger = (v: View) => within(v.getByRole('region', { name: 'Role details' })).getByRole('button', { name: 'Delete role' });
const confirm = (v: View) => within(v.getByRole('dialog')).getByRole('button', { name: 'Delete role' });
const pick = (v: View, id: string) => fireEvent.click([...within(v.getByRole('list', { name: 'Saved roles' })).getAllByRole('button')].find(b => b.lastElementChild!.textContent === id)!);
const ids = (v: View) => within(v.getByRole('list', { name: 'Saved roles' })).getAllByRole('listitem').map(li => li.querySelector('strong')!.textContent);

describe('role delete model', () => {
  it('delete_is_enabled_only_for_complete_unused_role_with_required_tokens', () => {
    const base: { catalogSha256: string | null; disconnected: boolean; mutationPending: boolean; refreshRequired: boolean } = { catalogSha256: SHA, disconnected: false, mutationPending: false, refreshRequired: false };
    const reason = (r: RoleCatalogItem, over: Partial<typeof base> = {}) => roleDeleteDisabledReason({ role: r, ...base, ...over });
    expect(reason(role('a'))).toBeNull();
    expect(reason(roleItem('n'))).toBeNull();
    expect(reason(roleItem('m', { instructions: { state: 'missing', path: '.agent-studio/roles/m.md', text: null, sha256: null, bytes: null } }))).toBeNull();
    expect(reason(role('a', { usage: usageOf({ blocking: true, count: 1 }) }))).toMatch(/still referenced/);
    expect(reason(role('a', { usage: usageOf({ partial: true }) }))).toMatch(/could not be checked completely/);
    expect(reason(role('a'), { catalogSha256: null })).toMatch(/no version token/);
    expect(reason(role('a', { instructions: { state: 'ok', path: 'p', text: '', sha256: null, bytes: 0 } }))).toMatch(/no version token/);
    for (const state of ['invalid', 'truncated']) expect(reason(role('a', { instructions: { state, path: 'p', text: null, sha256: ISHA, bytes: 0 } }))).toMatch(/invalid or truncated/);
    expect(reason(role('a'), { disconnected: true })).toMatch(/connection/);
    expect(reason(role('a'), { mutationPending: true })).toMatch(/in progress/);
    expect(reason(role('a'), { refreshRequired: true })).toMatch(/Retry Roles/);
  });

  it('selection_after_deletion_prefers_next_then_previous_then_first', () => {
    expect(selectionAfterRoleDeletion(['a', 'b', 'c'], ['a', 'c'], 'b')).toBe('c');
    expect(selectionAfterRoleDeletion(['a', 'b', 'c'], ['a', 'b'], 'c')).toBe('b');
    expect(selectionAfterRoleDeletion(['a', 'b'], ['x'], 'b')).toBe('x');
    expect(selectionAfterRoleDeletion(['a'], [], 'a')).toBeNull();
  });

  it('error_parsers_ignore_malformed_data', () => {
    const e = (code: string, data: unknown): ManagementError => ({ code, message: 'm', retryable: false, data });
    expect(roleUsageFromDeleteError(e('ROLE_IN_USE', 'junk'))).toBeNull();
    expect(roleUsageFromDeleteError(e('ROLE_IN_USE', { usage: { members: [1, null] } }))).toBeNull();
    expect(roleUsageProblemsFromDeleteError(e('ROLE_USAGE_UNAVAILABLE', { usage: { problems: [{ source: 's', message: 'boom' }, 7] } }))).toEqual([{ source: 's', message: 'boom' }]);
  });
});

describe('RoleDeleteDialog', () => {
  const props = (over: Record<string, unknown> = {}) => ({ role: role('dev'), pending: false, blockedReason: null, onCancel: vi.fn(), onConfirm: vi.fn(), ...over });

  it('dialog_names_role_and_exact_instruction_disposition', () => {
    const r = role('dev', { name: ' Developer ' });
    expect(instructionDeleteDescription(r)).toBe('The role entry and its instruction file .agent-studio/roles/dev.md will be removed.');
    expect(instructionDeleteDescription(role('dev', { instructions: { state: 'ok', path: '.agent-studio/roles/custom.md', text: '', sha256: ISHA, bytes: 0 } }))).toMatch(/custom file and will be preserved/);
    expect(instructionDeleteDescription(r, true)).toMatch(/shared with another role and will be preserved/);
    expect(instructionDeleteDescription(role('dev', { instructions: { state: 'missing', path: '.agent-studio/roles/dev.md', text: null, sha256: null, bytes: null } }))).toMatch(/already missing, so no file cleanup/);
    expect(instructionDeleteDescription(roleItem('dev'))).toMatch(/No instruction file is configured/);
    const view = render(<RoleDeleteDialog {...props({ role: r })} />);
    const dialog = within(view.getByRole('dialog', { name: 'Delete role' }));
    expect(dialog.getByText(/Developer/)).toBeTruthy();
    expect(dialog.getByText('dev')).toBeTruthy();
    expect(view.container.textContent).not.toMatch(/\/home|\/work|C:\\/);
    expect(view.queryByRole('button', { name: /force|rewrite|migrate|repair|reassign/i })).toBeNull();
  });

  it('cancel_and_escape_make_no_call_and_restore_delete_focus', () => {
    const p = props();
    const view = render(<><button>opener</button><RoleDeleteDialog {...p} /></>);
    const cancel = view.getByRole('button', { name: 'Cancel' });
    expect(document.activeElement).toBe(cancel);
    const del = view.getByRole('button', { name: 'Delete role' });
    del.focus();
    fireEvent.keyDown(del, { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(del);
    fireEvent.keyDown(del, { key: 'Escape' });
    fireEvent.click(cancel);
    expect(p.onCancel).toHaveBeenCalledTimes(2);
    expect(p.onConfirm).not.toHaveBeenCalled();
    view.rerender(<RoleDeleteDialog {...props({ pending: true, onCancel: p.onCancel })} />);
    fireEvent.keyDown(view.getByRole('dialog'), { key: 'Escape' });
    expect(p.onCancel).toHaveBeenCalledTimes(2);
    expect((view.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
    expect(view.getByRole('button', { name: 'Delete role' }).getAttribute('aria-busy')).toBe('true');
  });
});

describe('RolesScreen delete flow', () => {
  it('confirm_forwards_snapshot_tokens_once_and_blocks_repeated_submit', async () => {
    let release!: (v: ReturnType<typeof okDeleted>) => void;
    const deleteRole = vi.fn(() => new Promise<ReturnType<typeof okDeleted>>(r => { release = r; }));
    const { view } = setup([catalog([role('a'), role('b')]), catalog([role('b')])], deleteRole as never);
    await view.findByRole('list', { name: 'Saved roles' });
    fireEvent.click(trigger(view));
    const button = confirm(view);
    fireEvent.click(button); fireEvent.click(button); fireEvent.keyDown(button, { key: 'Enter' });
    expect(deleteRole).toHaveBeenCalledTimes(1);
    expect(deleteRole).toHaveBeenCalledWith('a', 'a', { expectedRolesSha256: SHA, expectedInstructionsSha256: ISHA });
    expect(ids(view)).toEqual(['a', 'b']);
    release(okDeleted());
    await waitFor(() => expect(ids(view)).toEqual(['b']));
    expect(deleteRole).toHaveBeenCalledTimes(1);
  });

  it('changed_tokens_disable_stale_open_confirmation_without_calling_backend', async () => {
    const { view, roles, deleteRole } = setup([catalog([role('a'), role('b')])]);
    await view.findByRole('list', { name: 'Saved roles' });
    fireEvent.click(trigger(view));
    expect((confirm(view) as HTMLButtonElement).disabled).toBe(false);
    pick(view, 'b');
    expect((confirm(view) as HTMLButtonElement).disabled).toBe(true);
    expect(view.getByText('Role data changed. Close and reopen Delete to confirm the latest version.')).toBeTruthy();
    fireEvent.click(confirm(view));
    expect(deleteRole).not.toHaveBeenCalled();
    expect(roles).toHaveBeenCalledTimes(1);
  });

  it('cancel_closes_without_call_and_restores_trigger_focus', async () => {
    const { view, deleteRole } = setup([catalog([role('a')])]);
    await view.findByRole('list', { name: 'Saved roles' });
    trigger(view).focus();
    fireEvent.click(trigger(view));
    fireEvent.keyDown(view.getByRole('dialog'), { key: 'Escape' });
    expect(view.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger(view));
    expect(deleteRole).not.toHaveBeenCalled();
  });

  it('blocked_roles_open_no_dialog_and_explain_why_while_browsing_continues', async () => {
    const { view, deleteRole } = setup([catalog([role('a', { usage: usageOf({ blocking: true, count: 1 }) }), role('b')])]);
    await view.findByRole('list', { name: 'Saved roles' });
    fireEvent.click(trigger(view));
    expect(view.queryByRole('dialog')).toBeNull();
    expect(trigger(view).getAttribute('aria-describedby')).toBe('roles-delete-reason');
    expect(view.getByText(/still referenced/)).toBeTruthy();
    pick(view, 'b');
    expect(view.queryByText(/still referenced/)).toBeNull();
    expect(deleteRole).not.toHaveBeenCalled();
  });

  it('role_in_use_overrides_stale_unused_ui_and_renders_all_reference_groups', async () => {
    const long = 'L'.repeat(400);
    const usage = {
      members: [{ teamDefId: 'core', teamName: 'Core', memberId: 'dev-1', memberName: 'Dev', saved: true, live: null }],
      boardRules: [{ index: 0, status: 'todo' }], workflows: [{ name: 'first', stageId: 'work' }],
      legacyRoster: [{ memberIndex: 0, memberName: long }], liveRuntime: [{ teamId: 'live', memberId: 'm1', availability: 'busy', assignmentId: 'as-1' }], count: 5,
    };
    const deleteRole = vi.fn(async () => fail('ROLE_IN_USE', { roleId: 'a', usage }));
    const { view } = setup([catalog([role('a')])], deleteRole as never);
    await view.findByRole('list', { name: 'Saved roles' });
    trigger(view).focus();
    fireEvent.click(trigger(view));
    fireEvent.click(confirm(view));
    const alert = await view.findByRole('alert');
    expect(view.queryByRole('dialog')).toBeNull();
    const titles = [...alert.querySelectorAll('h4')].map(h => h.textContent);
    expect(titles).toEqual(['Team members', 'Board rules', 'Workflow stages', 'Legacy roster', 'Live runtime']);
    expect(alert.textContent).toMatch(/Core \(core\) — Dev \(dev-1\)/);
    expect(alert.textContent).toMatch(/Rule 1 \(status todo\)/);
    expect(alert.textContent).toMatch(/first — stage work/);
    expect(alert.textContent).toMatch(/assignment as-1/);
    expect(alert.textContent).not.toContain(long);
    expect(within(alert).queryByRole('button')).toBeNull();
    expect(view.queryByRole('button', { name: /force|rewrite|migrate|repair/i })).toBeNull();
    expect(document.activeElement).toBe(trigger(view));
    expect(ids(view)).toEqual(['a']);
  });

  it('usage_unavailable_and_config_changed_require_retry_or_reload', async () => {
    const results = [
      fail('ROLE_USAGE_UNAVAILABLE', { usage: { problems: [{ source: 'runtime', path: '', message: 'State database unavailable' }] } }),
      fail('CONFIG_CHANGED', { rolesSha256: 'x' }),
    ];
    let i = 0;
    const deleteRole = vi.fn(async () => results[i++]!);
    const { view } = setup([catalog([role('a')])], deleteRole as never);
    await view.findByRole('list', { name: 'Saved roles' });
    fireEvent.click(trigger(view));
    fireEvent.click(confirm(view));
    const alert = await view.findByRole('alert');
    expect(alert.textContent).toMatch(/retry the scan and confirm again/);
    expect(alert.textContent).toMatch(/runtime: State database unavailable/);
    fireEvent.click(trigger(view));
    fireEvent.click(confirm(view));
    await waitFor(() => expect(view.getByRole('alert').textContent).toMatch(/Reload Roles and confirm again/));
    expect(deleteRole).toHaveBeenCalledTimes(2);
  });

  it('successful_delete_waits_for_reload_then_selects_next_visible_role', async () => {
    const cases: Array<[string, string]> = [['deleted', 'instruction file was deleted'], ['preserved', 'custom or shared instruction file was preserved'], ['missing', 'already missing'], ['none', 'No instruction file was configured']];
    for (const [disposition, copy] of cases) {
      cleanup();
      const deleteRole = vi.fn(async () => okDeleted(disposition));
      const { view } = setup([catalog([role('a'), role('b'), role('c')]), catalog([role('a'), role('c')])], deleteRole as never);
      await view.findByRole('list', { name: 'Saved roles' });
      pick(view, 'b');
      fireEvent.click(trigger(view));
      fireEvent.click(confirm(view));
      await waitFor(() => expect(ids(view)).toEqual(['a', 'c']));
      expect(within(view.getByRole('region', { name: 'Role details' })).getAllByRole('heading', { level: 3 })[0].textContent).toBe('c');
      expect(view.getByRole('status').textContent).toContain(copy);
      expect(view.queryByRole('dialog')).toBeNull();
    }
  });

  it('last_visible_role_falls_back_to_previous_under_current_filter', async () => {
    const { view } = setup([catalog([role('a1'), role('a2'), role('b')]), catalog([role('a1'), role('b')])]);
    await view.findByRole('list', { name: 'Saved roles' });
    fireEvent.change(view.getByLabelText('Search roles'), { target: { value: 'a' } });
    pick(view, 'a2');
    fireEvent.click(trigger(view));
    fireEvent.click(confirm(view));
    await waitFor(() => expect(ids(view)).toEqual(['a1']));
    expect(within(view.getByRole('region', { name: 'Role details' })).getAllByRole('heading', { level: 3 })[0].textContent).toBe('a1');
  });

  it('deleting_final_role_renders_catalog_empty_state', async () => {
    const { view } = setup([catalog([role('a')]), catalog([])]);
    await view.findByRole('list', { name: 'Saved roles' });
    fireEvent.click(trigger(view));
    fireEvent.click(confirm(view));
    await view.findByText('No roles are configured yet.');
    expect(view.queryByRole('region', { name: 'Role details' })).toBeNull();
    expect(view.queryByRole('dialog')).toBeNull();
    expect(view.getByRole('status').textContent).toMatch(/Role a was deleted/);
  });

  it('committed_delete_with_failed_reload_blocks_mutations_until_retry_succeeds', async () => {
    const { view, deleteRole } = setup([catalog([role('a'), role('b')]), { code: 'BACKEND_UNAVAILABLE', message: 'down', retryable: true }, catalog([role('b')])]);
    await view.findByRole('list', { name: 'Saved roles' });
    fireEvent.click(trigger(view));
    fireEvent.click(confirm(view));
    await waitFor(() => expect(view.getByText(REFRESH_FAILED)).toBeTruthy());
    expect(view.queryByRole('dialog')).toBeNull();
    expect(ids(view)).toEqual(['a', 'b']);
    fireEvent.click(trigger(view));
    expect(view.queryByRole('dialog')).toBeNull();
    expect(trigger(view).getAttribute('aria-describedby')).toBe('roles-delete-reason');
    expect(deleteRole).toHaveBeenCalledTimes(1);
    fireEvent.click(view.getByRole('button', { name: 'Retry loading roles' }));
    await waitFor(() => expect(ids(view)).toEqual(['b']));
    await waitFor(() => expect(view.queryByText(REFRESH_FAILED)).toBeNull());
    expect(view.getByRole('status').textContent).toMatch(/Role a was deleted/);
    expect(deleteRole).toHaveBeenCalledTimes(1);
    fireEvent.click(trigger(view));
    expect(view.getByRole('dialog')).toBeTruthy();
  });

  it('late_delete_or_reload_result_from_previous_workspace_is_ignored', async () => {
    let release!: (v: ReturnType<typeof okDeleted>) => void;
    const deleteRole = vi.fn(() => new Promise<ReturnType<typeof okDeleted>>(r => { release = r; }));
    const roles = vi.fn(async (id: string) => ({ ok: true as const, data: catalog(id === 'a' ? [role('a'), role('x')] : [role('p'), role('q')]) }));
    const fake = fakeManagement({ calls: { roles, deleteRole } });
    const view = render(<main><RolesScreen workspace={workspace} management={fake.api} /></main>);
    await view.findByRole('list', { name: 'Saved roles' });
    fireEvent.click(trigger(view));
    fireEvent.click(confirm(view));
    view.rerender(<main><RolesScreen workspace={{ ...workspace, id: 'b' }} management={fake.api} /></main>);
    await waitFor(() => expect(ids(view)).toEqual(['p', 'q']));
    await act(async () => { release(okDeleted()); });
    expect(ids(view)).toEqual(['p', 'q']);
    expect(view.queryByRole('status')).toBeNull();
    expect(view.queryByRole('alert')).toBeNull();
    expect(roles).toHaveBeenCalledTimes(2);
  });

  it('delete_dialog_and_blockers_fit_narrow_layout_and_wrap_long_values', () => {
    const css = readFileSync(resolve(__dirname, '../src/renderer/styles.css'), 'utf8').replace(/\s+/g, ' ');
    expect(css).toMatch(/\.roles-delete-dialog \{ max-width: min\(520px, calc\(100vw - 32px\)\)/);
    expect(css).toMatch(/\.roles-delete-reason, \.roles-delete-copy, \.roles-delete-name \{ min-width: 0; overflow-wrap: anywhere/);
    expect(css).toMatch(/@media \(max-width: 560px\) \{ \.roles-delete-actions \{ flex-direction: column-reverse; align-items: stretch; \}/);
    expect(css).toMatch(/\.roles-delete-alert, \.roles-delete-group, \.roles-delete-dialog, [^{]*\{ min-width: 0; overflow-wrap: anywhere/);
  });
});
