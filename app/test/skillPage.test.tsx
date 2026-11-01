// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionStatus, DashboardApi, Workspace } from '../src/renderer/api';
import { SkillsScreen } from '../src/renderer/skills/SkillsScreen';
import { WorkspaceShell } from '../src/renderer/shell/WorkspaceShell';
import type { ManagementResult, SkillCatalogList, SkillDetail, SkillItem } from '../src/shared/management';
import { connectionFixture, deferred, fakeManagement } from './teamsFixtures';
import { SKILL_TEXT, skillCatalog, skillItem } from './skillFixtures';

afterEach(cleanup);

const workspace: Workspace = { id: 'a', name: 'A', path: '/a', exists: true, missing: false };
const ok = (data: SkillCatalogList) => ({ ok: true as const, data });
const okDetail = (data: SkillDetail): ManagementResult<SkillDetail> => ({ ok: true, data });

type SkillLookup = (workspaceId: string, skillId: string) => Promise<ManagementResult<SkillDetail>>;

function defaultLookup(catalog: SkillCatalogList, texts: Record<string, string> = {}): SkillLookup {
  return async (_workspaceId, skillId) => {
    const skill = catalog.skills.find(entry => entry.id === skillId);
    if (skill === undefined) {
      return { ok: false, error: { code: 'SKILL_NOT_FOUND', message: `Skill '${skillId}' was not found.`, retryable: false } };
    }
    const text = skill.state === 'ok' || skill.state === 'truncated'
      ? texts[skill.id] ?? SKILL_TEXT[skill.id] ?? `# ${skill.id}`
      : null;
    return okDetail({ workspace: catalog.workspace, skill, text });
  };
}

function setup(
  data: SkillCatalogList = skillCatalog(),
  options: {
    skill?: SkillLookup;
    texts?: Record<string, string>;
    connection?: ConnectionStatus;
    onViewRole?: (roleId: string) => void;
  } = {},
) {
  const skills = vi.fn(async (_id: string) => ok(data));
  const skill = vi.fn(options.skill ?? defaultLookup(data, options.texts));
  const fake = fakeManagement({ calls: { skills, skill } });
  const view = render(<main>
    <SkillsScreen
      workspace={workspace}
      management={fake.api}
      connection={options.connection}
      onViewRole={options.onViewRole}
    />
  </main>);
  return { view, skills, skill, fake };
}

const skillList = (view: ReturnType<typeof render>) => view.getByRole('list', { name: 'Saved skills' });
const rowById = (view: ReturnType<typeof render>, id: string) =>
  within(skillList(view)).getAllByRole('button').find(button => button.getAttribute('data-skill-id') === id)!;
const page = (view: ReturnType<typeof render>) => within(view.getByRole('region', { name: 'Skill details' }));
const card = (view: ReturnType<typeof render>, className: string) => {
  const element = view.container.querySelector(`.${className}`);
  expect(element).toBeTruthy();
  return element as HTMLElement;
};

async function open(view: ReturnType<typeof render>, id = 'code-search') {
  await view.findByRole('list', { name: 'Saved skills' });
  fireEvent.click(rowById(view, id));
  await view.findByRole('region', { name: 'Skill details' });
}

