// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionStatus, DashboardApi, Workspace } from '../src/renderer/api';
import { SkillsScreen } from '../src/renderer/skills/SkillsScreen';
import { WorkspaceShell } from '../src/renderer/shell/WorkspaceShell';
import type { SkillCatalogList, SkillItem } from '../src/shared/management';
import { connectionFixture, deferred, fakeManagement } from './teamsFixtures';
import { skillCatalog, skillItem } from './skillFixtures';

afterEach(cleanup);
const workspace: Workspace = { id: 'a', name: 'A', path: '/a', exists: true, missing: false };
const ok = (data: SkillCatalogList) => ({ ok: true as const, data });

function setup(data: SkillCatalogList = skillCatalog(), connection?: ConnectionStatus) {
  const skills = vi.fn(async (_id: string) => ok(data));
  const fake = fakeManagement({ calls: { skills } });
  const view = render(<main><SkillsScreen workspace={workspace} management={fake.api} connection={connection} /></main>);
  return { view, skills, fake };
}

const skillList = (view: ReturnType<typeof render>) => view.getByRole('list', { name: 'Saved skills' });
const rowById = (view: ReturnType<typeof render>, id: string) =>
  within(skillList(view)).getAllByRole('button').find(button => button.getAttribute('data-skill-id') === id)!;
const detail = (view: ReturnType<typeof render>) => within(view.getByRole('region', { name: 'Skill details' }));
const backToSkills = (view: ReturnType<typeof render>) => fireEvent.click(view.getByRole('button', { name: 'Skills' }));

function everyStateCatalog(): SkillCatalogList {
  const threeRoles = skillItem({
    id: 'three-roles', title: 'Used by three roles', state: 'ok', bytes: 2048, sha256: 'a'.repeat(64),
    roles: [
      { id: 'alpha', name: 'Alpha', contextBytes: 100 },
      { id: 'beta', name: null, contextBytes: 200 },
      { id: 'gamma', name: 'Gamma', contextBytes: 300 },
    ],
  });
  const unreadable = skillItem({ id: 'broken-skill', state: 'unreadable', title: null, bytes: null, sha256: null, roles: [] });
  const truncated = skillItem({ id: 'huge-skill', state: 'truncated', title: 'Huge skill', bytes: 40960, sha256: 'b'.repeat(64), roles: [] });
  const untitled = skillItem({ id: 'untitled-skill', state: 'ok', title: null, bytes: 4, sha256: 'd'.repeat(64), roles: [] });
  return skillCatalog({
    skills: [skillItem({ id: 'code-search' }), threeRoles, skillItem({ id: 'ts-testing' }), skillItem({ id: 'legacy-notes' }), unreadable, truncated, untitled],
    problems: [],
  });
}

