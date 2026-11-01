// @vitest-environment jsdom
import { cleanup, render, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DashboardApi, RoleCatalogItem, Workspace } from '../src/renderer/api';
import { RolePage } from '../src/renderer/roles/RolePage';
import { WorkspaceShell } from '../src/renderer/shell/WorkspaceShell';
import { connectionFixture, fakeManagement } from './teamsFixtures';
import { roleItem, rolesFixture } from './rolesFixtures';
import { skillCatalog, skillItem } from './skillFixtures';

afterEach(cleanup);
const workspace: Workspace = { id: 'a', name: 'A', path: '/a', exists: true, missing: false };
const nextWorkspace: Workspace = { id: 'b', name: 'B', path: '/b', exists: true, missing: false };
const okRoles = (data: ReturnType<typeof rolesFixture>) => ({ ok: true as const, data });
const okSkills = (data: ReturnType<typeof skillCatalog>) => ({ ok: true as const, data });

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

function roleWithSkills(skills: RoleCatalogItem['skills']): ReturnType<typeof rolesFixture> {
  return rolesFixture({
    items: [roleItem('Developer', { name: 'Developer', skills }), roleItem('TeamLead')],
    availableSkills: ['code-search', 'python-testing'],
  });
}

function shell(management: ReturnType<typeof fakeManagement>['api'], ws: Workspace = workspace) {
  return render(
    <WorkspaceShell
      workspace={ws}
      dashboard={dashboard}
      management={management}
      connection={connectionFixture('connected')}
      onSwitchWorkspace={vi.fn()}
    />,
  );
}

const nav = (view: ReturnType<typeof render>) => within(view.getByRole('navigation', { name: 'Workspace' }));

async function openRoles(view: ReturnType<typeof render>) {
  await userEvent.setup().click(nav(view).getByRole('button', { name: 'Roles' }));
  return view.findByRole('list', { name: 'Saved roles' });
}

async function openRole(view: ReturnType<typeof render>, id = 'Developer') {
  await openRoles(view);
  await userEvent.setup().click(view.getByRole('button', { name: `Open role ${id}` }));
  return view.findByRole('region', { name: 'Role details' });
}