describe('Skill page header', () => {
  it('shows the id, the used-by pill, the title and the repeated notice for a used skill', async () => {
    const { view } = setup();
    await open(view);

    expect(page(view).getByRole('heading', { level: 1, name: 'code-search' }).className).toBe('skills-page-title');
    const pill = page(view).getByText('Used by 4 roles');
    expect(pill.classList.contains('skills-page-pill')).toBe(true);
    expect(pill.classList.contains('is-used')).toBe(true);
    expect(within(card(view, 'skills-page-top')).getByText('Searching the code cheaply')).toBeTruthy();
    const icon = card(view, 'skills-page-icon');
    expect(icon.classList.contains('is-missing')).toBe(false);
    expect(icon.querySelector('svg')?.getAttribute('data-icon')).toBe('skills');
    expect(icon.querySelector('svg')?.getAttribute('width')).toBe('22');
    expect(page(view).getByText('Saved changes apply to new assignments. Assignments already running keep the skills they started with.')).toBeTruthy();
    expect(page(view).getByRole('navigation', { name: 'Breadcrumb' }).textContent).toContain('Skillscode-search');
  });

  it('shows Not used in grey when no role lists the skill', async () => {
    const { view } = setup();
    await open(view, 'ts-testing');
    const pill = page(view).getByText('Not used');
    expect(pill.classList.contains('is-muted')).toBe(true);
    expect(within(card(view, 'skills-page-top')).getByText('Testing the app (TypeScript)')).toBeTruthy();
    expect(page(view).queryByText(/^Used by \d+ roles?$/)).toBeNull();
  });

  it('uses the singular used-by pill for a skill listed by one role', async () => {
    const solo = skillItem({
      id: 'solo', state: 'ok', title: 'Solo skill', bytes: 10, sha256: 'd'.repeat(64),
      roles: [{ id: 'alpha', name: 'Alpha', contextBytes: 1024 }],
    });
    const { view } = setup(skillCatalog({ skills: [solo], problems: [] }));
    await open(view, 'solo');

    const pill = page(view).getByText('Used by 1 role');
    expect(pill.classList.contains('is-used')).toBe(true);
    expect(within(card(view, 'skills-page-top')).getByText('Solo skill')).toBeTruthy();
    expect(page(view).queryByText('Used by 1 roles')).toBeNull();
  });

  it('counts every role in the missing header line', async () => {
    const missing = skillItem({
      id: 'lost', state: 'missing', title: null, bytes: null, sha256: null,
      roles: [
        { id: 'alpha', name: 'Alpha', contextBytes: 1 },
        { id: 'beta', name: 'Beta', contextBytes: 2 },
      ],
    });
    const { view } = setup(skillCatalog({ skills: [missing], problems: [] }));
    await open(view, 'lost');

    expect(page(view).getByText('Referenced by 2 roles, but there is no file.')).toBeTruthy();
    expect(page(view).getByText('Missing').classList.contains('is-missing')).toBe(true);
  });

  it('shows Missing in amber and explains the missing file', async () => {
    const { view } = setup();
    await open(view, 'legacy-notes');
    const pill = page(view).getByText('Missing');
    expect(pill.classList.contains('is-missing')).toBe(true);
    expect(page(view).getByText('Referenced by 1 role, but there is no file.')).toBeTruthy();
    expect(card(view, 'skills-page-icon').classList.contains('is-missing')).toBe(true);
    const note = card(view, 'skills-missing-note');
    expect(note.textContent).toBe('Roles refer to this skill but skills/legacy-notes/SKILL.md does not exist, so it is skipped when assignments start. Create it, or remove it from the roles that list it.');
    expect(note.querySelector('code')?.textContent).toBe('skills/legacy-notes/SKILL.md');
  });
});

