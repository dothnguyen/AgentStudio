// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionStatus, Workspace } from '../src/renderer/api';
import { RolesScreen } from '../src/renderer/roles/RolesScreen';
import type { RoleCatalogList } from '../src/shared/management';
import { fakeManagement } from './teamsFixtures';
import { LONG_ID, LONG_PATH, MEMBERS, roleItem, rolesFixture, usageOf } from './rolesFixtures';

afterEach(cleanup);
const workspace: Workspace = { id: 'a', name: 'A', path: '/a', exists: true, missing: false };
const ok = (data: RoleCatalogList) => ({ ok: true as const, data });

function setup(data: RoleCatalogList = rolesFixture(), connection?: ConnectionStatus, requestedRoleId: string | null = null) {
  const roles = vi.fn(async (_id: string) => ok(data));
  const fake = fakeManagement({ calls: { roles } });
  const view = render(<main><RolesScreen workspace={workspace} management={fake.api} connection={connection} requestedRoleId={requestedRoleId} /></main>);
  return { view, roles, fake };
}
const roleList = (view: ReturnType<typeof render>) => view.getByRole('list', { name: 'Saved roles' });
const rowById = (view: ReturnType<typeof render>, id: string) => within(roleList(view)).getAllByRole('button').find(b => b.getAttribute('data-role-id') === id)!;
const details = (view: ReturnType<typeof render>) => within(view.getByRole('region', { name: 'Role details' }));
const openRow = (view: ReturnType<typeof render>, id: string) => fireEvent.click(rowById(view, id));
const backToRoles = (view: ReturnType<typeof render>) => fireEvent.click(view.getByRole('button', { name: 'Roles' }));
async function showRole(view: ReturnType<typeof render>, id: string) {
  if (view.queryByRole('button', { name: 'Roles' })) backToRoles(view);
  await view.findByRole('list', { name: 'Saved roles' });
  openRow(view, id);
  await view.findByRole('region', { name: 'Role details' });
}