describe('Skills cross-links with Roles', () => {
  it('skills_chips_on_the_role_page_are_buttons_that_open_including_missing_skills', () => {
    const onOpenSkill = vi.fn();
    const props = {
      role: roleItem('Developer', {
        name: 'Developer',
        skills: [{ id: 'code-search', state: 'ok' }, { id: 'legacy-notes', state: 'missing' }],
      }),
      editDisabled: false,
      editReason: null,
      onEditOverview: vi.fn(),
      onEditSkills: vi.fn(),
      onEditInstructions: vi.fn(),
      onBack: vi.fn(),
      onDelete: vi.fn(),
      deleteDisabledReason: null,
      onOpenSkill,
    };
    const view = render(<RolePage {...props} />);
    const chips = within(view.container).getAllByRole('button', { name: /^Open skill / });
    expect(chips.map(chip => chip.getAttribute('aria-label'))).toEqual([
      'Open skill code-search',
      'Open skill legacy-notes',
    ]);
    expect(chips.every(chip => chip.tagName === 'BUTTON' && chip.classList.contains('roles-skill-chip'))).toBe(true);
    chips[0]!.click();
    chips[1]!.click();
    expect(onOpenSkill.mock.calls).toEqual([['code-search'], ['legacy-notes']]);
    expect(chips[1]!.textContent).toBe('legacy-notes · missing');
  });

  it('manage_skills_in_the_edit_skills_dialog_closes_it_and_opens_the_skills_list', async () => {
    const fake = fakeManagement({
      calls: {
        roles: vi.fn(async () => okRoles(roleWithSkills([{ id: 'code-search', state: 'ok' }]))),
        skills: vi.fn(async () => okSkills(skillCatalog())),
      },
    });
    const view = shell(fake.api);
    const user = userEvent.setup();
    const region = await openRole(view);
    await user.click(within(region).getByRole('button', { name: 'Edit skills' }));
    const dialog = view.getByRole('dialog', { name: 'Edit skills' });
    const manage = within(dialog).getByRole('button', { name: 'Manage skills' });
    expect(manage.className).toContain('dialog-action-link');
    await user.click(manage);

    await view.findByRole('heading', { level: 1, name: 'Skills' });
    expect(view.queryByRole('dialog')).toBeNull();
    expect(nav(view).getByRole('button', { name: 'Skills' }).getAttribute('aria-current')).toBe('page');
    expect(await view.findByRole('list', { name: 'Saved skills' })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(view.getByRole('heading', { level: 1, name: 'Skills' })));
  });

  it('a_role_chip_opens_the_skill_page_and_a_known_missing_skill_opens_its_missing_page', async () => {
    const roles = roleWithSkills([
      { id: 'code-search', state: 'ok' },
      { id: 'legacy-notes', state: 'missing' },
    ]);
    const fake = fakeManagement({
      calls: {
        roles: vi.fn(async () => okRoles(roles)),
        skills: vi.fn(async () => okSkills(skillCatalog())),
      },
    });
    const view = shell(fake.api);
    const user = userEvent.setup();

    await openRole(view);
    await user.click(view.getByRole('button', { name: 'Open skill code-search' }));
    const page = await view.findByRole('region', { name: 'Skill details' });
    expect(within(page).getByRole('heading', { level: 1, name: 'code-search' })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(within(page).getByRole('heading', { level: 1, name: 'code-search' })));

    await openRole(view);
    await user.click(view.getByRole('button', { name: 'Open skill legacy-notes' }));
    const missing = await view.findByRole('region', { name: 'Skill details' });
    expect(within(missing).getByRole('heading', { level: 1, name: 'legacy-notes' })).toBeTruthy();
    expect(within(missing).getByText('Missing')).toBeTruthy();
    expect(within(missing).getAllByRole('button', { name: 'Create this skill' })).toHaveLength(2);
  });

  it('an_unknown_skill_deep_link_keeps_the_list_and_shows_a_fallback_notice', async () => {
    const roles = roleWithSkills([{ id: 'retired-skill', state: 'missing' }]);
    const fake = fakeManagement({
      calls: {
        roles: vi.fn(async () => okRoles(roles)),
        skills: vi.fn(async () => okSkills(skillCatalog())),
      },
    });
    const view = shell(fake.api);
    const user = userEvent.setup();

    await openRole(view);
    await user.click(view.getByRole('button', { name: 'Open skill retired-skill' }));

    expect(await view.findByText('Skill "retired-skill" is unavailable in this workspace.')).toBeTruthy();
    expect(await view.findByRole('list', { name: 'Saved skills' })).toBeTruthy();
    expect(view.queryByRole('region', { name: 'Skill details' })).toBeNull();
  });

  it('workspace_change_clears_a_pending_skill_deep_link', async () => {
    const roles = roleWithSkills([{ id: 'code-search', state: 'ok' }]);
    const fake = fakeManagement({
      calls: {
        roles: vi.fn(async () => okRoles(roles)),
        skills: vi.fn(async () => okSkills(skillCatalog())),
      },
    });
    const view = shell(fake.api);
    const user = userEvent.setup();

    await openRole(view);
    await user.click(view.getByRole('button', { name: 'Open skill code-search' }));
    await view.findByRole('region', { name: 'Skill details' });

    view.rerender(
      <WorkspaceShell
        workspace={nextWorkspace}
        dashboard={dashboard}
        management={fake.api}
        connection={connectionFixture('connected')}
        onSwitchWorkspace={vi.fn()}
      />,
    );
    expect(view.getByRole('heading', { level: 1, name: 'Workspace overview' })).toBeTruthy();
    await user.click(nav(view).getByRole('button', { name: 'Skills' }));
    await view.findByRole('list', { name: 'Saved skills' });
    expect(view.queryByText(/is unavailable in this workspace\./)).toBeNull();
    expect(view.queryByRole('region', { name: 'Skill details' })).toBeNull();
  });

  it('opening_a_role_from_used_by_roles_then_back_returns_to_the_roles_list', async () => {
    const roles = roleWithSkills([{ id: 'code-search', state: 'ok' }]);
    const fake = fakeManagement({
      calls: {
        roles: vi.fn(async () => okRoles(roles)),
        skills: vi.fn(async () => okSkills(skillCatalog())),
      },
    });
    const view = shell(fake.api);
    const user = userEvent.setup();
    await user.click(nav(view).getByRole('button', { name: 'Skills' }));
    await view.findByRole('list', { name: 'Saved skills' });
    await user.click(view.getByRole('button', { name: 'Open skill code-search' }));
    const page = await view.findByRole('region', { name: 'Skill details' });
    await user.click(within(page).getByRole('button', { name: 'Open role TeamLead' }));

    const rolePage = await view.findByRole('region', { name: 'Role details' });
    expect(within(rolePage).getByRole('heading', { level: 1, name: 'TeamLead' })).toBeTruthy();
    await user.click(within(rolePage).getByRole('button', { name: 'Roles' }));
    expect(await view.findByRole('list', { name: 'Saved roles' })).toBeTruthy();
    expect(view.queryByRole('region', { name: 'Role details' })).toBeNull();
  });

  it('skills_show_a_role_new_usage_the_next_time_the_screen_opens', async () => {
    let roles = rolesFixture({
      items: [roleItem('Developer', { name: 'Developer', skills: [{ id: 'code-search', state: 'ok' }] }), roleItem('TeamLead')],
      availableSkills: ['code-search', 'extra-skill'],
    });
    let skills = skillCatalog({
      skills: [
        skillItem({ id: 'code-search', roles: [] }),
        skillItem({ id: 'extra-skill', title: 'Extra skill', state: 'ok', bytes: 10, sha256: 'e'.repeat(64), roles: [] }),
      ],
      problems: [],
    });
    const rolesApi = vi.fn(async () => okRoles(roles));
    const skillsApi = vi.fn(async () => okSkills(skills));
    const updateRole = vi.fn(async (_workspaceId: string, roleId: string, changes: { skills?: string[] }) => {
      const wanted = changes.skills ?? [];
      const updated = roleItem(roleId, {
        ...roles.items.find(item => item.id === roleId)!,
        skills: wanted.map(id => ({ id, state: 'ok' as const })),
      });
      roles = { ...roles, items: [updated, ...roles.items.slice(1)], sha256: '8'.repeat(64) };
      skills = skillCatalog({
        skills: [
          skillItem({ id: 'code-search', roles: [] }),
          skillItem({
            id: 'extra-skill', title: 'Extra skill', state: 'ok', bytes: 10, sha256: 'e'.repeat(64),
            roles: [{ id: 'Developer', name: 'Developer', contextBytes: 120 }],
          }),
        ],
        problems: [],
      });
      return {
        ok: true as const,
        data: { workspace: '/a', sha256: '8'.repeat(64), role: updated, warnings: [], appliesToNewAssignments: true as const },
      };
    });
    const fake = fakeManagement({ calls: { roles: rolesApi, skills: skillsApi, updateRole } });
    const view = shell(fake.api);
    const user = userEvent.setup();
    expect(skillsApi).not.toHaveBeenCalled();

    const region = await openRole(view);
    await user.click(within(region).getByRole('button', { name: 'Edit skills' }));
    const dialog = view.getByRole('dialog', { name: 'Edit skills' });
    await user.click(within(dialog).getByRole('checkbox', { name: 'extra-skill' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(view.queryByRole('dialog')).toBeNull());
    expect(updateRole).toHaveBeenCalledWith('a', 'Developer', { skills: ['code-search', 'extra-skill'] }, 'c'.repeat(64));

    await user.click(nav(view).getByRole('button', { name: 'Skills' }));
    await view.findByRole('list', { name: 'Saved skills' });
    // Opening Skills mounts the screen again, which reloads the catalog: that is
    // how the role change made in Roles becomes visible here.
    expect(skillsApi).toHaveBeenCalledTimes(1);
    const row = view.getByRole('button', { name: 'Open skill extra-skill' });
    expect(within(row).getByText('Developer')).toBeTruthy();
  });
});