describe('Skill page content', () => {
  it('shows the path, line and byte counts, the read-only preview and the Edit action for an ok skill', async () => {
    const { view } = setup();
    await open(view);
    await waitFor(() => expect(card(view, 'skills-content-preview')).toBeTruthy());

    const content = card(view, 'skills-content-card');
    expect(within(content).getByRole('heading', { name: 'Content' })).toBeTruthy();
    expect(within(content).getByText("What the agent reads. Loaded into the role's context when an assignment starts.")).toBeTruthy();
    expect(within(content).getByText('skills/code-search/SKILL.md')).toBeTruthy();
    expect(within(content).getByText('11 lines · 839 / 32,768 bytes')).toBeTruthy();
    expect(content.querySelector('pre')?.textContent).toContain('# Searching the code cheaply');
    expect(card(view, 'skills-content-fade')).toBeTruthy();
    expect(within(content).getByRole('button', { name: 'Edit skill content' })).toBeTruthy();
    expect(content.querySelector('textarea, [contenteditable="true"]')).toBeNull();
  });

  it('shows the truncation note and the real size for a truncated skill', async () => {
    const text = 'one\ntwo\nthree\nfour';
    const truncated = skillItem({
      id: 'huge-skill', state: 'truncated', title: 'Huge skill', bytes: 40960, sha256: 'b'.repeat(64), roles: [],
    });
    const { view } = setup(skillCatalog({ skills: [truncated], problems: [] }), { texts: { 'huge-skill': text } });
    await open(view, 'huge-skill');

    const content = card(view, 'skills-content-card');
    expect(within(content).getByText('4 lines · 40,960 / 32,768 bytes')).toBeTruthy();
    expect(content.querySelector('pre')?.textContent).toBe(text);
    expect(within(content).getByText('This file is larger than 32 KiB, so only the start is shown and it cannot be edited here. Shorten it outside the app.')).toBeTruthy();
  });

  it('shows the unreadable message instead of a preview', async () => {
    const unreadable = skillItem({
      id: 'broken-skill', state: 'unreadable', title: null, bytes: null, sha256: null, roles: [],
    });
    const { view } = setup(skillCatalog({ skills: [unreadable], problems: [] }));
    await open(view, 'broken-skill');

    const content = card(view, 'skills-content-card');
    expect(within(content).getByText('The file cannot be read.')).toBeTruthy();
    expect(content.querySelector('pre')).toBeNull();
    expect(content.querySelector('.skills-content-stats')).toBeNull();
  });

  it('shows a loading line until the skill text arrives', async () => {
    const catalog = skillCatalog();
    const item = catalog.skills.find(skill => skill.id === 'code-search')!;
    const gate = deferred<ManagementResult<SkillDetail>>();
    const { view } = setup(catalog, { skill: vi.fn(() => gate.promise) });
    await open(view);

    expect(page(view).getByText('Loading content…').getAttribute('role')).toBe('status');
    await act(async () => {
      gate.resolve(okDetail({ workspace: catalog.workspace, skill: item, text: SKILL_TEXT['code-search']! }));
    });
    await waitFor(() => expect(card(view, 'skills-content-preview')).toBeTruthy());
    expect(page(view).queryByText('Loading content…')).toBeNull();
  });

  it('shows the text error with Retry and reloads the preview', async () => {
    const catalog = skillCatalog();
    const item = catalog.skills.find(skill => skill.id === 'code-search')!;
    const skill = vi.fn()
      .mockResolvedValueOnce({ ok: false as const, error: { code: 'OFFLINE', message: 'cannot read the file', retryable: true } })
      .mockResolvedValue(okDetail({ workspace: catalog.workspace, skill: item, text: SKILL_TEXT['code-search']! }));
    const { view } = setup(catalog, { skill });
    await open(view);

    const alert = page(view).getByRole('alert');
    expect(alert.textContent).toContain('OFFLINE: cannot read the file');
    const user = userEvent.setup();
    await user.click(page(view).getByRole('button', { name: 'Retry loading content' }));
    await waitFor(() => expect(card(view, 'skills-content-preview')).toBeTruthy());
    expect(skill).toHaveBeenCalledTimes(2);
    expect(skill).toHaveBeenCalledWith('a', 'code-search');
  });

  it('shows an error and recovers when the text request rejects', async () => {
    const catalog = skillCatalog();
    const item = catalog.skills.find(skill => skill.id === 'code-search')!;
    const skill = vi.fn()
      .mockRejectedValueOnce(new Error('socket closed'))
      .mockResolvedValue(okDetail({ workspace: catalog.workspace, skill: item, text: SKILL_TEXT['code-search']! }));
    const { view } = setup(catalog, { skill });
    await open(view);

    const alert = await page(view).findByRole('alert');
    expect(alert.textContent).toContain('INTERNAL: socket closed');
    const user = userEvent.setup();
    await user.click(page(view).getByRole('button', { name: 'Retry loading content' }));
    await waitFor(() => expect(card(view, 'skills-content-preview')).toBeTruthy());
    expect(skill).toHaveBeenCalledTimes(2);
  });
});

