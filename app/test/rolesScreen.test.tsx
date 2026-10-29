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

function setup(data: RoleCatalogList = rolesFixture(), connection?: ConnectionStatus) {
  const roles = vi.fn(async (_id: string) => ok(data));
  const fake = fakeManagement({ calls: { roles } });
  const view = render(<main><RolesScreen workspace={workspace} management={fake.api} connection={connection} /></main>);
  return { view, roles, fake };
}
const details = (view: ReturnType<typeof render>) => within(view.getByRole('region', { name: 'Role details' }));
const pick = (view: ReturnType<typeof render>, id: string) => fireEvent.click([...within(view.getByRole('list', { name: 'Saved roles' })).getAllByRole('button')].find(b => b.lastElementChild!.textContent === id)!);

describe('RolesScreen', () => {
  it('loads_roles_once_and_renders_one_roles_heading_inside_the_shell_main', async () => {
    const { view, roles, fake } = setup();
    expect(view.getByText('Loading roles…').getAttribute('role')).toBe('status');
    await view.findByRole('list', { name: 'Saved roles' });
    expect(roles).toHaveBeenCalledTimes(1);
    expect(roles).toHaveBeenCalledWith('a');
    expect(fake.overview).not.toHaveBeenCalled();
    expect(within(view.getByRole('main')).getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(view.getByRole('heading', { level: 1 }).textContent).toBe('Roles');
    expect(view.getAllByRole('main')).toHaveLength(1);
    expect(view.queryAllByRole('alert')).toHaveLength(0);
  });

  it('search_preserves_order_selection_and_distinguishes_missing_empty_and_no_match', async () => {
    const { view } = setup();
    const list = await view.findByRole('list', { name: 'Saved roles' });
    const labels = () => within(list).getAllByRole('listitem').map(li => li.querySelector('strong')!.textContent);
    expect(labels()).toEqual(['Developer', 'Code Reviewer', 'Planner', 'Writer', LONG_ID]);
    expect(view.getByText('5 roles')).toBeTruthy();
    pick(view, 'Writer');
    expect(details(view).getByRole('heading', { level: 3, name: 'Writer' })).toBeTruthy();
    fireEvent.change(view.getByLabelText('Search roles'), { target: { value: ' WRITER ' } });
    expect(labels()).toEqual(['Writer']);
    expect(view.getByText('1 role')).toBeTruthy();
    expect(details(view).getByRole('heading', { level: 3, name: 'Writer' })).toBeTruthy();
    fireEvent.change(view.getByLabelText('Search roles'), { target: { value: 'review' } });
    expect(details(view).getByRole('heading', { level: 3, name: 'Code Reviewer' })).toBeTruthy();
    fireEvent.change(view.getByLabelText('Search roles'), { target: { value: 'zzz' } });
    expect(view.getByText(/No roles match this search\./)).toBeTruthy();
    expect(view.queryByRole('region', { name: 'Role details' })).toBeNull();
    expect(view.queryByText('No roles are configured yet.')).toBeNull();
    fireEvent.click(view.getByRole('button', { name: 'Clear search' }));
    expect((view.getByLabelText('Search roles') as HTMLInputElement).value).toBe('');
    expect(document.activeElement).toBe(view.getByLabelText('Search roles'));
    expect(labels()).toHaveLength(5);
    view.unmount();

    const missing = setup(rolesFixture({ state: 'missing', sha256: null, items: [] }));
    expect(await missing.view.findByText('No roles catalog is configured for this workspace.')).toBeTruthy();
    expect(missing.view.queryByText('No roles are configured yet.')).toBeNull();
    cleanup();
    const empty = setup(rolesFixture({ items: [] }));
    expect(await empty.view.findByText('No roles are configured yet.')).toBeTruthy();
    expect(empty.view.queryByText(/No roles match/)).toBeNull();
    expect(empty.view.queryByRole('list', { name: 'Saved roles' })).toBeNull();
  });

  it('renders_every_instruction_state_skills_warnings_and_shared_timing_copy', async () => {
    const { view } = setup();
    await view.findByRole('list', { name: 'Saved roles' });
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

    pick(view, 'Reviewer'); d = details(view);
    expect(d.getByText('The configured instruction file is missing.')).toBeTruthy();
    expect(d.getByText('Display name: Code Reviewer')).toBeTruthy();
    expect(d.getByText('No skills configured.')).toBeTruthy();
    expect(d.getByText('No warnings')).toBeTruthy();
    pick(view, 'Planner'); d = details(view);
    expect(d.getByText('Shared instructions are unavailable because the configured file is invalid or unsafe.')).toBeTruthy();
    expect(d.getByText('No description')).toBeTruthy();
    expect(d.queryByText(/Instruction file:/)).toBeNull();
    pick(view, 'Writer'); d = details(view);
    expect(d.getByText('partial body')).toBeTruthy();
    expect(d.getByText('Instruction content is truncated.')).toBeTruthy();
    pick(view, LONG_ID); d = details(view);
    expect(d.getByText(LONG_PATH)).toBeTruthy();
    expect(d.getByText(/unbroken/).tagName).toBe('PRE');
    cleanup();
    const none = setup(rolesFixture({ items: [roleItem('Plain')] }));
    expect(await none.view.findByText('No shared instruction file configured.')).toBeTruthy();
  });

  it('renders_saved_and_live_members_with_duplicate_labels_without_inheritance_claims', async () => {
    const { view } = setup();
    await view.findByRole('list', { name: 'Saved roles' });
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
    expect(details(disc.view).getByText('Live assignments are unavailable; saved assignments remain shown.')).toBeTruthy();
    expect(details(disc.view).getByText(/dev-1/)).toBeTruthy();
    cleanup();
    const part = setup(mk({ partial: true, liveRuntime: { state: 'unavailable', error: null }, problems: [{ source: 'runtime', path: '', message: 'State database unavailable' }] }));
    await part.view.findByRole('list', { name: 'Saved roles' });
    const d = details(part.view);
    expect(d.getByText('Assigned-member results are incomplete.')).toBeTruthy();
    expect(d.getByText('State database unavailable')).toBeTruthy();
    expect(d.getByText('Live assignments are unavailable; saved assignments remain shown.')).toBeTruthy();
    cleanup();
    const emptyPartial = setup(rolesFixture({ items: [roleItem('R', { usage: usageOf({ partial: true }) })] }));
    await emptyPartial.view.findByRole('list', { name: 'Saved roles' });
    expect(emptyPartial.view.queryByText('No saved or live member assignments found.')).toBeNull();
    cleanup();
    const complete = setup(rolesFixture({ items: [roleItem('R')] }));
    await complete.view.findByRole('list', { name: 'Saved roles' });
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
    await withItems.view.findByRole('list', { name: 'Saved roles' });
    const alert = withItems.view.getByRole('alert');
    expect(alert.textContent).toContain('Roles catalog is invalid.');
    expect(within(alert).getByText('roles.json: bad json')).toBeTruthy();
    expect(within(alert).getByText('roles[2]: dup id')).toBeTruthy();
    cleanup();
    const none = setup(rolesFixture({ state: 'invalid', problems, items: [] }));
    await none.view.findByText('Roles catalog is invalid.');
    expect(none.view.queryByRole('list', { name: 'Saved roles' })).toBeNull();
    expect(none.view.queryByRole('region', { name: 'Role details' })).toBeNull();
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
    // Selection changes are not announced.
    pick(view, 'Writer');
    expect(view.queryAllByRole('status')).toHaveLength(0);
  });

  it('workspace_change_resets_state_and_rejects_the_old_deferred_response', async () => {
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
    // Local query does not cross workspaces.
    fireEvent.change(view.getByLabelText('Search roles'), { target: { value: 'fre' } });
    view.rerender(<RolesScreen workspace={{ ...workspace, id: 'c' }} management={fake.api} />);
    await view.findByRole('list', { name: 'Saved roles' });
    expect((view.getByLabelText('Search roles') as HTMLInputElement).value).toBe('');
  });

  it('native_row_buttons_support_mouse_enter_and_space_selection', async () => {
    const { view } = setup();
    const list = await view.findByRole('list', { name: 'Saved roles' });
    const buttons = within(list).getAllByRole('button');
    expect(buttons.every(b => b.tagName === 'BUTTON' && b.getAttribute('type') === 'button' && !b.hasAttribute('tabindex'))).toBe(true);
    expect(buttons[0].getAttribute('aria-current')).toBe('true');
    expect(buttons.filter(b => b.getAttribute('aria-current') === 'true')).toHaveLength(1);
    const user = userEvent.setup();
    await user.click(buttons[1]);
    expect(details(view).getByRole('heading', { level: 3, name: 'Code Reviewer' })).toBeTruthy();
    buttons[2].focus();
    await user.keyboard('{Enter}');
    expect(details(view).getByRole('heading', { level: 3, name: 'Planner' })).toBeTruthy();
    buttons[3].focus();
    await user.keyboard(' ');
    expect(details(view).getByRole('heading', { level: 3, name: 'Writer' })).toBeTruthy();
    expect(buttons[3].getAttribute('aria-current')).toBe('true');
    // Keyboard-only search.
    view.getByLabelText('Search roles').focus();
    await user.keyboard('plan');
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(details(view).getByRole('heading', { level: 3, name: 'Planner' })).toBeTruthy();
  });

  it('roles_layout_css_stacks_wraps_and_has_no_wide_overflow_rule', () => {
    const css = readFileSync(resolve(__dirname, '../src/renderer/styles.css'), 'utf8');
    const rules = css.slice(css.indexOf('/* Roles browser')).replace(/\s+/g, ' ');
    expect(rules).toMatch(/\.roles-layout \{ display: grid; grid-template-columns: minmax\(0, 1fr\) minmax\(0, 2fr\)/);
    expect(rules).toMatch(/@media \(max-width: 900px\) \{ \.roles-layout \{ grid-template-columns: minmax\(0, 1fr\); \} \}/);
    expect(rules).toMatch(/min-width: 0; overflow-wrap: anywhere/);
    expect(rules).toMatch(/\.roles-instructions \{ white-space: pre-wrap; overflow-wrap: anywhere/);
    expect(rules).toMatch(/\.roles-screen :is\(button, input\):focus-visible \{ outline: 2px solid/);
    expect(rules).not.toMatch(/overflow-x: ?scroll/);
    expect(rules).not.toMatch(/(?<!max-)width: ?\d{3,}px/);
    expect(rules).not.toMatch(/(?<![\w-])min-width: ?[1-9]/);
    for (const selector of rules.match(/[^{}]+(?=\{)/g) ?? []) {
      if (selector.includes('@media')) continue;
      expect(selector).toMatch(/\.roles-/);
    }
  });

  it('requested_role_selection_is_exact_and_clears_search', async () => {
    const data = rolesFixture({ items: [roleItem('qa-a', { name: 'QA' }), roleItem('qa-b', { name: 'QA' }), roleItem('dev', { name: 'Dev' })] });
    const fake = fakeManagement({ calls: { roles: vi.fn(async () => ok(data)) } });
    const view = render(<main><RolesScreen workspace={workspace} management={fake.api} requestedRoleId={null} /></main>);
    await view.findByRole('list', { name: 'Saved roles' });
    fireEvent.change(view.getByLabelText('Search roles'), { target: { value: 'dev' } });
    view.rerender(<main><RolesScreen workspace={workspace} management={fake.api} requestedRoleId="qa-b" /></main>);
    await waitFor(() => expect((view.getByLabelText('Search roles') as HTMLInputElement).value).toBe(''));
    expect(details(view).getByText('qa-b')).toBeTruthy();
    expect(view.queryByText(/is unavailable in this workspace/)).toBeNull();
    const current = view.getAllByRole('button').filter(b => b.getAttribute('aria-current') === 'true');
    expect(current.map(b => b.lastElementChild!.textContent)).toEqual(['qa-b']);
  });

  it('missing_requested_role_reports_fallback', async () => {
    const data = rolesFixture({ items: [roleItem('qa-a', { name: 'QA' }), roleItem('qa-b', { name: 'QA' })] });
    const fake = fakeManagement({ calls: { roles: vi.fn(async () => ok(data)) } });
    const view = render(<main><RolesScreen workspace={workspace} management={fake.api} requestedRoleId="retired" /></main>);
    expect(await view.findByText('Role "retired" is unavailable in this workspace.')).toBeTruthy();
    expect(details(view).getByText('qa-a')).toBeTruthy();
    view.rerender(<main><RolesScreen workspace={workspace} management={fake.api} requestedRoleId={null} /></main>);
    await waitFor(() => expect(view.queryByText(/is unavailable in this workspace/)).toBeNull());
  });
});