describe('SkillsScreen', () => {
  it('loads_skills_once_and_renders_the_header_notice_search_and_count', async () => {
    const { view, skills, fake } = setup();
    expect(view.getByText('Loading skills…').getAttribute('role')).toBe('status');
    await view.findByRole('list', { name: 'Saved skills' });
    expect(skills).toHaveBeenCalledTimes(1);
    expect(skills).toHaveBeenCalledWith('a');
    expect(fake.overview).not.toHaveBeenCalled();
    expect(view.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(view.getByRole('heading', { level: 1 }).textContent).toBe('Skills');
    expect(view.getByText('Reusable instructions that roles load. Each skill is a folder with a SKILL.md file; a role lists the skills it uses.')).toBeTruthy();
    expect(view.getByText('Saved changes apply to new assignments. Assignments already running keep the skills they started with.')).toBeTruthy();
    expect(view.getByLabelText('Search skills')).toBeTruthy();
    expect(view.getByText('5 skills')).toBeTruthy();
    expect(view.queryByRole('button', { name: /new skill/i })).toBeNull();
    expect(view.queryAllByRole('alert')).toHaveLength(0);
  });

  it('rows_show_every_column_for_ok_three_role_unused_missing_unreadable_and_truncated_skills', async () => {
    const { view } = setup(everyStateCatalog());
    const list = await view.findByRole('list', { name: 'Saved skills' });
    const buttons = within(list).getAllByRole('button');
    expect(buttons.every(button => button.tagName === 'BUTTON' && button.getAttribute('type') === 'button' && !button.hasAttribute('tabindex'))).toBe(true);
    expect(buttons.every(button => (button.getAttribute('aria-label') ?? '').startsWith('Open skill '))).toBe(true);
    expect(buttons.every(button => button.querySelectorAll('button, a, input, select, textarea').length === 0)).toBe(true);

    const head = view.container.querySelector('.skills-table-head')!;
    expect([...head.children].map(cell => cell.textContent)).toEqual(['Skill', 'Summary', 'Used by roles', 'Size', '']);
    const columns = view.container.querySelector('#skills-table-columns')!;
    expect(columns.className).toBe('skills-visually-hidden');
    expect(columns.textContent).toBe('Columns: Skill, Summary, Used by roles, Size.');

    const okRow = rowById(view, 'code-search');
    expect(okRow.children).toHaveLength(5);
    expect(okRow.getAttribute('aria-label')).toBe('Open skill code-search');
    expect(okRow.getAttribute('aria-describedby')).toBe('skills-table-columns');
    expect(okRow.querySelector('.skills-badge svg')?.getAttribute('data-icon')).toBe('skills');
    expect(within(okRow).getByText('code-search')).toBeTruthy();
    expect(within(okRow).getByText('skills/code-search/SKILL.md')).toBeTruthy();
    expect(within(okRow).getByText('Searching the code cheaply')).toBeTruthy();
    expect(within(okRow).getByText('TeamLead')).toBeTruthy();
    expect(within(okRow).getByText('Developer')).toBeTruthy();
    expect(within(okRow).getByText('+2')).toBeTruthy();
    expect(within(okRow).getByText('839 B')).toBeTruthy();
    expect(within(okRow).getByText('of 32 KiB')).toBeTruthy();
    expect(okRow.lastElementChild!.classList.contains('skills-chevron')).toBe(true);
    expect(okRow.lastElementChild!.querySelector('svg')).toBeTruthy();

    const three = rowById(view, 'three-roles');
    expect(within(three).getByText('Alpha')).toBeTruthy();
    expect(within(three).getByText('beta')).toBeTruthy();
    expect(within(three).getByText('+1')).toBeTruthy();
    expect(within(three).queryByText('Gamma')).toBeNull();
    expect(within(three).getByText('2.0 KB')).toBeTruthy();

    const unused = rowById(view, 'ts-testing');
    expect(within(unused).getByText('Not used')).toBeTruthy();
    expect(within(unused).getByText('148 B')).toBeTruthy();

    const missing = rowById(view, 'legacy-notes');
    expect(missing.querySelector('.skills-badge')!.classList.contains('is-warning')).toBe(true);
    const missingSummary = within(missing).getByText('No SKILL.md found. Roles still list it.');
    expect(missingSummary.classList.contains('is-warning')).toBe(true);
    const missingSize = within(missing).getByText('Missing');
    expect(missingSize.classList.contains('is-warning')).toBe(true);
    expect(within(missing).getByText('File not found')).toBeTruthy();
    expect(within(missing).getByText('SeniorDeveloper')).toBeTruthy();

    const unreadable = rowById(view, 'broken-skill');
    expect(within(unreadable).getByText('The file cannot be read.').classList.contains('is-warning')).toBe(true);
    expect(within(unreadable).getByText('Unreadable')).toBeTruthy();

    const truncated = rowById(view, 'huge-skill');
    expect(within(truncated).getByText('Huge skill')).toBeTruthy();
    expect(within(truncated).getByText('40.0 KB').classList.contains('is-warning')).toBe(true);
    expect(within(truncated).getByText('Over the 32 KiB limit').classList.contains('is-warning')).toBe(true);
    expect(within(truncated).getByText('Not used')).toBeTruthy();

    const untitled = rowById(view, 'untitled-skill');
    expect(within(untitled).getByText('No title')).toBeTruthy();
    expect(within(untitled).getByText('4 B')).toBeTruthy();
  });

  it('searches_by_id_and_title_case_insensitively_and_updates_the_count', async () => {
    const { view } = setup();
    await view.findByRole('list', { name: 'Saved skills' });
    const ids = () => within(skillList(view)).getAllByRole('button').map(button => button.getAttribute('data-skill-id'));
    expect(ids()).toEqual(['code-search', 'legacy-notes', 'python-testing', 'story-format', 'ts-testing']);
    fireEvent.change(view.getByLabelText('Search skills'), { target: { value: ' PYTHON ' } });
    expect(ids()).toEqual(['python-testing']);
    expect(view.getByText('1 of 5 skills')).toBeTruthy();
    fireEvent.change(view.getByLabelText('Search skills'), { target: { value: 'testing' } });
    expect(ids()).toEqual(['python-testing', 'ts-testing']);
    expect(view.getByText('2 of 5 skills')).toBeTruthy();
    fireEvent.change(view.getByLabelText('Search skills'), { target: { value: 'testing the app' } });
    expect(ids()).toEqual(['ts-testing']);
    expect(view.getByText('1 of 5 skills')).toBeTruthy();
    fireEvent.change(view.getByLabelText('Search skills'), { target: { value: 'SEARCHING THE CODE' } });
    expect(ids()).toEqual(['code-search']);
    fireEvent.change(view.getByLabelText('Search skills'), { target: { value: 'legacy' } });
    expect(ids()).toEqual(['legacy-notes']);
    expect(view.getByText('1 of 5 skills')).toBeTruthy();
    fireEvent.change(view.getByLabelText('Search skills'), { target: { value: '' } });
    expect(ids()).toHaveLength(5);
    expect(view.getByText('5 skills')).toBeTruthy();
  });

  it('uses_singular_grammar_for_one_skill_and_one_filtered_match', async () => {
    const { view } = setup(skillCatalog({
      skills: [skillItem({ id: 'only-skill', state: 'ok', title: 'Only skill', bytes: 10, sha256: 'a'.repeat(64), roles: [] })],
      problems: [],
    }));
    await view.findByRole('list', { name: 'Saved skills' });
    expect(view.getByText('1 skill')).toBeTruthy();
    fireEvent.change(view.getByLabelText('Search skills'), { target: { value: 'only' } });
    expect(view.getByText('1 of 1 skill')).toBeTruthy();
    expect(view.queryByText('1 of 1 skills')).toBeNull();
  });

  it('shows_the_size_limit_from_the_catalog_for_ok_and_truncated_skills', async () => {
    const { view } = setup(skillCatalog({
      limits: { skillBytes: 65536, roleContextBytes: 98304 },
      skills: [
        skillItem({ id: 'small-skill', state: 'ok', title: 'Small', bytes: 2048, sha256: 'a'.repeat(64), roles: [] }),
        skillItem({ id: 'large-skill', state: 'truncated', title: 'Large', bytes: 70000, sha256: 'b'.repeat(64), roles: [] }),
      ],
      problems: [],
    }));
    await view.findByRole('list', { name: 'Saved skills' });
    const small = rowById(view, 'small-skill');
    expect(within(small).getByText('2.0 KB')).toBeTruthy();
    expect(within(small).getByText('of 64 KiB')).toBeTruthy();
    const large = rowById(view, 'large-skill');
    expect(within(large).getByText('68.4 KB')).toBeTruthy();
    expect(within(large).getByText('Over the 64 KiB limit').classList.contains('is-warning')).toBe(true);
  });

  it('shows_no_match_for_a_query_and_clear_search_restores_the_list', async () => {
    const { view } = setup();
    await view.findByRole('list', { name: 'Saved skills' });
    fireEvent.change(view.getByLabelText('Search skills'), { target: { value: 'zzz' } });
    expect(view.getByText(/No skill matches "zzz"\./)).toBeTruthy();
    expect(view.getByText('0 of 5 skills')).toBeTruthy();
    expect(view.queryByRole('list', { name: 'Saved skills' })).toBeNull();
    fireEvent.click(view.getByRole('button', { name: 'Clear search' }));
    expect((view.getByLabelText('Search skills') as HTMLInputElement).value).toBe('');
    expect(document.activeElement).toBe(view.getByLabelText('Search skills'));
    expect(within(skillList(view)).getAllByRole('button')).toHaveLength(5);
    expect(view.getByText('5 skills')).toBeTruthy();
  });

  it('shows_the_empty_catalog_copy_without_a_create_button', async () => {
    const { view } = setup(skillCatalog({ skills: [], problems: [] }));
    expect(await view.findByText(/No skills yet\. A skill is a folder/)).toBeTruthy();
    expect(view.getByText('.agent-studio/skills/<id>/SKILL.md')).toBeTruthy();
    expect(view.queryByRole('list', { name: 'Saved skills' })).toBeNull();
    expect(view.queryByLabelText('Search skills')).toBeNull();
    expect(view.queryByRole('button', { name: /new skill/i })).toBeNull();
  });

  it('keeps_a_loading_status_until_the_catalog_arrives', async () => {
    const gate = deferred<ReturnType<typeof ok>>();
    const skills = vi.fn(() => gate.promise);
    const fake = fakeManagement({ calls: { skills } });
    const view = render(<main><SkillsScreen workspace={workspace} management={fake.api} /></main>);
    expect(view.getByText('Loading skills…').getAttribute('role')).toBe('status');
    await act(async () => { gate.resolve(ok(skillCatalog())); });
    await view.findByRole('list', { name: 'Saved skills' });
    expect(view.queryByText('Loading skills…')).toBeNull();
  });

  it('keeps_the_loaded_list_visible_and_warns_while_the_connection_is_lost_or_connecting', async () => {
    const { view, fake } = setup(skillCatalog(), connectionFixture('lost'));
    const list = await view.findByRole('list', { name: 'Saved skills' });
    const lost = view.getByText('Connection to the backend was lost. Saved skill data stays visible but may be out of date.');
    expect(lost.getAttribute('role')).toBe('status');
    expect(within(list).getAllByRole('button')).toHaveLength(5);
    view.rerender(<main><SkillsScreen workspace={workspace} management={fake.api} connection={connectionFixture('connecting')} /></main>);
    const connecting = view.getByText('Connecting to the backend… Saved skill data may be out of date.');
    expect(connecting.getAttribute('role')).toBe('status');
    expect(within(view.getByRole('list', { name: 'Saved skills' })).getAllByRole('button')).toHaveLength(5);
  });

  it('shows_an_error_with_retry_and_focuses_the_catalog_heading_after_recovery', async () => {
    const error = { code: 'BACKEND_UNAVAILABLE', message: 'offline', remediation: 'start it', retryable: true };
    const skills = vi.fn().mockResolvedValueOnce({ ok: false as const, error }).mockResolvedValue(ok(skillCatalog()));
    const fake = fakeManagement({ calls: { skills } });
    const view = render(<main><SkillsScreen workspace={workspace} management={fake.api} /></main>);
    const alert = await view.findByRole('alert');
    expect(alert.textContent).toContain('BACKEND_UNAVAILABLE: offline');
    expect(alert.textContent).toContain('start it');
    const user = userEvent.setup();
    view.getByRole('button', { name: 'Retry loading skills' }).focus();
    await user.keyboard('{Enter}');
    await view.findByRole('list', { name: 'Saved skills' });
    await waitFor(() => expect(document.activeElement).toBe(view.getByRole('heading', { name: 'Skill catalog' })));
    expect(view.queryAllByRole('alert')).toHaveLength(0);
    expect(skills).toHaveBeenCalledTimes(2);
  });

  it('shows_list_problems_above_the_table_in_an_amber_note', async () => {
    const problems = [
      { path: 'skills/legacy-notes/SKILL.md', message: "Skill 'legacy-notes' has no readable SKILL.md." },
      { path: 'skills/broken/SKILL.md', message: 'Skill could not be read.' },
    ];
    const { view } = setup(skillCatalog({ problems }));
    await view.findByRole('list', { name: 'Saved skills' });
    const note = view.getByText('Skill catalog problems').closest('.skills-problems') as HTMLElement;
    expect(within(note).getByText("skills/legacy-notes/SKILL.md: Skill 'legacy-notes' has no readable SKILL.md.")).toBeTruthy();
    expect(within(note).getByText('skills/broken/SKILL.md: Skill could not be read.')).toBeTruthy();
    const card = view.container.querySelector('.skills-table-card')!;
    expect(note.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(view.queryAllByRole('alert')).toHaveLength(0);
  });

  it('opens_a_placeholder_with_click_enter_and_space_and_returns_with_breadcrumb_focus', async () => {
    const { view } = setup();
    await view.findByRole('list', { name: 'Saved skills' });
    const user = userEvent.setup();

    await user.click(rowById(view, 'code-search'));
    expect(detail(view).getByRole('heading', { level: 1, name: 'code-search' })).toBeTruthy();
    expect(view.getByRole('navigation', { name: 'Breadcrumb' }).textContent).toContain('Skillscode-search');
    expect(view.queryByRole('list', { name: 'Saved skills' })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(view.getByRole('heading', { level: 1, name: 'code-search' })));
    backToSkills(view);
    await view.findByRole('list', { name: 'Saved skills' });

    rowById(view, 'python-testing').focus();
    await user.keyboard('{Enter}');
    expect(detail(view).getByRole('heading', { level: 1, name: 'python-testing' })).toBeTruthy();
    backToSkills(view);
    await view.findByRole('list', { name: 'Saved skills' });

    rowById(view, 'story-format').focus();
    await user.keyboard(' ');
    expect(detail(view).getByRole('heading', { level: 1, name: 'story-format' })).toBeTruthy();
  });

  it('placeholder_replaces_the_list_chrome_and_shows_the_id_in_the_breadcrumb', async () => {
    const { view } = setup();
    await view.findByRole('list', { name: 'Saved skills' });
    fireEvent.click(rowById(view, 'code-search'));
    expect(view.queryByRole('heading', { level: 1, name: 'Skills' })).toBeNull();
    expect(view.queryByLabelText('Search skills')).toBeNull();
    expect(view.queryByText('5 skills')).toBeNull();
    expect(view.getByRole('region', { name: 'Skill details' })).toBeTruthy();
    const crumbs = within(view.getByRole('navigation', { name: 'Breadcrumb' })).getAllByRole('listitem');
    expect(crumbs.map((crumb) => crumb.textContent)).toEqual(['Skills', 'code-search']);
    expect(crumbs[1].getAttribute('aria-current')).toBe('page');
    expect(detail(view).getByRole('heading', { level: 1, name: 'code-search' })).toBeTruthy();
  });

  it('breadcrumb_returns_to_the_list_with_the_search_text_and_focus_on_the_opened_row', async () => {
    const custom = skillCatalog({
      skills: [
        skillItem({ id: 'alpha', state: 'ok', title: 'Alpha', bytes: 10, sha256: 'a'.repeat(64), roles: [] }),
        skillItem({ id: 'beta', state: 'ok', title: 'Beta', bytes: 20, sha256: 'b'.repeat(64), roles: [] }),
        skillItem({ id: 'gamma', state: 'ok', title: 'Gamma', bytes: 30, sha256: 'c'.repeat(64), roles: [] }),
      ],
      problems: [],
    });
    const { view } = setup(custom);
    await view.findByRole('list', { name: 'Saved skills' });
    fireEvent.change(view.getByLabelText('Search skills'), { target: { value: 'bet' } });
    expect(view.getByText('1 of 3 skills')).toBeTruthy();
    fireEvent.click(rowById(view, 'beta'));
    expect(detail(view).getByRole('heading', { level: 1, name: 'beta' })).toBeTruthy();
    backToSkills(view);
    await view.findByRole('list', { name: 'Saved skills' });
    expect((view.getByLabelText('Search skills') as HTMLInputElement).value).toBe('bet');
    expect(view.getByText('1 of 3 skills')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(rowById(view, 'beta')));
  });

  it('workspace_change_resets_to_the_list_and_clears_search', async () => {
    const skills = vi.fn(async (id: string) => ok(skillCatalog({
      skills: [skillItem({ id: id === 'a' ? 'code-search' : 'fresh', state: 'ok', title: 'Fresh', bytes: 10, sha256: 'a'.repeat(64), roles: [] })],
      problems: [],
    })));
    const fake = fakeManagement({ calls: { skills } });
    const view = render(<SkillsScreen workspace={workspace} management={fake.api} />);
    await view.findByRole('list', { name: 'Saved skills' });
    fireEvent.change(view.getByLabelText('Search skills'), { target: { value: 'code' } });
    fireEvent.click(rowById(view, 'code-search'));
    expect(detail(view).getByRole('heading', { level: 1, name: 'code-search' })).toBeTruthy();
    view.rerender(<SkillsScreen workspace={{ ...workspace, id: 'b' }} management={fake.api} />);
    await view.findByRole('list', { name: 'Saved skills' });
    expect(view.queryByRole('region', { name: 'Skill details' })).toBeNull();
    expect((view.getByLabelText('Search skills') as HTMLInputElement).value).toBe('');
    expect(within(skillList(view)).getAllByRole('button').map(button => button.getAttribute('data-skill-id'))).toEqual(['fresh']);
    expect(skills).toHaveBeenCalledWith('b');
  });

  it('defines_the_shared_skills_grid_template_once_and_scrolls_narrow_tables', () => {
    const css = readFileSync(resolve(__dirname, '../src/renderer/styles.css'), 'utf8');
    const rules = css.slice(css.indexOf('/* Skills browser'), css.indexOf('/* Teams v4 Members card')).replace(/\s+/g, ' ');
    const template = 'minmax(0, 1.5fr) minmax(0, 3fr) minmax(0, 1.8fr) minmax(0, 1.1fr) 28px';
    expect(rules.split(template).length - 1).toBe(1);
    expect(rules).toMatch(/\.skills-table \{ --skills-table-cols: minmax\(0, 1\.5fr\) minmax\(0, 3fr\) minmax\(0, 1\.8fr\) minmax\(0, 1\.1fr\) 28px; min-width: 820px; \}/);
    expect(rules).toMatch(/\.skills-table-head, \.skills-row \{ display: grid; grid-template-columns: var\(--skills-table-cols\); gap: 16px; align-items: center; \}/);
    expect(rules).toMatch(/\.skills-table-scroll \{ overflow-x: auto; max-width: 100%; \}/);
    expect(rules).toMatch(/\.skills-table-card \{ min-width: 0; background: var\(--surface\); border: 1px solid var\(--border-card\); border-radius: 12px; overflow: hidden; \}/);
    expect(rules).toMatch(/\.skills-screen \.skills-row \{[^}]*width: 100%/);
    expect(rules).toMatch(/\.skills-screen \.skills-row:hover:not\(:disabled\) \{[^}]*background: var\(--surface-hover\)/);
    expect(rules).toMatch(/\.skills-screen \.skills-row:focus-visible \{ outline: 2px solid var\(--focus\); outline-offset: -2px; \}/);
    expect(rules).toMatch(/\.skills-badge \{[^}]*width: 34px;[^}]*height: 34px;[^}]*border-radius: 8px/);
    expect(rules).toMatch(/\.skills-skill-id \{[^}]*font-family: var\(--font-mono\)[^}]*text-overflow: ellipsis/);
    expect(rules).toMatch(/\.skills-skill-path \{[^}]*font-family: var\(--font-mono\)[^}]*text-overflow: ellipsis/);
    expect(rules).toMatch(/\.skills-summary \{[^}]*-webkit-line-clamp: 2/);
    expect(rules).toMatch(/\.skills-cell \{ min-width: 0; \}/);
  });
});