describe('Skill page missing state', () => {
  it('shows the two fixing rows with the two Create this skill buttons and omits the content card', async () => {
    const { view } = setup();
    await open(view, 'legacy-notes');

    expect(view.container.querySelector('.skills-content-card')).toBeNull();
    const missing = card(view, 'skills-missing-card');
    expect(within(missing).getByRole('heading', { name: 'No SKILL.md yet' })).toBeTruthy();
    expect(within(missing).getByText('Two ways to fix the roles that list this skill.')).toBeTruthy();
    expect(within(missing).getByText('Create the file')).toBeTruthy();
    expect(within(missing).getByText('Start from a template and write the skill.')).toBeTruthy();
    expect(within(missing).getByRole('button', { name: 'Create this skill' })).toBeTruthy();
    expect(within(missing).getByText('Remove it from the roles')).toBeTruthy();
    expect(within(missing).getByText('Stop listing a skill that does not exist.')).toBeTruthy();
    expect(page(view).getAllByRole('button', { name: 'Create this skill' })).toHaveLength(2);
    // Both the Used by roles card header and the Remove it from the roles row
    // open the same dialog for a missing skill.
    expect(page(view).getAllByRole('button', { name: /edit roles/i })).toHaveLength(2);
    expect(within(missing).getByRole('button', { name: 'Edit roles' })).toBeTruthy();
    expect(page(view).queryByRole('button', { name: /delete skill/i })).toBeNull();
    expect(page(view).queryByRole('button', { name: 'Edit' })).toBeNull();
  });
});

describe('Skill page details and used by roles', () => {
  it('shows the details values for a readable skill', async () => {
    const { view } = setup();
    await open(view);
    const details = card(view, 'skills-details-card');
    expect(within(details).getByRole('heading', { name: 'Details' })).toBeTruthy();
    expect(within(details).getByText("The folder name is the skill's id and cannot change.")).toBeTruthy();
    expect(within(details).getByText('Skill id')).toBeTruthy();
    expect(within(details).getByText('code-search')).toBeTruthy();
    expect(within(details).getByText('File')).toBeTruthy();
    expect(within(details).getByText('skills/code-search/SKILL.md')).toBeTruthy();
    expect(within(details).getByText('Title')).toBeTruthy();
    expect(within(details).getByText('Searching the code cheaply')).toBeTruthy();
    expect(within(details).getByText('Size')).toBeTruthy();
    expect(within(details).getByText('839 B of 32 KiB')).toBeTruthy();
  });

  it('shows the missing details values', async () => {
    const { view } = setup();
    await open(view, 'legacy-notes');
    const details = card(view, 'skills-details-card');
    expect(within(details).getByText('legacy-notes')).toBeTruthy();
    expect(within(details).getByText('skills/legacy-notes/SKILL.md')).toBeTruthy();
    expect(within(details).getByText('No SKILL.md found')).toBeTruthy();
    expect(within(details).getByText('File not found')).toBeTruthy();
  });

  it('shows the unreadable details values without a preview', async () => {
    const unreadable = skillItem({
      id: 'broken-skill', state: 'unreadable', title: null, bytes: null, sha256: null, roles: [],
    });
    const { view } = setup(skillCatalog({ skills: [unreadable], problems: [] }));
    await open(view, 'broken-skill');

    const details = card(view, 'skills-details-card');
    expect(within(details).getByText('broken-skill')).toBeTruthy();
    expect(within(details).getByText('skills/broken-skill/SKILL.md')).toBeTruthy();
    expect(within(details).getByText('The file cannot be read.')).toBeTruthy();
    expect(within(details).getByText('File cannot be read')).toBeTruthy();
    expect(card(view, 'skills-content-card').querySelector('pre')).toBeNull();
  });

  it('lists each role with its context size and marks a context above 80 percent in amber', async () => {
    const onViewRole = vi.fn();
    const used = skillItem({
      id: 'used-skill', state: 'ok', title: 'Used skill', bytes: 10, sha256: 'a'.repeat(64),
      roles: [
        { id: 'alpha', name: 'Alpha', contextBytes: 2048 },
        { id: 'huge', name: 'Huge Context', contextBytes: 90000 },
        { id: 'beta', name: null, contextBytes: 512 },
      ],
    });
    const { view } = setup(skillCatalog({ skills: [used], problems: [] }), { onViewRole });
    await open(view, 'used-skill');

    const usedBy = card(view, 'skills-usedby-card');
    expect(within(usedBy).getByRole('heading', { name: 'Used by roles' })).toBeTruthy();
    expect(within(usedBy).getByText('Roles that load this skill.')).toBeTruthy();
    expect(within(usedBy).getByText('Context 2.0 KB of 96 KiB')).toBeTruthy();
    const huge = within(usedBy).getByText('Context 87.9 KB of 96 KiB');
    expect(huge.classList.contains('is-warning')).toBe(true);
    expect(within(usedBy).getByText('Context 0.5 KB of 96 KiB')).toBeTruthy();
    const alphaRow = within(usedBy).getByText('Alpha').closest('li')!;
    expect(alphaRow.querySelector('.skills-usedby-avatar')?.textContent).toBe('A');
    expect(within(usedBy).getByText('beta')).toBeTruthy();
    const user = userEvent.setup();
    await user.click(within(usedBy).getByRole('button', { name: 'Open role Alpha' }));
    expect(onViewRole).toHaveBeenCalledWith('alpha');
    await user.click(within(usedBy).getByRole('button', { name: 'Open role Huge Context' }));
    expect(onViewRole).toHaveBeenCalledWith('huge');
  });

  it('says when no role uses the skill yet', async () => {
    const { view } = setup();
    await open(view, 'ts-testing');
    expect(page(view).getByText('No role uses this skill yet.')).toBeTruthy();
  });
});