describe('RolesScreen', () => {
  it('loads_roles_once_and_renders_the_full_width_table_header', async () => {
    const { view, roles, fake } = setup();
    expect(view.getByText('Loading roles…').getAttribute('role')).toBe('status');
    await view.findByRole('list', { name: 'Saved roles' });
    expect(roles).toHaveBeenCalledTimes(1);
    expect(roles).toHaveBeenCalledWith('a');
    expect(fake.overview).not.toHaveBeenCalled();
    expect(within(view.getByRole('main')).getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(view.getByRole('heading', { level: 1 }).textContent).toBe('Roles');
    expect(view.getByText('Shared descriptions, instructions and skills. Every member with a role uses it.')).toBeTruthy();
    expect(view.getByText('Saved changes apply to new assignments. Assignments already running keep the instructions they started with.')).toBeTruthy();
    expect(view.getByRole('button', { name: 'New role' })).toBeTruthy();
    expect(view.getByText('5 roles')).toBeTruthy();
    expect(view.container.querySelector('.roles-layout')).toBeNull();
    expect(view.queryAllByRole('alert')).toHaveLength(0);
  });

  it('search_filters_in_order_and_distinguishes_missing_empty_and_no_match', async () => {
    const { view } = setup();
    await view.findByRole('list', { name: 'Saved roles' });
    const ids = () => within(roleList(view)).getAllByRole('button').map(b => b.getAttribute('data-role-id'));
    expect(ids()).toEqual(['Developer', 'Reviewer', 'Planner', 'Writer', LONG_ID]);
    fireEvent.change(view.getByLabelText('Search roles'), { target: { value: ' WRITER ' } });
    expect(ids()).toEqual(['Writer']);
    expect(view.getByText('1 of 5 roles')).toBeTruthy();
    fireEvent.change(view.getByLabelText('Search roles'), { target: { value: 'zzz' } });
    expect(view.getByText(/No role matches this search\./)).toBeTruthy();
    expect(view.queryByRole('region', { name: 'Role details' })).toBeNull();
    expect(view.queryByText('No roles are configured yet.')).toBeNull();
    expect(view.getByText('0 of 5 roles')).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: 'Clear search' }));
    expect((view.getByLabelText('Search roles') as HTMLInputElement).value).toBe('');
    expect(document.activeElement).toBe(view.getByLabelText('Search roles'));
    expect(ids()).toHaveLength(5);
    expect(view.getByText('5 roles')).toBeTruthy();
    view.unmount();

    const missing = setup(rolesFixture({ state: 'missing', sha256: null, items: [] }));
    expect(await missing.view.findByText('No roles catalog is configured for this workspace.')).toBeTruthy();
    expect(missing.view.queryByText('No roles are configured yet.')).toBeNull();
    cleanup();
    const empty = setup(rolesFixture({ items: [] }));
    expect(await empty.view.findByText('No roles are configured yet.')).toBeTruthy();
    expect(empty.view.getByText('Use New role to create one.')).toBeTruthy();
    expect(empty.view.queryByText(/No role matches/)).toBeNull();
    expect(empty.view.queryByRole('list', { name: 'Saved roles' })).toBeNull();
  });

  it('table_rows_show_role_description_skills_usage_and_placeholder_cells', async () => {
    const full = roleItem('full', {
      name: 'Full Role', description: 'Does the important work',
      instructions: { state: 'ok', path: '.agent-studio/roles/full.md', text: 'x', sha256: 'e'.repeat(64), bytes: 1 },
      skills: [{ id: 'python-testing', state: 'ok' }, { id: 'retired-skill', state: 'missing' }, { id: 'code-search', state: 'ok' }],
      usage: usageOf({}, [{ teamDefId: 'core', teamName: 'Core', memberId: 'dev-1', memberName: 'Dev', saved: { path: 'teams.json', memberIndex: 0 }, live: { availability: 'available', assignment: { id: 'a-1', status: 'running' } } }]),
    });
    const bare = roleItem('bare', { name: 'Bare', description: null, instructions: { state: 'none', path: null, text: null, sha256: null, bytes: null }, skills: [] });
    const { view } = setup(rolesFixture({ items: [full, bare] }));
    await view.findByRole('list', { name: 'Saved roles' });

    const head = view.container.querySelector('.roles-table-head')!;
    expect([...head.children].map(cell => cell.textContent)).toEqual(['Role', 'Description', 'Skills', 'Used by', '']);
    const columns = view.container.querySelector('#roles-table-columns')!;
    expect(columns.className).toBe('roles-visually-hidden');
    expect(columns.textContent).toBe('Columns: Role, Description, Skills, Used by.');

    const fullRow = rowById(view, 'full');
    expect(fullRow.tagName).toBe('BUTTON');
    expect(fullRow.getAttribute('type')).toBe('button');
    expect(fullRow.getAttribute('aria-label')).toBe('Open role Full Role');
    expect(fullRow.getAttribute('aria-describedby')).toBe('roles-table-columns');
    expect(fullRow.querySelectorAll('button, a, input, select, textarea').length).toBe(0);
    expect(fullRow.children).toHaveLength(5);
    expect(fullRow.textContent).toContain('FR');
    expect(fullRow.textContent).toContain('Full Role');
    expect(fullRow.textContent).toContain('.agent-studio/roles/full.md');
    expect(fullRow.textContent).toContain('Does the important work');
    expect(within(fullRow).getByText('python-testing')).toBeTruthy();
    const missing = fullRow.querySelector('.roles-skill-chip-missing')!;
    expect(missing.textContent).toBe('retired-skill missing');
    expect(within(fullRow).getByText('+1')).toBeTruthy();
    expect(within(fullRow).getByText('1 member')).toBeTruthy();
    expect(within(fullRow).getByText('1 running')).toBeTruthy();
    expect(within(fullRow).queryByText('code-search')).toBeNull();
    const chevron = fullRow.lastElementChild!;
    expect(chevron.classList.contains('roles-chevron')).toBe(true);
    expect(chevron.querySelector('svg')).toBeTruthy();

    const bareRow = rowById(view, 'bare');
    expect(within(bareRow).getByText('No description')).toBeTruthy();
    expect(within(bareRow).getByText('No instruction file')).toBeTruthy();
    expect(within(bareRow).getByText('None')).toBeTruthy();
    expect(within(bareRow).getByText('Unused')).toBeTruthy();
    expect(within(bareRow).getByText('No running assignments')).toBeTruthy();
  });

  it('used_by_never_claims_unused_when_usage_is_partial_or_the_runtime_is_disconnected', async () => {
    const unused = roleItem('unused', { name: 'Unused role' });
    const partial = roleItem('partial', { name: 'Partial role', usage: usageOf({ partial: true, liveRuntime: { state: 'unavailable', error: null }, problems: [{ source: 'runtime', path: '', message: 'State database unavailable' }] }) });
    const disconnected = roleItem('disconnected', { name: 'Disconnected role', usage: usageOf({ liveRuntime: { state: 'disconnected', error: null } }) });
    const partialMember = roleItem('partial-member', { name: 'Partial member role', usage: usageOf({ partial: true, liveRuntime: { state: 'unavailable', error: null } }, [{ teamDefId: 'core', teamName: 'Core', memberId: 'dev-1', memberName: 'Dev', saved: { path: 'teams.json', memberIndex: 0 }, live: null }]) });
    const unknownRuntime = roleItem('unknown-runtime', { name: 'Unknown runtime role', usage: usageOf({ liveRuntime: { state: 'booting', error: null } }) });
    const { view } = setup(rolesFixture({ items: [unused, partial, disconnected, partialMember, unknownRuntime] }));
    await view.findByRole('list', { name: 'Saved roles' });

    expect(within(rowById(view, 'unused')).getByText('Unused')).toBeTruthy();
    expect(within(rowById(view, 'unused')).getByText('No running assignments')).toBeTruthy();

    for (const id of ['partial', 'disconnected', 'unknown-runtime']) {
      const row = rowById(view, id);
      expect(within(row).getByText('Usage incomplete')).toBeTruthy();
      expect(within(row).queryByText('Unused')).toBeNull();
      expect(within(row).queryByText('No running assignments')).toBeNull();
    }
    expect(within(rowById(view, 'partial-member')).getByText('1 member')).toBeTruthy();
    expect(within(rowById(view, 'partial-member')).getByText('Usage incomplete')).toBeTruthy();
    expect(within(rowById(view, 'partial-member')).queryByText('1 running')).toBeNull();
  });

  it('native_rows_open_the_role_page_with_click_enter_and_space_and_have_no_preselection', async () => {
    const { view } = setup();
    await view.findByRole('list', { name: 'Saved roles' });
    const buttons = within(roleList(view)).getAllByRole('button');
    expect(buttons.every(b => b.tagName === 'BUTTON' && b.getAttribute('type') === 'button' && !b.hasAttribute('tabindex'))).toBe(true);
    expect(buttons.every(b => (b.getAttribute('aria-label') ?? '').startsWith('Open role '))).toBe(true);
    expect(buttons.some(b => b.getAttribute('aria-current') === 'true')).toBe(false);

    const user = userEvent.setup();
    await user.click(rowById(view, 'Reviewer'));
    expect(details(view).getByRole('heading', { level: 3, name: 'Code Reviewer' })).toBeTruthy();
    expect(view.getByRole('navigation', { name: 'Breadcrumb' }).textContent).toContain('RolesCode Reviewer');
    expect(view.queryByRole('list', { name: 'Saved roles' })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(view.getByRole('heading', { name: 'Role details' })));
    await user.click(view.getByRole('button', { name: 'Roles' }));
    await view.findByRole('list', { name: 'Saved roles' });

    rowById(view, 'Planner').focus();
    await user.keyboard('{Enter}');
    expect(details(view).getByRole('heading', { level: 3, name: 'Planner' })).toBeTruthy();
    await user.click(view.getByRole('button', { name: 'Roles' }));
    await view.findByRole('list', { name: 'Saved roles' });

    rowById(view, 'Writer').focus();
    await user.keyboard(' ');
    expect(details(view).getByRole('heading', { level: 3, name: 'Writer' })).toBeTruthy();
  });

  it('breadcrumb_returns_to_list_with_the_search_text_and_focus_on_the_opened_row', async () => {
    const items = [roleItem('alpha', { name: 'Alpha', description: 'one' }), roleItem('beta', { name: 'Beta', description: 'two' }), roleItem('gamma', { name: 'Gamma', description: 'three' })];
    const { view } = setup(rolesFixture({ items }));
    await view.findByRole('list', { name: 'Saved roles' });
    fireEvent.change(view.getByLabelText('Search roles'), { target: { value: 'bet' } });
    expect(view.getByText('1 of 3 roles')).toBeTruthy();
    fireEvent.click(rowById(view, 'beta'));
    expect(details(view).getByRole('heading', { level: 3, name: 'Beta' })).toBeTruthy();
    backToRoles(view);
    await waitFor(() => expect(view.getByRole('list', { name: 'Saved roles' })).toBeTruthy());
    expect((view.getByLabelText('Search roles') as HTMLInputElement).value).toBe('bet');
    expect(view.getByText('1 of 3 roles')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(rowById(view, 'beta')));
  });

  it('requested_role_opens_its_page_directly_and_a_missing_request_falls_back_to_the_list', async () => {
    const data = rolesFixture({ items: [roleItem('qa-a', { name: 'QA' }), roleItem('qa-b', { name: 'QA' }), roleItem('dev', { name: 'Dev' })] });
    const fake = fakeManagement({ calls: { roles: vi.fn(async () => ok(data)) } });
    const view = render(<main><RolesScreen workspace={workspace} management={fake.api} requestedRoleId={null} /></main>);
    await view.findByRole('list', { name: 'Saved roles' });
    fireEvent.change(view.getByLabelText('Search roles'), { target: { value: 'dev' } });
    view.rerender(<main><RolesScreen workspace={workspace} management={fake.api} requestedRoleId="qa-b" /></main>);
    await view.findByRole('region', { name: 'Role details' });
    expect(details(view).getByText('qa-b')).toBeTruthy();
    expect(view.queryByText(/is unavailable in this workspace/)).toBeNull();
    expect(view.queryByRole('list', { name: 'Saved roles' })).toBeNull();
    backToRoles(view);
    await view.findByRole('list', { name: 'Saved roles' });
    expect((view.getByLabelText('Search roles') as HTMLInputElement).value).toBe('');
    expect(view.queryByRole('region', { name: 'Role details' })).toBeNull();
    cleanup();

    const missing = render(<main><RolesScreen workspace={workspace} management={fake.api} requestedRoleId="retired" /></main>);
    expect(await missing.findByText('Role "retired" is unavailable in this workspace.')).toBeTruthy();
    expect(within(missing.getByRole('list', { name: 'Saved roles' })).getAllByRole('button')).toHaveLength(3);
    expect(missing.queryByRole('region', { name: 'Role details' })).toBeNull();
    missing.rerender(<main><RolesScreen workspace={workspace} management={fake.api} requestedRoleId={null} /></main>);
    await waitFor(() => expect(missing.queryByText(/is unavailable in this workspace/)).toBeNull());
    expect(missing.getByRole('list', { name: 'Saved roles' })).toBeTruthy();
  });

  it('breadcrumb_from_a_requested_role_returns_to_the_list_and_focuses_that_row', async () => {
    const { view } = setup(rolesFixture(), undefined, 'Writer');
    await view.findByRole('region', { name: 'Role details' });
    expect(details(view).getByRole('heading', { level: 3, name: 'Writer' })).toBeTruthy();
    expect(view.queryByRole('list', { name: 'Saved roles' })).toBeNull();
    backToRoles(view);
    await view.findByRole('list', { name: 'Saved roles' });
    expect((view.getByLabelText('Search roles') as HTMLInputElement).value).toBe('');
    await waitFor(() => expect(document.activeElement).toBe(rowById(view, 'Writer')));
  });

  it('role_page_keeps_the_mutation_reason_associated_with_a_disabled_edit_button', async () => {
    const problems = [{ path: 'roles.json', message: 'unknown field' }];
    const { view } = setup(rolesFixture({ problems }));
    await view.findByRole('list', { name: 'Saved roles' });
    openRow(view, 'Developer');
    const edit = view.getByRole('button', { name: 'Edit role' }) as HTMLButtonElement;
    expect(edit.disabled).toBe(true);
    expect(edit.getAttribute('aria-describedby')).toBe('roles-mutation-reason');
    const reason = document.getElementById('roles-mutation-reason');
    expect(reason).not.toBeNull();
    expect(reason!.textContent).toBe('Role changes are unavailable while the roles catalog has problems.');
    expect(view.getAllByText('Role changes are unavailable while the roles catalog has problems.')).toHaveLength(1);
  });

  it('role_page_keeps_the_mutation_reason_associated_when_the_backend_is_disconnected', async () => {
    const lost = { state: 'lost', error: null, distro: null, command: null } as ConnectionStatus;
    const { view } = setup(rolesFixture(), lost);
    await view.findByRole('list', { name: 'Saved roles' });
    openRow(view, 'Developer');
    const edit = view.getByRole('button', { name: 'Edit role' }) as HTMLButtonElement;
    expect(edit.disabled).toBe(true);
    expect(edit.getAttribute('aria-describedby')).toBe('roles-mutation-reason');
    const reason = document.getElementById('roles-mutation-reason');
    expect(reason).not.toBeNull();
    expect(reason!.textContent).toBe('Role changes are unavailable while the backend is disconnected.');
    expect(view.getAllByText('Role changes are unavailable while the backend is disconnected.')).toHaveLength(1);
    expect(view.queryByRole('button', { name: 'New role' })).toBeNull();
  });

  it('role_page_replaces_the_list_chrome_and_the_breadcrumb_shows_the_display_name', async () => {
    const { view } = setup();
    await view.findByRole('list', { name: 'Saved roles' });
    openRow(view, 'Reviewer');
    expect(view.getByRole('region', { name: 'Role details' })).toBeTruthy();
    expect(view.queryByRole('heading', { level: 1, name: 'Roles' })).toBeNull();
    expect(view.queryByRole('button', { name: 'New role' })).toBeNull();
    expect(view.queryByLabelText('Search roles')).toBeNull();
    expect(view.queryByText('5 roles')).toBeNull();
    expect(view.queryByText('Saved changes apply to new assignments. Assignments already running keep the instructions they started with.')).toBeNull();
    const crumbs = within(view.getByRole('navigation', { name: 'Breadcrumb' })).getAllByRole('listitem');
    expect(crumbs.map(li => li.textContent)).toEqual(['Roles', 'Code Reviewer']);
    expect(crumbs[1].getAttribute('aria-current')).toBe('page');
  });

  it('opening_a_role_by_enter_or_space_moves_focus_to_the_role_page_heading', async () => {
    const { view } = setup();
    await view.findByRole('list', { name: 'Saved roles' });
    const user = userEvent.setup();
    for (const [id, key] of [['Planner', '{Enter}'], ['Writer', ' ']] as const) {
      rowById(view, id).focus();
      await user.keyboard(key);
      await waitFor(() => expect(document.activeElement).toBe(view.getByRole('heading', { name: 'Role details' })));
      expect(details(view).getByText(id, { selector: 'code' })).toBeTruthy();
      backToRoles(view);
      await view.findByRole('list', { name: 'Saved roles' });
    }
  });

  it('count_uses_singular_grammar_for_one_role_and_one_filtered_match', async () => {
    const { view } = setup(rolesFixture({ items: [roleItem('only', { name: 'Only role' })] }));
    await view.findByRole('list', { name: 'Saved roles' });
    expect(view.getByText('1 role')).toBeTruthy();
    fireEvent.change(view.getByLabelText('Search roles'), { target: { value: 'only' } });
    expect(view.getByText('1 of 1 role')).toBeTruthy();
    expect(view.queryByText('1 of 1 roles')).toBeNull();
  });

  it('opening_a_row_clears_a_stale_missing_request_notice', async () => {
    const { view } = setup(rolesFixture({ items: [roleItem('dev', { name: 'Dev' })] }), undefined, 'retired');
    expect(await view.findByText('Role "retired" is unavailable in this workspace.')).toBeTruthy();
    fireEvent.click(rowById(view, 'dev'));
    expect(view.queryByText('Role "retired" is unavailable in this workspace.')).toBeNull();
    expect(details(view).getByRole('heading', { level: 3, name: 'Dev' })).toBeTruthy();
  });

  it('workspace_change_resets_the_view_to_the_list_and_rejects_the_old_deferred_response', async () => {
    let resolveOld!: (value: ReturnType<typeof ok>) => void;
    const roles = vi.fn((id: string) => id === 'a' ? new Promise<ReturnType<typeof ok>>(r => { resolveOld = r; }) : Promise.resolve(ok(rolesFixture({ items: [roleItem('Fresh')] }))));
    const fake = fakeManagement({ calls: { roles } });
    const view = render(<RolesScreen workspace={workspace} management={fake.api} />);
    view.rerender(<RolesScreen workspace={{ ...workspace, id: 'b' }} management={fake.api} />);
    await view.findByRole('list', { name: 'Saved roles' });
    await act(async () => { resolveOld(ok(rolesFixture())); });
    expect(within(view.getByRole('list', { name: 'Saved roles' })).getAllByRole('listitem')).toHaveLength(1);
    expect(view.queryByText('Developer')).toBeNull();
    expect(roles).toHaveBeenCalledWith('b');
    // Local query and the open role page do not cross workspaces.
    fireEvent.change(view.getByLabelText('Search roles'), { target: { value: 'fre' } });
    fireEvent.click(rowById(view, 'Fresh'));
    expect(view.getByRole('region', { name: 'Role details' })).toBeTruthy();
    view.rerender(<RolesScreen workspace={{ ...workspace, id: 'c' }} management={fake.api} />);
    await view.findByRole('list', { name: 'Saved roles' });
    expect(view.queryByRole('region', { name: 'Role details' })).toBeNull();
    expect((view.getByLabelText('Search roles') as HTMLInputElement).value).toBe('');
  });

  it('renders_every_instruction_state_skills_warnings_and_shared_timing_copy_on_the_role_page', async () => {
    const { view } = setup();
    await view.findByRole('list', { name: 'Saved roles' });
    await showRole(view, 'Developer');
    expect(view.getAllByText(/read when an assignment starts/).length).toBeGreaterThan(0);
    let d = details(view);
    expect(d.getByText('Developer', { selector: 'code' })).toBeTruthy();
    expect(d.getByText('Implements stories')).toBeTruthy();
    expect(d.getByText('.agent-studio/roles/Developer.md')).toBeTruthy();
    expect(d.getByText(/Write tests\./).textContent).toBe('Write tests.\nKeep it small.');
    expect(d.getByText('python-testing').parentElement!.textContent).toBe('python-testing — Available');
    expect(d.getByText('retired-skill').parentElement!.textContent).toBe('retired-skill — Missing');
    expect(d.getByText('3 warnings')).toBeTruthy();
    expect(d.getByText('Skill retired-skill is missing')).toBeTruthy();
    expect(d.getByText('roles.Developer: role problem text')).toBeTruthy();
    expect(d.getByText('teams.json: source problem text')).toBeTruthy();

    await showRole(view, 'Reviewer'); d = details(view);
    expect(d.getByText('The configured instruction file is missing.')).toBeTruthy();
    expect(d.getByText('Display name: Code Reviewer')).toBeTruthy();
    expect(d.getByText('No skills configured.')).toBeTruthy();
    expect(d.getByText('No warnings')).toBeTruthy();
    await showRole(view, 'Planner'); d = details(view);
    expect(d.getByText('Shared instructions are unavailable because the configured file is invalid or unsafe.')).toBeTruthy();
    expect(d.getByText('No description')).toBeTruthy();
    expect(d.queryByText(/Instruction file:/)).toBeNull();
    await showRole(view, 'Writer'); d = details(view);
    expect(d.getByText('partial body')).toBeTruthy();
    expect(d.getByText('Instruction content is truncated.')).toBeTruthy();
    await showRole(view, LONG_ID); d = details(view);
    expect(d.getByText(LONG_PATH)).toBeTruthy();
    expect(d.getByText(/unbroken/).tagName).toBe('PRE');
    cleanup();
    const none = setup(rolesFixture({ items: [roleItem('Plain')] }));
    await none.view.findByRole('list', { name: 'Saved roles' });
    await showRole(none.view, 'Plain');
    expect(none.view.getByText('No shared instruction file configured.')).toBeTruthy();
  });

  it('renders_saved_and_live_members_with_duplicate_labels_without_inheritance_claims', async () => {
    const { view } = setup();
    await view.findByRole('list', { name: 'Saved roles' });
    await showRole(view, 'Developer');
    const items = details(view).getAllByRole('listitem').filter(li => / · (Saved|Live)/.test(li.textContent ?? ''));
    expect(items.map(li => li.textContent)).toEqual([
      'Core (core) — Dev (dev-1) · Saved and Live · available, assignment running',
      'Core (core) — Dev (dev-2) · Saved',
      'Ops (ops) — Dev (dev-3) · Live · busy',
      'Unknown team — Unnamed member · Saved',
    ]);
    const text = details(view).getByText(/Roles do not grant permissions/).textContent!;
    expect(text).toMatch(/do not choose agents/);
    expect(view.queryByText(/inherit/i)).toBeNull();
  });

  it('keeps_saved_members_visible_when_runtime_is_disconnected_or_usage_is_partial', async () => {
    const mk = (usage: object) => rolesFixture({ items: [roleItem('R', { usage: usageOf(usage, MEMBERS.slice(0, 2)) })] });
    const disc = setup(mk({ liveRuntime: { state: 'disconnected', error: null } }));
    await disc.view.findByRole('list', { name: 'Saved roles' });
    await showRole(disc.view, 'R');
    expect(details(disc.view).getByText('Live assignments are unavailable; saved assignments remain shown.')).toBeTruthy();
    expect(details(disc.view).getByText(/dev-1/)).toBeTruthy();
    cleanup();
    const part = setup(mk({ partial: true, liveRuntime: { state: 'unavailable', error: null }, problems: [{ source: 'runtime', path: '', message: 'State database unavailable' }] }));
    await part.view.findByRole('list', { name: 'Saved roles' });
    await showRole(part.view, 'R');
    const d = details(part.view);
    expect(d.getByText('Assigned-member results are incomplete.')).toBeTruthy();
    expect(d.getByText('State database unavailable')).toBeTruthy();
    expect(d.getByText('Live assignments are unavailable; saved assignments remain shown.')).toBeTruthy();
    cleanup();
    const emptyPartial = setup(rolesFixture({ items: [roleItem('R', { usage: usageOf({ partial: true }) })] }));
    await emptyPartial.view.findByRole('list', { name: 'Saved roles' });
    await showRole(emptyPartial.view, 'R');
    expect(emptyPartial.view.queryByText('No saved or live member assignments found.')).toBeNull();
    cleanup();
    const complete = setup(rolesFixture({ items: [roleItem('R')] }));
    await complete.view.findByRole('list', { name: 'Saved roles' });
    await showRole(complete.view, 'R');
    expect(complete.view.getByText('No saved or live member assignments found.')).toBeTruthy();
    expect(complete.view.queryByText(/Live assignments are unavailable/)).toBeNull();
    cleanup();
    const lost = setup(rolesFixture(), { state: 'lost', error: null, distro: null, command: null });
    await lost.view.findByRole('list', { name: 'Saved roles' });
    expect(lost.view.getByText(/Connection to the backend was lost/).getAttribute('role')).toBe('status');
    expect(lost.view.getByRole('list', { name: 'Saved roles' })).toBeTruthy();
  });

  it('renders_invalid_catalog_items_when_available_and_reports_catalog_problems', async () => {
    const problems = [{ path: 'roles.json', message: 'bad json' }, { path: 'roles[2]', message: 'dup id' }];
    const withItems = setup(rolesFixture({ state: 'invalid', problems }));
    const invalidList = await withItems.view.findByRole('list', { name: 'Saved roles' });
    const alert = withItems.view.getByRole('alert');
    expect(alert.textContent).toContain('Roles catalog is invalid.');
    expect(within(alert).getByText('roles.json: bad json')).toBeTruthy();
    expect(within(alert).getByText('roles[2]: dup id')).toBeTruthy();
    expect(within(invalidList).getAllByRole('button').map(b => b.getAttribute('data-role-id'))).toEqual(['Developer', 'Reviewer', 'Planner', 'Writer', LONG_ID]);
    cleanup();
    const none = setup(rolesFixture({ state: 'invalid', problems, items: [] }));
    await none.view.findByText('Roles catalog is invalid.');
    expect(none.view.queryByRole('list', { name: 'Saved roles' })).toBeNull();
    expect(none.view.queryByRole('region', { name: 'Role details' })).toBeNull();
  });

  it('shows_catalog_problems_above_the_table_without_hiding_the_roles', async () => {
    const problems = [{ path: 'roles.json', message: 'unknown field' }];
    const { view } = setup(rolesFixture({ problems }));
    const list = await view.findByRole('list', { name: 'Saved roles' });
    const note = view.getByText('Roles catalog problems').closest('.roles-problems') as HTMLElement;
    expect(within(note).getByText('roles.json: unknown field')).toBeTruthy();
    const card = view.container.querySelector('.roles-table-card')!;
    expect(note.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(list).getAllByRole('button')).toHaveLength(5);
    expect(view.queryAllByRole('alert')).toHaveLength(0);
  });

  it('complete_usage_with_members_and_no_running_assignment_reports_the_count_without_claiming_unused', async () => {
    const idle = roleItem('idle', {
      name: 'Idle',
      usage: usageOf({}, [{ teamDefId: 'core', teamName: 'Core', memberId: 'dev-1', memberName: 'Dev', saved: { path: 'teams.json', memberIndex: 0 }, live: { availability: 'available', assignment: null } }]),
    });
    const { view } = setup(rolesFixture({ items: [idle] }));
    await view.findByRole('list', { name: 'Saved roles' });
    expect(view.getByText('1 role')).toBeTruthy();
    const row = rowById(view, 'idle');
    expect(within(row).getByText('1 member')).toBeTruthy();
    expect(within(row).getByText('No running assignments')).toBeTruthy();
    expect(within(row).queryByText('Unused')).toBeNull();
    expect(within(row).queryByText('Usage incomplete')).toBeNull();
  });

  it('request_errors_retry_and_restore_focus_without_duplicate_live_regions', async () => {
    const error = { code: 'BACKEND_UNAVAILABLE', message: 'offline', remediation: 'start it', retryable: true };
    const roles = vi.fn().mockResolvedValueOnce({ ok: false, error }).mockRejectedValueOnce(new Error('thrown')).mockResolvedValue(ok(rolesFixture()));
    const fake = fakeManagement({ calls: { roles } });
    const view = render(<main><RolesScreen workspace={workspace} management={fake.api} /></main>);
    const alert = await view.findByRole('alert');
    expect(alert.textContent).toContain('BACKEND_UNAVAILABLE: offline');
    expect(alert.textContent).toContain('start it');
    expect(view.getAllByRole('alert')).toHaveLength(1);
    const user = userEvent.setup();
    view.getByRole('button', { name: 'Retry loading roles' }).focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(view.getByRole('alert').textContent).toContain('thrown'));
    expect(view.getAllByRole('alert')).toHaveLength(1);
    expect(view.queryByRole('status')).toBeNull();
    view.getByRole('button', { name: 'Retry loading roles' }).focus();
    await user.keyboard(' ');
    await view.findByRole('list', { name: 'Saved roles' });
    await waitFor(() => expect(document.activeElement).toBe(view.getByRole('heading', { name: 'Role catalog' })));
    expect(view.queryAllByRole('alert')).toHaveLength(0);
    expect(roles).toHaveBeenCalledTimes(3);
    // Opening a role is not announced.
    fireEvent.click(rowById(view, 'Writer'));
    expect(view.queryAllByRole('status')).toHaveLength(0);
  });

  it('roles_layout_css_defines_the_shared_grid_template_once_and_scrolls_narrow_tables', () => {
    const css = readFileSync(resolve(__dirname, '../src/renderer/styles.css'), 'utf8');
    const rules = css.slice(css.indexOf('/* Roles browser'), css.indexOf('/* Teams v4 Members card')).replace(/\s+/g, ' ');
    const template = 'minmax(0, 1.5fr) minmax(0, 3fr) minmax(0, 1.7fr) minmax(0, 1.1fr) 28px';
    expect(rules.split(template).length - 1).toBe(1);
    expect(rules).toMatch(/\.roles-table \{ --roles-table-cols: minmax\(0, 1\.5fr\) minmax\(0, 3fr\) minmax\(0, 1\.7fr\) minmax\(0, 1\.1fr\) 28px; min-width: 820px; \}/);
    expect(rules).toMatch(/\.roles-table-head, \.roles-row \{ display: grid; grid-template-columns: var\(--roles-table-cols\); gap: 16px; align-items: center; \}/);
    expect(rules).toMatch(/\.roles-table-scroll \{ overflow-x: auto; max-width: 100%; \}/);
    expect(rules).toMatch(/\.roles-table-card \{ min-width: 0; background: var\(--surface\); border: 1px solid var\(--border-card\); border-radius: 12px; overflow: hidden; \}/);
    expect(rules.split('.roles-toolbar {').length - 1).toBe(1);
    expect(rules).toMatch(/\.roles-toolbar \{[^}]*justify-content: space-between/);
    expect(rules).toMatch(/\.roles-toolbar \{[^}]*margin: 0;/);
    expect(rules).not.toMatch(/\.roles-toolbar \{[^}]*margin: 16px 0/);
    expect(rules).toMatch(/\.roles-screen \.roles-row \{[^}]*width: 100%/);
    expect(rules).toMatch(/\.roles-screen \.roles-row:hover:not\(:disabled\) \{[^}]*background: var\(--surface-hover\)/);
    expect(rules).toMatch(/\.roles-screen \.roles-row:focus-visible \{ outline: 2px solid var\(--focus\); outline-offset: -2px; \}/);
    expect(rules).toMatch(/\.roles-description \{[^}]*-webkit-line-clamp: 2/);
    expect(rules).toMatch(/\.roles-cell \{ min-width: 0; \}/);
    expect(css).toMatch(/--surface: #16191d;/);
    expect(css).toMatch(/--border-card: #262a30;/);
    expect(css).toMatch(/--surface-hover: #1b1f25;/);
    expect(rules).not.toMatch(/\.roles-layout/);
    expect(rules).not.toMatch(/\.roles-list/);
  });
});