describe('Skills navigation', () => {
  const dashboard: DashboardApi = {
    teams: vi.fn(async () => ({ ok: true, data: { workspace: '/a', teams: [], truncated: false } })),
    board: vi.fn(async () => ({
      ok: true,
      data: {
        workspace: '/a', currentPhase: { slug: 'default', name: 'Default', status: 'open' },
        columns: [], totals: { active: 0, blocked: 0, done: 0 }, tickets: [],
      },
    })),
    activity: vi.fn(async () => ({ ok: true, data: { workspace: '/a', dbId: 'activity-db', head: 0, entries: [] } })),
  };

  it('shows_skills_after_roles_and_opens_the_list_with_its_icon', async () => {
    const fake = fakeManagement({ calls: { skills: vi.fn(async () => ok(skillCatalog())) } });
    const view = render(
      <WorkspaceShell
        workspace={workspace}
        dashboard={dashboard}
        management={fake.api}
        connection={connectionFixture('connected')}
        onSwitchWorkspace={vi.fn()}
      />,
    );
    const nav = view.getByRole('navigation', { name: 'Workspace' });
    const labels = Array.from(nav.querySelectorAll<HTMLButtonElement>('.nav-item')).map(button => button.textContent);
    expect(labels).toEqual(['Home', 'Teams', 'Agents', 'Roles', 'Skills', 'Boards', 'Routing', 'Configuration']);
    expect(labels.indexOf('Skills')).toBe(labels.indexOf('Roles') + 1);
    const button = within(nav).getByRole('button', { name: 'Skills' });
    const icon = button.querySelector('svg')!;
    expect(icon.getAttribute('data-icon')).toBe('skills');
    expect(icon.getAttribute('width')).toBe('16');
    expect(icon.getAttribute('height')).toBe('16');
    expect(icon.getAttribute('stroke-width')).toBe('1.8');
    expect(icon.querySelectorAll('path')).toHaveLength(2);
    expect(icon.querySelectorAll('path')[0]!.getAttribute('d')).toBe('M12 3l9 5-9 5-9-5z');
    expect(icon.querySelectorAll('path')[1]!.getAttribute('d')).toBe('M3 13l9 5 9-5');
    fireEvent.click(button);
    expect(button.getAttribute('aria-current')).toBe('page');
    expect(view.container.querySelector('[data-section="skills"]')).toBeTruthy();
    expect(await view.findByRole('heading', { level: 1, name: 'Skills' })).toBeTruthy();
    expect(await view.findByRole('list', { name: 'Saved skills' })).toBeTruthy();
  });

  it('activates_skills_from_the_sidebar_with_enter_and_space_and_marks_it_current', async () => {
    const fake = fakeManagement({ calls: { skills: vi.fn(async () => ok(skillCatalog())) } });
    const view = render(
      <WorkspaceShell
        workspace={workspace}
        dashboard={dashboard}
        management={fake.api}
        connection={connectionFixture('connected')}
        onSwitchWorkspace={vi.fn()}
      />,
    );
    const nav = view.getByRole('navigation', { name: 'Workspace' });
    const button = within(nav).getByRole('button', { name: 'Skills' });
    const user = userEvent.setup();
    button.focus();
    await user.keyboard('{Enter}');
    expect(button.getAttribute('aria-current')).toBe('page');
    expect(view.container.querySelector('[data-section="skills"]')).toBeTruthy();
    expect(await view.findByRole('heading', { level: 1, name: 'Skills' })).toBeTruthy();

    await user.click(within(nav).getByRole('button', { name: 'Home' }));
    button.focus();
    await user.keyboard(' ');
    expect(button.getAttribute('aria-current')).toBe('page');
    expect(await view.findByRole('heading', { level: 1, name: 'Skills' })).toBeTruthy();
    expect(view.container.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  });
});