describe('Skill page navigation and freshness', () => {
  it('focuses the id on open and returns focus to the opened row', async () => {
    const { view } = setup();
    await open(view);
    const heading = page(view).getByRole('heading', { level: 1, name: 'code-search' });
    await waitFor(() => expect(document.activeElement).toBe(heading));

    fireEvent.click(page(view).getByRole('button', { name: 'Skills' }));
    await view.findByRole('list', { name: 'Saved skills' });
    await waitFor(() => expect(document.activeElement).toBe(rowById(view, 'code-search')));
  });

  it('opens the role page in Roles with the right role id', async () => {
    const fake = fakeManagement();
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
    const view = render(
      <WorkspaceShell
        workspace={workspace}
        dashboard={dashboard}
        management={fake.api}
        connection={connectionFixture('connected')}
        onSwitchWorkspace={vi.fn()}
      />,
    );
    const user = userEvent.setup();
    await user.click(within(view.getByRole('navigation', { name: 'Workspace' })).getByRole('button', { name: 'Skills' }));
    await view.findByRole('list', { name: 'Saved skills' });
    await user.click(rowById(view, 'code-search'));
    await view.findByRole('region', { name: 'Skill details' });
    await user.click(view.getByRole('button', { name: 'Open role TeamLead' }));

    await view.findByRole('region', { name: 'Role details' });
    expect(view.getByRole('heading', { level: 1, name: 'TeamLead' })).toBeTruthy();
    expect(within(view.getByRole('navigation', { name: 'Workspace' })).getByRole('button', { name: 'Roles' }).getAttribute('aria-current')).toBe('page');
  });

  it('shows a removed skill while the page is open and links back to the list', async () => {
    const first = skillCatalog();
    const { view } = setup(first);
    await open(view);

    const without = skillCatalog({ skills: first.skills.filter(skill => skill.id !== 'code-search') });
    const nextSkills = vi.fn(async () => ok(without));
    const next = fakeManagement({ calls: { skills: nextSkills, skill: defaultLookup(without) } });
    view.rerender(<main><SkillsScreen workspace={workspace} management={next.api} /></main>);

    await view.findByText('This skill no longer exists.');
    expect(view.getByRole('region', { name: 'Skill details' })).toBeTruthy();
    const user = userEvent.setup();
    await user.click(view.getByRole('button', { name: 'Back to skills' }));
    await view.findByRole('list', { name: 'Saved skills' });
    expect(view.queryByText('This skill no longer exists.')).toBeNull();
  });

  it('shows the new title when the list reloads the open skill', async () => {
    const first = skillCatalog();
    const { view } = setup(first);
    await open(view);
    expect(within(card(view, 'skills-page-top')).getByText('Searching the code cheaply')).toBeTruthy();

    const changed = skillCatalog({
      skills: first.skills.map(skill => skill.id === 'code-search' ? { ...skill, title: 'Changed title' } : skill),
    });
    const next = fakeManagement({ calls: { skills: vi.fn(async () => ok(changed)), skill: defaultLookup(changed) } });
    view.rerender(<main><SkillsScreen workspace={workspace} management={next.api} /></main>);

    await waitFor(() => expect(within(card(view, 'skills-page-top')).getByText('Changed title')).toBeTruthy());
    expect(page(view).getByRole('heading', { level: 1, name: 'code-search' })).toBeTruthy();
  });

  it('shows the new role usage when the list reloads the open skill', async () => {
    const first = skillCatalog();
    const { view } = setup(first);
    await open(view);
    expect(page(view).getByText('Used by 4 roles')).toBeTruthy();

    const changed = skillCatalog({
      skills: first.skills.map(skill => skill.id === 'code-search'
        ? { ...skill, roles: [{ id: 'QA', name: 'QA', contextBytes: 4096 }] }
        : skill),
    });
    const next = fakeManagement({ calls: { skills: vi.fn(async () => ok(changed)), skill: defaultLookup(changed) } });
    view.rerender(<main><SkillsScreen workspace={workspace} management={next.api} /></main>);

    await waitFor(() => expect(page(view).getByText('Used by 1 role')).toBeTruthy());
    const usedBy = card(view, 'skills-usedby-card');
    expect(within(usedBy).getByText('QA')).toBeTruthy();
    expect(within(usedBy).getByText('Context 4.0 KB of 96 KiB')).toBeTruthy();
    expect(within(usedBy).queryByText('Developer')).toBeNull();
  });
});

describe('Skill page layout styles', () => {
  it('defines the two column layout and stacks it before 900px', () => {
    const css = readFileSync(resolve(__dirname, '../src/renderer/styles.css'), 'utf8');
    const flat = css.replace(/\s+/g, ' ');
    expect(flat).toContain('.skills-page-main { flex: 999 1 560px; display: flex; flex-direction: column; gap: 22px; min-width: 0; }');
    expect(flat).toContain('.skills-page-aside { flex: 1 1 320px; display: flex; flex-direction: column; gap: 22px; min-width: 0; max-width: 400px; }');
    expect(flat).toMatch(/@media \(max-width: 900px\) \{ \.skills-page-layout \{ flex-direction: column; \} \.skills-page-main, \.skills-page-aside \{ width: 100%; flex: 1 1 auto; max-width: none; \} \}/);
    expect(flat).toContain('.skills-content-preview pre { max-height: 360px;');
    expect(flat).toContain('.skills-content-fade { position: absolute; left: 0; right: 0; bottom: 0; height: 64px;');
  });

  it('follows the design metrics and tones of the skill page', () => {
    const css = readFileSync(resolve(__dirname, '../src/renderer/styles.css'), 'utf8').replace(/\s+/g, ' ');
    // The icon is a 48 px rounded square that turns amber for a missing file.
    expect(css).toMatch(/\.skills-page-icon \{[^}]*width: 48px; height: 48px;[^}]*border-radius: 11px/);
    expect(css).toMatch(/\.skills-page-icon\.is-missing \{[^}]*rgba\(240, 180, 83, 0\.12\)[^}]*color: var\(--warning\)/);
    // The id is mono, and the pill tones are blue, grey and amber.
    expect(css).toMatch(/\.skills-page-title \{[^}]*font-family: var\(--font-mono\)/);
    expect(css).toMatch(/\.skills-page-pill\.is-used \{[^}]*rgba\(91, 156, 255, 0\.12\)/);
    expect(css).toMatch(/\.skills-page-pill\.is-muted \{[^}]*rgba\(141, 148, 158, 0\.14\)/);
    expect(css).toMatch(/\.skills-page-pill\.is-missing \{[^}]*rgba\(240, 180, 83, 0\.12\)/);
    // The preview ends in the design's fade; paths wrap in mono; a heavy context turns amber.
    expect(css).toMatch(/\.skills-content-fade \{[^}]*linear-gradient\(to bottom, rgba\(18, 20, 24, 0\), #121418\)/);
    expect(css).toMatch(/\.skills-details-grid dd code \{[^}]*font-family: var\(--font-mono\)/);
    expect(css).toMatch(/\.skills-details-path \{ word-break: break-all; \}/);
    expect(css).toMatch(/\.skills-usedby-context\.is-warning \{ color: var\(--warning\); \}/);
  });
});
